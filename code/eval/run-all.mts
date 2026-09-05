/**
 * T4-05/K01：评测统一入口——顺序跑全部冒烟套件，写基线记录。
 * 运行：pnpm eval
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const suites: Array<[string, string]> = [
  ['W1', 'eval/W1-smoke.mts'],
  ['W2', 'eval/W2-smoke.mts'],
  ['W3', 'eval/W3-smoke.mts'],
  ['W4', 'eval/W4-smoke.mts'],
];

const results: Record<string, string> = {};
let failed = 0;
for (const [name, file] of suites) {
  console.log(`\n========== ${name} ==========`);
  const run = spawnSync(process.execPath, ['--import', 'tsx', file], { stdio: 'inherit' });
  results[name] = run.status === 0 ? 'pass' : 'fail';
  if (run.status !== 0) failed += 1;
}

const baseline = {
  date: new Date().toISOString(),
  suites: results,
  overall: failed === 0 ? 'pass' : 'fail',
};
writeFileSync('eval/baseline.json', JSON.stringify(baseline, null, 2));
console.log(`\n===== 基线已写入 eval/baseline.json：${baseline.overall} =====`);
process.exit(failed > 0 ? 1 : 0);
