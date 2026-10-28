# 开源项目分析：OpenAI Codex CLI（Rust）

> **分析方式**：本地源码 `E:\project\codex`（github.com/openai/codex，main@459a79e，2026-09-05 克隆）。源码级分析，未运行。
> **一段话结论**：OpenAI 官方开源的编程 agent（Apache-2.0），Rust workspace **146 个 crate、161 万行**，是目前工程化程度最高的开源 agent harness——工具面收缩到 `exec_command`+`apply_patch`+`view_image`+`update_plan` 四五件，压缩/会话持久化/审批沙箱全部做成一等公民；安全模型是「平台沙箱兜底 + 审批例外通道 + Starlark 规则层 + 托管网络代理」四层叠加，Windows 投入最重。对 WorkPivot 的价值在**设计、协议与格式参考**（Rust 代码不可复用），且注意：它开源但不接受外部代码 PR。
>
> 姊妹文档：[pi-agent.md](pi-agent.md)（同类可嵌入内核，极简路线）｜[openclaw.md](openclaw.md)（用 pi 内核做生活助理）｜[myagents.md](myagents.md)（Claude Agent SDK 系）｜[workbuddy-technical-analysis.md](evidence/workbuddy/technical-analysis.md)（闭源对标）

- **分析人**：lichb
- **日期**：2026-09-05
- **信息来源**：本地源码（main@459a79e）+ [openai/codex](https://github.com/openai/codex)

## 1. 项目身份

| 键 | 值 |
|---|---|
| 定位 | "Lightweight coding agent that runs in your terminal"——OpenAI 官方编程 agent,家族含 CLI/IDE 扩展/桌面版/云端 Codex Web |
| 许可 | **Apache-2.0** 标准全文（有专利授予,不在 K05 传染性黑名单）★ 可合法复用 |
| 所有者 | OpenAI;⚠️ **明确不接受外部代码 PR**（docs/contributing.md）,只收 issue——"开源"而非"开放协作" |
| 版本 | workspace 统一 `version = "0.0.0"`,发布时打 tag（CI 校验 tag==版本） |
| 语言 | Rust edition 2024 主体 + TypeScript/Python SDK（均为 CLI 包装） |
| 规模 | codex-rs 3730 个 .rs 文件、**1,618,309 行**（含测试）;core 36.8 万 > tui 31.4 万 > app-server 16.4 万 |
| 构建 | Cargo 为唯一真源;Bazel 9 管CI/远程执行;pnpm 只管 npm 发行壳（`@openai/codex` 元包+6 平台原生二进制包） |

顶层：`codex-rs/`（唯一实现本体）、`codex-cli/`（npm 发行壳,无业务逻辑）、`sdk/`（TS/Python SDK,spawn CLI + JSONL）、`.codex/`（仓库自己的 11 个内置 skills——**SKILL.md 格式又一实证**）、`docs/`（刻意做薄,10/15 是跳转官网的存根）。

## 2. 总体架构

```
                    protocol（叶子,60+ crate 共用的 wire 类型）
                       ↑
  config/state/skills/tools/hooks/rollout/sandboxing/codex-mcp/ext/*
                       ↓
                    core（引擎:turn 循环/client/compact/exec_policy/agents_md）
                       ↑                          ↑
  cli/exec/app-server/mcp-server…(约50个内部依赖)   tui ✗ 不依赖 core
                                                    │ tui → app-server-client/protocol
                                                    └（UI 与引擎经 JSON-RPC 解耦）
  cli（bin codex）= arg0 多路复用总装:TUI/exec/app-server/mcp-server 全进一个二进制
```

- **146 个 crate 按职能分六组**：入口/前端（cli/tui/exec/app-server/exec-server/mcp-server）、协议层（protocol/codex-api/config）、引擎域（core/state/skills/tools/hooks/rollout/memories）、扩展 ext/*（14 个插件式能力：agent/goal/mcp/web-search/memories…）、沙箱安全（sandboxing/linux-sandbox/windows-sandbox-rs/execpolicy/network-proxy/login/keyring-store）、基建（约 30 个 utils 小 crate）。
- **两条关键架构纪律**（AGENTS.md 明文）：① "resist adding code to codex-core"——core 臃肿后新概念一律拆独立 crate;② **TUI 不依赖 core**,经 app-server 的 JSON-RPC 协议对接（IDE/桌面/TUI 共用一个宿主协议,v1 冻结/v2 活跃）。这与 WorkPivot 形态 A 的「前端只走 HTTP/SSE」纪律同构,是它的重装版验证。
- crate 级 README 是真正的架构文档（app-server/README.md 3009 行）,`docs/` 反而极薄。

## 3. Agent 内核

### 3.1 turn 循环（core/src/session/turn.rs,2881 行,内核心脏）

链路：用户输入（`Op::TurnInput`）→ `SessionTask` trait 派发（Regular/Compact/Review/UserShell 四种任务）→ `run_turn`：**pre-turn 压缩 → 注入 skills/环境上下文/AGENTS.md → 采样循环**（模型流式响应→工具调用包成 future **并行执行**→结果写回历史→有 follow-up 继续）→ token 触顶则 mid-turn 自动压缩后 continue → 纯文本回复且无 pending input → Stop hooks → `TurnComplete`。支持用户中途插话（steer,pending input 机制）。

### 3.2 工具面：比 pi 更极简,shell 为王

| 工具 | 形态 | 说明 |
|---|---|---|
| `exec_command` | JSON+output_schema | 万能 shell（带 yield_time_ms/max_output_tokens/后台 session_id） |
| `write_stdin` | JSON | 向**持续 PTY 会话**写 stdin（交互式命令不中断） |
| `apply_patch` | **Freeform**（Lark 文法,非 JSON） | 补丁式写文件（Add/Delete/Update/Move 四种 hunk） |
| `view_image` | JSON | 本地图进上下文 |
| `update_plan` | JSON | 纯状态广播（`PlanUpdate` 事件给 UI 画过程主线）,与 VS Code 扩展共享类型 |
| web_search | hosted | Responses API 模型端执行,core 只解析事件 |

**没有 read/grep/find/ls 工具**——文件读取检索统一走 shell（pi 的 7 工具思路在此被放弃）。另有 `request_permissions`（模型主动申请权限）、`request_user_input`、`tool_search`（deferred 工具按需加载）、多 agent v1/v2 协作工具（spawn/wait/mailbox 信箱通信）。

### 3.3 上下文工程：压缩是一等公民

- 触发阈值 = 模型上下文的 **90%**（可配,支持只统计前缀后增量的 scope）;**四个触发点**：pre-turn / mid-turn / manual / 模型切换（带 comp_hash 检测）。
- 实现：整个 history + 摘要提示词做一次**无工具采样**;遇 ContextWindowExceeded 从最旧逐条丢弃重试;摘要以 `CompactedItem` checkpoint 落盘（window_id/window_number,支持多窗口）;远端压缩（provider capability）双轨。
- 系统提示词**不存仓库**——随模型目录从服务端下发（含 personality 占位符）,本地只有兜底模板;AGENTS.md 从项目根向下逐层收集拼接（`AGENTS.override.md` 优先）,每 turn 注入环境上下文（workspace roots/权限档位,XML 式）。

### 3.4 模型接入：⚠️ 只剩 Responses 协议

`WireApi` 枚举**只剩 `Responses`**——Chat Completions 已被移除（反序列化直接报错指向官方公告）。内置 provider：openai（ChatGPT 登录态/API key 双形态）、Bedrock（SigV4）、**ollama/lmstudio（内网本地模型）**;传输有 SSE 与 **Responses over WebSocket**（beta,跨 turn 复用连接）,以及服务端压缩端点、`/models` 模型目录（能力协商：上下文长度/压缩限/工具形态/推理档位全由 `ModelInfo` 下发）。→ 对 WorkPivot 的信号见 §6.3。

### 3.5 会话持久化：rollout 即协议（★ 对 F01 最有参考价值）

- 格式：`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<thread>.jsonl`,每行 `{timestamp, ordinal, item}`,item 枚举直接存 `ResponseItem/EventMsg/Compacted/TurnContext/TokenUsageRecord…`——**持久化的就是协议事件本身**,resume = 重放,fork = 引用历史前缀（Copied/Referenced 两种持久化模式）,revert = fork 语义 + 截断事件。另配 SQLite 状态库做线程索引。
- 对比 WorkPivot F01（JSONL 转写+原子写+.bak）：思路同源,Codex 版多了 ordinal/fork 链/压缩 checkpoint/回放工具（rollout-trace）。

### 3.6 协议分层

下行 `EventMsg`（约 90 个变体：生命周期/内容流/工具/审批/上下文管理/多 agent）、上行 `Op`（Interrupt/TurnInput/ExecApproval…）。外部宿主（IDE/桌面）走 app-server 的 JSON-RPC 2.0（`thread/start`、`turn/start`…,stdio/ws/unix socket 三传输,v1/v2 两套）,SDK 只是 CLI 包装。**WorkPivot 若要对标,对齐的是这一层协议,不是 core 内部**。

## 4. 安全模型：四层叠加（★ WorkPivot I 模块最强对标）

**核心思路：平台沙箱是默认前提,审批只是"沙箱之上的例外通道"**——与 Claude Code「纯审批+提示」路线形成代差。

1. **OS 级沙箱（默认）**：macOS Seatbelt（SBPL 模板拼装,硬编码 sandbox-exec 绝对路径防 PATH 注入）;Linux bubblewrap+seccomp（`--unshare-all`、`--cap-drop ALL`,旧 Landlock 为 legacy 选项）;**Windows 自研 restricted-token 沙箱**（~50 源文件：token+写 ACL+**deny-read ACL**+**WFP 内核层网络过滤**+私有桌面隔离+防 symlink 逃逸）——Windows-first 的 WorkPivot 直接受益,这是三大平台里唯一把 Windows 当一等公民做的开源实现。
2. **审批策略 = 例外通道**：`AskForApproval`（UnlessTrusted/OnRequest/Granular/Never）× `SandboxMode`（read-only/workspace-write/danger-full-access）正交组合;**模型可主动请求权限**（工具参数带 `sandbox_permissions`+`justification`,或调 `request_permissions` 工具）,系统校验后走审批流——对比 Claude Code 的被动拦截后询问,UX 更顺但必须有沙箱兜底。审批决策含「本会话记住」缓存;⚠️ 还可委托 **guardian subagent 自动审批**（`ApprovalsReviewer::AutoReview`,受提示词约束的风险审查 agent）——企业场景的自动审批预演。
3. **execpolicy 规则层**（Claude Code 没有）：Starlark 写命令前缀规则（allow/prompt/forbidden,含网络规则）;**"批准即固化规则"**——用户批准某命令时可附带 amendment 把该前缀永久写入项目策略（`ReviewDecision::ApprovedExecpolicyAmendment`）。是 I02 权限档位+I05 高危表的可借鉴进化形态。
4. **托管网络代理**：本地 MITM 代理+自签 CA+域级策略+凭据代理（子进程拿不到真 token）,沙箱内进程被置于"仅可达代理"的网络态,审批可按 host+协议持久化——网络管控能做到请求级审计。细节约束：**策略含 denied-read 时禁止"免沙箱重跑"**（防提权绕过 deny-read）,这类边角恰是企业审计会抓的点。

审计面：rollout 全量录制可回放 + 沙箱违规归一化事件（violation.rs,按平台归因,上报 otel）+ 网络策略审计事件——没有独立审计文件,靠「回放+遥测」。

## 5. 产品形态面

单一 `codex` 二进制 arg0 多路复用：**TUI**（ratatui 自绘,经 app-server 连接本地 daemon）、**`codex exec`**（headless,`--json` JSONL 事件流/结构化输出）、**app-server**（IDE/桌面宿主协议,VS Code 扩展的消费端）、**`codex mcp-server`**（把整个 Codex 暴露为一个 MCP 工具供别的 agent 调用,审批经 MCP elicitation 转交宿主）、**MCP client**（rmcp,支持远程 MCP 的 OAuth/PKCE/EMA）、skills（SKILL.md,项目/`$CODEX_HOME` 双层,脚本执行有独立审批开关）、hooks（生命周期,有"仅托管 hook"企业开关）、登录（ChatGPT OAuth PKCE/设备码 + API key,token 走 OS keyring）。另有 exec-server 支持远程环境注册（Noise 加密 relay）——云侧执行形态。

## 6. 对照与对 WorkPivot 的启示

### 6.1 内核路线对照

| | **pi** | **OpenClaw** | **Codex** | WorkPivot(M0 计划) |
|---|---|---|---|---|
| 规模 | 万行级 | 10 万行级 | **160 万行** | 全栈 TS 小内核 |
| 工具面 | 7 工具(read/grep/ls 独立) | 继承 pi | **4-5 件,shell 王道** | 7 工具基线(pi 式) |
| 压缩 | compaction 模块 | 引用 pi | 四触发点+多窗口+远端双轨 | W3/M1(阈值+摘要) |
| 持久化 | 会话 JSONL | session 存储 | rollout=协议,fork 引用前缀 | F01 JSONL(同源思路) |
| 沙箱 | 无 | 无 | **三平台 OS 级默认** | I01 Job Object 薄实现 |
| 许可 | MIT | MIT | Apache-2.0(可复用但 Rust) | — |

### 6.2 值得借鉴（按 WorkPivot 模块对号）

1. **rollout 持久化设计**（→ F01）：转写行=协议事件本身+ordinal 序号,resume=重放,fork=引用前缀——比"消息+工具结果"的自定义格式更抗演进,协议加字段天然向后兼容。
2. **压缩工程**（→ K04/F03）：90% 阈值、摘要提示词模板（"handoff summary for another LLM"）、续跑前缀（"另一个模型已开始解决此问题…"）、模型切换检测——W3/M1 做压缩时照抄结构。
3. **「批准即固化规则」**（→ I02/I05）：用户批准高危命令时顺手把前缀写入项目级白名单/黑名单策略,把"本会话不重复骚扰"升级为可积累的企业策略资产。
4. **模型主动请求权限 + justification**（→ PRD-02 授权卡）：授权卡上显示 AI 给的理由,交互比被动拦截更顺;前提是沙箱兜底（WorkPivot I01+I08 边界即兜底）。
5. **update_plan 过程工具**（→ A03）：过程主线 = 模型主动汇报计划状态（PlanUpdate 事件）而非 UI 猜——与 A03"阶段来自任务计划结构"的设计完全一致,验证了路线。
6. **app-server 宿主协议**（→ A01 形态 A 纪律）：UI/IDE/桌面共用一个 JSON-RPC Thread/Turn/Item 协议,v1 冻结 v2 演进——WorkPivot 的 Express+SSE 是同构思想的轻量版,升级 Web 管理后台/IDE 插件时按此组织。
7. **Windows 沙箱实现参考**（→ I01）：restricted-token+deny-read ACL+WFP 的自研路径证明 Windows 可以不是"无沙箱"平台,细节设计可读源码对标。
8. **SKILL.md 生态再确认**：官方仓库自带 11 个 SKILL.md skills——格式收敛判断第三次验证（QwenWork/WorkBuddy/Codex）。

### 6.3 应当规避 / 警惕

1. **core 臃肿教训**：146 crate、单文件 2881-6291 行、AGENTS.md 要喊"别再往 core 塞代码"——WorkPivot 微内核（ADR-002）从第一天就要有 crate/模块边界纪律,C05 依赖方向检查是对的措施。
2. **Chat Completions 被移除**：OpenAI 在向 Responses 协议收敛,但**私有化世界（vLLM/Ollama 各版本）的通用语言仍是 Chat Completions**——WorkPivot C02 双协议判断不变,反而要守住"OpenAI 兼容协议永不删"的兼容承诺,这是与官方工具差异化的点。
3. **开源≠开放协作**：不接受 PR,意味着跟进它的节奏只能靠读 commit;作为"设计参考"没问题,作为"依赖上游"不成立。
4. **审计靠回放+遥测**：企业要的"导出审计文件、还原违规链路"它没有现成答案——WorkPivot I03 按天 JSONL+导出仍是差异点。
5. 体量与费用：官方二进制+ChatGPT 登录态深度绑定,私有化企业场景它只能当内网模型客户端用（ollama provider 存在）,体验不为私有化优化——正是 WorkPivot 的立足空间。

### 6.4 许可地位说明

Apache-2.0 有专利授予、无传染性,不在 K05 黑名单,**法律上可 vendor/改写**;工程上 160 万行 Rust 对 TS 产品不可行,现实复用面=**协议结构、事件枚举、rollout/补丁格式、提示词模板、execpolicy 思想**这些"设计件"。读它的代码学设计,写自己的 TS——与 pi/OpenClaw 的"可嵌入"是两种不同的复用姿势,ADR-002 候选对比时应分开评估。

## 附：快速验证路径（本机）

| 想看什么 | 去哪里（E:\project\codex\） |
|---|---|
| turn 循环心脏 | `codex-rs\core\src\session\turn.rs`（run_turn,2881 行） |
| 工具面与 schema | `codex-rs\core\src\tools\spec_plan.rs`、`handlers\shell_spec.rs`、`handlers\apply_patch_spec.rs` |
| 补丁文法 | `codex-rs\apply-patch\src\parser.rs` 头部 Lark 文法 |
| 压缩提示词模板 | `codex-rs\prompts\templates\compact\prompt.md`、`summary_prefix.md` |
| rollout 格式 | `codex-rs\rollout\src\lib.rs`（RolloutLine/RolloutItem）、`history\src\lib.rs` L118 |
| 协议事件全表 | `codex-rs\protocol\src\protocol.rs`（EventMsg L1356 / Op L592） |
| 审批矩阵 | `codex-rs\core\src\exec_policy.rs`、`core\src\tools\sandboxing.rs` |
| execpolicy 规则语言 | `codex-rs\execpolicy\`（Starlark prefix_rule）+ `docs\execpolicy.md` |
| Windows 沙箱 | `codex-rs\windows-sandbox-rs\`（token/workspace_acl/deny_read_*/wfp） |
| 宿主协议 | `codex-rs\app-server\README.md`（3009 行）+ `app-server-protocol\src\protocol\` |
| 官方自带技能 | `.codex\`（environments + 11 个 SKILL.md skills） |
| 不收 PR 的声明 | `docs\contributing.md` |
