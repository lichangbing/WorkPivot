/** O-06：转写只保留参数摘要，避免 write/run_code 的大字段把 JSONL 撑大；完整参数仍保留在审批记录里。 */
export const TRANSCRIPT_ARG_LIMIT = 2000;

export function transcriptArgs(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    result[key] = typeof item === 'string' && item.length > TRANSCRIPT_ARG_LIMIT
      ? { truncated: true, length: item.length, head: item.slice(0, TRANSCRIPT_ARG_LIMIT) }
      : item;
  }
  return result;
}
