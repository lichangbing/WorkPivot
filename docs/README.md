# WorkPivot 文档中心

> 最后整理：2026-10-28
> 适用范围：当前 PostgreSQL 运行链路、`v0.3.0-rc.1` 候选版本与后续私有化部署

本目录按“从产品为什么存在，到系统如何实现，再到如何交付和运行”的顺序组织，而不是按开发时间堆放文件。聊天记录、周报和一次性实施日志属于证据，不作为当前行为的第一依据。

## 先读什么

| 角色 | 建议顺序 |
| --- | --- |
| 产品/业务负责人 | [产品总纲](02-design/product/prd/PRD-00-产品总纲.md) → [竞品总览](01-research/competitors/README.md) → [项目状态](03-project/STATUS.md) |
| 新加入的开发者 | [根 README](../README.md) → [系统总览](02-design/architecture/系统总览.md) → [源码说明](../code/README.md) → [ADRs](02-design/decisions/) |
| 测试/验收人员 | [PRD 总纲](02-design/product/prd/PRD-00-产品总纲.md) → [验收标准](02-design/product/prd/PRD-00-产品总纲.md#12-验收指标) → [项目状态](03-project/STATUS.md) → [历史验收](03-project/HISTORY.md) |
| 运维/私有化交付 | [快速部署](04-operations/快速部署.md) → [远程部署记录](03-project/deployments/远程部署-20261026.md) → [备份恢复](03-project/deployments/backup-recovery-20261016.md) |

## 分层结构

```text
docs/
├── 00-overview/       产品一页纸与统一叙事
├── 01-research/       市场、竞品、技术研究与决策输入
│   └── competitors/   一产品一主卡 + evidence/ 原始证据
├── 02-design/
│   ├── product/       prd/ 当前 PRD + requirements/ 需求来源
│   ├── architecture/  总览、运行时、数据、安全、能力、交付、归档
│   ├── decisions/     ADR，一次决策一份记录
│   ├── prototypes/    交互原型
│   └── ui-ux/         视觉与资产规范
├── 03-project/        当前状态与索引
│   ├── planning/      计划、任务台账、工程债与可靠性问题
│   ├── verification/  验收、复盘、截图与复现脚本
│   ├── deployments/   安装、升级、备份、回退与远程部署
│   └── weekly/        周报
└── 04-operations/     安装、升级、备份、监控和排障
```

### 00 概览

用于第一次接触项目的人快速理解产品。它不承载详细需求和实施记录。

主要入口：

- [WorkPivot 项目介绍](00-overview/WorkPivot-项目介绍.md)
- [根 README](../README.md)

### 01 研究与证据

研究文档用于解释设计依据，不直接定义当前实现。竞品结论以统一总览为准，单产品专项和本机取证作为证据库保留。

主要入口：

- [竞品总览](01-research/competitors/README.md)
- [统一竞品研究卡](01-research/competitors/product-landscape-2026.md)
- [原始证据库](01-research/competitors/evidence/README.md)
- [技术研究](01-research/tech/)
- [研究结论汇总](01-research/conclusions/研究结论汇总.md)

### 02 设计

设计层是“期望系统如何工作”的主线。按以下顺序阅读：

1. [产品总纲 PRD](02-design/product/prd/PRD-00-产品总纲.md)：定位、用户、范围、成功指标和发布门槛。
2. [PRD 分册](02-design/product/README.md)：登录、任务、技能、记忆等模块行为。
3. [系统总览](02-design/architecture/系统总览.md)：组件、数据流、信任边界和部署拓扑。
4. [架构专题](02-design/architecture/README.md)：记忆、RAG、恢复、安全、Office 等深入设计。
5. [ADRs](02-design/decisions/)：关键技术取舍及其后果。

产品行为以 PRD 为准，系统结构以架构总览和 ADR 为准。实现与文档冲突时，必须先确认预期行为，再同步修正代码和文档。

### 03 项目交付

这一层回答“现在做到哪里、下一步是什么、如何证明通过”。

- [当前状态](03-project/STATUS.md)：唯一的高层完成度快照。
- [开发计划](03-project/planning/tasks-postgresql-knowledge.md)：长期任务台账和依赖。
- [优化清单](03-project/planning/优化清单-20261024.md)：已识别工程债。
- [验收与复盘](03-project/HISTORY.md)：按日期保留的证据索引。

日期型部署记录、周报、截图和一次性验收报告属于历史证据，不得覆盖 `STATUS.md`、PRD 或架构文档中的当前结论。

### 04 运维

运维层给出可直接执行的操作步骤和安全检查：

- [快速部署](04-operations/快速部署.md)
- [运行与排障](04-operations/运行与排障.md)
- [远程部署记录](03-project/deployments/远程部署-20261026.md)
- [备份与恢复](03-project/deployments/backup-recovery-20261016.md)
- [回退基线](03-project/deployments/回退基线-20261020.md)

生产操作必须使用与当前数据库 schema、镜像和配置相匹配的发布记录；历史命令不能直接复制执行。

## 文档状态

长期文档统一在标题下标注状态：

| 状态 | 含义 |
| --- | --- |
| 草稿 | 正在形成，不能作为验收依据 |
| 评审中 | 已有完整结构，等待产品和工程共同确认 |
| 已确认 | 当前产品/架构决策，可作为实现依据 |
| 已实现 | 代码与验证结果和文档一致 |
| 已归档 | 仅保留历史价值，不代表当前行为 |

日期型记录可以在标题或摘要中直接标明日期，但仍需说明当时对应的版本和 schema。

## 维护规则

1. **先更新唯一事实源**：产品行为改 PRD，架构边界改总览/ADR，完成度改 `STATUS.md`，操作步骤改运维文档。
2. **历史只追加不重写**：验收日志如需纠错，追加“更正”段落并说明原因，不删除原始证据。
3. **竞品一产品一主卡**：统一结论写入产品主卡和横向总览，源码路径、截图、哈希和单次实测放入 `evidence/{product}/`。
4. **链接必须可验证**：提交前运行文档链接检查，禁止把本地绝对路径或聊天上下文当作读者可获得的信息。
5. **敏感信息零入库**：密码、Token、API Key、真实业务样本、内部绝对路径和未脱敏日志不得进入文档。
6. **文档随功能一起交付**：涉及用户行为、权限、数据、部署或验收的变化，必须同批更新对应文档。

## 文档模板

- [PRD 模板](02-design/product/prd/_template.md)
- [架构设计模板](02-design/architecture/_template-architecture.md)
- [ADR 模板](02-design/decisions/_template-ADR.md)
- [竞品研究模板](01-research/competitors/_template.md)
- [技术调研模板](01-research/tech/_template.md)

## 命名约定

- 长期文档使用稳定的主题名，例如 `系统总览.md`。
- 日期型证据使用 `{主题}-{YYYYMMDD}.md`，同一主题可追加内容，不另建近义文件。
- 当前设计放主题目录；被合并或替换的完整设计放 `architecture/archive/`，不得在根目录另起“补充版”“终版”。
- 文件路径使用中文主题时保持全仓库一致；引用路径必须与实际文件名大小写一致。
- 编号用于稳定引用，不建议为了排序频繁重命名已有文档。

提交前在 `code/` 目录执行：

```bash
pnpm check:docs
```

该检查会扫描根 README、源码说明、`docs/` 和 `releases/` 中的 Markdown 本地链接，并校验架构专题归类、文档状态、PRD 必备字段与竞品主卡规则。
