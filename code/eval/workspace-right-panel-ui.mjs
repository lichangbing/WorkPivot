// 验证右侧工作区三页签、文件预览、任务级恢复和隐藏浏览器轻量轮询。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { extname, resolve } from 'node:path';

const require = createRequire(new URL('../packages/server/package.json', import.meta.url));
const { chromium } = require('playwright');
const root = resolve('apps/web/dist');
const server = createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url, 'http://localhost').pathname;
    const file = resolve(root, pathname === '/' ? 'index.html' : '.' + pathname);
    if (!file.startsWith(root + '/')) throw Error('invalid path');
    response.setHeader('content-type', {
      '.html': 'text/html',
      '.js': 'text/javascript',
      '.css': 'text/css',
    }[extname(file)] ?? 'application/octet-stream');
    response.end(await readFile(file));
  } catch {
    response.writeHead(404);
    response.end();
  }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));

let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/google-chrome' });
  const pdfPage = await browser.newPage();
  await pdfPage.setContent('<!doctype html><meta charset="utf-8"><h1>PDF 预览验收</h1><p>这段文字必须由 Chrome PDF 阅读器渲染。</p>');
  const pdf = await pdfPage.pdf({ format: 'A4' });
  await pdfPage.close();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  let statusRequests = 0, screenshotRequests = 0;
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  await page.addInitScript(() => {
    try {
      localStorage.setItem('wp_token', 'synthetic-ui-token');
      localStorage.setItem('wp-right-panel-open', 'true');
    } catch { /* 初始 about:blank 没有存储权限，导航后仍会重新执行。 */ }
  });
  const now = new Date().toISOString();
  const task = { id: 'task-right', projectId: 'project-right', name: '右侧工作区测试', status: 'idle', revision: 1, createdAt: now };
  const artifact = { id: 'version-pdf', documentId: 'document-pdf', name: '分析报告.pdf', revision: 1, current: true };
  const upload = { id: 'version-md', documentId: 'document-md', name: '说明.md', revision: 1, current: true, knowledgeStatus: 'pending' };
  await page.route('**/api/**', async route => {
    const request = route.request(), pathname = new URL(request.url()).pathname;
    let data = { experts: [], suggestions: [], plans: [], checkpoints: [], files: [], artifacts: [], executions: [], builds: [], entries: [] };
    if (pathname === '/api/health') data = { ok: true, chatEnabled: true, storage: 'postgresql' };
    else if (pathname === '/api/auth/state') data = { authenticated: true, user: { id: 'owner', username: '合成用户', role: 'member' }, quota: { used: 0, limit: 10, remaining: 10 } };
    else if (pathname === '/api/tasks') data = { tasks: [task] };
    else if (pathname === '/api/projects') data = { projects: [{ id: 'project-right', name: '预览项目', revision: 1 }] };
    else if (pathname === '/api/tasks/task-right/conversation') data = { turns: [], nextCursor: null, hasMore: false, snapshotSequence: '1' };
    else if (pathname === '/api/tasks/task-right/conversation-changes') data = { events: [], nextSequence: '1', snapshotSequence: '1', hasMore: false };
    else if (pathname === '/api/tasks/task-right/interactions') data = { interactions: [], blocking: 0, queued: 0 };
    else if (pathname === '/api/tasks/task-right/steering') data = { steering: [] };
    else if (pathname === '/api/tasks/task-right/resource-scope') data = { scope: { versionIds: [], memoryScopes: [], expert: false, scheduleIds: [], baseRunId: null } };
    else if (pathname === '/api/tasks/task-right/parsing') data = { files: [] };
    else if (pathname === '/api/tasks/task-right/summary') data = { checkpoints: [] };
    else if (pathname === '/api/memory-suggestions' || pathname === '/api/expert-suggestions') data = { suggestions: [] };
    else if (pathname === '/api/workspace/stream') {
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: `data: ${JSON.stringify({ type: 'workspace', value: { tasks: [task], projects: [{ id: 'project-right', name: '预览项目', revision: 1 }], revision: '1' } })}\n\n` });
      return;
    }
    else if (pathname === '/api/tasks/task-right/files') data = { files: [upload] };
    else if (pathname === '/api/tasks/task-right/artifacts') data = { artifacts: [artifact] };
    else if (pathname === '/api/tasks/task-right/files/document-pdf/versions') data = { versions: [artifact] };
    else if (pathname === '/api/tasks/task-right/files/document-md/versions') data = { versions: [upload] };
    else if (pathname === '/api/tasks/task-right/file-versions/version-pdf/preview') {
      await route.fulfill({ status: 200, headers: { 'content-type': 'application/pdf' }, body: pdf });
      return;
    } else if (pathname === '/api/tasks/task-right/file-versions/version-md/preview') {
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/markdown; charset=utf-8' }, body: '# 已加载文件预览\n\n这是任务资料。' });
      return;
    } else if (pathname === '/api/tasks/task-right/browser/status') {
      statusRequests++;
      data = { available: true, open: false, busy: false, url: '', title: '', blockedRequests: 0 };
    } else if (pathname === '/api/tasks/task-right/browser') {
      screenshotRequests++;
      data = { available: true, open: false, busy: false, url: '', title: '', blockedRequests: 0 };
    } else if (pathname === '/api/tasks/task-right/stream') {
      await route.fulfill({ status: 200, headers: { 'content-type': 'text/event-stream' }, body: `data: ${JSON.stringify({ type: 'state', value: { tasks: [task], pending: [] } })}\n\n` });
      return;
    }
    await route.fulfill({ json: data });
  });

  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByText('预览项目', { exact: true }).waitFor();
    await page.getByRole('button', { name: '右侧工作区测试', exact: true }).click();
    const panel = page.getByRole('complementary', { name: '工作区右侧面板' });
    await panel.getByRole('tab', { name: '预览', exact: true }).waitFor();
    await panel.getByRole('tabpanel', { name: '预览' }).getByText('分析报告.pdf', { exact: true }).waitFor();
    await panel.locator('iframe[title="分析报告.pdf 预览"]').waitFor();
    const pdfFrame = panel.locator('iframe[title="分析报告.pdf 预览"]');
    assert.equal(await pdfFrame.getAttribute('sandbox'), null, 'Chrome PDF 阅读器不能被 sandbox 拦截');
    await page.waitForTimeout(1000);
    const pdfFrameText = await page.frameLocator('iframe[title="分析报告.pdf 预览"]').locator('body').innerText().catch(() => '');
    assert.ok(!pdfFrameText.includes('This page has been blocked by Chrome'), 'PDF 预览必须通过 Chrome 阅读器真实渲染');
    assert.equal(await panel.getByRole('tab', { name: '预览', exact: true }).getAttribute('aria-selected'), 'true');
    assert.ok(statusRequests >= 1, '隐藏浏览器页签应通过轻量接口探测会话');
    assert.equal(screenshotRequests, 0, '隐藏浏览器页签不应拉取截图');

    await panel.getByRole('tab', { name: '文件', exact: true }).click();
    await panel.getByTitle('预览 说明.md').waitFor();
    await panel.getByTitle('预览 说明.md').click();
    await panel.getByText('已加载文件预览', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => localStorage.getItem('wp-right-version:owner:task-right')), 'version-md');
    assert.equal(await page.evaluate(() => localStorage.getItem('wp-right-tab:owner:task-right')), 'preview');

    await panel.getByRole('tab', { name: '浏览器', exact: true }).click();
    await page.waitForTimeout(200);
    assert.ok(screenshotRequests >= 1, '切换到浏览器页签后应恢复截图');
    assert.deepEqual(errors, []);
    console.log('右侧工作区检查通过：三页签、PDF/Markdown 预览、选择恢复和隐藏截图暂停。');
  } catch (error) {
    console.error('页面错误:', errors);
    console.error('页面文本:', await page.locator('body').innerText().catch(() => ''));
    throw error;
  }
} finally {
  await browser?.close();
  server.close();
}
