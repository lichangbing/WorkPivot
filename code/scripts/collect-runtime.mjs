/**
 * M4：收集桌面打包所需的服务层运行时依赖（bash 子进程 require 的文档库及其传递依赖）。
 * pnpm deploy 目标目录必须为空——先清空重建（幂等，dist:dir 可反复跑）。
 */
import { execSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const codeDir = resolve(here, '..');
const target = resolve(codeDir, 'apps/desktop/build/server-deploy');

rmSync(target, { recursive: true, force: true });
execSync('pnpm --filter @workpivot/server deploy --prod --legacy ./apps/desktop/build/server-deploy', {
  cwd: codeDir,
  stdio: 'inherit',
});
console.log('[collect-runtime] 完成：', target);
