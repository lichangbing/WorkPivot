import { normalizeServerUrl, DEFAULT_SERVER_URL } from '../apps/desktop/src/server-address.js';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const results: boolean[] = [];
function assert(name: string, pass: boolean): void { results.push(pass); console.log(`${pass ? '✅' : '❌'} ${name}`); }
assert('客户端默认连接已配置的公网入口', DEFAULT_SERVER_URL === 'https://115-191-1-188.sslip.io:80');
assert('服务地址规范化', normalizeServerUrl(' https://Example.com:443/ ') === 'https://example.com');
for (const value of ['file:///etc/passwd', 'javascript:alert(1)', 'https://user:password@example.com', 'https://example.com/admin', 'https://example.com/?token=secret', 'https://example.com/#x', '', null]) {
  let rejected = false; try { normalizeServerUrl(value); } catch { rejected = true; }
  assert(`客户端拒绝非法服务地址 ${value === null ? 'null' : value.split(':')[0] || 'empty'}`, rejected);
}
// 检查实际发布包及源码导入，防止后端依赖进入客户端。
// 不依赖宿主 PATH 中的 pnpm：优先复用当前包管理器脚本，再回退 Corepack。
function buildDesktop() {
  const manager = process.env['npm_execpath'];
  const attempts = manager
    ? [process.execPath, [manager, '--filter', '@workpivot/desktop', 'build'] as string[]]
    : [];
  attempts.push(process.platform === 'win32' ? 'corepack.cmd' : 'corepack', ['pnpm', '--filter', '@workpivot/desktop', 'build']);
  let last = spawnSync(String(attempts[0]), attempts[1] as string[], { encoding: 'utf8' });
  if (last.status === null || last.status !== 0) {
    last = spawnSync(String(attempts[2]), attempts[3] as string[], { encoding: 'utf8' });
  }
  return last;
}
const built = buildDesktop();
assert('纯客户端可独立构建', built.status === 0);
if (built.status !== 0) console.error(built.stdout, built.stderr);
else {
  const main = readFileSync('apps/desktop/dist/main.js', 'utf8');
  assert('客户端包不包含后端及模型执行代码', !/createOpenAICompatibleClient|createAnthropicClient|runAgentLoop|registerFirstAdmin|startServer\(/.test(main));
  assert('客户端包不包含系统密钥解密', !main.includes('safeStorage'));
}
console.log(`W16 client: ${results.filter(Boolean).length}/${results.length}`);
process.exit(results.every(Boolean) ? 0 : 1);
