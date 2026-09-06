/**
 * T2-04/T2-05/I05：权限档位 + 目录边界 + 高危分类 + 异步授权请求。
 *
 * 四档（需求清单 I02）：
 *  - readonly 只看不动：读界内放行；写/bash 一律拒绝
 *  - ask      每步都问：读界内放行；写/bash 逐次询问
 *  - workdir  界内自动+界外询问（默认）：界内放行；界外读写/执行 → 授权卡
 *  - auto     全自动：除高危命令（I05，仍需询问）外全部放行
 *
 * I05 高危命令：任何档位都至少询问（readonly 直接拒绝），且不提供"永久放行"。
 * bypass-immune 原则（对标竞品）：危险判定不受档位与白名单影响。
 */
import { isAbsolute, join, resolve as resolvePath } from 'node:path';
import { ensureWorkpivotDir, readJsonSafe, writeAtomic } from './store.js';

export type Tier = 'readonly' | 'ask' | 'workdir' | 'auto';

export const TIER_LABELS: Record<Tier, string> = {
  ask: '变更前确认',
  readonly: '计划模式',
  workdir: '自动编辑',
  auto: '完全访问',
};

const DEFAULT_TIER: Tier = 'workdir';

function settingsPath(): string {
  return join(ensureWorkpivotDir('config'), 'settings.json');
}

interface SettingsFile {
  version: 1;
  permissionTier?: Tier;
}

export function getTier(): Tier {
  const settings = readJsonSafe<SettingsFile>(settingsPath(), { version: 1 }).value;
  return settings.permissionTier ?? DEFAULT_TIER;
}

export function setTier(tier: Tier): void {
  const settings = readJsonSafe<SettingsFile>(settingsPath(), { version: 1 }).value;
  writeAtomic(settingsPath(), JSON.stringify({ ...settings, version: 1, permissionTier: tier }, null, 2));
}

// ---- 永久白名单（界外目录）----

function allowListPath(): string {
  return join(ensureWorkpivotDir('config'), 'permissions.json');
}

interface AllowListFile {
  version: 1;
  allowDirs: string[];
}

export function listAllowDirs(): string[] {
  return readJsonSafe<AllowListFile>(allowListPath(), { version: 1, allowDirs: [] }).value.allowDirs;
}

export function addAllowDir(dir: string): void {
  const file = readJsonSafe<AllowListFile>(allowListPath(), { version: 1, allowDirs: [] }).value;
  if (!file.allowDirs.includes(dir)) file.allowDirs.push(dir);
  writeAtomic(allowListPath(), JSON.stringify(file, null, 2));
}

// ---- 本会话记住（服务进程生命周期内的内存授权）----

const sessionAllowedDirs = new Set<string>();
const sessionAllowedCommands = new Set<string>();

export function grantSessionDir(dir: string): void {
  sessionAllowedDirs.add(dir);
}

export function grantSessionCommand(prefix: string): void {
  sessionAllowedCommands.add(prefix);
}

// ---- I05 高危命令分类 ----

const DANGER_PATTERNS: RegExp[] = [
  /\brm\s+(-[a-z]+\s+)*-?[a-z]*r[a-z]*f/i, // rm -rf 及变体
  /\brm\s+-[a-z]*f[a-z]*r/i,
  /\bRemove-Item\b[^\n]*-Recurse/i,
  /\bdel\s+\/[fsq]/i,
  /\b(rd|rmdir)\s+\/s/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\b(shutdown|restart-computer)\b/i,
  /\breg(\.exe)?\s+(delete|add)\b/i,
  /\bgit\s+push\b[^\n]*--force/i,
  /\bgit\s+reset\s+--hard\b/i,
  /\bdrop\s+(table|database)\b/i,
  /:\(\)\{\s*:\|\:&\s*\};:/, // fork 炸弹
  /\bdd\s+if=/i,
  />\s*\/dev\/(sd|nvme)/i,
  /\bdiskpart\b/i,
];

/** rm/del 的删除目标是否指向根/家目录/通配（对标竞品 isDangerousRemovalPaths）。 */
function isDangerousRemovalTarget(command: string): boolean {
  const roots = ['/', '~', 'C:\\', 'D:\\', 'E:\\', '*', '.'];
  const rmMatch = /(?:^|[;&|]\s*)(rm|del|rd|rmdir|Remove-Item)\b(.*)$/im.exec(command);
  if (!rmMatch) return false;
  const targets = rmMatch[2] ?? '';
  return roots.some((root) => targets.includes(root));
}

export function classifyCommand(command: string): { danger: boolean; reason?: string } {
  for (const pattern of DANGER_PATTERNS) {
    if (pattern.test(command)) return { danger: true, reason: `命中高危命令模式：${String(pattern)}` };
  }
  if (isDangerousRemovalTarget(command)) return { danger: true, reason: '删除目标指向根/家目录或通配符' };
  return { danger: false };
}

// ---- 判定与异步授权请求 ----

export interface AccessPath {
  path: string;
  mode: 'read' | 'write';
}

export interface AccessRequest {
  id: string;
  tool: string;
  kind: 'read' | 'write' | 'bash';
  paths: AccessPath[];
  command?: string;
  reason?: string;
  /** 授权卡可选动作：路径类支持 本会话/永久；高危命令只支持 允许一次 */
  scope: 'once' | 'session-or-forever';
}

