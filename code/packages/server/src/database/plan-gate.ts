/**
 * 执行模式的授权闸门判定（O-16/O-17）。
 *
 * - 计划闸门：确认模式下，只读阶段不打扰；第一个写入/执行类动作前确认一次执行计划。
 * - 联网首次确认：本轮首次网络工具确认后，其余网络工具直接放行；外部 MCP 不受影响。
 */
import type { ToolAccessRequest } from '@workpivot/core';

/** 本轮共享一次确认的网络工具；MCP 等外部工具仍逐次确认。 */
export const NETWORK_TOOLS = ['web_fetch', 'web_search', 'browser_visit'] as const;

type GateTool = Pick<NonNullable<ToolAccessRequest>, 'effects' | 'kind'> | { effects?: readonly string[]; kind?: string };

/** 是否需要在执行该工具前询问一次计划。 */
export function needsPlanGate(tool: GateTool): boolean {
  if (tool.kind === 'write' || tool.kind === 'bash') return true;
  return (tool.effects ?? []).some((effect) => effect === 'write' || effect === 'execution');
}

/** 本次网络工具是否还需要弹卡：已在本轮批准过就不再问。 */
export function shouldAskNetwork(tool: string, approved: boolean): boolean {
  return (NETWORK_TOOLS as readonly string[]).includes(tool) && !approved;
}
