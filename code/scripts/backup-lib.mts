import { BackupError } from './backup-error.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { cp, lstat, mkdir, open, readFile, readdir, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { captureRetention, inspectDatabase, latestBackupSchema, reconcileRetention, reserveBackupSource, reserveEmptyDatabase, sanitizeRestoredDatabase } from './backup-database.mjs';

export const backupFormat = 1;
export type BackupEntry = { path: string; bytes: number; sha256: string };
export type BackupManifest = {
  format: number;
  createdAt: string;
  schemaVersion: number;
  database: BackupEntry;
  files: BackupEntry[];
  totals: { files: number; bytes: number };
};

const inside = (root: string, path: string) => path === root || path.startsWith(root + sep);

async function hashFile(path: string): Promise<BackupEntry> {
  const info = await lstat(path);
  if (!info.isFile()) throw new BackupError(`备份载荷不是普通文件：${path}`);
  const hash = createHash('sha256');
  await new Promise<void>((ok, fail) => {
    const stream = createReadStream(path);
    stream.on('data', chunk => hash.update(chunk));
    stream.on('error', fail);
    stream.on('end', ok);
  });
  return { path: '', bytes: info.size, sha256: hash.digest('hex') };
}

async function listPayload(root: string, current = root): Promise<BackupEntry[]> {
  const info = await lstat(current);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new BackupError('载荷目录不能是符号链接');
  const result: BackupEntry[] = [];
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) throw new BackupError(`文件存储包含符号链接，拒绝备份：${relative(root, path)}`);
    if (entry.isDirectory()) result.push(...await listPayload(root, path));
    else if (entry.isFile()) result.push({ ...await hashFile(path), path: relative(root, path).split(sep).join('/') });
    else throw new BackupError(`文件存储包含不支持的条目：${relative(root, path)}`);
  }
  return result.sort((a, b) => a.path.localeCompare(b.path));
}

function pgEnvironment(raw: string): { env: NodeJS.ProcessEnv; database: string } {
  const url = new URL(raw);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname.slice(1)) throw new BackupError('数据库地址无效');
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(decodeURIComponent(url.pathname.slice(1)))) throw new BackupError('数据库名称只支持字母、数字和下划线');
  const env = { ...process.env, PGHOST: url.hostname, PGPORT: url.port || '5432', PGUSER: decodeURIComponent(url.username), PGPASSWORD: decodeURIComponent(url.password), PGDATABASE: decodeURIComponent(url.pathname.slice(1)), PGSSLMODE: url.searchParams.get('sslmode') ?? process.env.PGSSLMODE };
  return { env, database: decodeURIComponent(url.pathname.slice(1)) };
}

