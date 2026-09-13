import { getToken } from '../api';
export interface PackageSummary { name: string; description: string; source: string; disabled: boolean; managed: boolean; dirty: boolean; published: string | null; hasPublished: boolean }
export interface PackageDetail { name: string; revision: string; published: string | null; versions: Array<{ id: string; label: string; createdAt: string }>; files: Array<{ path: string; size: number; editable: boolean }>; dirty: boolean; dependencies: unknown }
export interface PackageValidation { valid: boolean; errors: string[]; warnings: string[]; revision: string }
export interface PackageDetail { directories?: string[] }
const base = '/api/skill-packages';
const path = (name: string) => `${base}/${encodeURIComponent(name)}`;
async function request(url: string, method = 'GET', body?: unknown, raw = false): Promise<Response> {
  const response = await fetch(url, { method, headers: { authorization: `Bearer ${getToken() ?? ''}`, 'content-type': raw ? 'application/octet-stream' : 'application/json' }, ...(body === undefined ? {} : { body: raw ? body as Blob : JSON.stringify(body) }), signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error((await response.json().catch(() => ({ error: `请求失败 (${response.status})` }))).error);
  return response;
}
async function json<T>(url: string, method = 'GET', body?: unknown, raw = false): Promise<T> { return (await request(url, method, body, raw)).json() as Promise<T>; }
export const packagesApi = {
  list: () => json<{ packages: PackageSummary[] }>(base),
  create: (name: string) => json<PackageDetail>(base, 'POST', { name }),
  directory: (name: string, file: string, revision: string) => json<PackageDetail>(path(name) + '/directory', 'POST', { path: file, revision }),
  removeDirectory: (name: string, file: string, revision: string) => json<PackageDetail>(path(name) + '/directory?path=' + encodeURIComponent(file), 'DELETE', { revision }),
  open: (name: string) => json<PackageDetail>(path(name) + '/open', 'POST'),
  file: (name: string, file: string) => json<{ path: string; content: string | null; size: number }>(path(name) + '/file?path=' + encodeURIComponent(file)),
  save: (name: string, file: string, content: string, revision: string) => json<PackageDetail>(path(name) + '/file', 'PUT', { path: file, content, revision }),
  upload: (name: string, file: string, blob: File, revision: string) => json<PackageDetail>(path(name) + `/upload?path=${encodeURIComponent(file)}&revision=${revision}`, 'PUT', blob, true),
  remove: (name: string, file: string, revision: string) => json<PackageDetail>(path(name) + '/file?path=' + encodeURIComponent(file), 'DELETE', { revision }),
  import: (name: string, blob: File, revision: string) => json<PackageDetail>(path(name) + '/import?revision=' + revision, 'POST', blob, true),
  validate: (name: string) => json<PackageValidation>(path(name) + '/validate', 'POST'),
  publish: (name: string, revision: string) => json<PackageDetail>(path(name) + '/publish', 'POST', { revision }),
  rollback: (name: string, version: string, revision: string) => json<PackageDetail>(path(name) + '/rollback', 'POST', { version, revision }),
  discard: (name: string, revision: string) => json<PackageDetail>(path(name) + '/discard', 'POST', { revision }),
  toggle: (name: string, disabled: boolean) => json<{ ok: boolean }>(path(name) + '/toggle', 'POST', { disabled }),
  download: async (name: string, file: string, version?: string) => (await request(path(name) + '/download?path=' + encodeURIComponent(file) + (version ? '&version=' + version : ''))).blob(),
  export: async (name: string, version?: string) => (await request(path(name) + '/export' + (version ? '?version=' + version : ''))).blob(),
};
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob); const link = document.createElement('a'); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
