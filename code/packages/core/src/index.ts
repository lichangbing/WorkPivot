/**
 * agent 编排内核（ADR-002：自研微内核）。
 * T1-04 循环 / T1-05 内置工具 / T1-06 OpenAI 兼容模型客户端 / M1-06 Anthropic Messages 客户端。
 */

export const CORE_VERSION = '0.0.0';

export {
  runAgentLoop,
  MAX_STEPS_DEFAULT,
  MAX_DURATION_DEFAULT_MS,
  RESULT_STASH_THRESHOLD,
  type AgentEvent,
  type AgentEventType,
  type RunAgentOptions,
  type RunAgentResult,
  type StopReason,
} from './loop.js';
export { BUILTIN_TOOLS, lsTool, readTool, writeTool, bashTool, grepTool, findTool, type Tool, type ToolContext, type ToolAccessRequest } from './tools.js';
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
export { createAnthropicClient, verifyAnthropicProvider } from './model/anthropic.js';

