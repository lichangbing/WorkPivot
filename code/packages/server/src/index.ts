/**
 * 服务层（形态 A：与 Electron 主进程同进程挂载，T1-02 接入）。
 * 对前端只暴露 localhost HTTP/SSE；前端禁 import 本包（A01.3 拆分边界纪律）。
 */

/** 本地服务默认端口。 */
export const SERVER_PORT_DEFAULT = 39800;
