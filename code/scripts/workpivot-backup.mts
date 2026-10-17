import { BackupError } from './backup-error.mjs';
import { schemaUpgrades, schemaVersion } from '../packages/server/src/database/schema.js';
import { createBackup, restoreBackup, verifyBackup } from './backup-lib.mjs';

async function main() {
  const [command, path] = process.argv.slice(2);
  if (!path || !['create', 'verify', 'restore'].includes(command ?? '')) throw new BackupError('用法：pnpm backup:create <目录>、pnpm backup:verify <目录> 或 pnpm backup:restore <备份目录>');

  if (command === 'create') {
    const databaseUrl = process.env.WORKPIVOT_DATABASE_ADMIN_URL;
    const filesRoot = process.env.WORKPIVOT_DATABASE_FILES_ROOT;
    if (!databaseUrl || !filesRoot) throw new BackupError('创建备份需要 WORKPIVOT_DATABASE_ADMIN_URL 和 WORKPIVOT_DATABASE_FILES_ROOT');
    const manifest = await createBackup({ target: path, databaseUrl, filesRoot, schemaVersion: schemaUpgrades.at(-1)?.version ?? schemaVersion });
    console.log(`联合备份已创建：${manifest.totals.files} 个文件，${manifest.totals.bytes} 字节，schema v${manifest.schemaVersion}`);
  } else if (command === 'verify') {
    const manifest = await verifyBackup(path);
    console.log(`备份校验通过：${manifest.totals.files} 个文件，${manifest.totals.bytes} 字节，schema v${manifest.schemaVersion}`);
  } else {
    const databaseUrl = process.env.WORKPIVOT_DATABASE_ADMIN_URL;
    const filesRoot = process.env.WORKPIVOT_DATABASE_FILES_ROOT;
    if (!databaseUrl || !filesRoot) throw new BackupError('恢复需要隔离目标的 WORKPIVOT_DATABASE_ADMIN_URL 和 WORKPIVOT_DATABASE_FILES_ROOT');
    const currentDatabase = process.env.WORKPIVOT_RESTORE_CURRENT_DATABASE_URL;
    const currentFiles = process.env.WORKPIVOT_RESTORE_CURRENT_FILES_ROOT;
    const safetyTarget = process.env.WORKPIVOT_RESTORE_SAFETY_BACKUP;
    if (!currentDatabase || !currentFiles || !safetyTarget) throw new BackupError('恢复前须提供当前数据源及安全快照目录：WORKPIVOT_RESTORE_CURRENT_DATABASE_URL、WORKPIVOT_RESTORE_CURRENT_FILES_ROOT、WORKPIVOT_RESTORE_SAFETY_BACKUP');
    const manifest = await restoreBackup({ backup: path, databaseUrl, filesRoot, beforeRestore: { target: safetyTarget, databaseUrl: currentDatabase, filesRoot: currentFiles } });
    console.log(`隔离恢复已通过结构、权限、引用及安全状态校验；备份原含 ${manifest.totals.files} 个文件，schema v${manifest.schemaVersion}。遗忘规则可能清理部分旧文件，请核对业务后再切换服务。`);
  }

}

try { await main(); } catch (error) {
  console.error(error instanceof BackupError ? error.message : '备份或恢复未完成，请检查离线配置、数据库连接和文件权限；底层诊断未回显。');
  process.exitCode = 1;
}
