export const DEFAULT_SERVER_URL = 'http://127.0.0.1:39990';

export function normalizeServerUrl(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('请填写服务器地址');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('地址格式不正确，例如 http://192.168.1.158:39800'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('请输入 HTTP 或 HTTPS 服务器根地址，不包含账号、密码或其他路径');
  }
  return url.origin;
}
