import { runAgentLoop, type AgentEvent, type RunAgentOptions, type StopReason } from '@workpivot/core';
import type { Pool } from 'pg';
import { RepositoryError } from './connection.js';
import { RunRepository, type RunHandle } from './runs.js';
import type { CompactionService } from './compaction.js';

/** Configured by trusted server services, never by HTTP-supplied paths, keys or tools. */
export type PrepareExecution = (actor: string, taskId: string, context: { run?: RunHandle }) => Promise<Omit<RunAgentOptions, 'messages' | 'onEvent' | 'signal'>>;
export type DurableEvent = Omit<AgentEvent, 'type'> & { type: AgentEvent['type'] | 'permission_request' | 'permission_resolved'; id: string; sequence: string; turnId: string; runId: string; eventId?: string };
export class DatabaseExecution {
  readonly runs: RunRepository;
  private readonly controllers = new Map<string, { actor: string; taskId: string; controller: AbortController }>();
  constructor(db: Pool, private readonly prepare: PrepareExecution, private readonly onCompleted?: (actor: string, taskId: string, runId: string) => Promise<void>, readonly compaction?: CompactionService) { this.runs = new RunRepository(db); }
  async begin(actor: string, taskId: string, content: string, requestId: string, attachments: string[] = []) {
    await this.runs.recover(actor, taskId);
    const context: { run?: RunHandle } = {};
    const options = await this.prepare(actor, taskId, context);
    await this.compaction?.guard(actor, taskId, content, {system:options.system,tools:options.tools.map(t=>({name:t.name,description:t.description,parameters:t.parameters}))}, requestId);
    const run = await this.runs.start(actor, taskId, requestId, content, attachments);
    context.run = run;
    if (run.duplicate) return { run, execute: undefined };
    const controller = new AbortController(); this.controllers.set(run.id, { actor, taskId, controller });
    let executed = false;
    return { run, execute: async (send: (event: DurableEvent) => void): Promise<StopReason> => {
      if (executed) throw new RepositoryError(409, '运行已经启动');
      executed = true;
      let reason: StopReason = 'error', heartbeatPending = false, persistenceFailed = false;
      const timer = setInterval(() => {
        if (heartbeatPending) return;
        heartbeatPending = true;
        void this.runs.heartbeat(actor, run).then(live => { if (!live) controller.abort(); }).catch(() => { persistenceFailed = true; controller.abort(); }).finally(() => { heartbeatPending = false; });
      }, 5000);
      timer.unref();
      try {
        const messages = await this.runs.history(actor, run);
        const requestAccess: NonNullable<RunAgentOptions['requestAccess']> = options.requestAccess ?? (async request => {
          if (!request.external || request.paths.length || request.kind !== 'write') return false;
          const permission = await this.runs.requestPermission(actor, run, request);
          try { if (!permission.automatic) send(permission); } catch { /* Pending requests remain queryable after disconnect. */ }
          while (!controller.signal.aborted) {
            const decision = await this.runs.consumePermission(actor, run, permission.id);
            if (decision !== 'pending') return decision === 'allow';
            await new Promise<void>(resolve => {
              const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
              const timer = setTimeout(done, 500); controller.signal.addEventListener('abort', done, { once: true });
              if (controller.signal.aborted) done();
            });
          }
          return false;
        });
        const result = await runAgentLoop({ ...options, requestAccess, messages, signal: controller.signal,
          onEvent: async value => {
            try {
              const saved = await this.runs.append(actor, run, value);
              // Never tell the client an event exists until it has committed.
              try { send({ ...value, ...saved }); } catch { /* Client may reconnect using persisted events. */ }
            } catch (error) { persistenceFailed = true; controller.abort(); throw error; }
          },
        });
        reason = await this.runs.finish(actor, run, persistenceFailed ? 'error' : result.stopReason, result.messages.slice(messages.length + 1));
      } catch {
        reason = controller.signal.aborted && !persistenceFailed ? 'aborted' : 'error';
        // A stale executor must not mark a newer run complete; the repository fences every write.
        try { reason = await this.runs.finish(actor, run, reason, []); } catch { /* Lease recovery retains interrupted state. */ }
      } finally { clearInterval(timer); this.controllers.delete(run.id); }
      if (reason === 'completed' && this.onCompleted) { try { await this.onCompleted(actor, taskId, run.id); } catch { /* Durable recovery can enqueue finished runs later. */ } }
      return reason;
    } };
  }
  async stop(actor: string, taskId: string): Promise<void> {
    await this.runs.stop(actor, taskId);
    for (const local of this.controllers.values()) if (local.actor === actor && local.taskId === taskId) local.controller.abort();
    // Other server processes observe the stop through the durable heartbeat.
  }
}
