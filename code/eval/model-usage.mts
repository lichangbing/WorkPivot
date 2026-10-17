import assert from 'node:assert/strict';
import { createOpenAICompatibleClient, createAnthropicClient, runAgentLoop } from '../packages/core/src/index.js';
import type { StreamEvent } from '../packages/core/src/index.js';
let count=0;const check=(value:unknown,label:string)=>{assert.ok(value,label);console.log('通过：'+label);count++;};
const original=globalThis.fetch;let request:Record<string,unknown>={};
function serve(events:unknown[]){globalThis.fetch=async(_url,init)=>{request=JSON.parse(String(init?.body));return new Response(events.map(e=>'data: '+(typeof e==='string'?e:JSON.stringify(e))+'\n\n').join(''),{headers:{'content-type':'text/event-stream'}});};}
const config={providerId:'fixture',baseUrl:'https://example.invalid/v1',model:'fixture'};
const collect=async(client:ReturnType<typeof createOpenAICompatibleClient>)=>{const events:StreamEvent[]=[];for await(const e of client.streamChat([],[]))events.push(e);return events;};
try{
 serve([{choices:[{delta:{content:'完成'}}]},{choices:[],usage:{prompt_tokens:21,completion_tokens:7}},'[DONE]']);
 let events=await collect(createOpenAICompatibleClient(config));
 check((request.stream_options as {include_usage:boolean}).include_usage,'兼容协议请求末尾用量');
 check(events.some(e=>e.type==='usage'&&e.inputTokens===21&&e.outputTokens===7),'无choices的最终usage仍被读取');
 serve([{choices:[],usage:{prompt_tokens:-1,completion_tokens:NaN}},'[DONE]']);events=await collect(createOpenAICompatibleClient(config));check(!events.some(e=>e.type==='usage'),'非法usage不伪造精确值');
 serve([{type:'message_start',message:{usage:{input_tokens:10,cache_read_input_tokens:20,cache_creation_input_tokens:5,output_tokens:1}}},{type:'message_delta',usage:{output_tokens:8}},{type:'message_delta',usage:{output_tokens:12}},{type:'message_stop'}]);
 events=await collect(createAnthropicClient(config));const usage=events.filter(e=>e.type==='usage');
 check(usage.at(-1)?.inputTokens===35&&usage.at(-1)?.outputTokens===12,'Anthropic累计输出取快照，输入含独立缓存读写');
 serve([{choices:[{delta:{content:'完成'}}]},{usage:{prompt_tokens:10,completion_tokens:2}},'[DONE]']);
 const result=await runAgentLoop({client:createOpenAICompatibleClient(config),tools:[],taskDir:'.',system:'测试',messages:[{role:'user',content:'测试'}],filePolicy:()=>false});
 check(result.stopReason!=='error','新增usage事件不被误认为工具调用');
 console.log(`模型用量协议：${count}/${count}通过`);
}finally{globalThis.fetch=original;}
