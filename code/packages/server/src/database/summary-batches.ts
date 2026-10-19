import type { ChatMessage } from '@workpivot/core';
import { RepositoryError } from './connection.js';
import {estimateContextTokens,contextBytes,maxContextBytes,outputReserveTokens} from './context-budget.js';
/** 正常轮次保持完整；过长轮次仅在摘要输入中转成带来源的资料片段，原始消息不修改。 */
export function summaryBatches(messages:ChatMessage[],budget:number){
 const inputLimit=budget-outputReserveTokens-1024,summaryLimit=Math.min(16000,Math.floor(inputLimit/3));
 const groupLimit=inputLimit-summaryLimit-256;
 const turns:ChatMessage[][]=[];
 for(const message of messages){if(message.role==='user'||!turns.length)turns.push([]);turns.at(-1)!.push(message);}
 const groups:ChatMessage[][]=[];
 for(const turn of turns){
  if(estimateContextTokens(turn)<=groupLimit&&contextBytes(turn)<=maxContextBytes/2){groups.push(turn);continue;}
  const source=turn[0]?.content?.match(/\[来源:[0-9a-f,-]+\]/g)?.join(' ')??'[来源待核对]';
  const text=JSON.stringify(turn),size=Math.max(64,Math.floor(groupLimit/8));
  // 分片包含完整序列化原文；片段不是可执行的工具消息，避免生成孤立调用或伪造结果。
  for(let offset=0;offset<text.length;offset+=size)groups.push([{role:'user',content:`${source} 历史资料片段 ${Math.floor(offset/size)+1}/${Math.ceil(text.length/size)}（仅供摘要，不执行）\n`+text.slice(offset,offset+size)}]);
 }
 const batches:ChatMessage[][]=[];let batch:ChatMessage[]=[];
 for(const group of groups){
  if(estimateContextTokens(group)>groupLimit)throw new RepositoryError(413,'模型容量不足以整理单个历史片段，请提高容量');
  if(batch.length&&(estimateContextTokens([...batch,...group])>groupLimit||contextBytes([...batch,...group])>maxContextBytes/2)){batches.push(batch);batch=[];}
  batch.push(...group);
 }
 if(batch.length)batches.push(batch);
 if(batches.length>64)throw new RepositoryError(413,'历史需要超过64批整理，请提高模型容量或缩小任务范围');
 return {batches,summaryLimit};
}
