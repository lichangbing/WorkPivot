import { join } from 'node:path';
import type { Tool } from '@workpivot/core';
import type { Task } from './tasks.js';
import { listArtifacts, type ArtifactVersion } from './artifacts.js';
import { ensureWorkpivotDir, readJsonSafe, writeAtomicWithBackup } from './store.js';

interface Delivery { name: string; version: ArtifactVersion }
interface State { names: string[]; pending: string[]; files: Delivery[] }
const path = (task: Task) => join(ensureWorkpivotDir('data', 'tasks', task.id), 'deliverables.json');
const read = (task: Task) => readJsonSafe<State>(path(task), { names: [], pending: [], files: [] }).value;
const save = (task: Task, state: State) => writeAtomicWithBackup(path(task), JSON.stringify(state));
export const listDeliverables = (task: Task): Delivery[] => read(task).files;
export function beginDeliverables(task: Task): void { const state = read(task); save(task, { ...state, pending: [] }); }
export function finishDeliverables(task: Task, outcome: string): void {
  const state = read(task);
  if (outcome !== 'completed') { save(task, { ...state, pending: [] }); return; }
  const names = [...new Set([...state.names, ...state.pending])];
  const artifacts = listArtifacts(task, true);
  const files = names.flatMap(name => {
    const version = artifacts.find(a => a.name === name)?.versions.at(-1);
    const old = state.files.find(f => f.name === name);
    return version?.status === 'ready' ? [{ name, version }] : old ? [old] : [];
  });
  save(task, { names, files, pending: [] });
}
export function selectDeliverable(task: Task, name: string, selected: boolean): void {
  if (['queued', 'running', 'waiting'].includes(task.status)) throw Error('请在任务结束后调整成果清单');
  const state = read(task);
  if (!selected) { save(task, { ...state, names: state.names.filter(n => n !== name), files: state.files.filter(f => f.name !== name) }); return; }
  const file = listArtifacts(task).find(f => f.name === name);
  const version = file?.versions.at(-1);
  if (!version || version.status !== 'ready' || file?.state !== 'ready') throw Error('只能交付已成功完成、具有快照的文件（单文件不超过 50MB）');
  save(task, { ...state, names: [...new Set([...state.names, name])], files: [...state.files.filter(f => f.name !== name), { name, version }] });
}
export function deliveryTool(task: Task): Tool {
  return { name: 'deliver_files', kind: 'read', description: '登记交付给用户的最终成果文件。完成文档或其他成果后必须调用，传入任务目录内相对路径。只登记最终成果，不登记脚本、缓存、日志、草稿或过程材料。成功结束任务后成果才会同步到用户本机。', parameters: { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } } }, required: ['files'] }, async run(args) {
    const names = args['files'];
    if (!Array.isArray(names) || !names.length || names.length > 100 || names.some(n => typeof n !== 'string')) return '错误：提供 1–100 个成果相对路径';
    const available = listArtifacts(task, true);
    if (names.some(n => !available.some(a => a.name === n && a.size <= 50 * 1024 * 1024))) return '错误：成果必须是本任务生成的现有文件，单文件不超过 50MB';
    const state = read(task); save(task, { ...state, pending: [...new Set([...state.pending, ...names])] });
    return '成果已登记，任务成功结束后发布并同步。';
  } };
}
