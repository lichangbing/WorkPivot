# 设计文档

> 状态：✅ 已整理
> 最近更新：2026-10-28
> 当前产品阶段：`v0.3.0-rc.1`

设计层回答三个问题：产品要提供什么、系统如何实现、关键技术取舍是什么。历史计划和实施日志不再放在本页顶部，以日期堆叠方式充当“现状”。

## 设计主线

```text
产品总纲
  ├── 模块 PRD：页面、角色、流程、异常和验收
  ├── 系统总览：组件、数据流、信任边界和部署拓扑
  ├── 专题架构：记忆、RAG、恢复、安全、Office 等
  └── ADR：不可轻易逆转的技术选择
```

### 1. 产品设计

- [产品总纲 PRD](product/prd/PRD-00-产品总纲.md)：当前定位、范围、原则和 RC 验收。
- [PRD 分册索引](product/README.md)：登录、任务、技能与专家、后台、记忆、设置、业务事实和限额。
- [历史需求基线](product/requirements/历史需求基线.md)：冻结的详细需求来源。
- [需求池](product/requirements/backlog.md)：尚未纳入当前承诺的能力。
- [交互原型](prototypes/app.html)与[UI 规范](ui-ux/主界面布局规范.md)。

### 2. 系统设计

- [系统总览](architecture/系统总览.md)：先读这一份建立端到端认识。
- [架构专题索引](architecture/README.md)：按运行时、数据、安全、能力、交付分组。
- [Agent 循环](architecture/runtime/Agent循环与上下文.md)
- [记忆体系](architecture/data/记忆体系.md)
- [RAG 与遗忘](architecture/data/RAG知识库与遗忘管理.md)
- [业务事实](architecture/data/业务事实模型.md)
- [任务授权与安全边界](architecture/security/任务授权与安全边界.md)
- [事件恢复](architecture/runtime/事件溯源与中断恢复.md)
- [Office 与 PDF](architecture/capabilities/Office与PDF交付.md)

### 3. 架构决策

- [ADR 模板](decisions/_template-ADR.md)
- [ADR-001 全栈 TypeScript 与 Node](decisions/ADR-001-全栈TypeScript与Node.md)
- [ADR-002 自研编排微内核](decisions/ADR-002-编排内核自研微内核.md)
- [ADR-003 PostgreSQL 与文件混合存储](decisions/ADR-003-PostgreSQL与文件混合存储.md)
- [ADR-004 业务事实与项目范围](decisions/ADR-004-业务事实与项目范围.md)
- [ADR-005 原始文件与文档知识层](decisions/ADR-005-原始文件与文档知识层.md)

## 状态与事实源

| 问题 | 唯一事实源 |
| --- | --- |
| 产品当前为什么存在、服务谁、不做什么 | [产品总纲](product/prd/PRD-00-产品总纲.md) |
| 某个页面应如何行为 | 对应模块 PRD |
| 系统如何分层、数据如何流动、权限在哪里检查 | [系统总览](architecture/系统总览.md) |
| 关键技术为什么这样选 | 对应 ADR 与专题设计 |
| 实际完成到哪一步 | [项目状态](../03-project/STATUS.md) |
| 什么时候部署了什么 | [项目历史](../03-project/HISTORY.md)与部署记录 |

## 文档状态约定

| 状态 | 使用条件 |
| --- | --- |
| 📝 草稿 | 方案仍在形成，不作为实现依据 |
| 🔄 评审中 | 需要产品或工程确认 |
| ✅ 已确认 | 当前设计决策，可以据此实现 |
| 🛠️ 已实现 | 代码和验收结果与设计一致 |
| 📚 已归档 | 仅供追溯；不得据此判断当前行为 |

## 设计评审门槛

一般功能：

1. PRD 明确用户、流程、异常、权限和验收。
2. 系统边界和数据归属清楚。
3. 失败、取消、恢复和删除路径可实现。

涉及以下变化时必须增加架构专题和 ADR：

- 新存储系统或数据模型重大调整。
- 新信任边界、外部服务或宿主权限。
- 多租户、身份联合、公开共享和跨项目数据流。
- 自动执行、不可逆副作用或新审批模型。
- 会改变兼容性、升级或回滚方式的基础设施选择。

实现完成后更新状态与验收证据。历史日期记录保留原文，但不得覆盖当前 PRD、架构总览和项目状态页。
