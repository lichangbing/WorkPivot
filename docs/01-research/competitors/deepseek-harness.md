# 竞品分析：DeepSeek Harness（dsh）

- **分析人**：开发代理
- **日期**：2026-10-24
- **信息来源**：本机安装包静态分析（`D:\Program Files\DeepSeek Harness\resources\app.asar`，解包 548 个 `@deepseek-ai/dsh-*` 包，v0.2.1-rc.2，MIT）；未运行实测。

> 插件与长期记忆专项：[Hindsight 与 DSH 长期记忆插件](hindsight-dsh-memory-20261028.md)。该专项说明 Hindsight 官方支持 DSH、第三方插件并非 DeepSeek 官方插件，并提炼自动召回、知识页和证据化归纳的可借鉴机制。

## 1. 产品概述

- **厂商与背景**：DeepSeek 官方开源的 agent 客户端（仓库 `deepseek-ai/deepseek-harness`），npm 公开发布 `@deepseek-ai/dsh-*`，MIT 许可。
- **产品定位**：单机桌面 agent 运行环境，面向开发者/个人，把「模型 + 工具 + 会话 + 子代理」做成可插拔插件。
- **目标客户**：个人开发者、技术用户；未见企业多租户/审计能力。
- **发展状态**：0.2.1-rc.2，迭代快，模块化程度很高。

## 2. 核心功能拆解

| 功能模块 | 具体能力 | 成熟度 | 备注 |
|----------|----------|--------|------|
| Agent 循环 | 事件溯源会话（seq）、中断恢复、逐块压缩、并行工具池 | ✅ | `dsh-agent-loop` |
| 子代理 | `subagent`（全新上下文）/ `subagent_fork`（继承已完成轮次）、异步返回、可续聊、深度限制 | ✅ | 见 §5 |
| 网页搜索 | 模型原生 `web_search`（DeepSeek Anthropic 兼容接口） | ✅ | 不维护自己的索引 |
| 网页读取 | `web_fetch`，HTML 转 Markdown | ✅ | turndown + gfm |
| 终端 | 持久 PTY 会话：open/send/read/signal/close/list | ✅ | 非一次性命令 |
| 工具面 | 文件、bash、todo、skill、ask_user、workflow、定时、会话查询 | ✅ | 见下 |
| 审批 | `dsh-user-approval` + 授权 seam | ✅ | 按工具声明 |
| 上下文压缩 | 工具结果修剪（8192/4096/1024）+ 会话压缩 | ✅ | 见 §5 |
| 长期记忆扩展 | Cordis 插件可绑定 session-start、pre-step、turn-stopping，并注册记忆工具 | 🧪 | 依赖第三方/外部服务，非 DSH 内置 |
| 多用户/租户 | 无 | ❌ | 单机单用户 |

其他工具：`ask_user_question`（多问题 + heading + options，推荐项排第一）、`workflow`（JS 编排脚本，`agent`/`parallel`/`pipeline`）、`todo`、`str_replace_editor`、`fs_search`、`session_search`、`schedule`、`goal`、`ralph`。

## 3. 客户端与部署形态

- **客户端**：Electron 桌面（asar 内含 Web 前端与 ACP 协议包），另有 `dsh-acp-app` 支持 Agent Client Protocol 接入编辑器。
- **部署方式**：本机安装；无服务端多租户形态。
- **模型接入**：DeepSeek 官方为主（Anthropic 兼容 + OpenAI 兼容适配），支持多 provider 路由（子代理可指定 provider/model）。

## 4. 商业模式与定价

- 开源 MIT，仓库公开；商业形态未从包内确认，不做推断。

## 5. 架构与技术观察

- **插件化到极致**：548 个包，每个能力（循环、工具、终端、搜索、审批、压缩）都是 Cordis 插件，通过 `ctx.*` 服务注入；模型面的工具与执行实现分离（如 `web_search` 工具只做 schema，执行走 `ctx.web` 服务）。
- **会话是事件流**：每轮带 `seq` 写入 SessionLog，支持 `SessionLogOffset` 续读、`ToolCallRecovery`、中断 turn 收尾，重启可恢复。
- **工具并行**：`maxParallelToolCalls` 默认 10，按工具声明的执行模式分组（`parallel` / 独占 barrier），滚动补位。
- **上下文治理**：工具结果超过 8192 字符保留头 4096 + 尾 1024，中间替换标记；压缩在流式 chunk 上做，不是结束后补。
- **子代理**：`subagent` 与 `subagent_fork` 两种种子；调用立即返回 id，完成时运行时通知；子代理是 continuable 的，父代理可用 `send_message` 续聊；`maxDepth` 可配置或由 provider 托管；子代理可覆写 provider/model/effort/cwd，父的 sandbox 策略下传。隔离目前是**进程内**。
- **搜索**：`dsh-web-search-deepseek` 走 DeepSeek 的 Anthropic 兼容接口，用原生 `web_search_20250305` server tool；一次最多 4 个 query 并发、8 条结果；摘要取 `citations[].cited_text`，无结果块直接报错；每条结果前加 `External web content follows...` 声明。
- **终端**：owner 作用域的持久 PTY 注册表，后端可插拔；输出按 UTF-8 边界 head/tail 截断。

## 6. 对 WorkPivot 的启示

- **值得借鉴**：
  1. 工具结果头/尾修剪，参数直接照 8192/4096/1024（对应 O-04）。
  2. 并行工具池 + 工具声明 `parallel`/`exclusive`，默认并发 10（对应 O-13）。
  3. `ask_user_question` 的 schema：多问题、heading、options 推荐项（对应 R004）。
  4. 子代理语义：两种种子、可续聊、深度限制、完成通知（对应 R005，先收敛为单层同步）。
  5. 搜索走模型原生 `web_search`，自建引擎退为离线备选（R003 的替代方案）。
  6. 会话事件流 + 中断恢复，是长任务可靠性的根本，比事后压缩更彻底。
  7. 记忆插件应基于宿主生命周期自动接入，但使用有限预取、超时和失败降级；不要把记忆服务加入聊天主链路的硬依赖。
- **应当规避**：
  1. 进程内子代理（无 OS 隔离，不能用于多用户服务端）。
  2. 搜索完全依赖模型供应商，离线/隐私场景不可用。
  3. Cordis 服务容器耦合极深，代码不可直接搬到 Express + pg。
- **差异化机会**：多用户 + RLS + 文件授权 + 沙箱隔离 + 审计，dsh 完全没有；自托管搜索（SearXNG）可离线。

## 7. 参考链接

- [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)
- 本机包：`@deepseek-ai/dsh-agent-loop`、`dsh-subagent`、`dsh-tool-web`、`dsh-web-search-deepseek`、`dsh-terminal`、`dsh-tool-terminal`（v0.2.1-rc.2）
