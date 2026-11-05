import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  parseClientUpdateEnvelope,
  parseClientUpdateManifest,
  selectClientUpdate,
  type ClientUpdateManifest,
} from '../packages/shared/src/client-update.js';
import { updateCheckDelay } from '../apps/mobile/src/updater.js';
import { loadClientUpdates } from '../packages/server/src/client-updates.js';

const valid: ClientUpdateManifest = {
  channel: 'beta', platform: 'android', version: '1.11', build: 12, minimumBuild: 9,
  downloadUrl: 'https://example.com/WorkPivot-android-1.11.apk',
  sha256: 'a'.repeat(64), packageName: 'com.workpivot.mobile', signerSha256: 'b'.repeat(64),
  minimumApiProtocol: 1, maximumApiProtocol: 1,
  releaseNotesUrl: 'https://example.com/releases/1.11', publishedAt: '2026-11-05T00:00:00.000Z',
};
let passed = 0;
const check = async (name: string, run: () => Promise<void> | void) => { await run(); passed++; console.log(`✅ ${name}`); };

await check('合法 Android 更新清单通过', () => assert.deepEqual(parseClientUpdateManifest(valid), valid));
await check('拒绝非 HTTPS 下载地址', () => assert.throws(() => parseClientUpdateManifest({ ...valid, downloadUrl: 'http://example.com/app.apk' })));
await check('拒绝降级和无效版本', () => assert.throws(() => parseClientUpdateManifest({ ...valid, build: 8, minimumBuild: 9 })));
await check('拒绝错误 SHA-256', () => assert.throws(() => parseClientUpdateManifest({ ...valid, sha256: 'x' })));
await check('Android 缺少包名或签名被拒绝', () => assert.throws(() => parseClientUpdateManifest({ ...valid, signerSha256: undefined })));
await check('只选择更高且协议兼容的版本', () => {
  const envelope = parseClientUpdateEnvelope({ updates: [valid, { ...valid, build: 10, version: '1.9' }] });
  assert.equal(selectClientUpdate(envelope, { platform: 'android', channel: 'beta', build: 9, apiProtocol: 1 })?.build, 12);
  assert.equal(selectClientUpdate(envelope, { platform: 'android', channel: 'beta', build: 12, apiProtocol: 1 }), null);
  assert.equal(selectClientUpdate(envelope, { platform: 'android', channel: 'beta', build: 8, apiProtocol: 1 }), null);
  assert.equal(selectClientUpdate(envelope, { platform: 'android', channel: 'stable', build: 9, apiProtocol: 1 }), null);
});
await check('更新检查间隔为 6～10 小时', () => {
  assert.equal(updateCheckDelay(() => 0), 6 * 60 * 60 * 1000);
  const upper = updateCheckDelay(() => 0.999999);
  assert(upper >= 10 * 60 * 60 * 1000 - 1_000 && upper < 10 * 60 * 60 * 1000);
});
await check('服务端只发布已到期清单并支持关闭', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'wp-update-'));
  const path = join(directory, 'updates.json');
  try {
    await writeFile(path, JSON.stringify({ updates: [valid, { ...valid, build: 13, version: '1.12', publishedAt: '2099-01-01T00:00:00.000Z' }] }));
    process.env['WORKPIVOT_UPDATE_MANIFEST'] = path;
    delete process.env['WORKPIVOT_UPDATE_ENABLED'];
    const loaded = await loadClientUpdates(new Date('2026-11-06T00:00:00.000Z'));
    assert.deepEqual(loaded.updates.map(update => update.build), [12]);
    process.env['WORKPIVOT_UPDATE_ENABLED'] = '0';
    assert.deepEqual((await loadClientUpdates()).updates, []);
  } finally {
    delete process.env['WORKPIVOT_UPDATE_MANIFEST'];
    delete process.env['WORKPIVOT_UPDATE_ENABLED'];
    await rm(directory, { recursive: true, force: true });
  }
});
console.log(`Client update: ${passed}/${passed}`);
