/**
 * W4 端到端评测：文档闭环（模拟 LLM 零成本）。
 * 覆盖：SKILL.md 三层发现与校验、系统提示词技能目录注入、斜杠激活全文注入、
 *       Word 生成工具链（write 脚本 → bash 运行(NODE_PATH→docx) → 写后自检）。
 * 运行：pnpm eval:w4
 */
import { createServer as createHttpServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const home = mkdtempSync(join(tmpdir(), 'wp4-home-'));
const workspace = mkdtempSync(join(tmpdir(), 'wp4-ws-'));
process.env['WORKPIVOT_HOME'] = home;
process.env['WORKPIVOT_WORKSPACE'] = workspace;

const { startServer } = await import('../packages/server/src/index.js');
const { listSkills } = await import('../packages/server/src/skills.js');

const results: Array<{ name: string; pass: boolean; detail?: string }> = [];
function assert(name: string, pass: boolean, detail?: string): void {
  results.push({ name, pass, detail });
  console.log(`${pass ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
}

// ---- 模拟供应商：按请求体特征响应 ----
const MOCK_PORT = 39921;
let sawSkillInSystem = false;
let sawSkillFullText = false;
let w4Step = 0;
let genFixed = false;
const mock: Server = createHttpServer((req, res) => {
  if (req.method === 'GET' && req.url?.endsWith('/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ data: [] }));
    return;
  }
  if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) {
    res.writeHead(404);
    res.end();
    return;
  }
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk.toString();
  });
  req.on('end', () => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (payload: unknown): void => {
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    };
    const toolCall = (name: string, args: string): void => {
      send({ choices: [{ delta: { role: 'assistant' } }] });
      send({ choices: [{ delta: { tool_calls: [{ index: 0, id: `c_${Math.random().toString(36).slice(2, 8)}`, function: { name, arguments: args } }] } }] });
      res.write('data: [DONE]\n\n');
      res.end();
    };
    const final = (text: string): void => {
      send({ choices: [{ delta: { content: text } }] });
      res.write('data: [DONE]\n\n');
      res.end();
    };
    const LF = String.fromCharCode(10);
    if (body.includes('docx-report')) sawSkillInSystem = true;
    if (body.includes('先写生成脚本')) sawSkillFullText = true;
    let lastUser = '';
    try {
      const parsed = JSON.parse(body) as { messages?: Array<{ role: string; content: string | null }> };
      const users = (parsed.messages ?? []).filter((m) => m.role === 'user');
      lastUser = String(users[users.length - 1]?.content ?? '');
    } catch {
      lastUser = body;
    }

    // 斜杠激活：注入技能全文
    if (lastUser.startsWith('/docx-report')) {
      if (body.includes('先写生成脚本')) sawSkillFullText = true;
      final('SKILL-SLASH-OK');
      return;
    }

    // Word 生成场景状态机（T4-02/T4-03：坏脚本→自检失败→修复→自检通过）
    if (lastUser.includes('生成 Word 测试文档')) {
      w4Step += 1;
      if (w4Step === 1) {
        toolCall('write', JSON.stringify({ path: 'gen-docx.cjs', content: [
          "require('fs').writeFileSync(process.argv[2], '这不是有效的 docx');"
        ].join(LF) }));
      } else if (w4Step === 2) {
        toolCall('bash', JSON.stringify({ command: 'node gen-docx.cjs report.docx' }));
      } else if (w4Step === 3) {
        toolCall('write', JSON.stringify({ path: 'check-docx.cjs', content: [
          "const b = require('fs').readFileSync(process.argv[2]);",
          "if (!(b[0] === 0x50 && b[1] === 0x4b && b.includes(Buffer.from('word/document.xml')) && b.length > 2000)) { console.error('自检失败'); process.exit(1); }",
          "console.log('自检通过', b.length);",
        ].join(LF) }));
      } else if (w4Step === 4) {
        toolCall('bash', JSON.stringify({ command: 'node check-docx.cjs report.docx' }));
      } else if (w4Step === 5) {
        genFixed = true;
        toolCall('write', JSON.stringify({ path: 'gen-docx.cjs', content: [
          "const { Document, Packer, Paragraph, TextRun } = require('docx');",
          "const fs = require('fs');",
          'const doc = new Document({ sections: [{ children: [new Paragraph({ children: [new TextRun("W4 工具链验证")] })] }] });',
          'Packer.toBuffer(doc).then((buf) => fs.writeFileSync(process.argv[2], buf));',
        ].join(LF) }));
      } else if (w4Step === 6) {
        toolCall('bash', JSON.stringify({ command: 'node gen-docx.cjs report.docx' }));
      } else if (w4Step === 7) {
        toolCall('write', JSON.stringify({ path: 'check-docx.cjs', content: [
          "const b = require('fs').readFileSync(process.argv[2]);",
          "if (!(b[0] === 0x50 && b[1] === 0x4b && b.includes(Buffer.from('word/document.xml')) && b.length > 2000)) { console.error('自检失败'); process.exit(1); }",
          "console.log('自检通过', b.length);",
        ].join(LF) }));
      } else if (w4Step === 8) {
        toolCall('bash', JSON.stringify({ command: 'node check-docx.cjs report.docx' }));
      } else {
        final('报告已生成并通过自检。');
      }
      return;
    } else if (body.includes('SKILL-MARKER')) {
      final('SKILL-DIRECTIVE-RECEIVED');
      return;
    } else if (body.includes('自检失败') || body.includes('自检通过')) {
      final(body.includes('自检通过') ? '报告已生成并通过自检。' : '自检未通过。');
      return;
    }
    final('（默认回复）');
  });
});
await new Promise<void>((resolve) => mock.listen(MOCK_PORT, '127.0.0.1', resolve));
const server = await startServer({ port: 39922 });
const base = `http://127.0.0.1:${server.port}`;

await fetch(`${base}/api/auth/register`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ username: 'admin', password: 'w4-smoke-123' }),
}).then(async (r) => {
  const { token } = (await r.json()) as { token: string };
  (globalThis as { __tok?: string }).__tok = token;
});
const auth = { authorization: `Bearer ${(globalThis as { __tok?: string }).__tok ?? ''}` };

