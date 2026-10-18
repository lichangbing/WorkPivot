import {sourceResult} from './tool-policy.js';
import {AsyncLocalStorage} from 'node:async_hooks';
import {toolValidator} from './tool-schema.js';
import {createHash,randomUUID} from 'node:crypto';
import type {Tool,ToolAccessRequest} from '@workpivot/core';
/** 对象键顺序不影响摘要，数组顺序及所有参数值均参与绑定。 */
export function canonical(value:unknown):string {
  let nodes=0;
  const encode=(item:unknown,depth:number):string=>{
    if(depth>64||++nodes>100000)throw Error('授权参数过深或节点过多');
    if(item===null||typeof item==='string'||typeof item==='boolean')return JSON.stringify(item);
    if(typeof item==='number'&&Number.isFinite(item))return JSON.stringify(item);
    if(Array.isArray(item))return '['+item.map(v=>encode(v,depth+1)).join(',')+']';
    if(item&&typeof item==='object')return '{'+Object.keys(item).sort().map(k=>JSON.stringify(k)+':'+encode((item as Record<string,unknown>)[k],depth+1)).join(',')+'}';
    throw Error('授权参数必须是有效JSON');
  };
  return encode(value,0);
}
function freeze(value:unknown):void {
  if(value&&typeof value==='object'){for(const item of Object.values(value))freeze(item);Object.freeze(value);}
}
export const authorizationDigest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');
interface InvocationContext {tool:string;invocation:NonNullable<ToolAccessRequest['invocation']>;active:boolean}
const invocationContext=new AsyncLocalStorage<InvocationContext>();
/** 服务层只信任当前包装器建立的调用上下文，不接受模型参数提供调用身份。 */
export function currentInvocation(expected:string[]) {
  const value=invocationContext.getStore();
  if(!value?.active||!expected.includes(value.tool))throw Error('业务操作缺少匹配的工具调用授权');
  return value;
}
/** 在真实执行入口申请许可，直接调用包装后的run也不能跳过审批。 */
export function authorizeTools(tools:Tool[],check?:(tool:Tool,args:Record<string,unknown>)=>Promise<void>,published?:(tool:Tool,result:string)=>Promise<void>):Tool[] {
  return tools.map(tool=>{
    const validate=toolValidator(tool.parameters);
    const definition=authorizationDigest({name:tool.name,kind:tool.kind,parameters:tool.parameters,effects:tool.effects??[],resultSource:tool.resultSource??null});
    return {...tool,access:undefined,run:async(args,ctx)=>{
      ctx.signal?.throwIfAborted();
      // 固定本次参数，等待用户期间外部对象变化不能改变实际执行内容。
      const parameters=JSON.parse(canonical(args)) as Record<string,unknown>;
      validate(parameters);freeze(parameters);
      await check?.(tool,parameters);
      const invocation={id:randomUUID(),definition,arguments:parameters,digest:authorizationDigest(parameters)};
      const decisions=new Map<string,boolean>();
      const approve=async(request:ToolAccessRequest)=>{
        if(request.tool!==tool.name)throw Error('授权工具与实际调用不一致');
        const key=authorizationDigest(request);
        if(decisions.has(key))return decisions.get(key)!;
        const decision=await ctx.requestAccess?.({...request,...(tool.effects?{effects:tool.effects}:{}),invocation})??false;
        if(decision){ctx.signal?.throwIfAborted();await check?.(tool,parameters);}
        decisions.set(key,decision);return decision;
      };
      // 同一调用的入口与连接层使用相同请求时复用决定，不跨调用复用。
      if(tool.kind!=='read'||tool.access){
        const declared=tool.access?.(parameters,ctx);
        const request:ToolAccessRequest=declared??{external:true,tool:tool.name,kind:'write',paths:[],command:tool.name};
        if(declared?.paths.length)throw Error('数据库工具不允许任意宿主路径授权');
        if(!await approve(request))throw Error('本次操作未获授权，未执行');
      }
      ctx.signal?.throwIfAborted();
      await check?.(tool,parameters);
      freeze(invocation);
      const current={tool:tool.name,invocation:structuredClone(invocation),active:true};
      let result:string;
      try { result=await invocationContext.run(current,()=>tool.run(parameters,{...ctx,requestAccess:approve})); }
      finally { current.active=false; }
      await check?.(tool,parameters);
      await published?.(tool,result);
      return sourceResult(tool,result);
    }};
  });
}
