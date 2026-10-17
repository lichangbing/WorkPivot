import {RepositoryError} from './connection.js';

export interface EmbeddingInput {name:string;baseUrl:string;modelId:string;modelVersion:string;protocol:'ollama'|'openai';dimensions:number;apiKey?:string|null}
export function validateEmbedding(input:EmbeddingInput):EmbeddingInput {
  if(!input||typeof input.name!=='string'||!input.name.trim()||input.name.length>120||typeof input.modelId!=='string'||!input.modelId.trim()||input.modelId.length>200||typeof input.modelVersion!=='string'||!input.modelVersion.trim()||input.modelVersion.length>200||!['ollama','openai'].includes(input.protocol)||!Number.isInteger(input.dimensions)||input.dimensions<1||input.dimensions>4096)throw new RepositoryError(400,'请填写名称、模型、版本标识和1至4096之间的向量维度');
  let url:URL;try{if(typeof input.baseUrl!=='string'||input.baseUrl.length>2000)throw Error();url=new URL(input.baseUrl);}catch{throw new RepositoryError(400,'向量服务地址无效');}
  if(!['http:','https:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new RepositoryError(400,'服务地址仅允许不含凭据、查询参数的HTTP(S)地址');
  if(input.apiKey!==undefined&&input.apiKey!==null&&(typeof input.apiKey!=='string'||!input.apiKey.trim()||input.apiKey.length>16000))throw new RepositoryError(400,'密钥格式无效');
  return {...input,name:input.name.trim(),modelId:input.modelId.trim(),modelVersion:input.modelVersion.trim(),baseUrl:url.toString().replace(/\/+$/,'')};
}
/** 不返回模型原始错误正文，防止服务回显资料或凭据。 */
export async function embed(input:EmbeddingInput,texts:string[],signal?:AbortSignal):Promise<number[][]> {
  const abort=AbortSignal.any([AbortSignal.timeout(90000),...(signal?[signal]:[])]);
  try {
    const response=await fetch(input.baseUrl+(input.protocol==='ollama'?'/api/embed':'/embeddings'),{
      method:'POST',redirect:'error',signal:abort,headers:{'content-type':'application/json',...(input.apiKey?{authorization:'Bearer '+input.apiKey}:{})},
      body:JSON.stringify({model:input.modelId,input:texts,...(input.protocol==='ollama'?{truncate:false,keep_alive:'5m'}:{encoding_format:'float'})}),
    });
    if(!response.ok){await response.body?.cancel();throw new RepositoryError(502,'向量服务请求失败（HTTP '+response.status+'）');}
    const reader=response.body?.getReader();if(!reader)throw Error();let bytes=0;const chunks:Uint8Array[]=[];
    try{while(true){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>2*1024*1024)throw Error();chunks.push(value);}}finally{await reader.cancel();}
    const result=JSON.parse(Buffer.concat(chunks).toString('utf8'));
    let vectors:unknown=result.embeddings;
    if(input.protocol==='openai'){
      if(!Array.isArray(result.data)||result.data.length!==texts.length)throw Error();
      const rows=[...result.data].sort((a,b)=>a.index-b.index);
      if(rows.some((v,i)=>v.index!==i))throw Error();vectors=rows.map(v=>v.embedding);
    }
    if(!Array.isArray(vectors)||vectors.length!==texts.length||vectors.some(v=>!Array.isArray(v)||v.length!==input.dimensions||v.some(x=>typeof x!=='number'||!Number.isFinite(x)||Math.abs(x)>1e10)||!v.some(x=>x!==0)))throw new RepositoryError(502,'向量响应数量、维度或数值无效，请核对模型配置');
    return vectors as number[][];
  }catch(error){if(error instanceof RepositoryError)throw error;throw new RepositoryError(502,abort.aborted?'向量请求超时或已取消':'向量服务不可用或响应格式无效');}
}
