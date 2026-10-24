import { AsyncLocalStorage } from 'node:async_hooks';
import { TenantMap } from './tenant-map.js';
/** 两种操作模式：ask 变更前确认；auto 项目内常规操作自动执行。
 * 旧 readonly/workdir 存储值在读取时转换，高风险命令和 MCP 仍逐次授权。 */
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { canonicalPath, pathWithin } from '@workpivot/shared/node';
import { ensureWorkpivotDir, readJsonSafe, writeAtomic } from './store.js';
import { getUserTier } from './auth.js';
import { grantPath, pathIsGranted } from './permission-grants.js';

export type Tier = 'readonly' | 'ask' | 'workdir' | 'auto';

export const TIER_LABELS: Record<string, string> = {
  ask: '确认模式',
  auto: '自动模式',
};

const DEFAULT_TIER: Tier = 'auto';
/** 兼容读取旧存储值；新界面和接口只开放两种模式。 */
export function normalizeTier(tier: unknown): 'ask' | 'auto' {
  return tier === 'auto' || tier === 'workdir' ? 'auto' : 'ask';
}

function settingsPath(): string {
  return join(ensureWorkpivotDir('config'), 'settings.json');
}

interface SettingsFile {
  version: 1;
  permissionTier?: Tier;
}

/**
 * RL1-02：有效档位两层合并——用户自选（个人层）优先，未自选回落全局默认档（policy 雏形，仅 admin 可改）。
 * 设计对照：Claude Code settings 分层（user→policy）的企业版简化；I07 策略下发（4b）将在默认档之上加 policy 锁。
 */
export function getTier(userId?: string): Tier {
  const personal = userId ? getUserTier(userId) : null;
  if (personal) return normalizeTier(personal);
  const settings = readJsonSafe<SettingsFile>(settingsPath(), { version: 1 }).value;
  return normalizeTier(settings.permissionTier ?? DEFAULT_TIER);
}

export function setTier(tier: Tier): void {
  const settings = readJsonSafe<SettingsFile>(settingsPath(), { version: 1 }).value;
  writeAtomic(settingsPath(), JSON.stringify({ ...settings, version: 1, permissionTier: normalizeTier(tier) }, null, 2));
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
  try { return pathWithin(path, dir); } catch { return false; }
}

