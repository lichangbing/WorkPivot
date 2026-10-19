import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, rmSync, lstatSync } from 'node:fs';
import { join } from 'node:path';

export interface CachedConversation {
  events: {id:string;sequence:string;turnId:string;runId:string;kind:string;content:string;truncated:boolean;attachments?:{id:string;name:string|null;deleted?:boolean}[]}[];
  older:string|null; details:Record<string,{after:string;snapshot:string}>; sequence:string; savedAt:string;
}
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const counter=(value:unknown):value is string=>typeof value==='string'&&/^(0|[1-9][0-9]{0,18})$/.test(value);
const id=(value:unknown):value is string=>typeof value==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(value);
const taskLimit=32*1024*1024, accountLimit=256*1024*1024;
export function validateConversation(value:CachedConversation):void {
  if(!value||!Array.isArray(value.events)||value.events.length>100000||!counter(value.sequence)||!(value.older===null||typeof value.older==='string'&&value.older.length<=512)||!value.details||typeof value.details!=='object')throw Error('本地会话格式无效');
  const seen=new Set<string>();
  for(const e of value.events){
    if(!id(e.id)||seen.has(e.id)||!id(e.turnId)||!id(e.runId)||!counter(e.sequence)||BigInt(e.sequence)>BigInt(value.sequence)||!['user','assistant','thinking','tool_use','tool_result','meta'].includes(e.kind)||typeof e.content!=='string'||e.content.length>200000||typeof e.truncated!=='boolean')throw Error('本地会话事件无效');
    seen.add(e.id);
    if(e.attachments&&(!Array.isArray(e.attachments)||e.attachments.length>100||e.attachments.some(a=>!id(a.id)||!(a.name===null||typeof a.name==='string'&&a.name.length<=2000))))throw Error('文件引用无效');
  }
  for(const [key,d] of Object.entries(value.details))if(!id(key)||!counter(d.after)||!counter(d.snapshot))throw Error('本地分页信息无效');
  if(Buffer.byteLength(JSON.stringify(value))>taskLimit)throw Error('此会话超过本地缓存上限，仍可从服务端读取');
}
interface Session {origin:string;account:string;tokenHash:string;allowed:Set<string>;epoch:number}
/** 服务端身份绑定后才开放缓存；磁盘路径不接受渲染进程传入。 */
export class ConversationCache {
  private sessions=new Map<string,Session>();
  constructor(private root:string){mkdirSync(root,{recursive:true,mode:0o700});if(lstatSync(root).isSymbolicLink())throw Error('本地会话目录不能是链接');}
  private directory(s:Session){const path=join(this.root,hash(s.origin+'\0'+s.account));mkdirSync(path,{recursive:true,mode:0o700});if(lstatSync(path).isSymbolicLink())throw Error('本地会话目录不能是链接');return path;}
  private audit(s:Session,action:string,count:number){const file=join(this.directory(s),'audit.log');let rows:{at:string;action:string;count:number}[]=[];try{rows=JSON.parse(readFileSync(file,'utf8'));}catch{/* 首次写入无需历史记录。 */}rows.push({at:new Date().toISOString(),action,count});writeFileSync(file,JSON.stringify(rows.slice(-100)),{mode:0o600});}
  private session(handle:string){const s=this.sessions.get(handle);if(!s)throw Error('本地会话授权已失效，请重新登录');return s;}
  private file(s:Session,task:string){if(!id(task)||!s.allowed.has(task))throw Error('无权读取此任务的本地会话');return join(this.directory(s),hash(task)+'.json');}
  find(origin:string,token:string){return [...this.sessions].find(([,s])=>s.origin===origin&&s.tokenHash===hash(token))?.[0];}
  bind(origin:string,token:string,account:string,tasks:string[]){if(!id(account)||tasks.some(t=>!id(t)))throw Error('服务端账号或任务清单无效');const handle=randomUUID();this.sessions.set(handle,{origin,account,tokenHash:hash(token),allowed:new Set(tasks),epoch:0});this.reconcile(handle,tasks);return handle;}
  check(handle:string,origin:string,token?:string){const s=this.session(handle);if(s.origin!==origin||(token!==undefined&&s.tokenHash!==hash(token)))throw Error('本地会话身份不匹配');}
  lock(){this.sessions.clear();}
  reconcile(handle:string,tasks:string[]){
    const s=this.session(handle);if(tasks.some(t=>!id(t)))throw Error('任务清单无效');
    const allowed=new Set(tasks),valid=new Set(tasks.map(t=>hash(t)+'.json'));
    // 删除/撤权后不允许先前读取获得的写入租约复活缓存。
    for(const session of this.sessions.values())if(session.origin===s.origin&&session.account===s.account){if([...session.allowed].some(t=>!allowed.has(t)))session.epoch++;session.allowed=allowed;}
    let removed=0;for(const file of readdirSync(this.directory(s)))if(file.endsWith('.json')&&!valid.has(file)){rmSync(join(this.directory(s),file));removed++;}if(removed)this.audit(s,'同步删除或撤权',removed);
  }
  read(handle:string,task:string){const s=this.session(handle),file=this.file(s,task);let snapshot:CachedConversation|null=null;
    try{if(lstatSync(file).isSymbolicLink()||statSync(file).size>taskLimit)throw Error();snapshot=JSON.parse(readFileSync(file,'utf8')) as CachedConversation;validateConversation(snapshot);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT'){rmSync(file,{force:true});this.audit(s,'清理损坏缓存',1);throw Error('本地会话缓存损坏，已移除，将重新从服务端加载');}}
    return {snapshot,epoch:s.epoch};
  }
  write(handle:string,task:string,epoch:number,snapshot:CachedConversation){const s=this.session(handle);if(epoch!==s.epoch)throw Error('本地缓存已清理或权限已更新，请重新打开任务');const file=this.file(s,task);validateConversation(snapshot);
    const current=this.read(handle,task).snapshot;
    if(current&&BigInt(current.sequence)>BigInt(snapshot.sequence))return;
    // 只持久化会话字段，不保存令牌、模型配置、下载地址或文件正文。
    const data:CachedConversation={events:snapshot.events.map(e=>({id:e.id,sequence:e.sequence,turnId:e.turnId,runId:e.runId,kind:e.kind,content:e.content,truncated:e.truncated,...(e.attachments?{attachments:e.attachments.map(a=>({id:a.id,name:a.name,...(a.deleted?{deleted:true}:{})}))}:{})})),older:snapshot.older,details:snapshot.details,sequence:snapshot.sequence,savedAt:new Date().toISOString()};
    const temp=file+'.'+randomUUID()+'.tmp';try{writeFileSync(temp,JSON.stringify(data),{mode:0o600,flag:'wx'});renameSync(temp,file);}finally{rmSync(temp,{force:true});}
    const files=readdirSync(this.directory(s)).filter(f=>f.endsWith('.json')).map(f=>({path:join(this.directory(s),f),stat:statSync(join(this.directory(s),f))})).sort((a,b)=>a.stat.mtimeMs-b.stat.mtimeMs);
    let bytes=files.reduce((n,f)=>n+f.stat.size,0);for(const f of files){if(bytes<=accountLimit)break;if(f.path===file)continue;rmSync(f.path);bytes-=f.stat.size;this.audit(s,'容量清理',1);}
  }
  discard(handle:string,task:string){const s=this.session(handle),file=this.file(s,task);for(const other of this.sessions.values())if(other.origin===s.origin&&other.account===s.account)other.epoch++;rmSync(file,{force:true});this.audit(s,'服务端快照重建',1);}
  status(handle:string){const s=this.session(handle),files=readdirSync(this.directory(s)).filter(f=>f.endsWith('.json')).map(f=>statSync(join(this.directory(s),f)));let audit=[];try{audit=JSON.parse(readFileSync(join(this.directory(s),'audit.log'),'utf8'));}catch{/* 尚无管理操作。 */}return {audit,tasks:files.length,bytes:files.reduce((n,f)=>n+f.size,0),lastSavedAt:files.length?new Date(Math.max(...files.map(f=>f.mtimeMs))).toISOString():null};}
  clear(handle:string){const s=this.session(handle);for(const other of this.sessions.values())if(other.origin===s.origin&&other.account===s.account)other.epoch++;let count=0;for(const file of readdirSync(this.directory(s)))if(file.endsWith('.json')){rmSync(join(this.directory(s),file));count++;}this.audit(s,'用户清空本地副本',count);}
}
