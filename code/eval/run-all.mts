/**
 * T4-05/K01：评测统一入口——顺序跑全部冒烟套件，写基线记录。
 * 运行：pnpm eval
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
process.env['WORKPIVOT_INSECURE_SECRETS'] = '1';
process.env['WORKPIVOT_EXECUTION_MODE'] = 'trusted-local';
delete process.env['WORKPIVOT_SECRET_KEY'];

const suites: Array<[string, string]> = [
  ['W1', 'eval/W1-smoke.mts'],
  ['W3', 'eval/W3-smoke.mts'],
  ['W5', 'eval/W5-memory.mts'],
  ['W7', 'eval/W7-file.mts'],
  ['W8', 'eval/W8-anthropic.mts'],
  ['W10', 'eval/W10-schedule.mts'],
  ['W13', 'eval/W13-session.mts'],
  ['W16', 'eval/W16-client.mts'],
  ['W17', 'eval/W17-connection.mts'],
  ['W18', 'eval/W18-capabilities.mts'],
  ['W19', 'eval/W19-chat-content.mts'],
  ['W20', 'eval/W20-skills.mts'],
  ['W22', 'eval/W22-worker-client.mts'],
  ['W26', 'eval/W26-accounts.mts'],
  ['W27', 'eval/W27-sidebar.mts'],
  ['W28', 'eval/W28-task-workflow.mts'],
  ['W29', 'eval/W29-skill-management.mts'],
  ['W30', 'eval/W30-skill-packages.mts'],
  ['W31', 'eval/W31-mcp.mts'],
  ['W33', 'eval/W33-permissions.mts'],
  ['W34', 'eval/W34-attachments.mts'],
  ['W35', 'eval/W35-memory-layers.mts'],
  ['W36', 'eval/W36-deliverables.mts'],
  ['W37', 'eval/W37-password-reset.mts'],
  ['R005', 'eval/R005-delegate.mts'],
  ['R004', 'eval/R004-ask-user.mts'],
  ['OPT', 'eval/optimizations-p0.mts'],
  ['OPT2', 'eval/optimizations-p1.mts'],
  ['OPT3', 'eval/optimizations-p2.mts'],
  ['R001', 'eval/builtin-skills.mts'],
  ['OUT', 'eval/output-sanitize.mts'],
];
// 这些套件用于历史设计比较，不计入当前验收：
// 其前提是共享账号数据、管理员代执行及进程内命令执行。
// 替代覆盖见 eval/README.md；不得降低隔离要求。
if (process.env['WORKPIVOT_EVAL_LEGACY'] === '1') suites.push(
  ['legacy-W2', 'eval/W2-smoke.mts'], ['legacy-W4', 'eval/W4-smoke.mts'],
  ['legacy-W6', 'eval/W6-structure.mts'], ['legacy-W9', 'eval/W9-office.mts'],
  ['legacy-W11', 'eval/W11-authz.mts'], ['legacy-W12', 'eval/W12-boundary.mts'],
  ['legacy-W14', 'eval/W14-stability.mts'],
);

const results: Record<string, string> = {};
const assertions: Record<string, Array<{ name: string; pass: boolean }>> = {};
let failed = 0;
for (const [name, file] of suites) {
  console.log(`\n========== ${name} ==========`);
  const run = spawnSync(process.execPath, ['--import', 'tsx', file], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const output = (run.stdout ?? '') + (run.stderr ?? '');
  process.stdout.write(output);
  if (run.error) console.error(run.error);
  assertions[name] = output.split(/\r?\n/).flatMap((line) => {
    const match = /^(✅|❌) (.+)$/.exec(line);
    return match ? [{ name: match[2]!, pass: match[1] === '✅' }] : [];
  });
  const ok = run.status === 0 && assertions[name].length > 0 && assertions[name].every((a) => a.pass);
  results[name] = ok ? 'pass' : 'fail';
  if (!ok) failed += 1;
}

const baseline = {
  date: new Date().toISOString(),
  suites: results,
  assertions,
  assertionCount: Object.values(assertions).flat().length,
  overall: failed === 0 ? 'pass' : 'fail',
};
const baselinePath = process.env['WORKPIVOT_EVAL_BASELINE'] ?? 'eval/baseline.json';
writeFileSync(baselinePath, JSON.stringify(baseline, null, 2));
console.log(`\n===== 基线已写入 ${baselinePath}：${baseline.overall} =====`);
process.exit(failed > 0 ? 1 : 0);
