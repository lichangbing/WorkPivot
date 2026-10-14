# 源代码（pnpm monorepo）

## 当前开发入口

运行环境和包管理器版本以本目录 package.json、锁文件为准。用户界面在 apps/web，桌面外壳在 apps/desktop，业务服务在 packages/server，Agent 核心在 packages/core，共享协议在 packages/shared。

当前 PostgreSQL 运行入口为 scripts/database-server.mts，业务组装在 packages/server/src/database/runtime.ts；WSL 使用 eval/wsl-database-server.mts。前端通过后台 HTTP/SSE 通信，不要求后台与客户端在同一主机。原有文件存储代码仍保留，不能与数据库链路的验收结果混用。

### 检查方式（在 code 目录执行）

| 命令 | 范围 |
| --- | --- |
| pnpm typecheck | 工作区类型检查 |
| pnpm lint | 静态检查 |
| pnpm check:deps | 前端依赖边界 |
| pnpm check:licenses | 已安装 pnpm 依赖的许可证黑名单筛查，缺失声明单独提示；不是完整法律审查 |
| pnpm test:licenses | 许可证检查脚本自身的边界用例 |
| pnpm eval:chat-state | 数据库界面事件排序、去重与分组 |
| pnpm eval | 常规模拟评测；不包含数据库集成和真实模型验收 |
| pnpm eval:database | 独立临时 PostgreSQL 集成测试，需 Docker；Windows 使用 WSL |
| pnpm --filter @workpivot/web build | 用户端及管理端构建 |

数据库测试默认需要 postgres:17-alpine 镜像；可通过 WORKPIVOT_TEST_PG_IMAGE 显式指定已准备的受测版本。不要用业务数据库代替临时测试库。Windows 测试期间需保持 WSL 实例存活；本次审计发现无人持有前台进程时连接可能中断，保持实例运行后复测通过，详见工程检查记录。测试覆盖范围见 [eval/README.md](eval/README.md)，部署采用对应环境的最新记录。

开发规范见 [AGENTS.md](../AGENTS.md)，当前计划见 [数据库与知识开发计划](../docs/03-project/tasks-postgresql-knowledge.md)。

## 以下为早期实现记录

以下 M0 技术选择、认证设想、同进程拓扑、环境变量和任务提交约定仅用于理解历史，不覆盖当前代码、开发规范与部署记录。

> 工程于 2026-09-05 建立（M0 竖切开工，T1-01）。依据：ADR-002（编排内核=自研微内核）、
> [数据目录规范](../docs/02-design/architecture/数据目录规范.md)、plan-2026 / tasks-m0。

## 历史结构（M0 · 形态 A：服务层与 Electron 主进程同进程）

```
code/
├── apps/
│   ├── desktop/           # 桌面端 Electron 主进程（窗口/托盘/更新 + 挂载服务层，T1-02）
│   └── web/               # 前端：React + Tailwind + Vite（三栏 UI，仅经 localhost HTTP/SSE 通信）
├── packages/
│   ├── server/            # 服务层：HTTP/SSE、任务、审计（前端禁 import，拆分边界纪律 A01.3）
│   ├── core/              # agent 编排内核（T1-04：循环/工具注册/事件流；ADR-002 自研）
│   └── shared/            # 共享类型/常量/日志（浏览器入口 . 与 Node 入口 ./node 分离）
├── eval/                  # 评测题库（K01：任务验收的机器断言脚本）
├── scripts/               # 工程脚本（check-licenses.mjs = K05 许可黑名单）
├── Dockerfile             # 服务端镜像（拓扑二基础，v0.2.0；docker-compose.yml 在仓库根）
├── eslint.config.js / tsconfig.base.json / pnpm-workspace.yaml
```

拓扑二（服务端集中部署）基础已随 v0.2.0 落地：`code/Dockerfile` 构建服务端镜像，仓库根 `docker-compose.yml` 编排
（数据卷持久化/健康检查/时区），部署步骤与环境变量见 [releases/deploy/部署说明.md](../releases/deploy/部署说明.md)。
`services/`（后端按域拆分）与 `deploy/`（编排源文件目录化）仍留待规模触发；`im-bot` 属 Q3 未定项。
演进路线见 plan-2026 架构澄清节。

## 已定技术决策

- **栈**：全栈 TypeScript/Node 22（ESM）；前端 React + Tailwind（2026-09-05 确认）；Electron 37
- **内核**：自研微内核（ADR-002，2026-09-05 定案；pi-agent-core 仅作退化选项，触发条件见 ADR）
- **存储**：M0 纯文件 JSONL + store 三原语（原子写/.bak/坏文件隔离，T1-08）；SQLite 见数据目录规范 §5 触发器
- **技能**：SKILL.md 目录扫描热加载（D01）；**认证**：OAuth2/OIDC 主体 + 飞书首适配 + 管理员分配制（J07，M1）
- **沙箱基线**：项目绑定工作目录为权限主边界，界外须授权（I08）

## 工程纪律

1. **前端禁 import 服务层/内核**——只走 localhost HTTP/SSE（C05，W4 进 CI）
2. **业务持久化必经 store 层**（K02，T1-08 起强制）；日志允许直接追加
3. **`pnpm check:licenses` 是硬门禁**（K05：AGPL/PolyForm 一票否决）；参考仓库（codex/claude-code-leak 等）只读，代码与提示词原文不进本仓库
4. 每任务一 commit（message 带 T 编号），完成即更新 [tasks-m0.md](../docs/03-project/tasks-m0.md) 状态看板

## 常用命令

```bash
pnpm install
pnpm typecheck         # 全 workspace 类型检查
pnpm lint              # ESLint
pnpm check:licenses    # K05 许可黑名单
pnpm dev:web           # 前端 dev server（T1-02 起并入桌面壳启动链）
```

## 服务端环境变量（拓扑二部署，详见部署说明）

| 变量 | 默认 | 说明 |
|------|------|------|
| `WORKPIVOT_HOST` | 0.0.0.0（镜像内已设；桌面默认 127.0.0.1） | 监听地址 |
| `WORKPIVOT_PORT` | 39800 | 服务端口 |
| `WORKPIVOT_MAX_PARALLEL` | 8（compose 内 16） | 同时运行的 agent 任务上限 |
| `WORKPIVOT_HOME` | /data/workpivot | 应用数据根 |
| `WORKPIVOT_WORKSPACE` | /data/workspace | 工作区根（任务真实文件） |

## 私有化交付注意（承占位版约定）

1. 所有依赖可离线获取（npm 镜像化；Electron 二进制走内网镜像，A07 自建更新源）
2. `deploy/`（编排源文件，入库）与根 `releases/`（发布产物，大文件不入库）的关系不变
