/**
 * M4：打包前置准备（dist:dir 链第一步，幂等可反复跑）。
 * 1. 收集桌面打包所需的服务层运行时依赖（bash 子进程 require 的文档库及其传递依赖）：
 *    pnpm deploy 目标目录必须为空——先清空重建。
 * 2. 从 assets/logo 复制应用图标到 desktop build/（electron-builder 自动取 icon.ico，托盘取 icon.png）。
 */
import { execSync } from 'node:child_process';
import { copyFileSync, rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const codeDir = resolve(here, '..');
const repoRoot = resolve(codeDir, '..');
const target = resolve(codeDir, 'apps/desktop/build/server-deploy');

rmSync(target, { recursive: true, force: true });
execSync('pnpm --filter @workpivot/server deploy --prod --legacy ./apps/desktop/build/server-deploy', {
  cwd: codeDir,
  stdio: 'inherit',
});

for (const f of ['icon.ico', 'icon.png']) {
  copyFileSync(resolve(repoRoot, 'assets/logo', f), resolve(codeDir, 'apps/desktop/build', f));
}
console.log('[collect-runtime] 完成：', target);