/** 命令检查仅提供预判；实际隔离由执行沙箱强制实施。 */
function extractCommandPaths(command: string): string[] {
  const matches: string[] = command.match(/[A-Za-z]:[\\/][^\s"'|&;*)]*/g) ?? [];
  if (process.platform !== 'win32') for (const match of command.matchAll(/(?:^|[\s"'=])(\/[^\s"'|&;*)]*)/g)) matches.push(match[1]!);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const m of matches) {
    const key = process.platform === 'win32' ? m.toLowerCase() : m;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(m);
    }
  }
  return out;
}

function commandTouchesOutside(command: string, taskDir: string): string[] {
  return extractCommandPaths(command).filter((p) => {
    const abs = p.replace(/[\\/]+$/, '');
    if (withinDir(abs, taskDir)) return false; // 只允许任务目录自身/其子路径
    // Shell 无法可靠声明读写模式，路径白名单不豁免命令审批。
    return true;
  });
}

export interface PendingRequest {
  request: AccessRequest;
  taskId: string;
  userId: string;
  createdAt: number;
  resolve: (decision: Decision) => void;
}

const pending = new TenantMap<string, PendingRequest>();
export function pendingRequests(taskId: string, userId: string): AccessRequest[] {
  return [...pending.values()].filter((p) => p.taskId === taskId && p.userId === userId).map((p) => p.request);
}

export type ResolvePendingResult = 'resolved' | 'not-found' | 'forbidden' | 'invalid-decision';

/** 来自已认证路由的身份，不能从请求 body 获取。管理员可代管可见任务。 */
export interface PermissionActor {
  taskId: string;
  userId: string;
  role: 'admin' | 'member';
}

export function resolvePendingRequest(id: string, decision: unknown, actor: PermissionActor): ResolvePendingResult {
  if (decision !== 'allow' && decision !== 'deny' && decision !== 'session' && decision !== 'forever') {
    return 'invalid-decision';
  }
  const entry = pending.get(id);
  if (!entry) return 'not-found';
  if (entry.taskId !== actor.taskId || (entry.userId !== actor.userId && actor.role !== 'admin')) {
    return 'forbidden';
  }
  // 可选范围由服务端决定；伪造按钮请求不能扩大一次性授权。
  if (entry.request.scope === 'once' && decision !== 'allow' && decision !== 'deny') return 'invalid-decision';
  pending.delete(id);
  entry.resolve(decision);
  return 'resolved';
}

export interface EvaluateInput {
  external?: boolean;
  tool: string;
  kind: 'read' | 'write' | 'bash';
  paths: AccessPath[];
  command?: string;
  taskDir: string;
  /** RL1-02：档位归属用户（=任务所有者；admin 代跑/定时任务均不提权）。 */
  userId: string;
  taskId: string;
  signal?: AbortSignal;
  /** 仅服务端可设置，默认 120 秒。 */
  timeoutMs?: number;
  onSettled?: (id: string, decision: Decision, reason: 'decision' | 'aborted' | 'timeout') => void;
}

const EXTERNAL_ACTION_LABELS: Record<string, string> = {
  web_search: '联网搜索',
  web_fetch: '读取网页',
  browser_visit: '浏览网页',
};

/** 外部动作的用户可见名称；MCP 等未列出的仍归为“外部工具调用”。 */
export function externalActionLabel(tool: string): string {
  return EXTERNAL_ACTION_LABELS[tool] ?? '外部工具调用';
}

/**
 * 判定一次工具访问。返回 'allow'；需要用户决策时调用 onRequest（发授权卡）并等待。
 * 决策含义：allow=仅此次；session=本会话记住；forever=永久白名单（仅路径类）；deny=拒绝。
 */export async function evaluateAccess(
  input: EvaluateInput,
  onRequest: (request: AccessRequest) => void,
): Promise<{ allowed: boolean; auditedReason: string }> {
  if (input.signal?.aborted) return { allowed: false, auditedReason: '任务已停止' };
  const tier = getTier(input.userId);
  if (input.external) {
    // O-01：文案按工具生成，不再把所有外部调用都说成 MCP。
    const label = externalActionLabel(input.tool);
    const allowed = await ask(input, `${label}：请确认本次访问的目标与范围`, 'once');
    return { allowed, auditedReason: allowed ? `用户批准${label}（一次性）` : `${label}未获授权` };
  }
  // 工具声明的是相对任务目录的路径；边界判定必须先解析为绝对路径
  let absPaths: AccessPath[];
  try { absPaths = input.paths.map((p) => ({ mode: p.mode, path: canonicalPath(p.path, input.taskDir) })); }
  catch { return { allowed: false, auditedReason: '路径无法安全解析' }; }
  const outside = absPaths.filter((p) => !withinDir(p.path, input.taskDir));

  // 1) bash 命令：先过高危分类（bypass-immune）
  if (input.kind === 'bash' && input.command !== undefined) {
    const { danger, reason } = classifyCommand(input.command);
    if (danger) {
      const allowed = await ask(input, `高危命令：${reason ?? '命中高危模式'}`, 'once');
      return { allowed, auditedReason: allowed ? '用户批准高危命令（一次性）' : '用户拒绝高危命令' };
    }
    if (tier === 'ask') {
      const allowed = await ask(input, '确认模式：命令执行需确认', 'once');
      return { allowed, auditedReason: allowed ? '用户逐次批准命令' : '用户拒绝命令' };
    }
    // 彩排修复（I02 缺口）：非高危命令也可能引用任务目录之外的路径（如 type C:\...\settings.json
    // 绕过被拒的 read）——workdir/auto 档对含界外路径引用的命令仍需单次确认
    const outsideRefs = commandTouchesOutside(input.command, input.taskDir);
    if (outsideRefs.length > 0 && tier !== 'auto') {
      const allowed = await ask(
        { ...input, paths: outsideRefs.map((p) => ({ path: p, mode: 'read' as const })) },
        `命令引用任务目录之外的路径：${outsideRefs.join('、')}`,
        'once',
      );
      return { allowed, auditedReason: allowed ? '用户批准含界外路径的命令（一次性）' : '用户拒绝含界外路径的命令' };
    }
    return { allowed: true, auditedReason: `${tier} 档放行非高危命令` };
  }

  // 2) 文件类：全部界内
  if (outside.length === 0) {
    if (input.kind === 'read') return { allowed: true, auditedReason: '界内读取' };
    if (tier === 'ask') {
      const allowed = await ask(input, '确认模式：写入需确认', 'once');
      return { allowed, auditedReason: allowed ? '用户逐次批准写入' : '用户拒绝写入' };
    }
    return { allowed: true, auditedReason: `${tier} 档放行界内${input.kind === 'write' ? '写入' : '访问'}` };
  }

  // ask 的写入仍逐次确认；混合界内/界外请求只检查界外部分。
  if (!(tier === 'ask' && input.kind === 'write') && outside.every((p) => pathIsGranted(input, p.path, p.mode))) {
    return { allowed: true, auditedReason: '界外但命中白名单/会话授权' };
  }
  if (tier === 'auto') {
    return { allowed: false, auditedReason: `${tier} 档拒绝界外访问（${outside.map((p) => p.path).join(', ')}）` };
  }
  const allowed = await ask({ ...input, paths: absPaths }, '访问任务目录之外的路径', tier === 'ask' && input.kind === 'write' ? 'once' : 'session-or-forever');
  return { allowed, auditedReason: allowed ? '用户授权界外访问' : '用户拒绝界外访问' };

  async function ask(base: Omit<AccessRequest, 'id' | 'reason' | 'scope'>, reason: string, scope: AccessRequest['scope']): Promise<boolean> {
    const request: AccessRequest = {
      id: `pr-${randomUUID()}`,
      tool: base.tool,
      kind: base.kind,
      paths: base.paths,
      command: base.command,
      reason,
      scope,
    };
    const decision = await new Promise<Decision>((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined = undefined;
      const finish = (value: Decision, reason: 'decision' | 'aborted' | 'timeout'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener('abort', onAbort);
        pending.delete(request.id);
        resolve(value);
        try { input.onSettled?.(request.id, value, reason); } catch { /* 展示失败不阻塞清理 */ }
      };
      const onAbort = AsyncLocalStorage.bind((): void => finish('deny', 'aborted'));
      if (input.signal?.aborted) { finish('deny', 'aborted'); return; }
      pending.set(request.id, { request, taskId: input.taskId, userId: input.userId, createdAt: Date.now(), resolve: (value) => finish(value, 'decision') });
      input.signal?.addEventListener('abort', onAbort, { once: true });
      const timeout = input.timeoutMs;
      timer = setTimeout(() => finish('deny', 'timeout'), timeout !== undefined && Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 120_000) : 120_000);
      try { onRequest(request); } catch { finish('deny', 'aborted'); }
    });
    if (input.signal?.aborted) return false;
    if (decision === 'session' || decision === 'forever') {
      for (const p of request.paths) {
        if (!withinDir(p.path, input.taskDir)) grantPath(input, p.path, p.mode, decision);
      }
    }
    return decision === 'allow' || decision === 'session' || decision === 'forever';
  }
}
