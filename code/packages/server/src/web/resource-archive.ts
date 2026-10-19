import {createHash} from 'node:crypto';
import type {Original} from './original.js';
import type {WebResponse} from './safe-http.js';
/** 只归档真实经过完整URL校验的响应；JSON容器不包含可执行入口或文件系统路径。 */
export class ResourceArchive {
 private resources:Array<{url:string;status:number;mediaType:string;sha256:string;body:string}>=[];
 private bytes=0;
 private overflow=false;
 add(response:WebResponse){
  if(this.overflow)return;
  this.bytes+=response.body.length;
  if(this.bytes>2*1024*1024||this.resources.length>=100){this.overflow=true;this.resources=[];return;}
  this.resources.push({url:response.url,status:response.status,mediaType:(response.headers['content-type']??'application/octet-stream').slice(0,200).replace(/[\r\n]/g,''),sha256:createHash('sha256').update(response.body).digest('hex'),body:response.body.toString('base64')});
 }
 finish(url:string,html:string,blockedUrls:string[]):Original{
  if(this.overflow)throw Error('网页资源存档超过大小或数量限制，未保存不完整存档');
  const body=Buffer.from(JSON.stringify({format:'workpivot-web-archive',version:1,url,dom:html,resources:this.resources,blockedUrls,notice:'仅包括本次取得的响应与动作后DOM，不保证包含整站、跨框架、缓存或隐藏内容；资源正文使用base64编码。'}));
  if(body.length>2*1024*1024)throw Error('网页资源包超过2MiB限制，未保存截断存档');
  return {kind:'bundle',mediaType:'application/vnd.workpivot.web-archive+json',body:body.toString('base64')};
 }
}
