import type {WebResponse} from './safe-http.js';
export interface Original {body:string;mediaType:string;kind?:'http'|'dom'|'bundle'}
/** 仅保留解压后的正文和媒体类型；不保存Cookie等响应头。 */
export function originalResponse(response:WebResponse):Original{
 return {body:response.body.toString('base64'),mediaType:(response.headers['content-type']??'application/octet-stream').slice(0,200).replace(/[\r\n]/g,'')};
}
export function decodeOriginal(value:unknown){
 if(!value||typeof value!=='object')throw Error('采集服务未提供原始正文，请检查服务版本');
 const raw=value as Record<string,unknown>;
 if(typeof raw.body!=='string'||raw.body.length>2796204||typeof raw.mediaType!=='string'||!raw.mediaType||raw.mediaType.length>200||/[\r\n]/.test(raw.mediaType))throw Error('原始正文格式或大小无效');
 if(raw.kind!==undefined&&!['http','dom','bundle'].includes(String(raw.kind)))throw Error('存档类型无效');
 const data=Buffer.from(raw.body,'base64');
 if(data.length>2*1024*1024||data.toString('base64')!==raw.body)throw Error('原始正文编码或大小无效');
 return {data,mediaType:raw.mediaType,kind:(raw.kind??'http') as 'http'|'dom'|'bundle'};
}
