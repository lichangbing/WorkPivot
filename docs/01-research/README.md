# 研究与决策输入

> 状态：✅ 研究主线已整理
> 最近更新：2026-10-28
> 使用方式：先读结论，再用专项证据复核

研究层回答“市场、竞品和技术为什么这样选”。它不是当前功能完成度清单；当前实现以 [PRD](../02-design/product/PRD-00-产品总纲.md) 和 [项目状态](../03-project/STATUS.md) 为准。

## 当前结论

1. **产品方向**：私有化、任务式、成果交付型 AI 工作台。
2. **主要用户**：处理敏感材料和知识工作的内部团队。
3. **技术路线**：全栈 TypeScript/Node、自研 Agent 微内核、PostgreSQL + 文件混合存储。
4. **差异点**：模型中立、任务级授权、证据与恢复、三层记忆纠错、Office/PDF 成果闭环。
5. **不追的方向**：单纯堆聊天功能、厂商生态绑定、不受控的宿主命令执行、未审核的自动 Skill 发布。

完整横向对比见[2026 竞品格局](competitors/product-landscape-2026.md)。

## 竞品研究

- [竞品研究入口](competitors/README.md)：阅读顺序、证据等级、专项索引。
- [统一竞品格局](competitors/product-landscape-2026.md)：WorkBuddy、QwenWork、Codex、Claude Code、OpenClaw 等统一卡片。
- [竞品模板](competitors/_template.md)：新增或复核产品时使用。

当前覆盖：

| 类别 | 产品 |
| --- | --- |
| 直接办公竞品 | WorkBuddy、QwenWork |
| 通用 Agent | Claude Code、OpenAI Codex CLI |
| 开源工作台 | MyAgents、OpenWorkBuddy |
| 运行时/生态 | OpenClaw、Hermes Agent、Pi Agent Harness、DeepSeek Harness |
| 观察名单 | 飞书智能伙伴、钉钉 AI、Coze、Microsoft 365 Copilot |

原始长文和本机实测保留为证据，不要求读者按日期阅读。新增结论先写统一卡片，再附专项来源。

## 技术研究

| 课题 | 结论 | 文档 |
| --- | --- | --- |
| 桌面框架 | Electron，Web-ready 优先，客户端不承载全部服务 | [桌面端框架选型](tech/02-桌面端框架选型.md) |
| 动态插件 | 不直接引入 Cordis；采用受控 Skill 和自研扩展边界 | [Cordis 动态插件架构](tech/01-cordis-动态插件架构.md) |
| Agent 内核 | 自研微内核，工具、Skill、模型和持久运行分离 | [ADR-002](../02-design/decisions/ADR-002-编排内核自研微内核.md) |
| 数据存储 | PostgreSQL 保存状态/权限/版本，文件卷保存原件与成果 | [ADR-003](../02-design/decisions/ADR-003-PostgreSQL与文件混合存储.md) |
| 模型接入 | OpenAI 兼容 + Anthropic 双协议，优先保持供应商中立 | [系统总览](../02-design/architecture/系统总览.md) |
| 执行安全 | 独立 Worker/容器、任务资源范围、写入审批、不回落宿主 shell | [任务授权方案](../02-design/architecture/上下文注入防护与任务授权方案-20261017.md) |

技术研究模板见[tech/_template.md](tech/_template.md)。

## 研究结论

- [历史研究结论汇总](conclusions/研究结论汇总.md)：2026-08 立项阶段的定位、客群、MVP 和风险。
- 重要修订不直接覆盖历史结论；新的产品级取舍进入 PRD/ADR，并在原文档追加“后续更新”。

## 证据规则

| 等级 | 证据 | 使用范围 |
| --- | --- | --- |
| A | 官方文档、公开源码、可复现实测 | 可作为产品/架构结论 |
| B | 安装包静态分析、运行日志、源码局部推断 | 可作技术线索，需标注验证边界 |
| C | 媒体报道、访谈摘要、第三方测评 | 只作市场观察 |
| D | 未验证假设 | 必须进入待验证清单 |

要求：

- 每条关键结论都应有来源、日期和证据等级。
- 不把商业产品内部推断写成已证实事实。
- 不复用未确认许可的代码、Skill、提示词或模板。
- 不在研究材料中保存真实账号、密钥、私有样本和本机绝对路径。

## 当前待研究

- 首批种子客户的行业、团队规模与采购门槛。
- 中文 Office 复杂样版的视觉与业务验收基线。
- 本地模型、私有云模型和公有云模型的质量/成本路由。
- 企业身份、组织同步、跨项目共享与撤权。
- 多人项目协作是否进入下一版本，还是继续强化单用户完整闭环。
