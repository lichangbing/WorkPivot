import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { restoreBackup, verifyBackup, type BackupManifest } from '../scripts/backup-lib.mjs';

// 备份包校验离线执行；真实创建与恢复的安全检查由 eval:backup-database 覆盖。
const root = await mkdtemp(join(tmpdir(), 'workpivot-backup-test-'));
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex');
try {
  const file = Buffer.from([0, 1, 2, 255]), dump = Buffer.from('synthetic-dump');
  await mkdir(join(root, 'files', 'owner'), { recursive: true });
  await writeFile(join(root, 'files', 'owner', 'artifact.bin'), file);
  await writeFile(join(root, 'database.dump'), dump);
  const manifest: BackupManifest = { format: 1, schemaVersion: 27, createdAt: new Date().toISOString(), database: { path: 'database.dump', bytes: dump.length, sha256: digest(dump) }, files: [{ path: 'owner/artifact.bin', bytes: file.length, sha256: digest(file) }], totals: { files: 1, bytes: file.length + dump.length } };
  const save = () => writeFile(join(root, 'manifest.json'), JSON.stringify(manifest));
  await save(); await verifyBackup(root);
  await writeFile(join(root, 'files', 'owner', 'artifact.bin'), 'tampered');
  await assert.rejects(verifyBackup(root), /校验失败/);
  await writeFile(join(root, 'files', 'owner', 'artifact.bin'), file);
  await symlink(join(root, 'database.dump'), join(root, 'files', 'link'));
  await assert.rejects(verifyBackup(root), /符号链接/);
  await rm(join(root, 'files', 'link'));
  await writeFile(join(root, 'unexpected'), 'extra');
  await assert.rejects(verifyBackup(root), /额外/);
  await rm(join(root, 'unexpected'));
  manifest.files.push(manifest.files[0]!); await save();
  await assert.rejects(verifyBackup(root), /重复/);
  manifest.files.pop(); await save();
  await rm(join(root, 'database.dump')); await symlink(join(root, 'files', 'owner', 'artifact.bin'), join(root, 'database.dump'));
  await assert.rejects(verifyBackup(root), /普通文件/);
  process.env.WORKPIVOT_RESTORE_OFFLINE = '1';
  await assert.rejects(restoreBackup({ backup: root, databaseUrl: 'postgresql://user:secret@localhost/workpivot', filesRoot: join(root, 'unsafe_restored') }), /数据库名称/);
  assert.ok(!(await readFile(join(root, 'manifest.json'), 'utf8')).includes('secret'));
  console.log('PASS archive validation: intact, tamper, symlinks, extras, duplicate paths, unsafe target');
} finally { await rm(root, { recursive: true, force: true }); }
