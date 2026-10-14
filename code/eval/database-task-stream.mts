import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { RunRepository } from '../packages/server/src/database/runs.js';
import { readChatStream } from '../apps/web/src/chat-stream.js';

export async function testTaskStream(base:string,token:string,foreign:string,actor:string,task:string,runs:RunRepository,check:(value:unknown,name:string)=>void){
 const streams:AbortController[]=[];
 const connect=async(after='0')=>{
  const controller=new AbortController();streams.push(controller);
  const response=await fetch(`${base}/api/tasks/${task}/stream?after=${after}`,{headers:{Authorization:`Bearer ${token}`},signal:controller.signal});
  assert.equal(response.status,200);
  const events:Array<{type:string;events?:Array<{id:string;sequence:string;content:string}>;nextSequence?:string;value?:{pending:Array<{id:string}>}}> = [];
  void readChatStream< typeof events[number]>(response.body!,event=>events.push(event),controller.signal).catch(()=>undefined);
  return {events,controller};
 };
 const wait=async(predicate:()=>boolean)=>{for(let i=0;i<150;i++){if(predicate())return;await new Promise(r=>setTimeout(r,20));}throw Error('SSE did not deliver within 3 seconds');};
 try{
  check((await fetch(`${base}/api/tasks/${task}/stream`,{headers:{Authorization:`Bearer ${foreign}`}})).status===404,'SSE denies another user before streaming');
  check((await fetch(`${base}/api/tasks/${task}/stream?after=-1`,{headers:{Authorization:`Bearer ${token}`}})).status===400,'SSE rejects invalid replay cursor');
  const a=await connect(),b=await connect();
  await wait(()=>a.events.some(e=>e.type==='state')&&b.events.some(e=>e.type==='state'));
  const run=await runs.start(actor,task,randomUUID(),'SSE multi-device question');
  await wait(()=>[a,b].every(s=>s.events.some(e=>e.events?.some(v=>v.content==='SSE multi-device question'))));
  check(true,'two task subscribers receive committed event before heartbeat fallback');
  const cursor=b.events.filter(e=>e.type==='changes').at(-1)!.nextSequence!;b.controller.abort();
  const permission=await runs.requestPermission(actor,run,{tool:'fixture',command:'SSE approval',external:true,paths:[],kind:'write'});
  await wait(()=>a.events.some(e=>e.value?.pending.some(p=>p.id===permission.id)));
  const resumed=await connect(cursor);
  await wait(()=>resumed.events.some(e=>e.value?.pending.some(p=>p.id===permission.id)));
  check(resumed.events.flatMap(e=>e.events??[]).every(e=>BigInt(e.sequence)>BigInt(cursor)),'reconnected subscriber replays only events after its cursor and receives pending approval');
  await Promise.all([runs.decidePermission(actor,task,permission.id,'allow'),runs.decidePermission(actor,task,permission.id,'allow')]);
  await wait(()=>[a,resumed].every(s=>s.events.filter(e=>e.type==='state').at(-1)?.value?.pending.length===0));
  check(await runs.consumePermission(actor,run,permission.id)==='allow'&&await runs.consumePermission(actor,run,permission.id)==='deny','multi-device approval is consumed once');
  await runs.finish(actor,run,'completed',[]);
  check(true,'approval resolution propagates to every subscribed device');
 }finally{for(const c of streams)c.abort();}
}