export type Decision = 'allow' | 'deny' | 'session' | 'forever';

function withinDir(path: string, dir: string): boolean {
  const norm = path.replace(/[\\/]+$/, '');
  return norm === dir || norm.startsWith(dir + '\\') || norm.startsWith(dir + '/');
}

function pathCoveredByLists(path: string): boolean {
  const dirs = [...listAllowDirs(), ...sessionAllowedDirs];
  return dirs.some((dir) => withinDir(path, dir));
}

export interface PendingRequest {
  request: AccessRequest;
  resolve: (decision: Decision) => void;
}

const pending = new Map<string, PendingRequest>();

export function resolvePendingRequest(id: string, decision: Decision): boolean {
  const entry = pending.get(id);
  if (!entry) return false;
  pending.delete(id);
  entry.resolve(decision);
  return true;
}

export interface EvaluateInput {
  tool: string;
  kind: 'read' | 'write' | 'bash';
  paths: AccessPath[];
  command?: string;
  taskDir: string;
}

/**
 * 判定一次工具访问。返回 'allow'；需要用户决策时调用 onRequest（发授权卡）并等待。
 * 决策含义：allow=仅此次；session=本会话记住；forever=永久白名单（仅路径类）；deny=拒绝。
 */
export async function evaluateAccess(
  input: EvaluateInput,
  onRequest: (request: AccessRequest) => void,
): Promise<{ allowed: boolean; auditedReason: string }> {
  const tier = getTier();
  // 工具声明的是相对任务目录的路径；边界判定必须先解析为绝对路径
  const absPaths = input.paths.map((p) => ({ mode: p.mode, path: isAbsolute(p.path) ? p.path : resolvePath(input.taskDir, p.path) }));
  const outside = absPaths.filter((p) => !withinDir(p.path, input.taskDir));

  // 1) bash 命令：先过高危分类（bypass-immune）
  if (input.kind === 'bash' && input.command !== undefined) {
    const { danger, reason } = classifyCommand(input.command);
    if (danger) {
      if (tier === 'readonly') return { allowed: false, auditedReason: `readonly 档拒绝 bash：${reason ?? ''}` };
      const allowed = await ask(input, `高危命令：${reason ?? '命中高危模式'}`, 'once');
      return { allowed, auditedReason: allowed ? '用户批准高危命令（一次性）' : '用户拒绝高危命令' };
    }
    if (sessionAllowedCommands.has(input.command.trim())) return { allowed: true, auditedReason: '本会话已批准的命令' };
    if (tier === 'readonly') return { allowed: false, auditedReason: 'readonly 档拒绝 bash' };
    if (tier === 'ask') {
      const allowed = await ask(input, '每步都问档：命令执行需确认', 'once');
      return { allowed, auditedReason: allowed ? '用户逐次批准命令' : '用户拒绝命令' };
    }
    return { allowed: true, auditedReason: `${tier} 档放行非高危命令` };
  }

  // 2) 文件类：全部界内
  if (outside.length === 0) {
    if (input.kind === 'read') return { allowed: true, auditedReason: '界内读取' };
    if (tier === 'readonly') return { allowed: false, auditedReason: 'readonly 档拒绝界内写入' };
    if (tier === 'ask') {
      const allowed = await ask(input, '每步都问档：写入需确认', 'once');
      return { allowed, auditedReason: allowed ? '用户逐次批准写入' : '用户拒绝写入' };
    }
    return { allowed: true, auditedReason: `${tier} 档放行界内${input.kind === 'write' ? '写入' : '访问'}` };
  }

  // 3) 界外：白名单/会话授权 → 放行；否则授权卡
  if (absPaths.every((p) => pathCoveredByLists(p.path))) {
    return { allowed: true, auditedReason: '界外但命中白名单/会话授权' };
  }
  if (tier === 'readonly' || tier === 'auto') {
    return { allowed: false, auditedReason: `${tier} 档拒绝界外访问（${outside.map((p) => p.path).join(', ')}）` };
  }
  const allowed = await ask(input, '访问任务目录之外的路径', 'session-or-forever');
  if (allowed) {
    for (const p of outside) grantSessionDir(p.path);
  }
  return { allowed, auditedReason: allowed ? '用户授权界外访问' : '用户拒绝界外访问' };

  async function ask(base: Omit<AccessRequest, 'id' | 'reason' | 'scope'>, reason: string, scope: AccessRequest['scope']): Promise<boolean> {
    const request: AccessRequest = {
      id: `pr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tool: base.tool,
      kind: base.kind,
      paths: base.paths,
      command: base.command,
      reason,
      scope,
    };
    const decision = await new Promise<Decision>((resolve) => {
      pending.set(request.id, { request, resolve });
      onRequest(request);
    });
    if (decision === 'session') {
      if (request.kind === 'bash' && request.command) grantSessionCommand(request.command.trim());
      for (const p of request.paths) grantSessionDir(p.path);
    } else if (decision === 'forever') {
      for (const p of request.paths) addAllowDir(p.path.includes('\\') || p.path.includes('/') ? p.path : join(p.path));
    }
    return decision !== 'deny';
  }
}
