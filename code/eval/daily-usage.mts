import assert from 'node:assert/strict';
import {dailyUsage} from '../apps/web/src/usage-days.js';
const row={day:'2024-02-29',requests:1,inputTokens:'9007199254740993',outputTokens:'7',estimated:1,unfinished:0};
const days=dailyUsage('2024-02',[row,{...row,inputTokens:'2',estimated:0}], '2024-03-01');
assert.equal(days.length,29);assert.equal(days[0]?.inputTokens,'9007199254740995');assert.equal(days[0]?.requests,2);assert.equal(days[0]?.estimated,1);assert.equal(days[1]?.requests,0);
assert.equal(dailyUsage('2026-10',[],'2026-10-19').length,19);
assert.equal(dailyUsage('2026-11',[],'2026-10-19').length,0);
assert.equal(dailyUsage('2026-99',[],'2026-10-19').length,0);
console.log('每日用量：跨币种合并、整数精度、闰月、零用量日期与未来日期边界通过');
