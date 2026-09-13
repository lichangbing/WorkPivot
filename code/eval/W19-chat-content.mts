import { appendContent, type ContentItem } from '../apps/web/src/chat-content.js';
import { readChatStream } from '../apps/web/src/chat-stream.js';
const results: boolean[] = [];
function assert(name: string, pass: boolean): void { results.push(pass); console.log(`${pass ? '✅' : '❌'} ${name}`); }
let items: ContentItem[] = [{ kind: 'user', text: '问题' }];
items = appendContent(items, 'thought', '思考内容');
items = appendContent(items, 'assistant', '最终');
items = appendContent(items, 'assistant', '回答');
assert('正文不会并入思考块', items.at(-2)?.kind === 'thought' && items.at(-2)?.text === '思考内容');
assert('连续正文增量合并', items.at(-1)?.kind === 'assistant' && items.at(-1)?.text === '最终回答');
items.push({ kind: 'tool', text: '工具结果' });
items = appendContent(items, 'assistant', '读取后的总结');
assert('工具之后创建独立正文', items.at(-2)?.text === '工具结果' && items.at(-1)?.kind === 'assistant');
const before = items;
items = appendContent(items, 'assistant', '');
assert('空增量不制造占位消息', before === items);
items = appendContent(items, 'thought', '第二轮思考');
items = appendContent(items, 'assistant', '第二轮正文');
assert('多轮思考和正文保持顺序', items.slice(-2).map((item) => item.kind).join(',') === 'thought,assistant');
const encoder = new TextEncoder();
const events = [{ type: 'reasoning_delta', text: '推理' }, { type: 'assistant_delta', text: '可见答复' }, { type: 'done', stopReason: 'completed', steps: 1 }];
let streamed: ContentItem[] = [];
await readChatStream(new ReadableStream({ start(controller) { for (const event of events) controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`)); controller.close(); } }), (event) => {
  if (event.type === 'assistant_delta' || event.type === 'reasoning_delta') streamed = appendContent(streamed, event.type === 'assistant_delta' ? 'assistant' : 'thought', event.text);
});
assert('真实SSE解析后正文独立可见', streamed.length === 2 && streamed[1]?.kind === 'assistant' && streamed[1].text === '可见答复');
console.log(`W19 chat content: ${results.filter(Boolean).length}/${results.length}`);
if (results.some((pass) => !pass)) process.exitCode = 1;
