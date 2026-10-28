# 项目历史与验收索引

> 状态：📚 历史证据索引
> 最近整理：2026-10-28
> 原则：历史记录只追加、不覆盖；当前完成度以 [STATUS.md](STATUS.md) 为准

本页把按日期散落的计划、验收记录、截图和复盘收敛成一个可检索时间线。历史文档中的“未提交”“未部署”“待开发”只代表当时状态。

## 2026-10

### 当前 RC 收尾

- [远程部署与故障修复](deployments/远程部署-20261026.md)：消息发送、额度刷新、PDF、记忆自动保存与三层识别。
- [记忆体系设计](../02-design/architecture/data/记忆体系.md)：当前记忆规则。
- [业务事实模型](../02-design/architecture/data/业务事实模型.md)：项目对象、事实版本与证据。
- [原始文件与多版本管理](../02-design/architecture/data/原始文件与多版本文档管理.md)。
- [Office 与 PDF 交付](../02-design/architecture/capabilities/Office与PDF交付.md)。
- [演示模式](../02-design/product/requirements/历史演示模式-20261026.md)。
- [可靠性问题台账](planning/可靠性问题台账.md)：仍需跟踪的问题。
- [优化清单](planning/优化清单-20261024.md)：已识别工程改进项及完成状态。
- [回退基线](deployments/回退基线-20261020.md)：版本与恢复边界。

### 安装、发布与恢复

- [本地一体化栈安装](deployments/local-stack-install-20261024.md)
- [本地发布手册](deployments/local-release-runbook-20261017.md)
- [备份恢复设计与验收](deployments/backup-recovery-20261016.md)
- [单用户正式发布补强方案](../02-design/architecture/history/单用户发布补强计划.md)：大型历史计划与实施记录。
- [服务恢复与浏览器工作流](verification/browser-workflow-20261016.md)

### 知识、Office 与记忆

- [混合检索交付](verification/hybrid-retrieval-closeout-20261017.md)
- [Embedding 交付](verification/embedding-closeout-20261017.md)
- [记忆上下文](verification/memory-context-20260919.md)
- [记忆条目审阅](verification/memory-entry-review-20260919.md)
- [记忆审核策略](verification/memory-review-policy-20260919.md)
- [记忆、专家与 Office 联合验收](verification/memory-expert-office-acceptance-20260919.md)
- [个人数据与回收站交付](verification/trash-closeout-20261017.md)
- [Skill 构建交付](verification/skill-build-closeout-20261017.md)
- [自动化交付](verification/automation-closeout-20261017.md)
- [管理后台计划](planning/admin-management-plan-20261016.md)

### 数据库与工程基线

- [K01 数据库基础实现](verification/K01-数据库基础实现记录.md)
- [PostgreSQL 适配清单](verification/postgresql-adaptation-checklist.md)
- [数据库 Worker 联调](verification/database-worker-joint-20261016.md)
- [工程检查与整改](verification/engineering-review-20261014.md)
- [模型恢复](verification/model-recovery-20260919.md)

## 2026-09

- [首次验收彩排](verification/验收彩排记录-2026-09-07.md)
- [M0 验收清单](verification/M0-验收清单.md)
- [M5 试点验收清单](verification/M5-试点验收清单.md)
- [M0 任务](planning/tasks-m0.md)、[M1 任务](planning/tasks-m1.md)、[M5 任务](planning/tasks-m5.md)
- [2026 年计划](planning/plan-2026.md)
- [2026-W37 周报](weekly/2026-W37.md)

## 2026-08 及研究阶段

- [历史项目介绍](../00-overview/WorkPivot-项目介绍.md)
- [研究结论汇总](../01-research/conclusions/研究结论汇总.md)
- [需求清单](../02-design/product/requirements/历史需求基线.md)
- [PRD 索引与当前模块规格](../02-design/product/README.md)
- [原始 UI 原型](../02-design/prototypes/app.html)

## 验证记录阅读方式

每条验收记录应至少回答：

1. 对应哪个版本和 schema。
2. 实际验证了什么，用什么数据/环境。
3. 哪些是真实模型，哪些是合成桩。
4. 是否已部署到目标环境。
5. 未覆盖项和风险。

如果记录只包含“测试通过”而没有范围或证据，应视为线索，不作为发布门槛证明。

## 归档规则

- 不删除历史记录，避免丢失问题复盘和证据链。
- 更正历史结论时追加“后续更新”，并链接当前事实源。
- 同一主题的新实施记录继续追加到原文件；只有在内容规模影响阅读时才拆分。
- 截图、清单和脚本应保留其所属验收记录链接，避免成为孤立文件。
