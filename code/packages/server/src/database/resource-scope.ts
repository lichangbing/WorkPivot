import {RepositoryError,uuid} from './connection.js';
/** 服务端构造的固定版本集合；undefined仅供既有人工/API查询保持原范围。 */
export function versionScope(ids:readonly string[]|undefined):string[]|null {
  if(ids===undefined)return null;
  if(!Array.isArray(ids)||ids.length>100)throw new RepositoryError(400,'授权文件范围无效');
  ids.forEach(uuid);
  return [...new Set(ids.map(id=>id.toLowerCase()))].sort();
}
export function requireVersion(ids:readonly string[]|undefined,id:string):void {
  uuid(id);const allowed=versionScope(ids);
  if(allowed!==null&&!allowed.includes(id.toLowerCase()))throw new RepositoryError(403,'文件版本未获本轮读取授权');
}
export interface ResourceSelection {scheduleIds?:string[];versionIds:string[];memoryScopes:('user'|'project'|'task')[];expert:boolean}
export interface RunResourceScope extends ResourceSelection {version:1;epoch:string;baseRunId:string|null;initial:ResourceSelection}
export function selection(value:unknown):ResourceSelection {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new RepositoryError(400,'读取范围无效');
  const v=value as Record<string,unknown>;
  if(!Array.isArray(v.versionIds)||!Array.isArray(v.memoryScopes)||v.memoryScopes.some(s=>!['user','project','task'].includes(String(s)))||typeof v.expert!=='boolean')throw new RepositoryError(400,'读取范围字段无效');
  return {scheduleIds:versionScope((v.scheduleIds??[]) as string[])!,versionIds:versionScope(v.versionIds as string[])!,memoryScopes:[...new Set(v.memoryScopes)].sort() as ResourceSelection['memoryScopes'],expert:v.expert};
}
/** 已选文件可来自当前任务或同一项目；RLS仍限定账号，不跨项目扩大范围。 */
export function fileTaskScope(taskParameter:string){return `(d.task_id=${taskParameter} OR EXISTS(SELECT 1 FROM workpivot.tasks source JOIN workpivot.tasks target ON target.id=${taskParameter} AND target.project_id=source.project_id WHERE source.id=d.task_id AND source.deleted_at IS NULL AND target.deleted_at IS NULL))`;}
