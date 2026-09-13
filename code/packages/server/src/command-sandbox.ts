import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { mkdirSync, readdirSync, lstatSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { canonicalPath, requireWithin, workpivotHome } from '@workpivot/shared/node';
import { tmpdir } from 'node:os';
import type { Task } from './tasks.js';
import { moveToTrash } from './trash.js';
import { EXPORT_WORKSPACE } from './sandbox-export.js';

const execute = promisify(execFile);
const LIMIT = 128 * 1024 * 1024;
const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
type Policy = (path: string, mode: 'read' | 'write') => boolean;
const recovered = new Map<string, Promise<void>>();

/** Docker receives an isolated copy, never the project, application-data or socket mounts. */
export function sandboxCommand(task: Task, allowed: Policy, signal: AbortSignal): (command: string) => Promise<string> {
  return async (command) => {
    const owner = hash(Buffer.from(`${canonicalPath(workpivotHome())}:${process.env['WORKPIVOT_EXECUTION_VOLUME'] ?? ''}`)).slice(0, 16);
    const job = `wp-exec-${owner}-${randomUUID()}`;
    const stageRoot = process.env['WORKPIVOT_EXECUTION_ROOT'] ?? join(tmpdir(), 'workpivot-execution');
    const stage = join(stageRoot, job);
    const inputDir = join(stage, 'input');
    const originals = new Map<string, string>();
    const isWin = process.platform === 'win32';
    const program = isWin ? 'wsl.exe' : 'docker';
    const prefix = isWin ? ['--exec', 'docker'] : [];
    const docker = (args: string[], abort?: AbortSignal) => execute(program, [...prefix, ...args], {
      windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024, signal: abort,
    });
    const recoveryKey = `${owner}:${canonicalPath(stageRoot)}`;
    if (!recovered.has(recoveryKey)) {
      const recovery = (async () => {
        const previous = await docker(['ps', '-a', '--filter', `label=workpivot.execution.owner=${owner}`, '--format', '{{.Names}}']);
        for (const name of previous.stdout.trim().split(/\r?\n/).filter(Boolean)) {
          if (!name.startsWith(`wp-exec-${owner}-`)) throw new Error('隔离容器恢复标识不匹配');
          await docker(['rm', '-f', name]);
        }
        if (existsSync(stageRoot)) for (const entry of readdirSync(stageRoot)) {
          if (!new RegExp(`^wp-exec-${owner}-[0-9a-f-]{36}$`).test(entry)) continue;
          const candidate = join(stageRoot, entry);
          if (lstatSync(candidate).isSymbolicLink()) throw new Error('隔离恢复目录不能是链接');
          rmSync(requireWithin(candidate, stageRoot), { recursive: true, force: true });
        }
      })();
      recovered.set(recoveryKey, recovery);
    }
    try { await recovered.get(recoveryKey); }
    catch (error) { recovered.delete(recoveryKey); throw new Error(`隔离执行环境不可用，请启动 Docker 并准备执行镜像：${String(error)}`); }
    mkdirSync(inputDir, { recursive: true });
    const removeContainer = async (): Promise<void> => {
      try { await docker(['rm', '-f', job]); }
      catch (error) {
        if (!String((error as { stderr?: string }).stderr).includes('No such container')) throw error;
      }
    };
    let created = false;
    try {
      let bytes = 0;
      const collect = (root: string, copying: boolean): Map<string, Buffer> => {
        const files = new Map<string, Buffer>();
        let entries = 0;
        const walk = (rel: string): void => {
          for (const entry of readdirSync(join(root, rel), { withFileTypes: true })) {
            if (++entries > 10000) throw new Error('隔离任务目录项超过10000上限');
            if (signal.aborted) throw new Error('任务已停止');
            const name = join(rel, entry.name);
            const path = join(root, name);
            if (copying && !allowed(path, 'read')) continue;
            const stat = lstatSync(path);
            if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile()) || stat.nlink > 1 && stat.isFile()) {
              if (copying) continue;
              throw new Error('隔离环境产物包含链接或特殊文件，拒绝回写');
            }
            if (stat.isDirectory()) { walk(name); continue; }
            bytes += stat.size;
            if (bytes > LIMIT || files.size >= 10000) throw new Error('隔离任务文件超过 128MiB 或 10000 文件上限');
            files.set(name, readFileSync(path));
          }
        };
        walk(''); return files;
      };
      for (const [name, data] of collect(task.directory, true)) {
        const target = join(inputDir, name);
        requireWithin(target, inputDir);
        mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, data);
        originals.set(isWin ? name.toLowerCase() : name, hash(data));
      }
      if (signal.aborted) throw new Error('任务已停止');
      const volume = process.env['WORKPIVOT_EXECUTION_VOLUME'];
      let source = canonicalPath(inputDir);
      if (isWin) source = (await execute('wsl.exe', ['--exec', 'wslpath', '-u', source], { windowsHide: true, timeout: 15000 })).stdout.trim();
      if (source.includes(',') || volume?.includes(',')) throw new Error('隔离目录配置包含无效字符');
      const mount = volume ? `type=volume,src=${volume},dst=/input,volume-subpath=${job}/input,readonly` : `type=bind,src=${source},dst=/input,readonly`;
      const image = process.env['WORKPIVOT_EXECUTION_IMAGE'] ?? 'workpivot-server:0.3.0-dev';
      created = true; // Also clean up an uncertain create response from the daemon.
      await docker(['create', '--rm', '--name', job, '--label', 'workpivot.execution=true', '--label', `workpivot.execution.owner=${owner}`, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges:true', '--pids-limit', '128', '--memory', '512m', '--cpus', '1', '--user', '1000:1000',
        '--mount', mount, '--tmpfs', '/workspace:rw,nosuid,nodev,size=192m,uid=1000,gid=1000', '--tmpfs', '/tmp:rw,nosuid,nodev,size=64m',
        '--tmpfs', '/data/workpivot:ro,nosuid,nodev,size=1m', '--tmpfs', '/data/workspace:ro,nosuid,nodev,size=1m', '--workdir', '/workspace',
        '--env', 'HOME=/tmp', '--env', 'NODE_PATH=/app/packages/server/node_modules', '--entrypoint', '/bin/sh', image, '-c', 'exec sleep 150']);
      if (signal.aborted) throw new Error('任务已停止');
      await docker(['start', job], signal);
      await docker(['exec', job, 'cp', '-R', '/input/.', '/workspace/'], signal);
      const result = await docker(['exec', job, '/bin/sh', '-c', command], signal).catch((err: unknown) => {
        if (signal.aborted) throw new Error('任务已停止');
        const failure = err as { code?: number | string; stdout?: string; stderr?: string };
        throw new Error(`命令执行失败（${failure.code ?? 'unknown'}）：${failure.stdout ?? ''}${failure.stderr ?? ''}；文件变更未回写`);
      });
      // Export bounded, untrusted bytes through stdout; never mount a writable host directory.
      const exported = await execute(program, [...prefix, 'exec', job, 'node', '-e', EXPORT_WORKSPACE], {
        windowsHide: true, timeout: 30000, maxBuffer: 192 * 1024 * 1024, signal,
      });
      // Terminate all background processes before any host-side validation or writes.
      await removeContainer(); created = false;
      if (signal.aborted) throw new Error('任务已停止');
      bytes = 0;
      const payload: unknown = JSON.parse(exported.stdout);
      if (!Array.isArray(payload) || payload.length > 10000) throw new Error('隔离产物格式无效');
      const output = new Map<string, Buffer>();
      for (const entry of payload) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string' || typeof entry[1] !== 'string' || entry[0].startsWith('/') || entry[0].includes('\\') || entry[0].split('/').some((p: string) => p === '.' || p === '..' || p === '')) throw new Error('隔离产物路径无效');
        const joined = join(...entry[0].split('/'));
        const name = isWin ? joined.toLowerCase() : joined;
        requireWithin(name, task.directory);
        if (output.has(name)) throw new Error('隔离产物存在重复路径');
        const data = Buffer.from(entry[1], 'base64');
        bytes += data.length;
        if (bytes > LIMIT) throw new Error('隔离产物超过 128MiB');
        output.set(name, data);
      }
      const changes: Array<{ target: string; data?: Buffer }> = [];
      for (const name of new Set([...originals.keys(), ...output.keys()])) {
        const data = output.get(name);
        if (data && hash(data) === originals.get(name)) continue;
        const target = requireWithin(name, task.directory);
        if (!allowed(target, 'write')) throw new Error('产物涉及无权修改的文件，拒绝回写');
        const current = existsSync(target) ? hash(readFileSync(target)) : undefined;
        if (current !== originals.get(name)) throw new Error('项目文件已被其他任务修改，拒绝覆盖；请重新执行');
        changes.push({ target, data });
      }
      // All paths and conflicts are checked before the first change; writes are individually atomic.
      for (const change of changes) {
        if (signal.aborted || !allowed(change.target, 'write')) throw new Error('任务已停止或权限已变更');
        if (!change.data) { const moved = moveToTrash(change.target, `${job}-${randomUUID()}`); if (!moved.ok) throw new Error(moved.error); }
        else {
          mkdirSync(dirname(change.target), { recursive: true });
          const temp = `${change.target}.${job}.tmp`;
          writeFileSync(temp, change.data); renameSync(temp, change.target);
        }
      }
      return `exit=0\n${result.stdout}${result.stderr}`.slice(0, 65536);
    } finally {
      // Never remove staging while a container could still be using it.
      if (created) await removeContainer();
      const verified = requireWithin(stage, stageRoot);
      if (verified === canonicalPath(stageRoot)) throw new Error('不能清理隔离根目录');
      rmSync(verified, { recursive: true, force: true });
    }
  };
}
