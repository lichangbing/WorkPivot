import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { resolveClientDirectory } from '../packages/server/src/client-directories.js';

if (process.platform === 'win32') throw new Error('Run in Linux service environment');
const root = mkdtempSync(join(tmpdir(), 'wp-directory-test-'));
try {
  const workspace = join(root, 'workspace');
  const mounted = join(workspace, 'local');
  mkdirSync(join(mounted, '子目录'), { recursive: true });
  const config = JSON.stringify([{ client: 'E:\\资料', server: mounted }]);
  assert.equal(resolveClientDirectory('e:\\资料\\子目录', workspace, config), join(mounted, '子目录'));
  assert.equal(resolveClientDirectory('E:\\资料', workspace, config), mounted);
  for (const input of ['E:\\资料外', 'E:\\资料\\..\\秘密', 'F:\\资料', '\\\\host\\share', 'E:\\资料\\file:stream']) {
    assert.throws(() => resolveClientDirectory(input, workspace, config));
  }
  assert.throws(() => resolveClientDirectory('E:\\资料', workspace, ''));
  assert.throws(() => resolveClientDirectory('E:\\资料', workspace, '{}'));
  assert.throws(() => resolveClientDirectory('E:\\资料\\不存在', workspace, config));
  const outside = join(root, 'outside'); mkdirSync(outside);
  symlinkSync(outside, join(mounted, 'escape'));
  assert.throws(() => resolveClientDirectory('E:\\资料\\escape', workspace, config));
  console.log('Client directory mapping: 11 checks passed');
} finally { rmSync(root, { recursive: true, force: true }); }
