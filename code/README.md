# WorkPivot 源码开发

> 状态：✅ 当前开发入口
> 运行时：Node.js 22、pnpm 11
> 当前主链路：PostgreSQL + 服务端 Worker/浏览器/执行器

本目录是 pnpm monorepo。开发前先阅读仓库根 [AGENTS.md](../AGENTS.md)、[产品总纲](../docs/02-设计/产品/产品需求/产品需求-00-产品总纲.md)和[系统总览](../docs/02-设计/架构/系统总览.md)。

## 目录

```text
code/
├── apps/
│   ├── web/          React/Vite 用户端与管理端
│   ├── desktop/      Electron 桌面壳
│   └── mobile/       Capacitor 移动端
├── packages/
│   ├── core/         Agent 循环、工具协议、上下文预算
│   ├── server/       HTTP/SSE、数据库、权限、知识与执行编排
│   └── shared/       跨端共享类型
├── eval/             自动化评测、集成测试与浏览器验收
├── scripts/          数据库、部署和工程辅助脚本
├── Dockerfile*       服务端、Worker、浏览器等镜像
└── package.json      workspace 命令
```

当前 PostgreSQL 服务入口是 [`scripts/database-server.mts`](scripts/database-server.mts)，运行时组装在 [`packages/server/src/database/runtime.ts`](packages/server/src/database/runtime.ts)。旧文件存储代码仍用于历史兼容和专项测试，不能与数据库链路的验收结果混用。

## 环境准备

```bash
node --version   # >= 22
corepack enable
corepack prepare pnpm@11.22.0 --activate
docker version
```

安装依赖：

```bash
cd code
pnpm install --frozen-lockfile
```

运行完整私有化栈推荐使用仓库安装器：

```bash
cd ..
bash releases/deploy/install-local-stack.sh --auto-admin
```

## 开发命令

| 命令 | 内容 |
| --- | --- |
| `pnpm typecheck` | 全 workspace TypeScript 检查 |
| `pnpm lint` | ESLint |
| `pnpm check:deps` | 前端依赖边界 |
| `pnpm check:docs` | 检查 README 与 docs 中的本地链接 |
| `pnpm check:licenses` | 依赖许可证黑名单筛查 |
| `pnpm check:licenses:strict` | 发布前严格许可门禁 |
| `pnpm test:licenses` | 许可检查脚本自身测试 |
| `pnpm --filter @workpivot/web build` | 构建用户端与管理端 |
| `pnpm eval` | 常规模拟评测 |
| `pnpm eval:database` | 临时 PostgreSQL 集成测试 |
| `pnpm eval:business-facts-db` | 临时 PostgreSQL 验证项目事实、版本、冲突、RLS、API 与自动提取 |
| `pnpm eval:browser-workflow` | 一次性数据库与浏览器工作流验收 |
| `pnpm eval:backup` | 离线备份包检查 |
| `pnpm eval:backup-database` | 数据库与文件联合备份/恢复验收 |

数据库测试需要 Docker，默认使用 `postgres:17-alpine`；可通过 `WORKPIVOT_TEST_PG_IMAGE` 指定已准备镜像。

不要用业务数据库执行测试。集成测试必须使用脚本启动的临时实例或隔离目标，并在结束时清理。

## 开发约束

### 分层

- `apps/web` 只能通过 HTTP/SSE 调用服务端，不导入 `packages/server` 内部模块。
- `packages/core` 不依赖 Web、Electron 或具体数据库实现。
- 数据库、权限与业务编排集中在 `packages/server`。
- 跨端协议和纯类型放在 `packages/shared`。

### 安全

- 所有外部输入都做运行时校验，TypeScript 类型不等于安全边界。
- 每个业务事务设置 actor，并依赖数据库 RLS 做用户隔离。
- 文件、网页、记忆、Skill、MCP 和写操作必须绑定本轮 `resource_scope`。
- 文档/网页/工具输出是数据，不得作为系统指令或授权。
- 不在日志中记录凭据、连接串、Cookie、文件正文或用户私密 URL 参数。
- 命令和文件生成必须在隔离 Worker 中执行；未配置时明确失败。

