# 竞品与参考项目

> 状态：✅ 已统一整理
> 研究窗口：2026-08 至 2026-10
> 统一结论：[2026 产品与技术格局](product-landscape-2026.md)

## 阅读方式

本目录分两层：

1. **统一分析**：本文和[产品与技术格局](product-landscape-2026.md)给出相同维度、相同证据标准下的横向结论。
2. **专项证据**：单产品长文、本机安装包分析、运行录屏记录、哈希和截图保留在原名文件中，用于追溯细节，不再各自定义一套结论口径。

判断当前产品取舍时，以统一分析为准；需要复核某个事实时，再进入专项证据。

## 分析范围

| 类型 | 对象 | 主要参考价值 |
| --- | --- | --- |
| 直接商业竞品 | WorkBuddy、QwenWork | 任务交付、专家/技能、本地执行与企业形态 |
| 通用 Agent 产品 | Claude Code、OpenAI Codex CLI | 工具循环、上下文工程、沙箱、审批与会话协议 |
| 开源工作台 | MyAgents、OpenWorkBuddy | 桌面 Agent、工作区、任务与成果链路 |
| 运行时/记忆生态 | OpenClaw、Pi Agent Harness、Hermes Agent、DeepSeek Harness | 插件、记忆、技能、会话恢复与多模型协议 |
| 观察名单 | 飞书智能伙伴、钉钉 AI、Coze、Microsoft 365 Copilot | 待补充公开资料和可复现实测 |

## 横向结论

| 维度 | 市场正在收敛的做法 | WorkPivot 的判断 |
| --- | --- | --- |
| 产品单位 | 从“聊天”转向“任务/项目” | 采用项目 → 任务 → 运行 → 成果 |
| 工作区 | 任务绑定真实目录或受控文件空间 | 服务端任务目录 + 版本化成果，不依赖本地同步盘 |
| 扩展 | SKILL.md、MCP、专家/插件包生态 | 支持兼容格式，但技能发布和执行权限由 WorkPivot 自己控制 |
| 记忆 | 从单一 MEMORY.md 转向会话、项目、用户多层 | 采用 user/project/task 三层，冲突确认，来源可追溯 |
| 上下文 | 按需读取、压缩、恢复，而非无限堆消息 | 预算、检索、压缩和事件恢复分离 |
| 安全 | 工具审批、文件边界、隔离执行和密钥加密 | 任务资源绑定 + 独立执行器 + 不可信数据隔离 |
| 部署 | 桌面免部署与私有化服务并存 | 当前优先服务端集中部署，桌面/移动作为客户端 |
| 文档交付 | Office/PDF 是核心验收物 | 文件产出、结构检查、版本与下载进入同一链路 |

## 竞争空白

WorkPivot 不以“功能数量最多”为目标，当前差异化集中在：

1. **私有化与模型中立**：不绑定单一模型或企业生态，支持 OpenAI 兼容与 Anthropic 协议。
2. **任务授权而非全局权限**：文件版本、网页 URL、记忆层、技能和写操作随运行绑定。
3. **可恢复的副作用**：事件和工具派发持久化，恢复时不盲目重放。
4. **记忆可纠错**：无冲突新增自动保存，修改与冲突逐条确认。
5. **成果闭环**：Office/PDF、引用、版本、下载和回收站统一管理。
6. **中文办公与私有化交付**：面向文档密集、数据敏感的内部团队。

## 证据等级

| 等级 | 含义 | 可用于 |
| --- | --- | --- |
| A | 官方公开文档、可运行实测、可复现哈希 | 产品/架构结论 |
| B | 安装包静态分析、源码阅读、日志证据 | 技术推断与选型 |
| C | 媒体报道、第三方测评 | 市场和方向观察 |
| D | 未验证假设 | 只能进入待验证清单 |

原则：

- 商业产品未公开的内部实现只能写“观察/推断”，不能写成确定事实。
- 开源项目的许可必须在复用前重新核对；本目录结论不构成法律意见。
- 本机路径、账号、样本内容和私有运行数据不进入公开结论。
- 竞品更新后先修订统一卡片，再在专项文件追加新证据。

## 专项证据索引

### WorkBuddy

产品与官方能力：[workbuddy.md](workbuddy.md)、[官方文档纪要](workbuddy-official-docs.md)
运行与扩展：[技术拆解](workbuddy-technical-analysis.md)、[扩展系统](workbuddy-extension-system.md)、[Agent 运行时](workbuddy-agent-runtime-20261014.md)
Office 与证据：[Office 静态分析](workbuddy-office-static-20261017.md)、[Word 新建](workbuddy-word-runtime-20261017.md)、[Word 读取](workbuddy-word-read-runtime-20261017.md)、[Word 修改](workbuddy-word-edit-runtime-20261017.md)、[Excel 生成](workbuddy-excel-create-runtime-20261017.md)、[Excel 读取](workbuddy-excel-read-runtime-20261017.md)、[Excel 修改](workbuddy-excel-edit-runtime-20261017.md)

### 其他产品

- [WorkBuddy 本地记忆实证](workbuddy-local-memory-20261014.md)
- [QwenWork](qwenwork.md)
- [MyAgents](myagents.md)
- [OpenWorkBuddy](openworkbuddy.md)
- [OpenClaw](openclaw.md)
- [Hermes Agent](hermes.md)
- [Pi Agent Harness](pi-agent.md)
- [DeepSeek Harness](deepseek-harness.md)
- [OpenAI Codex CLI](codex.md)
- [Claude Code](claude-code.md)
- [Claude Code 内核专项](claude-code-internals.md)

## 维护规则

- 新建分析从[_template.md](_template.md)开始。
- 同一产品只有一个主卡片；新证据追加到主卡片“证据与限制”或对应专项文件。
- 统一卡片必须写明研究日期、证据等级和未验证项。
- 对外发布前删除本地绝对路径、账号信息、业务样本和未经授权的内容。
