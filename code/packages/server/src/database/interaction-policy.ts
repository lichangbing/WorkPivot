import type { InteractionRisk } from '@workpivot/shared';
import type { ToolAccessRequest } from '@workpivot/core';

const destructive = /(^|\s)(rm|rmdir|del|erase|remove-item|format|drop|truncate|revoke|purge)(\s|$)|删除|清空|永久|撤销|覆盖/i;
const external = /(send|publish|share|upload|submit|post|invite|transfer|发送|发布|共享|上传|提交|邀请|转账)/i;

/**
 * 服务端风险矩阵：模型只能描述意图，不能降低真实参数对应的风险等级。
 * run_permissions 仍负责逐调用绑定；此函数只决定展示、反馈和自动豁免资格。
 */
export function classifyInteractionRisk(
  request: Pick<ToolAccessRequest, 'tool' | 'kind' | 'command' | 'effects' | 'external' | 'binding'>,
): InteractionRisk {
  const tool = request.tool.toLowerCase();
  const binding = JSON.stringify(request.binding ?? {});
  const evidence = `${request.command ?? ''} ${binding}`;
  if (
    request.external ||
    (request.effects ?? []).includes('external') ||
    tool.startsWith('mcp__') ||
    tool.startsWith('browser_') && external.test(evidence) ||
    destructive.test(evidence) ||
    external.test(evidence)
  ) return 'high';
  if (request.kind !== 'read' || (request.effects ?? []).some((effect) => effect !== 'read')) return 'medium';
  return 'low';
}

/** 高风险操作没有会话级或永久豁免，必须逐次核对真实参数。 */
export function canRememberApproval(risk: InteractionRisk): boolean {
  return risk !== 'high';
}

/** 自动模式只静默执行白名单动作；高风险和显式确认仍必须经过用户。 */
export function canAutoApprove(request: ToolAccessRequest, mode: unknown, risk: InteractionRisk): boolean {
  if (process.env['WORKPIVOT_CODE_APPROVAL'] === 'confirm') return false;
  if (mode === 'manual' || risk === 'high') return false;
  if (request.tool === 'plan') return true;
  return request.auto === true && request.tool === 'run_code' && !request.paths.length;
}
