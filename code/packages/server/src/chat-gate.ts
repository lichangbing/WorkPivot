/**
 * T3-03/F02：成果核验闸门。
 * 收尾文本若声称"已生成/已写入"某文件，则逐一校验其在任务目录中真实存在且非空；
 * 缺失清单返回给循环打回重做（最多 2 次，由调用方控制）。
 */
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

const CLAIM_KEYWORDS = /(已生成|已创建|已产出|已写入|已保存|已导出)/;

/** 版本化产物名（含空格）："方案 v1.0 2026-09-05.md" */
const VERSIONED_FILE =
  /[^\s`'"<>|]+? v\d+\.\d+(?: \d{4}-\d{2}-\d{2})?\.(?:md|txt|docx|xlsx|pptx|pdf|html?|json|csv)/g;
/** 普通文件名（无空格） */
const PLAIN_FILE =
  /[\w\u4e00-\u9fa5][\w\u4e00-\u9fa5\-/\\]*\.(?:md|txt|docx|xlsx|pptx|pdf|html?|json|csv|log)/g;

export interface GateResult {
  missing: string[];
}

export function verifyClaimedFiles(finalText: string, taskDir: string): GateResult {
  if (!CLAIM_KEYWORDS.test(finalText)) return { missing: [] };

  const claimed = new Set<string>();
  for (const match of finalText.matchAll(VERSIONED_FILE)) claimed.add(match[0].trim());
  for (const match of finalText.matchAll(PLAIN_FILE)) claimed.add(match[0].trim());

  const missing: string[] = [];
  for (const token of claimed) {
    const candidates = [join(taskDir, token.replace(/^[\\/]+/, '')), join(taskDir, token)];
    const exists = candidates.some((abs) => {
      try {
        return existsSync(abs) && statSync(abs).size > 0;
      } catch {
        return false;
      }
    });
    if (!exists) missing.push(token);
  }
  return { missing };
}
