/** Deterministic preview only. The user reviews every entry before any write. */
export function splitMemoryEntries(text: string): string[] {
  const entries: string[] = [];
  let heading = '', current = '';
  const flush = () => { if (current.trim()) entries.push(current.trim()); current = ''; };
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    if (!line.trim()) { flush(); continue; }
    if (/^#{1,6}\s+/.test(line)) { flush(); heading = line.replace(/^#{1,6}\s+/, '').trim(); continue; }
    if (/^\s+\S/.test(line) && current) { current += '\n' + line; continue; }
    flush();
    const content = line.replace(/^(?:[-*+]\s+|\d+[.)、]\s*)/, '').trim();
    current = heading ? heading + '：' + content : content;
  }
  flush();
  return entries.length ? entries : [text.trim()];
}
