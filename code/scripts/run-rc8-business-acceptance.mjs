/**
 * RC.8 真实材料业务验收：使用本机测试栈、真实 DeepSeek、真实 Worker/Office，
 * 以仓库内已脱敏的项目材料完成五类业务任务。凭据从 0600 文件读取，不写入报告。
 */
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const base = process.env['WORKPIVOT_ACCEPTANCE_URL'] ?? 'http://127.0.0.1:39990';
const root = resolve(import.meta.dirname, '../..');
const evidenceRoot = join(root, 'local-runtime/acceptance/rc8-business');
const credentials = JSON.parse(readFileSync(join(root, 'local-runtime/acceptance/rc8-business-credentials.json'), 'utf8'));
const sourceFiles = {
  intro: join(root, 'docs/00-概览/项目介绍.docx'),
  state: join(root, 'docs/03-项目/当前状态.md'),
  roadmap: join(root, 'docs/03-项目/计划/公开发布与平台治理路线图-20261104.md'),
  deploy: join(root, 'docs/04-运维/快速部署.md'),
  updates: join(root, 'releases/deploy/client-updates.json'),
};
mkdirSync(evidenceRoot, { recursive: true });

async function request(path, init = {}) {
  const response = await fetch(base + path, {
    ...init,
    headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json', ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(60000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status} ${text.slice(0, 300)}`);
  return text ? JSON.parse(text) : null;
}

async function upload(taskId, path) {
  const name = basename(path), data = await readFile(path);
  const response = await fetch(base + `/api/tasks/${taskId}/files?${new URLSearchParams({ name, requestId: randomUUID() })}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/octet-stream' },
    body: data,
    signal: AbortSignal.timeout(60000),
  });
  if (!response.ok) throw new Error(`上传 ${name} 失败：HTTP ${response.status}`);
  return (await response.json()).file;
}

async function waitReady(taskId) {
  for (let attempt = 0; attempt < 240; attempt++) {
    const value = await request('/api/tasks');
    const status = value.tasks.find(task => task.id === taskId)?.status;
    if (status === 'idle' || ['failed', 'stopped', 'interrupted'].includes(status)) return status;
    await new Promise(done => setTimeout(done, 500));
  }
  throw new Error('任务未在时限内进入可发送状态');
}

function recommendedAnswer(question) {
  const options = Array.isArray(question.options) ? question.options : [];
  const selected = options.find(option => option.recommended) ?? options[0];
  if (selected?.label) return question.multiSelect ? [selected.label] : selected.label;
  return '请按当前已确认信息和现有文件继续执行，无需再次询问。';
}

async function continuationScope(taskId, versionIds) {
  const current = await request(`/api/tasks/${taskId}/resource-scope`);
  return {
    scheduleIds: current.scope.scheduleIds ?? [],
    versionIds,
    memoryScopes: current.scope.memoryScopes ?? [],
    expert: current.scope.expert === true,
    baseRunId: current.scope.baseRunId ?? null,
  };
}

async function consumeExecution(response, state, taskId, versionIds) {
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '');
    throw new Error(`执行请求失败：HTTP ${response.status}${detail ? ` ${detail.slice(0, 500)}` : ''}`);
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    state.events.push(await response.json());
    return;
  }
  let buffer = '';
  const decoder = new TextDecoder();
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
      const line = frame.split('\n').find(value => value.startsWith('data:'));
      if (!line) continue;
      const event = JSON.parse(line.slice(5).trim());
      state.events.push(event);
      if (event.type === 'assistant_delta') state.text += String(event.text ?? '');
      if (event.type === 'tool_use') state.toolNames.push(String(event.toolName ?? ''));
      if (event.type === 'usage') {
        state.inputTokens += Number(event.inputTokens ?? 0);
        state.outputTokens += Number(event.outputTokens ?? 0);
      }
      if (event.type === 'error') state.errors.push(String(event.message ?? '执行错误'));
      if (event.type === 'done') state.done = event;
      if (event.type === 'permission_request') {
        if (state.handledPermissions.has(event.id)) continue;
        state.handledPermissions.add(event.id);
        await request(`/api/tasks/${taskId}/permissions/${event.id}`, { method: 'POST', body: JSON.stringify({ decision: 'allow', scope: 'once' }) });
      }
      if (event.type === 'interaction_request') {
        if (state.handledInteractions.has(event.interaction.id)) continue;
        state.handledInteractions.add(event.interaction.id);
        if (++state.interactions > 8) throw new Error('交互澄清次数过多');
        const interaction = event.interaction;
        if (interaction.kind === 'clarification') {
          const questions = Array.isArray(interaction.payload?.questions) ? interaction.payload.questions : [];
          const resourceScope = await continuationScope(taskId, versionIds);
          const follow = await fetch(base + `/api/tasks/${taskId}/interactions/${interaction.id}/respond`, {
            method: 'POST',
            headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json' },
            body: JSON.stringify({
              revision: interaction.revision,
              requestId: randomUUID(),
              response: { answers: questions.map(question => ({ questionId: question.id, value: recommendedAnswer(question) })) },
              resourceScope,
            }),
            signal: AbortSignal.timeout(12 * 60 * 1000),
          });
          await consumeExecution(follow, state, taskId, versionIds);
        } else {
          const decision = interaction.kind === 'artifact_review' ? 'approve' : 'approve';
          const resourceScope = await continuationScope(taskId, versionIds);
          await request(`/api/tasks/${taskId}/interactions/${interaction.id}/respond`, {
            method: 'POST',
            body: JSON.stringify({
              revision: interaction.revision,
              requestId: randomUUID(),
              response: { decision },
              resourceScope,
            }),
          });
        }
      }
    }
  }
}

async function turn(taskId, content, versionIds) {
  await waitReady(taskId);
  const response = await fetch(base + `/api/tasks/${taskId}/messages`, {
    method: 'POST',
    headers: { authorization: `Bearer ${credentials.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      content, requestId: randomUUID(),
      resourceScope: { scheduleIds: [], versionIds, memoryScopes: [], expert: false, baseRunId: null },
    }),
    signal: AbortSignal.timeout(12 * 60 * 1000),
  });
  const state = {
    events: [], text: '', errors: [], toolNames: [], inputTokens: 0, outputTokens: 0,
    done: null, interactions: 0, handledInteractions: new Set(), handledPermissions: new Set(),
  };
  await consumeExecution(response, state, taskId, versionIds);
  return {
    text: state.text,
    errors: state.errors,
    toolNames: state.toolNames,
    inputTokens: state.inputTokens,
    outputTokens: state.outputTokens,
    stopReason: String(state.done?.stopReason ?? 'missing_done'),
  };
}