async function dumpDatabase(url: string, target: string): Promise<void> {
  const { env } = pgEnvironment(url);
  await new Promise<void>((ok, fail) => {
    const child = spawn(process.env.WORKPIVOT_PG_DUMP ?? 'pg_dump', ['--format=custom', '--no-owner', `--file=${target}`], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', value => { error = (error + value).slice(-4000); });
    child.on('error', () => fail(new BackupError('无法启动 pg_dump，请检查 PostgreSQL 客户端安装')));
    child.on('close', code => code === 0 ? ok() : fail(new BackupError(`pg_dump 失败（${code ?? 'signal'}），请检查权限、客户端版本和数据库状态`)));
  });
}

async function restoreDatabase(url: string, source: string): Promise<void> {
  const { env } = pgEnvironment(url);
  await new Promise<void>((ok, fail) => {
    const child = spawn(process.env.WORKPIVOT_PG_RESTORE ?? 'pg_restore', ['--no-owner', '--single-transaction', '--exit-on-error', `--dbname=${env.PGDATABASE}`, source], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let error = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', value => { error = (error + value).slice(-4000); });
    child.on('error', () => fail(new BackupError('无法启动 pg_restore，请检查 PostgreSQL 客户端安装')));
    child.on('close', code => code === 0 ? ok() : fail(new BackupError(`pg_restore 失败（${code ?? 'signal'}），事务已回滚，请检查运行角色、客户端版本和转储兼容性`)));
  });
}

export async function createBackup(input: { target: string; databaseUrl: string; filesRoot: string; schemaVersion: number }): Promise<BackupManifest> {
  if (process.env.WORKPIVOT_BACKUP_OFFLINE !== '1') throw new BackupError('联合备份首版要求停止应用写入，并设置 WORKPIVOT_BACKUP_OFFLINE=1');
  const target = resolve(input.target), parent = dirname(target), staging = join(parent, `.${basename(target)}.partial-${randomUUID()}`);
  if (inside(resolve(input.filesRoot), target) || inside(target, resolve(input.filesRoot))) throw new BackupError('备份目录不能位于文件存储内，也不能包含文件存储');
  try { await lstat(target); throw new BackupError('目标备份目录已存在'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const sourcePath = await realpath(input.filesRoot), parentPath = await realpath(parent);
  if (inside(sourcePath, parentPath) || inside(join(parentPath, basename(target)), sourcePath)) throw new BackupError('备份目录不能通过链接嵌套文件存储');
  await mkdir(staging, { recursive: true, mode: 0o700 });
  let sourceLock: Awaited<ReturnType<typeof reserveBackupSource>> | undefined;
  try {
    const filesRoot = resolve(input.filesRoot);
    const rootInfo = await lstat(filesRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new BackupError('文件存储必须是非符号链接目录');
    sourceLock = await reserveBackupSource(input.databaseUrl);
    const state = await inspectDatabase(input.databaseUrl);
    if (state.schemaVersion !== input.schemaVersion) throw new BackupError('指定 schema 与实际数据库不一致');
    await dumpDatabase(input.databaseUrl, join(staging, 'database.dump'));
    await cp(filesRoot, join(staging, 'files'), { recursive: true, dereference: false, preserveTimestamps: true, errorOnExist: true, force: false });
    const database = { ...await hashFile(join(staging, 'database.dump')), path: 'database.dump' };
    const files = await listPayload(join(staging, 'files'));
    await inspectDatabase(input.databaseUrl, files);
    const manifest: BackupManifest = { format: backupFormat, createdAt: new Date().toISOString(), schemaVersion: input.schemaVersion, database, files, totals: { files: files.length, bytes: database.bytes + files.reduce((sum, item) => sum + item.bytes, 0) } };
    await writeFile(join(staging, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600, flag: 'wx', flush: true });
    const handle = await open(staging, 'r'); try { await handle.sync(); } finally { await handle.close(); }
    await sourceLock.assertAlive();
    await rename(staging, target);
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally { await sourceLock?.end(); }
}

export async function verifyBackup(path: string): Promise<BackupManifest> {
  const root = resolve(path), manifestPath = join(root, 'manifest.json');
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new BackupError('备份路径必须是非符号链接目录');
  if (!(await lstat(manifestPath)).isFile()) throw new BackupError('备份清单必须是普通文件');
  const rootNames = (await readdir(root)).sort().join(',');
  if (rootNames !== 'database.dump,files,manifest.json') throw new BackupError('备份根目录包含额外内容');
  const actualFiles = await listPayload(join(root, 'files'));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8')) as BackupManifest;
  if (manifest.format !== backupFormat || !Number.isSafeInteger(manifest.schemaVersion) || manifest.schemaVersion < 1 || !Array.isArray(manifest.files) || !manifest.database || !manifest.totals || !Number.isFinite(Date.parse(manifest.createdAt))) throw new BackupError('备份清单格式不兼容');
  if (manifest.database.path !== 'database.dump') throw new BackupError('数据库载荷路径无效');
  const names = new Set<string>();
  for (const entry of manifest.files) {
    if (typeof entry.path !== 'string' || !entry.path || entry.path.includes('\\') || entry.path.split('/').some(part => !part || part === '.' || part === '..') || names.has(entry.path)) throw new BackupError('备份清单路径重复或无效');
    names.add(entry.path);
  }
  const expected = [manifest.database, ...manifest.files.map(entry => ({ ...entry, path: `files/${entry.path}` }))];
  for (const entry of expected) {
    if (!entry.path || entry.path.startsWith('/') || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new BackupError('备份清单包含非法路径或哈希');
    const actualPath = resolve(root, entry.path);
    if (!inside(root, actualPath)) throw new BackupError('备份清单路径越界');
    const actual = await hashFile(actualPath);
    if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new BackupError(`备份校验失败：${entry.path}`);
  }
  if (actualFiles.length !== manifest.files.length || actualFiles.some((entry, index) => entry.path !== manifest.files[index]?.path)) throw new BackupError('备份文件清单与目录内容不一致');
  const bytes = manifest.database.bytes + manifest.files.reduce((sum, item) => sum + item.bytes, 0);
  if (manifest.totals.files !== manifest.files.length || manifest.totals.bytes !== bytes) throw new BackupError('备份汇总数据不一致');
  return manifest;
}

/** 只恢复到名称明确的空隔离目标，禁止覆盖正在使用的文件目录。 */
export async function restoreBackup(input: { backup: string; databaseUrl: string; filesRoot: string; beforeRestore?: { target: string; databaseUrl: string; filesRoot: string } }): Promise<BackupManifest> {
  if (process.env.WORKPIVOT_RESTORE_OFFLINE !== '1') throw new BackupError('恢复要求隔离环境，并设置 WORKPIVOT_RESTORE_OFFLINE=1');
  const database = decodeURIComponent(new URL(input.databaseUrl).pathname.slice(1));
  if (!/_restored$|_restore_test$/.test(database)) throw new BackupError('恢复数据库名称必须以 _restored 或 _restore_test 结尾');
  const target = resolve(input.filesRoot);
  if (!/_restored$|_restore_test$/.test(basename(target))) throw new BackupError('恢复文件目录名称必须以 _restored 或 _restore_test 结尾');
  try { await lstat(target); throw new BackupError('恢复文件目录必须不存在'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const manifest = await verifyBackup(input.backup);
  if (manifest.schemaVersion !== latestBackupSchema) throw new BackupError('备份 schema 与当前程序不匹配，请使用匹配版本恢复后再升级');
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const packagePath = await realpath(input.backup), parentPath = await realpath(dirname(target));
  if (inside(packagePath, parentPath) || inside(join(parentPath, basename(target)), packagePath)) throw new BackupError('恢复文件目录与备份目录不能互相包含');
  const staging = join(dirname(target), `.${basename(target)}.partial-${randomUUID()}`);
  const reservation = await reserveEmptyDatabase(input.databaseUrl);
  try {
    let inventory: Awaited<ReturnType<typeof captureRetention>> | undefined;
    if (input.beforeRestore) {
      await createBackup({ ...input.beforeRestore, schemaVersion: latestBackupSchema });
      await verifyBackup(input.beforeRestore.target);
      inventory = await captureRetention(input.beforeRestore.databaseUrl);
    }
    await cp(join(resolve(input.backup), 'files'), staging, { recursive: true, dereference: false, errorOnExist: true, force: false });
    await restoreDatabase(input.databaseUrl, join(resolve(input.backup), 'database.dump'));
    const restoredState = await inspectDatabase(input.databaseUrl, await listPayload(staging));
    await sanitizeRestoredDatabase(input.databaseUrl);
    if (inventory) await reconcileRetention(input.databaseUrl, staging, inventory, restoredState.appRole);
    await reservation.assertAlive();
    await rename(staging, target);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  } finally { await reservation.end(); }
  return manifest;
}