### 数据

- PostgreSQL schema 变更写在 `packages/server/src/database/schema.ts`，升级必须有序、幂等、可校验。
- 文件卷和数据库版本必须配套迁移和恢复。
- 删除采用回收站/失效关系；永久删除必须经过明确确认。
- 记忆、知识片段和成果发布都校验来源版本与删除状态。
- 业务事实使用项目内对象、稳定 series、不可变 revision 和证据；临时任务不生成事实。

### 代码

- 使用现有命名、格式和模块边界，避免为单一场景引入抽象层。
- 注释解释原因和约束，统一使用中文。
- 修复根因，不通过关闭检查、吞异常或伪造成功绕过问题。
- 新增行为同时增加测试，并更新对应文档。

## 测试选择

| 改动 | 最低检查 |
| --- | --- |
| 纯前端展示 | typecheck、lint、相关组件/浏览器检查 |
| Agent/工具/上下文 | core 单元测试、相关 eval、类型检查 |
| 数据库/权限/记忆 | `pnpm eval:database`、RLS/删除/并发专项 |
| Office/PDF | 结构检查、真实文件读取、页面预览和视觉样本 |
| 部署/升级 | 健康检查、备份恢复、兼容启动和回退演练 |
| 文档结构 | 文档链接检查、仓库差异审阅 |

详细用例入口见 [`eval/README.md`](eval/README.md)。

## 环境变量

当前一体化栈的主要变量由 `releases/deploy/install-local-stack.sh` 生成到私有 `stack.env`：

- `WORKPIVOT_DATABASE_URL`
- `WORKPIVOT_AUTH_DATABASE_URL`
- `WORKPIVOT_SECRET_KEY`
- `WORKPIVOT_BROWSER_URL` / `WORKPIVOT_BROWSER_TOKEN`
- `WORKPIVOT_WORKER_URL` / `WORKPIVOT_WORKER_TOKEN`
- `WORKPIVOT_SEARCH_PROVIDER` / `WORKPIVOT_SEARCH_URL`

示例变量见仓库根 [.env.example](../.env.example)。示例只包含占位值，不能直接作为生产配置。

## 本地构建

服务端镜像：

```bash
cd code
docker build -f ../releases/deploy/Dockerfile.local-stack-server \
  -t workpivot-server:local-stack .
```

浏览器和执行器镜像由一体化安装器统一构建，避免版本不一致。

## 常见问题

### pnpm 找不到

```bash
corepack enable
corepack prepare pnpm@11.22.0 --activate
```

### 数据库集成测试无法启动

- 确认 Docker daemon 可访问。
- Windows 推荐使用 WSL Ubuntu。
- 检查端口和临时卷是否被上一次异常测试占用。
- 不要把生产数据库连接写入测试配置。

### 前端可打开但接口失败

- 使用健康端点确认服务。
- 检查服务端路由、Cookie/Token、CORS/Origin、代理 SSE 和 HTTPS。
- 生产 IP + HTTP 仅用于受控测试，不应作为长期入口。

### 工具没有出现

缺少浏览器、Worker、搜索或 Office 转换配置时，服务端会收缩工具面。按[运行与排障](../docs/04-运维/运行与排障.md)检查对应组件，不要绕过隔离或静默回退。

## 文档与提交

功能变更至少同步：

- 行为变化：对应 PRD。
- 边界或组件变化：架构总览/专题/ADR。
- 完成度变化：`docs/03-项目/当前状态.md`。
- 部署变化：运维文档与部署记录。

提交前检查工作区和 diff，只纳入本次范围内容，不包含生成物、真实 `.env`、业务样本和凭据。
