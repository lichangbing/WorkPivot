import { randomUUID } from 'node:crypto';
import type { Tool } from '@workpivot/core';
import type { ClarificationQuestion, InteractionOption } from '@workpivot/shared';

/**
 * R004/PC-03 结构化澄清：一次最多三个相关问题，保存为持久交互后结束本轮。
 * 澄清不是授权；权限仍由 run_permissions 单独处理。
 */
export interface AskUserBatch {
  interactionId: string;
  questions: ClarificationQuestion[];
}

const QUESTION_LIMIT = 200;
const LABEL_LIMIT = 60;
const DESCRIPTION_LIMIT = 240;
const PREVIEW_LIMIT = 2000;
const OPTION_MAX = 6;
const QUESTION_MAX = 3;

function fail(message: string): never {
  throw Error(message);
}

function parseOption(entry: unknown, questionIndex: number, optionIndex: number): InteractionOption {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) fail(`第 ${questionIndex + 1} 个问题的第 ${optionIndex + 1} 个选项格式无效`);
  const source = entry as Record<string, unknown>;
  const label = source['label'];
  if (typeof label !== 'string' || !label.trim()) fail(`第 ${questionIndex + 1} 个问题的第 ${optionIndex + 1} 个选项缺少 label`);
  if (label.trim().length > LABEL_LIMIT) fail(`选项 label 不能超过 ${LABEL_LIMIT} 字`);
  const description = source['description'];
  if (description !== undefined && (typeof description !== 'string' || description.length > DESCRIPTION_LIMIT)) fail(`选项 description 不能超过 ${DESCRIPTION_LIMIT} 字`);
  const preview = source['preview'];
  if (preview !== undefined && (typeof preview !== 'string' || preview.length > PREVIEW_LIMIT)) fail(`选项 preview 不能超过 ${PREVIEW_LIMIT} 字`);
  const recommended = source['recommended'];
  if (recommended !== undefined && typeof recommended !== 'boolean') fail('recommended 必须是布尔值');
  return {
    label: label.trim(),
    ...(description === undefined ? {} : { description: description.trim() }),
    ...(preview === undefined ? {} : { preview }),
    ...(recommended === true ? { recommended: true } : {}),
  };
}

function parseQuestion(raw: unknown, index: number): ClarificationQuestion {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail(`第 ${index + 1} 个问题格式无效`);
  const source = raw as Record<string, unknown>;
  const question = source['question'];
  if (typeof question !== 'string' || !question.trim()) fail('question 不能为空');
  if (question.trim().length > QUESTION_LIMIT) fail(`question 不能超过 ${QUESTION_LIMIT} 字`);
  const allowFreeText = source['allow_free_text'] === undefined ? true : source['allow_free_text'];
  if (typeof allowFreeText !== 'boolean') fail('allow_free_text 必须是布尔值');
  const multiSelect = source['multi_select'] === undefined ? false : source['multi_select'];
  if (typeof multiSelect !== 'boolean') fail('multi_select 必须是布尔值');
  const rawOptions = source['options'];
  if (rawOptions === undefined) {
    if (!allowFreeText) fail('没有选项时必须允许自由回答');
    return { id: randomUUID(), question: question.trim(), options: [], allowFreeText, multiSelect };
  }
  if (!Array.isArray(rawOptions)) fail('options 必须是数组');
  if (rawOptions.length < 2 || rawOptions.length > OPTION_MAX) fail(`options 需要 2-${OPTION_MAX} 项`);
  const options = rawOptions.map((entry, optionIndex) => parseOption(entry, index, optionIndex));
  if (new Set(options.map((option) => option.label)).size !== options.length) fail('同一问题的选项不能重复');
  if (options.filter((option) => option.recommended).length > 1) fail('同一问题最多一个推荐选项');
  return { id: randomUUID(), question: question.trim(), options, allowFreeText, multiSelect };
}

function parseQuestions(args: Record<string, unknown>): ClarificationQuestion[] {
  const raw = args['questions'];
  if (raw !== undefined) {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > QUESTION_MAX) fail(`questions 需要 1-${QUESTION_MAX} 项`);
    return raw.map(parseQuestion);
  }
  return [parseQuestion({
    question: args['question'],
    options: args['options'],
    allow_free_text: args['allow_free_text'],
    multi_select: args['multi_select'],
  }, 0)];
}

export interface AskUserOptions {
  emit: (batch: AskUserBatch) => void | Promise<void>;
}

export function askUserTool(options: AskUserOptions): Tool {
  let asked: AskUserBatch | undefined;
  return {
    name: 'ask_user',
    displayName: '向你确认需求',
    kind: 'read',
    endsTurn: true,
    description:
      '只在真正阻塞的用户专属歧义处提问，一次可问1至3个相关问题。问题应提供2至6个互斥选项，可标记推荐项和预览。' +
      `每题问题不超过 ${QUESTION_LIMIT} 字；支持单题多选和自由回答。` +
      '能从当前任务、资料、知识、记忆或业务事实查到的内容不得询问；不要确认权限、执行后果或已经明确的事情。' +
      '提问后本轮结束，回答会持久化并与 Web、桌面和手机同步。',
    parameters: {
      type: 'object',
      properties: {
        questions: {
          type: 'array',
          minItems: 1,
          maxItems: QUESTION_MAX,
          description: '相关的1至3个澄清问题；信息应一次收齐，避免连续多轮追问',
          items: {
            type: 'object',
            properties: {
              question: { type: 'string', description: `问题，不超过 ${QUESTION_LIMIT} 字` },
              options: {
                type: 'array', minItems: 2, maxItems: OPTION_MAX,
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', description: `选项文字，不超过 ${LABEL_LIMIT} 字` },
                    description: { type: 'string', description: `选项说明，不超过 ${DESCRIPTION_LIMIT} 字` },
                    recommended: { type: 'boolean', description: '是否为推荐项，每题最多一个' },
                    preview: { type: 'string', description: '可选的短预览，例如模板结构或示例' },
                  },
                  required: ['label'],
                  additionalProperties: false,
                },
              },
              allow_free_text: { type: 'boolean', description: '是否允许自由输入，默认 true' },
              multi_select: { type: 'boolean', description: '是否允许多选，默认 false' },
            },
            required: ['question'],
            additionalProperties: false,
          },
        },
        question: { type: 'string', description: '旧版单题字段；新调用优先使用 questions' },
        options: {
          type: 'array', minItems: 2, maxItems: OPTION_MAX,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string' },
              description: { type: 'string' },
              recommended: { type: 'boolean' },
              preview: { type: 'string' },
            },
            required: ['label'],
            additionalProperties: false,
          },
        },
        allow_free_text: { type: 'boolean', description: '旧版单题自由回答开关' },
        multi_select: { type: 'boolean', description: '旧版单题多选开关' },
      },
      oneOf: [{ required: ['questions'] }, { required: ['question'] }],
      additionalProperties: false,
    },
    async run(args) {
      if (!asked) {
        const questions = parseQuestions(args);
        asked = { interactionId: randomUUID(), questions };
        await options.emit(asked);
      }
      return JSON.stringify({ status: 'asked', ...asked });
    },
  };
}
