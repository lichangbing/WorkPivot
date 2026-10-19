/** 模型窗口以 token 计量；字节限制只用于控制本地内存和请求体大小。 */
export const maxContextTokens = 2097152;
export const maxContextBytes = 16 * 1024 * 1024;
export const outputReserveTokens = 8192;
export const contextBytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), 'utf8');
/** 未接入供应商分词器时的启发式估算，含20%余量；不作为精确计费或容量保证。 */
export function estimateContextTokens(value: unknown): number {
 const text = JSON.stringify(value);
 let ascii = 0, otherBytes = 0;
 for (const char of text) {
  if (char.codePointAt(0)! < 128) ascii++;
  else otherBytes += Buffer.byteLength(char, 'utf8');
 }
 return Math.ceil((ascii / 3 + otherBytes / 2) * 1.2) + 16;
}
