# 设计文档

基于产品研究结论进行设计，是开发实施的直接依据。

2026-09-13 插入当前开发批次：[会话项目删除与对话分页](architecture/会话项目删除与对话分页.md)，对应K01-D/K01-P；后台关联清理与首次5轮、上拉分页，尚未实现。

2026-09-13 实施进展：[K01数据库基础第一批](../03-project/K01-数据库基础实现记录.md)已完成独立PostgreSQL验证；正式界面和执行管线尚未切换，现有部署继续使用文件版。

2026-09-13 首版范围：[服务端集中存储与项目组协作预留](architecture/服务端集中存储与项目组协作预留.md)。数据库、RAG与业务数据全部在后台，用户端只负责交互；项目组同步列入后续 K09。

2026-09-13 补充：[三层记忆自动更新](architecture/三层记忆自动更新.md)已纳入[总开发计划 K07](../03-project/tasks-postgresql-knowledge.md)，包含分层策略、用户控制、版本与遗忘一致性，尚未实现。

2026-09-13 新增：[PostgreSQL 与项目知识数据架构](architecture/PostgreSQL与项目知识数据架构.md)、[RAG 知识库、版本与遗忘管理](architecture/RAG知识库、版本与遗忘管理.md)、[ADR-003 PostgreSQL 与文件混合存储](decisions/ADR-003-PostgreSQL与文件混合存储.md)。不迁移旧数据，按新数据库开发；RAG、版本管理和用户自主删除纳入核心范围。当前运行版本仍为文件存储，尚未执行建库。

## ✅ 阶段准入标准（2026-08-28 达成，设计阶段已启动）

《[研究结论汇总](../01-research/conclusions/研究结论汇总.md)》已完成，准入三项全部满足：

- [x] 产品定位建议与目标客户画像（客户画像含待验证假设 Q5/Q6，随种子客户接触修正）
- [x] MVP 功能范围建议（需求清单 P0 分层）
- [x] 后端技术栈与桌面端框架的选型结论（全栈 TS / Electron / Cordis 方向均已定案）

## PRD 分册索引（2026-08-29 · 6 册全部完成，配套原型在 `prototypes/`）

> **整体原型：[app.html](prototypes/app.html)** —— 六册 PRD 全部界面（30 页）合一，全局目录抽屉 + hash 路由 + 按产品流程的页面间点击跳转；分册原型保留作单册参考。

| PRD | 范围 | 原型 |
|-----|------|------|
| [PRD-01 登录与账户](product/PRD-01-登录与账户.md) | 登录/注册管理员/首登改密/引导/用户管理 | [prd01-login.html](prototypes/prd01-login.html) |
| [PRD-02 对话与任务](product/PRD-02-对话与任务.md) | 三栏主界面/状态机/过程主线/授权卡/续跑/定时任务/本地缓存 | [prd02-task.html](prototypes/prd02-task.html) |
| [PRD-03 技能与专家](product/PRD-03-技能与专家.md) | 技能市场+我的技能/编辑器/试运行/文档生成/专家配置 | [prd03-skills.html](prototypes/prd03-skills.html) |
| [PRD-04 后台管理](product/PRD-04-后台管理.md) | 模型管理/连接器/RAG/默认agent.md/公共技能/审计 | [prd04-admin.html](prototypes/prd04-admin.html) |
| [PRD-05 记忆管理](product/PRD-05-记忆管理.md) | 双层记忆/晋升确认卡/项目记忆/上下文管理 | [prd05-memory.html](prototypes/prd05-memory.html) |
| [PRD-06 设置](product/PRD-06-设置.md) | 通用/通知/安全设备/备份/更新回滚 | [prd06-settings.html](prototypes/prd06-settings.html) |

## 目录说明

| 目录 | 内容 | 主要产出物 |
|------|------|-----------|
| `product/` | 产品设计 | PRD、功能规格说明书（模板：[_template-PRD.md](product/_template-PRD.md)）；**[需求池 backlog.md](product/backlog.md)**（仅登记未排期的需求，不受下方准入门槛限制）；**[需求清单 v2](product/需求清单.md)**（详细需求规格：14 模块含后台管理 M 与公共 Skill/MCP 服务 S，每条含背景/用户故事/功能要求/边界/验收/依赖） |
| `architecture/` | 系统架构 | 总体架构设计、私有化部署架构、多租户/权限模型、API 设计、数据模型 |
| `ui-ux/` | 交互与视觉 | 设计规范、原型稿导出、桌面端交互说明（源文件存 Figma 等，此处放导出物与说明） |
| `decisions/` | 决策记录 | ADR 架构决策记录（模板：[_template-ADR.md](decisions/_template-ADR.md)） |

## 设计流程与编号规则

1. 每个重要版本/功能域先写 PRD（`product/`），评审通过后进入架构设计（`architecture/`）
2. 涉及技术选型、架构取舍的结论，必须同步落 ADR，命名：`ADR-{序号}-{标题}.md`（如 `ADR-001-后端技术栈选型.md`），序号递增不复用
3. 文档命名统一 `{编号}-{主题}.md`（如 `01-总体架构.md`），同一主题修订在文内记录变更历史

## 评审要求

- PRD 与架构设计文档须经评审后定稿，文首标注状态：📝 草稿 / 🔄 评审中 / ✅ 已定稿
- 已定稿文档的实质性修改需在文末「变更记录」中登记
