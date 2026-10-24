/**
 * 早停兜底：模型只回一段文本就结束时，判断它是不是“该动手却停了”。
 *
 * 两类触发：
 * 1) 用户请求本身是产出型任务（生成/整理/导出…），但整轮没有调用任何工具；
 * 2) 助手文本自己承诺了下一步动作（我将/接下来/先…再），却没有实际执行。
 * 纯咨询型问题（单句问号）不追问，避免多余的一轮。
 */

const ACTION_INTENT = /(生成|制作|做一份|做个|写一份|写一|整理|汇总|导出|转换|分析|统计|绘制|计算|提取|修改|更新|翻译|总结成|整理成|输出成|帮我做|帮我写|做张|做成)/;
const PROMISED_ACTION = /(接下来|下一步|我将|我会|先.{0,12}(再|然后)|正在|稍后|准备|马上)/;
const QUESTION_ONLY = /^[^。！!？?]{0,120}[？?]$/;

export const IDLE_NUDGE =
  '你还没有真正完成任务：不要只描述计划或征求确认，现在就用工具执行。完成后用一段话说明做了什么、产出了哪些真实文件（给出相对路径）。如果确实缺少用户才能提供的信息，请明确列出需要什么。';

export function continuationPrompt(userText: string, assistantText: string): string | null {
  const user = userText.trim();
  const assistant = assistantText.trim();
  const promised = PROMISED_ACTION.test(assistant) && assistant.length < 600;
  const actionable = ACTION_INTENT.test(user);
  if (!promised && !actionable) return null;
  if (!promised && QUESTION_ONLY.test(user)) return null;
  return IDLE_NUDGE;
}
