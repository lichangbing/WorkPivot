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

function subset(values: readonly string[], allowed: readonly string[]): boolean {
  const set = new Set(allowed);
  return values.every(value => set.has(value));
}

/**
 * 当前进程持有的运行范围只能在数据库完成受控增量扩展后同步到新值。
 * 减少文件、记忆或关闭专家时必须重新开始运行，不能热缩当前上下文。
 */
export function syncExpandedScope(target: RunResourceScope, value: unknown): RunResourceScope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RepositoryError(409, '运行读取范围已撤销或变化');
  const saved = value as Record<string, unknown>;
  const next = selection(saved);
  if (saved['version'] !== 1 || typeof saved['epoch'] !== 'string') throw new RepositoryError(409, '运行读取范围版本无效');
  uuid(saved['epoch']);
  if (!subset(target.versionIds, next.versionIds) || !subset(target.memoryScopes, next.memoryScopes) ||
      !subset(target.scheduleIds ?? [], next.scheduleIds ?? []) || target.expert && !next.expert) {
    throw new RepositoryError(409, '运行读取范围已被缩小或改变，请重新开始本轮');
  }
  const initial = saved['initial'] === undefined ? next : selection(saved['initial']);
  target.versionIds.splice(0, target.versionIds.length, ...next.versionIds);
  target.memoryScopes.splice(0, target.memoryScopes.length, ...next.memoryScopes);
  target.scheduleIds?.splice(0, target.scheduleIds.length, ...(next.scheduleIds ?? []));
  if (!target.scheduleIds && next.scheduleIds) target.scheduleIds = [...next.scheduleIds];
  target.expert = next.expert;
  target.epoch = saved['epoch'];
  target.baseRunId = typeof saved['baseRunId'] === 'string' ? saved['baseRunId'] : target.baseRunId;
  target.initial = initial;
  return target;
}

export interface RuntimeScopeExpansionInput {
  requestId: string;
  baseRunId: string;
  baseEpoch: string;
  addVersionIds?: string[];
  addMemoryScopes?: string[];
}
