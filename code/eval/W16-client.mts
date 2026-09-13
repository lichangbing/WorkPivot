import { normalizeServerUrl, DEFAULT_SERVER_URL } from '../apps/desktop/src/server-address.js';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const results: boolean[] = [];
function assert(name: string, pass: boolean): void { results.push(pass); console.log(`${pass ? '✅' : '❌'} ${name}`); }
assert('客户端默认连接本机WSL后台', DEFAULT_SERVER_URL === 'http://127.0.0.1:39880');
assert('服务地址规范化', normalizeServerUrl(' https://Example.com:443/ ') === 'https://example.com');
for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:password@example.com', 'https://example.com/admin', 'https://example.com/?token=secret', 'https://example.com/#x', '', null]) {
  let rejected = false; try { normalizeServerUrl(value); } catch { rejected = true; }
  assert(`客户端拒绝非法服务地址 ${value === null ? 'null' : value.split(':')[0] || 'empty'}`, rejected);
}
// Verify the shipped bundle, not just source imports. Backend dependencies must never reach the client.
const built = spawnSync(process.platform === 'win32' ? 'cmd.exe' : 'sh', process.platform === 'win32' ? ['/c', 'pnpm --filter @workpivot/desktop build'] : ['-c', 'pnpm --filter @workpivot/desktop build'], { encoding: 'utf8' });
assert('纯客户端可独立构建', built.status === 0);
if (built.status !== 0) console.error(built.stdout, built.stderr);
else {
  const main = readFileSync('apps/desktop/dist/main.js', 'utf8');
  assert('客户端包不包含后端及模型执行代码', !/createOpenAICompatibleClient|createAnthropicClient|runAgentLoop|registerFirstAdmin|startServer\(/.test(main));
  assert('客户端包不包含系统密钥解密', !main.includes('safeStorage'));
}
console.log(`W16 client: ${results.filter(Boolean).length}/${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
