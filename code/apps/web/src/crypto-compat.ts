/**
 * `crypto.randomUUID()` 只在安全上下文（HTTPS 或 localhost）中可用。
 * 私有化部署常通过服务器 IP 的普通 HTTP 访问，此时浏览器会缺失该方法。
 *
 * `crypto.getRandomValues()` 不受安全上下文限制，用它生成同语义的 UUID v4。
 */
const webCrypto = globalThis.crypto;

if (webCrypto && typeof webCrypto.randomUUID !== 'function') {
  Object.defineProperty(webCrypto, 'randomUUID', {
    configurable: true,
    value: (): `${string}-${string}-${string}-${string}-${string}` => {
      const bytes = new Uint8Array(16);
      webCrypto.getRandomValues(bytes);
      bytes[6] = (bytes[6]! & 0x0f) | 0x40;
      bytes[8] = (bytes[8]! & 0x3f) | 0x80;
      const hex = Array.from(bytes, value => value.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    },
  });
}
