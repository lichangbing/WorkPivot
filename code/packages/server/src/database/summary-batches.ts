import type { ChatMessage } from '@workpivot/core';
import { RepositoryError } from './connection.js';
const bytes=(value:unknown)=>Buffer.byteLength(JSON.stringify(value),'utf8');
/** Keep a full user turn and all its paired tool messages together. */
export function summaryBatches(messages:ChatMessage[],budget:number){
 const inputLimit=budget-8192-1024,summaryLimit=Math.min(16000,Math.floor(inputLimit/3));
 const groupLimit=inputLimit-summaryLimit-256;
 const turns:ChatMessage[][]=[];
 for(const message of messages){if(message.role==='user'||!turns.length)turns.push([]);turns.at(-1)!.push(message);}
 const batches:ChatMessage[][]=[];let batch:ChatMessage[]=[];
 for(const turn of turns){
  if(bytes(turn)>groupLimit)throw new RepositoryError(413,'单轮历史超过整理预算，无法保持完整轮次进行压缩；请提高模型容量或新建任务');
  if(batch.length&&bytes([...batch,...turn])>groupLimit){batches.push(batch);batch=[];}
  batch.push(...turn);
 }
 if(batch.length)batches.push(batch);
 if(batches.length>64)throw new RepositoryError(413,'历史需要超过64批整理，请提高模型容量或新建任务');
 return {batches,summaryLimit};
}