await fetch(`${base}/api/providers`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...auth },
  body: JSON.stringify({ name: '模拟', baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`, modelId: 'mock-1' }),
});

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(base + path, { headers: { 'content-type': 'application/json', ...auth }, ...init });
  if (!response.ok) throw new Error(`${path} → HTTP ${response.status}: ${await response.text()}`);
  return (await response.json()) as T;
}

async function runTurn(taskId: string, content: string): Promise<string> {
  let text = '';
  const response = await fetch(`${base}/api/tasks/${taskId}/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...auth },
    body: JSON.stringify({ content }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body) throw new Error(`SSE HTTP ${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!line) continue;
      const event = JSON.parse(line.slice(5)) as Record<string, unknown>;
      if (event['type'] === 'assistant_delta') text += String(event['text']);
      if (event['type'] === 'tool_result') console.log('  [tool_result]', String(event['message']).slice(0, 160));
      if (event['type'] === 'error') console.log('  [error]', String(event['message']).slice(0, 160));
      if (event['type'] === 'error') throw new Error(`SSE error: ${String(event['message'])}`);
    }
  }
  return text;
}

try {
  // 1. T4-01：内置技能发现（源码目录随应用发行）
  const { task } = await json<{ task: { id: string; directory: string } }>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({ name: 'W4 冒烟' }),
  });
  const skills = listSkills(task.directory);
  const docxSkill = skills.find((s) => s.name === 'docx-report');
  assert('T4-01 内置技能 docx-report 被发现', Boolean(docxSkill) && docxSkill?.source === 'builtin');
  assert('T4-01 校验：非法技能被跳过（name≠目录名）', !skills.some((s) => s.name === 'not-valid'));

  // 项目技能发现 + 同名覆盖
  const projSkillDir = join(task.directory, '.workpivot', 'skills', 'docx-report');
  mkdirSync(projSkillDir, { recursive: true });
  writeFileSync(
    join(projSkillDir, 'SKILL.md'),
    '---\nname: docx-report\ndescription: 项目级覆盖版本。Use when 测试项目覆盖。\n---\n项目级覆盖内容 SKILL-MARKER。',
    'utf8',
  );
  const overridden = listSkills(task.directory).find((s) => s.name === 'docx-report');
  assert('T4-01 项目技能覆盖内置（同名）', overridden?.source === 'project');
  rmSync(projSkillDir, { recursive: true, force: true });

  // 2. 系统提示词技能目录注入（mock 检测请求体）
  const text1 = await runTurn(task.id, '生成 Word 测试文档');
  assert('T4-01 系统提示词注入技能目录', text1.includes('SKILL-DIRECTIVE-RECEIVED') || sawSkillInSystem, `sawSkillInSystem=${sawSkillInSystem}`);

  // 3. Word 生成工具链（T4-02/T4-03）：写脚本 → 运行(NODE_PATH→docx) → 写后自检
  assert('T4-02 gen-docx.cjs 已生成', existsSync(join(task.directory, 'gen-docx.cjs')));
  const reportPath = join(task.directory, 'report.docx');
  assert('T4-02 报告 docx 真实生成', existsSync(reportPath), '目录内容: ' + JSON.stringify(existsSync(task.directory) ? readdirSync(task.directory) : []));
  if (existsSync(reportPath)) {
    const bytes = readFileSync(reportPath);
    assert('T4-03 写后自检：docx 为有效 ZIP（PK 头）', bytes[0] === 0x50 && bytes[1] === 0x4b);
    assert('T4-03 自检：含 word/document.xml 部件', bytes.includes(Buffer.from('word/document.xml')));
    assert('T4-03 自检：体积合理（>2000B）', bytes.length > 2000, `${bytes.length}B`);
  }
  assert('T4-03 生成链完整收尾', text1.includes('报告已生成并通过自检。'), text1.slice(-60));
  assert('T4-03 修复重试链发生（自检失败→修复→通过）', genFixed);

  // 4. 斜杠激活：技能全文注入
  sawSkillFullText = false;
  const text2 = await runTurn(task.id, '/docx-report 请按技能说明再生成一份');
  assert('T4-01 斜杠激活注入技能全文', sawSkillFullText && text2.length > 0, `saw=${sawSkillFullText}`);
} catch (err) {
  assert('执行无未捕获异常', false, err instanceof Error ? err.message : String(err));
} finally {
  await server.close();
  mock.close();
  rmSync(home, { recursive: true, force: true });
  rmSync(workspace, { recursive: true, force: true });
}

const failed = results.filter((r) => !r.pass);
console.log(`\n===== W4 冒烟：${results.length - failed.length}/${results.length} 通过 =====`);
process.exit(failed.length > 0 ? 1 : 0);
