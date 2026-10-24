/**
 * O-14：执行输出清洗。
 *
 * 隔离执行器回来的是终端原始输出，可能带 ANSI 颜色码、控制字符，以及脚本自己打印的凭据。
 * 交回模型前统一去掉颜色码、保留换行与制表符，并对常见密钥形态做脱敏；
 * 同时按头尾保留裁剪，避免只留开头导致错误栈丢失（与 O-04 一致）。
 */

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-[已脱敏]'],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, 'gh-[已脱敏]'],
  [/((?:api[_-]?key|access[_-]?token|secret|password|passwd)\s*[=:]\s*)([^\s'"`&]{6,})/gi, '$1[已脱敏]'],
  [/(Bearer\s+)([A-Za-z0-9._~+/-]{12,})/gi, '$1[已脱敏]'],
  [/((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^:\s/@]+:)([^@\s]+)(@)/gi, '$1[已脱敏]$3'],
];

export function sanitizeOutput(text: string): string {
  let value = text.replace(ANSI, '').replace(CONTROL, '');
  for (const [pattern, replacement] of SECRET_PATTERNS) value = value.replace(pattern, replacement);
  return value;
}

/** 头尾保留裁剪：默认 2/3 开头 + 1/3 结尾，中间标注省略字节。 */
export function clipOutput(text: string, limit = 16000): string {
  if (text.length <= limit) return text;
  const headLength = Math.floor(limit * 0.66);
  const tailLength = limit - headLength;
  const omitted = text.length - headLength - tailLength;
  return `${text.slice(0, headLength)}\n…（中间省略约 ${omitted} 字符，输出共 ${text.length} 字符）…\n${text.slice(-tailLength)}`;
}
