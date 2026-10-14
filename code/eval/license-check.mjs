import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const script = fileURLToPath(new URL('../scripts/check-licenses.mjs', import.meta.url));
function check(packages, expected, text) {
  const root = mkdtempSync(join(tmpdir(), 'workpivot-license-test-'));
  try {
    for (const [name, manifest] of packages) {
      const dir = join(root, 'node_modules', '.pnpm', 'fixture', 'node_modules', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'package.json'), typeof manifest === 'string' ? manifest : JSON.stringify({ name, version: '1', ...manifest }));
    }
    const run = spawnSync(process.execPath, [script], { cwd: root, encoding: 'utf8' });
    assert.ifError(run.error);
    assert.equal(run.status, expected, run.stdout + run.stderr);
    assert.match(run.stdout + run.stderr, text);
  } finally {
    // Only remove the temporary directory created by this test invocation.
    rmSync(root, { recursive: true, force: true });
  }
}
check([], 1, /检查未完成/);
check([['plain', { license: 'MIT' }]], 0, /已扫描依赖 1 个/);
check([['@example/blocked', { license: 'AGPL-3.0-only' }]], 1, /违规.*@example\/blocked/);
check([['@example/allowed', { licenses: [{ type: 'Apache-2.0' }] }]], 0, /已扫描依赖 1 个/);
check([['plain', { license: 'MIT' }], ['broken', '{']], 1, /无法解析的清单 1 个/);
check([['unspecified', {}]], 0, /未声明许可，需人工核对/);
console.log('License checker: 6/6 scenarios passed');
