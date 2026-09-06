/**
 * M1 批次 1/E01：记忆工具组（remember / forget / promote_memory）。
 * - remember：静默写入条目区（E01 条目层）
 * - forget：删除匹配条目
 * - promote_memory：晋升写入手写区 MEMORY.md——须用户在对话内确认（确认卡）
 * 工具不声明 access()（记忆操作不经文件权限档位）；promote 的确认经 SSE 事件+决策路由完成。
 */
import { addEntry, removeEntries, writeHandbook } from './memory.js';
import type { Tool } from '@workpivot/core';
import { memoryEnabled, readHandbook } from './memory.js';

type Send = (payload: unknown) => void;

const confirmResolvers = new Map<string, (approve: boolean) => void>();

/** 渲染层的确认回填入口。 */
export function resolveMemoryConfirm(id: string, approve: boolean): boolean {
  const resolver = confirmResolvers.get(id);
  if (!resolver) return false;
  confirmResolvers.delete(id);
  resolver(approve);
  return true;
}

export function buildMemoryTools(userId: string, taskId: string, send: Send): Tool[] {
  const rememberTool: Tool = {
    name: 'remember',
    kind: 'read',
    description:
      '把用户明确要求记住的信息（偏好/事实/决定/约定）写入记忆。只记录用户明确说出或确认的内容；不要主动把无关信息写进来。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要记住的信息，一句话，主谓完整。例："用户最喜欢的颜色是蓝色"' },
      },
      required: ['content'],
    },
    async run(args) {
      if (!memoryEnabled()) return '记忆功能已关闭,本次不记录。';
      const content = String(args['content'] ?? '').trim();
      if (content === '') return '错误：content 必填';
      const id = addEntry(userId, content);
      return `已记住（条目 ${id}）。如需删除可用 forget。`;
    },
  };

  const forgetTool: Tool = {
    name: 'forget',
    kind: 'read',
    description: '删除记忆中匹配指定关键词的条目（用户要求忘掉某事时使用）。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '匹配关键词（子串匹配）' },
      },
      required: ['query'],
    },
    async run(args) {
      const query = String(args['query'] ?? '').trim();
      if (query === '') return '错误：query 必填';
      const removed = removeEntries(userId, query);
      return removed > 0 ? `已删除 ${removed} 条匹配的记忆。` : '没有匹配的记忆条目。';
    },
  };

  const promoteTool: Tool = {
    name: 'promote_memory',
    kind: 'read',
    description:
      '把重要信息晋升为长期记忆（写入用户手写区 MEMORY.md，长期注入）。必须先向用户说明要写什么并征得同意后才能调用；调用后会弹出确认卡，用户可拒绝。',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string', description: '要写入长期记忆的一句话' },
      },
      required: ['content'],
    },
    async run(args) {
      const content = String(args['content'] ?? '').trim();
      if (content === '') return '错误：content 必填';
      const id = `mc-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      send({ type: 'memory_confirm', id, content, taskId });
      const approve = await new Promise<boolean>((resolve) => confirmResolvers.set(id, resolve));
      if (!approve) return '用户拒绝写入长期记忆。不要重试同一条内容。';
      const existing = readHandbookSafe(userId);
      writeHandbook(userId, existing.trim() + (existing.trim() === '' ? '' : '\n') + `- ${content}`);
      return '已写入长期记忆（MEMORY.md）。';
    },
  };

  return [rememberTool, forgetTool, promoteTool];
}

function readHandbookSafe(userId: string): string {
  return readHandbook(userId);
}
