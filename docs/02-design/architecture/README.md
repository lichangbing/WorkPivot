# 架构设计索引

> 状态：✅ 已按运行时、数据、安全、能力、交付分层整理
> 最近更新：2026-10-28
> 阅读原则：先读系统总览，再按问题进入专题；历史与原始证据不与当前设计混放

## 阅读顺序

1. [系统总览](系统总览.md)：组件、端到端数据流、信任边界和部署拓扑。
2. [Agent 循环与上下文](runtime/Agent循环与上下文.md)：任务如何持续推进、压缩、提问与结束。
3. [任务授权与安全边界](security/任务授权与安全边界.md)：模型之外的范围检查和审批生命周期。
4. [数据与知识](#数据与知识)或[Agent 能力](#agent-能力)：按当前问题继续阅读。
5. [ADR](../decisions/)：确认不可轻易逆转的技术选择。

实现状态以 [项目状态](../../03-project/STATUS.md) 为准；本目录描述当前设计和已知边界。

## 运行时

| 文档 | 内容 |
| --- | --- |
| [Agent 循环与上下文](runtime/Agent循环与上下文.md) | 早停、工具配对、轻量压缩、长对话摘要、结构化提问 |
| [工具执行与 Agent 协作](runtime/工具执行与Agent协作.md) | `run_code`、单层委派、候选多 Agent 协议 |
| [事件溯源与中断恢复](runtime/事件溯源与中断恢复.md) | 事件、工具派发、恢复与 at-most-once |
| [后台调度与并发](runtime/后台调度与并发.md) | 队列、租约、并发和容量边界 |

## 数据与知识

| 文档 | 内容 |
| --- | --- |
| [PostgreSQL 项目知识架构](data/PostgreSQL项目知识架构.md) | 项目、任务、文件、知识、版本、权限与 RLS |
| [记忆体系](data/记忆体系.md) | 用户/项目/任务三层记忆、自动保存、冲突确认与周期分析 |
| [业务事实模型](data/业务事实模型.md) | 项目对象、实体消歧、事实/关系 revision、证据与时态查询 |
| [原始文件与多版本文档管理](data/原始文件与多版本文档管理.md) | 不可变原件、版本发布、默认检索版本与删除传播 |
| [RAG 知识库与遗忘管理](data/RAG知识库与遗忘管理.md) | 解析、分块、混合检索、引用和失效 |
| [会话生命周期](data/会话生命周期.md) | 会话删除、级联清理、分页与恢复 |

## 安全与身份

| 文档 | 内容 |
| --- | --- |
| [任务授权与安全边界](security/任务授权与安全边界.md) | 授权快照、执行模式、工具矩阵、网络与调用摘要 |
| [企业身份接入](security/企业身份接入.md) | OIDC/OAuth、企业微信、组织映射与撤权设计 |

## Agent 能力

| 文档 | 内容 |
| --- | --- |
| [Web 与浏览器能力](capabilities/Web与浏览器能力.md) | 搜索、静态读取、Playwright、共享页面与 URL 授权 |
| [Office 与 PDF 交付](capabilities/Office与PDF交付.md) | DOCX/XLSX/PPTX 读改新建、Chromium PDF、LibreOffice 转换 |
| [Skill 按需加载](capabilities/Skill按需加载.md) | Skill 目录、版本、选择与加载边界 |
| [对话 Skill 与定时任务](capabilities/对话Skill与定时任务.md) | 草稿、试运行、确认发布和计划执行 |
| [专家智能体与经验管理](capabilities/专家智能体与经验管理.md) | 专家规则、经验、来源与权限 |

## 交付形态

| 文档 | 内容 |
| --- | --- |
| [产品形态与客户端](delivery/产品形态与客户端.md) | 服务端权威状态、Web/Electron/Android、多端同步 |
| [容器部署与定时采集](delivery/容器部署与定时采集.md) | 全后台容器、浏览器、Worker、采集与资源档位 |

## 历史与证据

分类迁移前的完整设计、测试参数和实施流水保留在以下目录，只用于追溯：

- [archive/runtime](archive/runtime/)：Agent 循环、工具面、代码执行、多 Agent。
- [archive/security](archive/security/)：授权、安全矩阵、文件边界。
- [archive/memory](archive/memory/)：三层记忆与周期分析原始设计。
- [archive/capabilities](archive/capabilities/)：Web、Office/PDF 原始设计。
- [archive/delivery](archive/delivery/)：服务端、Electron、手机与拓扑演进。
- [history](history/)：统一发布计划、旧文件链存储、数据目录和页面原型。

归档文档仍可被链接，但不是当前结论入口。结论更新必须先改上方主文档；原始测试和日期记录只追加。

## 编写规范

新专题从 [_template-architecture.md](_template-architecture.md) 开始，至少包含：

- 状态、适用范围、关联文档和非目标。
- 组件职责、正常/失败流程、数据生命周期和信任边界。
- 权限、日志、迁移、回退、容量与可观测性。
- 可复现验收方式、已知限制和设计沿革。

约定：

1. 一个主题只有一个当前主文档；不同时的定义合并，历史参数进入 `archive/`。
2. 业务流程用状态图或有序步骤；工具和权限用表格列出副作用、对象与失败行为。
3. “已实现”“已验收”“已部署”分别记录，测试通过不等于生产验收。
4. 新存储、信任边界、自动执行或不可逆副作用需要同时评估 ADR。
5. 文档中的相对链接必须能由 `pnpm check:docs` 验证。
