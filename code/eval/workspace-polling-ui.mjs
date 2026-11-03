// 标签页隐藏时暂停工作台轮询，恢复可见后立即补拉。
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
    response.setHeader(
      'content-type',
      { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }[
        extname(file)
      ] ?? 'application/octet-stream',
    );
    response.end(await readFile(file));
  } catch {
    response.writeHead(404);
    response.end();
  }
});

await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({
    headless: true,
    executablePath: '/usr/bin/google-chrome',
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack ?? error.message));
  await page.addInitScript(() => {
    localStorage.setItem('wp_token', 'synthetic-ui-token');
    localStorage.setItem('wp-right-panel-open', 'false');
  });

  const task = {
    id: 'task-startup',
    projectId: 'project-startup',
    name: '轮询测试',
    status: 'idle',
    revision: 1,
    createdAt: new Date().toISOString(),
  };
  const pollingPaths = [
    '/api/memory-suggestions',
    '/api/expert-suggestions',
    '/api/tasks/task-startup/parsing',
    '/api/tasks/task-startup/summary',
    '/api/automations',
  ];
  const pollingSeen = new Map(
    pollingPaths.map(pathname => [pathname, 0]),
  );
  const countRequest = pathname => {
    if (!pollingSeen.has(pathname)) return;
    pollingSeen.set(pathname, (pollingSeen.get(pathname) ?? 0) + 1);
  };
  const counts = () => Object.fromEntries(pollingSeen);
  const assertAtLeastOne = () => {
    for (const pathname of pollingPaths) {
      assert.ok((pollingSeen.get(pathname) ?? 0) >= 1, `${pathname} 应完成首次刷新`);
    }
  };

  await page.route('**/api/**', async route => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    countRequest(pathname);

    let data = {
      experts: [],
      suggestions: [],
      plans: [],
      checkpoints: [],
      files: [],
      executions: [],
      builds: [],
      entries: [],
    };
    if (pathname === '/api/health') {
      data = { ok: true, chatEnabled: true, storage: 'postgresql' };
    } else if (pathname === '/api/auth/state') {
      data = {
        authenticated: true,
        user: { id: 'owner', username: '合成用户', role: 'member' },
        quota: { used: 0, limit: 10, remaining: 10 },
      };
    } else if (pathname === '/api/tasks') {
      data = { tasks: [task] };
    } else if (pathname === '/api/projects') {
      data = {
        projects: [
          {
            id: 'project-startup',
            name: '轮询项目',
            revision: 1,
            createdAt: task.createdAt,
          },
        ],
      };
    } else if (pathname === '/api/memory-suggestions') {
      data = { suggestions: [] };
    } else if (pathname === '/api/experts') {
      data = { experts: [] };
    } else if (pathname === '/api/expert-suggestions') {
      data = { suggestions: [] };
    } else if (pathname === '/api/tasks/task-startup/conversation') {
      data = { turns: [], nextCursor: null, hasMore: false, snapshotSequence: '1' };
    } else if (pathname === '/api/tasks/task-startup/conversation-changes') {
      data = { events: [], nextSequence: '1', snapshotSequence: '1', hasMore: false };
    } else if (pathname === '/api/tasks/task-startup/permissions') {
      data = { pending: [] };
    } else if (pathname === '/api/tasks/task-startup/interactions') {
      data = { interactions: [], blocking: 0, queued: 0 };
    } else if (pathname === '/api/tasks/task-startup/steering') {
      data = { steering: [] };
    } else if (pathname === '/api/tasks/task-startup/stream') {
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
        body: `data: ${JSON.stringify({ type: 'state', value: { tasks: [task], pending: [] } })}\n\n`,
      });
      return;
    }
    await route.fulfill({ json: data });
  });

  try {
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByText('轮询项目', { exact: true }).waitFor();
    await page.getByRole('button', { name: '轮询测试', exact: true }).click();
    await page.getByRole('heading', { name: /轮询项目 \/ 轮询测试/ }).waitFor();
    await page.waitForTimeout(500);
    assertAtLeastOne();

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'hidden',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(300);
    const hiddenCounts = counts();
    await page.waitForTimeout(3500);
    assert.deepEqual(counts(), hiddenCounts, '页面隐藏后不应继续轮询');

    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', {
        configurable: true,
        get: () => 'visible',
      });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await page.waitForTimeout(500);
    for (const pathname of pollingPaths) {
      assert.ok(
        (pollingSeen.get(pathname) ?? 0) > (hiddenCounts[pathname] ?? 0),
        `${pathname} 应在恢复可见后立即刷新`,
      );
    }
    assert.deepEqual(errors, []);
    console.log('工作台轮询检查通过：隐藏时暂停，恢复可见后立即补拉。');
  } catch (error) {
    if (browser) {
      console.error('页面错误:', errors);
      console.error('页面文本:', await page.locator('body').innerText().catch(() => ''));
      console.error('轮询计数:', counts());
    }
    throw error;
  }
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
