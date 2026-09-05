/**
 * agent 编排内核（ADR-002：自研微内核）。
 * T1-04 循环 / T1-05 内置工具 / T1-06 OpenAI 兼容模型客户端。
 */

export const CORE_VERSION = '0.0.0';

export {
  runAgentLoop,
  type AgentEvent,
  type AgentEventType,
  type RunAgentOptions,
  type RunAgentResult,
  type StopReason,
} from './loop.js';
export { BUILTIN_TOOLS, lsTool, readTool, writeTool, type Tool, type ToolContext } from './tools.js';
export {
  createOpenAICompatibleClient,
  verifyProvider,
  type ChatMessage,
  type ModelClient,
  type ModelClientOptions,
  type StreamEvent,
  type ToolCall,
  type ToolSchema,
} from './model/openai.js';
