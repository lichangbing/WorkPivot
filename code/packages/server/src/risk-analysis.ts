/**
 * R002：授权卡 AI 风险解读。
 * 高危/界外授权卡弹出后，异步调一次同供应商模型的短分析（意图/影响面/风险建议），
 * 以 risk_analysis SSE 事件回填卡片折叠区。
 * 纪律：分析是参考信息，不参与权限判定；失败/超时静默降级（卡片不受影响）；不输出文件内容。
 */
import { createAnthropicClient, createOpenAICompatibleClient, type ModelClient } from '@workpivot/core';
import { createFileTagLogger } from '@workpivot/shared/node';
import { resolveActiveProvider } from './providers.js';

const logger = createFileTagLogger('RISK');

export interface RiskQuestion {
  id: string;
  tool: string;
  kind: string;
  command?: string;
  paths: Array<{ path: string; mode: string }>;
  reason?: string;
  /** 触发授权的当轮用户消息（意图上下文） */
  userContext?: string;
}

const SYSTEM_PROMPT =
  '你是 WorkPivot 的安全风险分析助手。针对一次工具授权请求，用不超过 120 字的中文说明：' +
  '①结合最近用户消息说明模型为什么发起该操作；②影响面（读/写/删了什么、是否可逆）；' +
  '③最坏风险与一句建议。只谈路径与命令，禁止输出任何文件内容。如实评估，不确定就明说。';

/** 整体软截止：超过即放弃（卡片降级为无解读，不阻塞用户确认）。 */
const ANALYSIS_BUDGET_MS = 20_000;

function activeClient(): ModelClient {
  const cfg = resolveActiveProvider();
  return cfg.protocol === 'anthropic' ? createAnthropicClient(cfg) : createOpenAICompatibleClient(cfg);
}

/** 生成风险解读；任何失败返回空串（调用方跳过回填，卡片照常工作）。 */
export async function analyzeRisk(q: RiskQuestion): Promise<string> {
  try {
    const c = activeClient();
    const user =
      `【最近用户消息】\n${(q.userContext ?? '（无）').slice(0, 500)}\n` +
      `【授权请求】\n${JSON.stringify({ tool: q.tool, kind: q.kind, command: q.command, paths: q.paths, reason: q.reason })}`;
    let text = '';
    const deadline = Date.now() + ANALYSIS_BUDGET_MS;
    for await (const ev of c.streamChat(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
      [],
    )) {
      if (ev.type === 'delta') text += ev.text;
      if (Date.now() > deadline) break;
    }
    logger.info(`解读生成 ${text.trim().length} 字`);
    return text.trim().slice(0, 600);
  } catch (err) {
    logger.error(`解读失败：${err instanceof Error ? err.message : String(err)}`);
    return '';
  }
}
