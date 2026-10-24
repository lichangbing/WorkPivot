import type {AgentEvent} from '@workpivot/core';
/** 静默执行的工具没有授权卡，代码必须留在对话记录里；其他工具仍只保留执行元数据。 */
const RUN_CODE_LIMIT=8000;
function runCodeArgs(args:unknown):Record<string,unknown>|undefined{
  if(!args||typeof args!=='object'||Array.isArray(args))return undefined;
  const source=args as Record<string,unknown>;
  const code=typeof source['code']==='string'?source['code']:'';
  return {language:source['language'],code:code.slice(0,RUN_CODE_LIMIT),codeTruncated:code.length>RUN_CODE_LIMIT,inputs:source['inputs'],outputs:source['outputs']};
}
/** 聊天工具事件仅保留执行元数据，完整参数由隔离的审批记录负责展示。 */
export function publicToolEvent(value:AgentEvent):AgentEvent {
  if(!['tool_use','tool_status','tool_result'].includes(value.type))return value;
  const result:AgentEvent={type:value.type,toolName:value.toolName,callId:value.callId,status:value.status,ok:value.ok,durationMs:value.durationMs};
  // 子代理事件带前缀，前端据此折叠；丢到这一层会让父子事件无法区分。
  if(value.delegateId!==undefined)result.delegateId=value.delegateId;
  if(value.type==='tool_use'&&value.toolName==='run_code')result.args=runCodeArgs(value.args);
  if(value.type==='tool_result'){
    result.message=value.ok?'工具执行完成；结果已交给模型。':'工具未完成，请查看审批状态或重新发起。';
    // 只传枚举化检索状态，不能为了降级提示再次复制资料正文。
    if(value.toolName==='search_project_documents'&&value.ok){
      try{const parsed=JSON.parse(value.message??'null');const mode=parsed?.data?.mode??parsed?.mode;if(['hybrid','keyword'].includes(mode))result.message=JSON.stringify({mode});}catch{/* 非结构结果不复制到事件。 */}
    }
  }
  return Object.assign(result,{redacted:true});
}