async function artifacts(taskId) {
  return (await request(`/api/tasks/${taskId}/artifacts`)).artifacts;
}

async function download(taskId, artifact, target) {
  const response = await fetch(base + `/api/tasks/${taskId}/file-versions/${artifact.id}`, {
    headers: { authorization: `Bearer ${credentials.token}` }, signal: AbortSignal.timeout(120000),
  });
  if (!response.ok || !response.body) throw new Error('下载业务成果失败');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(target, { mode: 0o600 }));
}

const project = (await request('/api/projects', { method: 'POST', body: JSON.stringify({ name: 'RC.8 真实材料业务验收' }) })).project;
const executionMode = (await request('/api/preferences/execution.mode')).setting;
if (executionMode?.value !== 'auto') {
  await request('/api/preferences/execution.mode', {
    method: 'PUT',
    body: JSON.stringify({ value: 'auto', revision: executionMode?.revision ?? 0 }),
  });
}
const allCases = [
  {
    id: 'RB-01', name: '产品简报', file: 'intro', artifact: 'RC8-产品简报.docx', marker: 'RC8-RB01',
    prompt: '读取上传的《项目介绍.docx》，生成真实可下载的 Word 产品简报 RC8-产品简报.docx。内容必须基于文件，包含产品定位、目标用户、核心能力和一条明确限制，并在正文写入标记 RC8-RB01。先 load_skill docx-report，再严格按技能说明用 execute_skill 生成。',
  },
  {
    id: 'RB-02', name: '发布门禁表', file: 'state', artifact: 'RC8-发布门禁.xlsx', marker: 'RC8-RB02',
    prompt: '读取上传的《当前状态.md》，生成真实可下载的 Excel 发布门禁表 RC8-发布门禁.xlsx，列包含检查项、当前状态、证据、剩余动作；至少覆盖真机、长稳、真实业务、发布工程。正文包含标记 RC8-RB02。先 load_skill xlsx-report，再用 execute_skill 生成。',
  },
  {
    id: 'RB-03', name: '发布路线汇报', file: 'roadmap', artifact: 'RC8-发布路线.pptx', marker: 'RC8-RB03',
    prompt: '读取上传的发布路线图，生成 5 页真实可下载的 PowerPoint RC8-发布路线.pptx，依次说明目标、RC.8范围、正式版门禁、风险、下一步。每页内容基于文件，首页包含 RC8-RB03。先 load_skill pptx-report，再用 execute_skill 生成。',
  },
  {
    id: 'RB-04', name: '部署操作审查', file: 'deploy', artifact: 'RC8-部署审查.pdf', marker: 'RC8-RB04',
    prompt: '读取上传的《快速部署.md》，生成一份 PDF 部署审查报告 RC8-部署审查.pdf，列出前置条件、核心步骤、数据保护、失败回退和运维风险。正文包含 RC8-RB04，必须使用 create_pdf 生成真实 PDF。',
  },
  {
    id: 'RB-05', name: '事实校正', file: 'state', extraFile: 'updates', artifact: 'RC8-事实校正.md', marker: 'RC8-RB05',
    prompt: '读取上传的《当前状态.md》和 client-updates.json。找出文档中关于 Android 版本和自动更新状态的旧口径，以更新清单中的 Android 1.11、build 12 为依据生成 Markdown 事实校正报告 RC8-事实校正.md。报告必须列出“旧口径、当前事实、证据、仍需完成”，并包含标记 RC8-RB05。使用 save_artifact 真实保存。',
  },
];
const selectedCases = (process.env.WORKPIVOT_ACCEPTANCE_CASES ?? '').split(',').map(value => value.trim()).filter(Boolean);
const cases = selectedCases.length ? allCases.filter(item => selectedCases.includes(item.id)) : allCases;
if (!cases.length) throw new Error('没有匹配的业务验收用例');

