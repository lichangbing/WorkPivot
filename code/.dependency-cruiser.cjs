/** T4-04/C05：依赖方向检查——前端禁依赖服务层/内核/桌面主进程（拆分边界纪律 A01.3）。 */
/** @type {import('dependency-cruiser').IConfiguration} */
module.exports = {
  forbidden: [
    {
      name: 'web-no-server-core-desktop',
      severity: 'error',
      comment: '前端只经 localhost HTTP/SSE 与服务层通信，禁止 import 服务层/内核/桌面主进程（A01.3/C05）',
      from: { path: '^apps/web' },
      to: { path: '^(packages/(server|core)|apps/desktop)' },
    },
  ],
  options: {
    /* 复用根 tsconfig 的 paths 解析（dependency-cruiser 自动读取 tsconfig） */
  },
};
