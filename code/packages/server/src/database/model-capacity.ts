import {RepositoryError} from './connection.js';
import {maxContextTokens} from './context-budget.js';
/** 只接受目标模型明确声明的总窗口；不能把最大输出长度当作上下文。 */
export function modelCapacity(payload: unknown, model: string): number {
 const data = (payload as {data?: unknown})?.data;
 if (!Array.isArray(data)) throw new RepositoryError(422, '接口未提供模型列表，请手动填写上下文容量');
 const matches = data.filter(row => row && typeof row === 'object' && row.id === model);
 if (matches.length !== 1) throw new RepositoryError(422, '接口未唯一返回当前模型，请核对模型名称或手动设置');
 const value = matches[0].context_window ?? matches[0].context_length;
 if (!Number.isSafeInteger(value) || value < 12000 || value > maxContextTokens) throw new RepositoryError(422, '接口未提供有效的上下文窗口（12000至2097152 tokens），请核对后手动设置');
 return value;
}
export async function fetchModelCapacity(baseUrl: string, model: string, protocol: string, key?: string): Promise<number> {
 const base = baseUrl.replace(/\/+$/, '');
 const url = /\/v1$/.test(base) ? base + '/models' : base + '/v1/models';
 const headers: Record<string,string> = {Accept:'application/json'};
 if (protocol === 'anthropic') { headers['anthropic-version']='2023-06-01'; if(key)headers['x-api-key']=key; }
 else if(key)headers.Authorization='Bearer '+key;
 try {
  // 不跟随重定向，避免将配置中的凭据发送给其他地址；限制响应体及耗时。
  const response = await fetch(url,{headers,redirect:'error',signal:AbortSignal.timeout(15000)});
  if(!response.ok)throw new RepositoryError(502, `模型元数据接口返回HTTP ${response.status}，原容量保持不变`);
  const reader=response.body?.getReader();if(!reader)throw new Error();
  const chunks:Uint8Array[]=[];let length=0;
  try { for(;;){const {done,value}=await reader.read();if(done)break;length+=value.byteLength;if(length>2*1024*1024)throw new RepositoryError(413,'模型元数据响应过大');chunks.push(value);} }
  finally { await reader.cancel(); }
  return modelCapacity(JSON.parse(Buffer.concat(chunks).toString('utf8')),model);
 } catch(error) {
  if(error instanceof RepositoryError)throw error;
  throw new RepositoryError(502,'无法读取模型容量，原配置保持不变；可手动填写');
 }
}