const results = [];
for (const item of cases) {
  const task = (await request('/api/tasks', { method: 'POST', body: JSON.stringify({ name: `RC.8 ${item.name}`, projectId: project.id }) })).task;
  const files = [await upload(task.id, sourceFiles[item.file])];
  if (item.extraFile) files.push(await upload(task.id, sourceFiles[item.extraFile]));
  const run = await turn(task.id, item.prompt, files.map(file => file.id));
  const rows = await artifacts(task.id);
  const target = rows.find(row => row.name === item.artifact);
  const errors = [...run.errors];
  if (run.stopReason !== 'completed') errors.push(`停止原因 ${run.stopReason}`);
  if (!target) errors.push(`缺少 ${item.artifact}`);
  if (!run.text.includes(item.marker)) errors.push(`回答缺少标记 ${item.marker}`);
  let evidence = '';
  if (target) {
    const path = join(evidenceRoot, item.artifact);
    await download(task.id, target, path);
    evidence = path;
    if (target.size < 100) errors.push('成果文件过小');
    if (/\.(docx|xlsx|pptx)$/i.test(item.artifact)) {
      const require = (await import('node:module')).createRequire(import.meta.url);
      const AdmZip = require('../packages/server/node_modules/adm-zip');
      const zip = new AdmZip(path);
      const body = zip.getEntries().map(entry => zip.readAsText(entry.entryName)).join('\n');
      if (!body.includes(item.marker)) errors.push('Office 成果正文缺少验收标记');
    }
  }
  results.push({
    id: item.id, taskId: task.id, passed: errors.length === 0, errors,
    artifact: target?.name ?? null, artifactId: target?.id ?? null, bytes: target?.size ?? 0,
    evidence, tools: run.toolNames, inputTokens: run.inputTokens, outputTokens: run.outputTokens,
    summary: run.text.slice(0, 800),
  });
  console.log(`${errors.length ? '❌' : '✅'} ${item.id} ${item.name}${errors.length ? ' · ' + errors.join('；') : ''}`);
}

const report = {
  passed: results.every(row => row.passed), generatedAt: new Date().toISOString(),
  scope: '本机测试栈、真实 DeepSeek、真实 Worker/Office、仓库内已脱敏项目材料',
  account: credentials.username, projectId: project.id, cases: results,
  inputTokens: results.reduce((sum, row) => sum + row.inputTokens, 0),
  outputTokens: results.reduce((sum, row) => sum + row.outputTokens, 0),
};
writeFileSync(join(evidenceRoot, 'report.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ passed: report.passed, cases: results.map(row => row.id), inputTokens: report.inputTokens, outputTokens: report.outputTokens }));
process.exit(report.passed ? 0 : 1);
