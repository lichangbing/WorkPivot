/** 只接受服务根地址，防止凭据通过重定向或错误路径发送到其他目标。 */
export function normalizeServerAddress(input: string, development = false): string {
  let url: URL;
  try { url = new URL(input.trim()); } catch { throw new Error('请输入完整的 HTTPS 服务器地址'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(development && loopback && url.protocol === 'http:')) throw new Error('服务器必须使用 HTTPS');
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error('请填写服务器根地址，不要包含账号、路径或查询参数');
  return url.origin;
}
