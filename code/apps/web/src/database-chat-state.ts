export interface StoredEvent { id: string; sequence: string; turnId: string; runId: string; kind: string; content: string; truncated: boolean; attachments?: { id: string; name: string | null; deleted?: boolean }[] }
export interface StoredTurn { id: string; sequence: string; events: StoredEvent[]; hasMoreEvents: boolean; nextEventSequence: string | null }
export interface ConversationPage { turns: StoredTurn[]; nextCursor: string | null; hasMore: boolean; snapshotSequence: string }
/** Durable IDs, not text equality, deduplicate overlap between history, catchup and retries. */
export function mergeEvents(old: StoredEvent[], added: StoredEvent[]): StoredEvent[] {
  const rows = new Map(old.map(e => [e.id, e]));
  for (const e of added) {
    const previous = rows.get(e.id);
    rows.set(e.id, previous && !previous.truncated && e.truncated ? previous : e);
  }
  return [...rows.values()].sort((a, b) => BigInt(a.sequence) < BigInt(b.sequence) ? -1 : BigInt(a.sequence) > BigInt(b.sequence) ? 1 : 0);
}
export function groupEvents(events: StoredEvent[]): Array<{ id: string; events: StoredEvent[] }> {
  const groups = new Map<string, StoredEvent[]>();
  for (const e of events) { const group = groups.get(e.turnId) ?? []; group.push(e); groups.set(e.turnId, group); }
  return [...groups].map(([id, rows]) => {
    const display: StoredEvent[] = [];
    for (const e of rows) {
      const last = display.at(-1);
      if (last && ['assistant', 'thinking'].includes(e.kind) && last.kind === e.kind && last.runId === e.runId && !last.truncated && !e.truncated) display[display.length - 1] = { ...last, content: last.content + e.content };
      else display.push(e);
    }
    return { id, events: display };
  });
}
