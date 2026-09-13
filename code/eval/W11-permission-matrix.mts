import { join } from 'node:path';
import { evaluateAccess, resolvePendingRequest, type Tier, type EvaluateInput } from '../packages/server/src/permissions.js';
import { setUserTier } from '../packages/server/src/auth.js';
type Outcome = 'allow' | 'deny' | 'once' | 'session-or-forever';
export async function checkPermissionMatrix(userId: string, workspace: string, assert: (name: string, pass: boolean, detail?: string) => void): Promise<void> {
  const tiers: Tier[] = ['readonly', 'ask', 'workdir', 'auto'];
  const cases: Array<{ name: string; kind: EvaluateInput['kind']; path?: string; command?: string; expected: Outcome[] }> = [
    { name: '界内读', kind: 'read', path: 'file.txt', expected: ['allow', 'allow', 'allow', 'allow'] },
    { name: '界内写', kind: 'write', path: 'file.txt', expected: ['deny', 'once', 'allow', 'allow'] },
    { name: '界外读', kind: 'read', path: '../outside.txt', expected: ['deny', 'session-or-forever', 'session-or-forever', 'deny'] },
    { name: '界外写', kind: 'write', path: '../outside.txt', expected: ['deny', 'once', 'session-or-forever', 'deny'] },
    { name: '普通命令', kind: 'bash', command: 'echo hello', expected: ['deny', 'once', 'allow', 'allow'] },
    { name: '高危命令', kind: 'bash', command: 'git reset --hard', expected: ['deny', 'once', 'once', 'once'] },
    { name: '引用界外路径命令', kind: 'bash', command: 'type Z:/matrix-outside/test.txt', expected: ['deny', 'once', 'once', 'allow'] },
  ];
  try {
    for (const [index, tier] of tiers.entries()) {
      setUserTier(userId, tier);
      for (const c of cases) {
        const taskId = `matrix-${tier}-${c.name}`;
        let asked: Outcome | undefined;
        const result = await evaluateAccess({ userId, taskId, taskDir: join(workspace, 'matrix'), tool: c.kind, kind: c.kind, command: c.command, paths: c.path ? [{ path: c.path, mode: c.kind === 'write' ? 'write' : 'read' }] : [] }, (request) => {
          asked = request.scope;
          resolvePendingRequest(request.id, 'deny', { userId, taskId, role: 'member' });
        });
        const actual = asked ?? (result.allowed ? 'allow' : 'deny');
        assert(`RL1-04 ${tier} × ${c.name}`, actual === c.expected[index], `预期=${c.expected[index]} 实际=${actual}`);
      }
    }
  } finally { setUserTier(userId, null); }
}
