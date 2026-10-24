import { randomUUID } from 'node:crypto';
import type { Tool } from '@workpivot/core';

/**
 * R004 结构化提问：需求不明确时用带选项的卡片澄清，而不是在正文里追问一句然后停下。
 *
 * 边界：
 * - 只用于澄清需求（选格式、选范围、选模板），不能替代授权确认——权限仍由 evaluateAccess 决定；
 * - 同一轮最多一个问题：重复调用直接返回同一 questionId，不重复弹卡；
 * - 工具返回后本轮结束（endsTurn），用户的选择作为下一条用户消息进入历史，带 `[回答提问 <id>]` 前缀；
 * - 因此不需要挂起状态机，也不会触发 onIdle 追问。
 */

export interface AskUserQuestion {
  questionId: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  allowFreeText: boolean;
}

const QUESTION_LIMIT = 200;
const LABEL_LIMIT = 40;
const DESCRIPTION_LIMIT = 120;
const OPTION_MAX = 6;

function fail(message: string): never {
  throw Error(message);
}

interface ParsedQuestion {
  question: string;
  options: AskUserQuestion['options'];
  allowFreeText: boolean;
}

function parseQuestion(args: Record<string, unknown>): ParsedQuestion {
  const raw = args['question'];
  if (typeof raw !== 'string' || raw.trim().length === 0) fail('question 不能为空');
  const question = raw.trim();
  if (question.length > QUESTION_LIMIT) fail(`question 不能超过 ${QUESTION_LIMIT} 字`);

  const allowFreeText = args['allow_free_text'] === undefined ? true : args['allow_free_text'];
  if (typeof allowFreeText !== 'boolean') fail('allow_free_text 必须是布尔值');

  const rawOptions = args['options'];
  if (rawOptions === undefined) return { question, options: [], allowFreeText };
  if (!Array.isArray(rawOptions)) fail('options 必须是数组');
  if (rawOptions.length < 2 || rawOptions.length > OPTION_MAX) fail(`options 需要 2-${OPTION_MAX} 项`);
  const options = rawOptions.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`第 ${index + 1} 个选项格式无效`);
    const source = entry as Record<string, unknown>;
    const label = source['label'];
    if (typeof label !== 'string' || label.trim().length === 0) fail(`第 ${index + 1} 个选项缺少 label`);
    if (label.trim().length > LABEL_LIMIT) fail(`选项 label 不能超过 ${LABEL_LIMIT} 字`);
    const description = source['description'];
    if (description !== undefined && (typeof description !== 'string' || description.length > DESCRIPTION_LIMIT)) fail(`选项 description 不能超过 ${DESCRIPTION_LIMIT} 字`);
    return description === undefined ? { label: label.trim() } : { label: label.trim(), description };
  });
  return { question, options, allowFreeText };
}

export interface AskUserOptions {
  /** 把问题写成可重放的对话事件；用户回答走普通发消息接口。 */
  emit: (question: AskUserQuestion) => void | Promise<void>;
}

export function askUserTool(options: AskUserOptions): Tool {
  /** 同一轮只保留一个问题；重复调用返回同一 id，不重复弹卡。 */
  let asked: AskUserQuestion | undefined;
  return {
    name: 'ask_user',
    displayName: '向你确认需求',
    kind: 'read',
    endsTurn: true,
    description:
      '当需求不明确（格式、范围、模板、口径）时，用带选项的卡片向用户确认，比在正文里追问更清楚。' +
      `question 不超过 ${QUESTION_LIMIT} 字；options 传 2-${OPTION_MAX} 个选项，省略表示自由回答；allow_free_text 默认 true。` +
      '一次只问一个问题，问完本轮立即结束，用户回答会作为下一条消息发来（带「[回答提问 编号]」前缀）。' +
      '只用于澄清需求，不能替代授权确认；不要用它确认权限、执行后果或已经明确的事情。',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: `要确认的问题，不超过 ${QUESTION_LIMIT} 字` },
        options: {
          type: 'array',
          minItems: 2,
          maxItems: OPTION_MAX,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: `选项文字，不超过 ${LABEL_LIMIT} 字` },
              description: { type: 'string', description: `选项补充说明，不超过 ${DESCRIPTION_LIMIT} 字` },
            },
            required: ['label'],
            additionalProperties: false,
          },
        },
        allow_free_text: { type: 'boolean', description: '是否允许自由输入，默认 true' },
      },
      required: ['question'],
      additionalProperties: false,
    },
    async run(args) {
      if (!asked) {
        const parsed = parseQuestion(args);
        asked = { questionId: randomUUID(), ...parsed };
        await options.emit(asked);
      }
      return JSON.stringify({ status: 'asked', ...asked });
    },
  };
}
