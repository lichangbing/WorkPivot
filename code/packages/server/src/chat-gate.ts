/**
 * T3-03/F02：成果核验闸门。
 * 收尾文本若声称"已生成/已写入"某文件，则逐一校验其在任务目录中真实存在且非空；
 * 缺失清单返回给循环打回重做（最多 2 次，由调用方控制）。
 *
 * O-09：同时校验"本轮是否登记交付"——文件存在但没有调用 deliver_files 时，
 * 用户下载不到，按未完成处理；扩展名白名单也补齐图片、压缩包与邮件等常见成果。
 */
import { existsSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const CLAIM_KEYWORDS = /(已生成|已创建|已产出|已写入|已保存|已导出)/;

const EXTENSIONS = 'md|txt|docx|xlsx|pptx|pdf|html?|json|csv|log|png|jpe?g|svg|zip|tar|gz|eml';
/** 版本化产物名（含空格）："方案 v1.0 2026-09-05.md" */
const VERSIONED_FILE = new RegExp(`[^\\s\`'"<>|]+? v\\d+\\.\\d+(?: \\d{4}-\\d{2}-\\d{2})?\\.(?:${EXTENSIONS})`, 'g');
/** 普通文件名（无空格） */
const PLAIN_FILE = new RegExp(`[\\w\\u4e00-\\u9fa5][\\w\\u4e00-\\u9fa5\\-/\\\\]*\\.(?:${EXTENSIONS})`, 'g');

export interface GateResult {
  /** 声称产出但磁盘上不存在或为空的文件。 */
  missing: string[];
  /** 存在但本轮没有登记交付的文件：用户拿不到，需要提示补登记。 */
  undelivered: string[];
}

export interface GateOptions {
  /** 本轮 deliver_files 收到的相对路径；提供时才检查交付登记。 */
  delivered?: ReadonlySet<string>;
}

/** 声明里常把动词粘在文件名前（"已生成报告 v1.0 ..."），匹配前先剥掉。 */
function stripVerb(token: string): string {
  return token.replace(/^(已生成|已创建|已产出|已写入|已保存|已导出)/, '').trim();
}

export function verifyClaimedFiles(finalText: string, taskDir: string, options: GateOptions = {}): GateResult {
  if (!CLAIM_KEYWORDS.test(finalText)) return { missing: [], undelivered: [] };

  const raw = new Set<string>();
  for (const match of finalText.matchAll(VERSIONED_FILE)) raw.add(match[0].trim());
  for (const match of finalText.matchAll(PLAIN_FILE)) raw.add(match[0].trim());
  // 去掉动词前缀，并丢弃被更长声明包含的片段（"2026-10-24.docx" 只是版本名的一部分）。
  const cleaned = new Set([...raw].map(stripVerb).filter(Boolean));
  const claimed = new Set([...cleaned].filter((token) => ![...cleaned].some((other) => other !== token && other.length > token.length && other.endsWith(token))));

  const missing: string[] = [];
  const undelivered: string[] = [];
  for (const token of claimed) {
    const candidates = [join(taskDir, token.replace(/^[\\/]+/, '')), join(taskDir, token)];
    const found = candidates.find((abs) => {
      try {
        return existsSync(abs) && statSync(abs).size > 0;
      } catch {
        return false;
      }
    });
    if (!found) { missing.push(token); continue; }
    if (options.delivered && !options.delivered.has(token) && !options.delivered.has(basename(found))) undelivered.push(token);
  }
  return { missing, undelivered };
}
