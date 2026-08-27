# 开源项目分析：MyAgents（Tauri 桌面个人 Agent 工作台）

> 分析方式：源码级分析（E:\project\MyAgents，v0.4.11 源码 + 项目自带 specs/ARCHITECTURE.md 1169 行架构文档）+ 本机安装目录与数据目录实测。
> 姊妹文档：WorkBuddy 系列（[workbuddy.md](workbuddy.md) / [workbuddy-technical-analysis.md](workbuddy-technical-analysis.md) / [workbuddy-extension-system.md](workbuddy-extension-system.md) / [workbuddy-official-docs.md](workbuddy-official-docs.md)）——文末有两者对照。

- **分析人**：ZCode
- **日期**：2026-08-27
- **信息来源**：
  - 源码：`E:\project\MyAgents`（GitHub: hAcKlyc/MyAgents）
  - 安装目录：`D:\Program Files\MyAgents`
  - 数据目录：`C:\Users\{user}\.myagents`

---

## 1. 项目身份

| 项 | 值 |
|----|-----|
| 定位 | **开源桌面个人 Agent 工作台**——"Desktop Claude Code for everyone"，把对话、工作区、文件、工具、模型、任务、长期记忆放进同一个桌面系统 |
| 许可 | **AGPL-3.0**（附 COMMERCIAL-LICENSING.md 双轨商业授权） |
| 版本 | v0.4.11（迭代活跃，CHANGELOG 296KB） |
| 技术栈 | **Tauri v2（Rust）+ React 19 + TypeScript + Vite + Tailwind 4** |
| Agent 运行时 | 内置 **Claude Agent SDK 0.3.233**（原生二进制）；可选外部 Runtime：Claude Code CLI / OpenAI Codex CLI / Google Gemini CLI（实验室） |
| 模型 | 多供应商：Anthropic 订阅/API、DeepSeek、Moonshot、智谱、MiniMax、Gemini、火山方舟、硅基流动、OpenRouter、ZenMux、MiMo、百炼等 |
| 平台 | macOS 13+ / Windows 10+（+ Linux 构建指南） |

产品三句话：本地优先的 Agent 桌面客户端；想法→任务→周期调度的任务系统；开放的 AI 运行环境（多模型/MCP/Skills/自定义 Agent/IM Bot/插件）。

**与本项目研究的关联**：MyAgents 是「桌面 Agent 工作台」这一品类的**开源参考实现**，其 Tauri 架构、Sidecar 进程模型、多 Runtime 抽象、OpenMino 记忆体系对 WorkPivot 的桌面端技术选型（Electron vs Tauri）和架构设计有直接参考价值。

---

## 2. 总体架构（四层）

```
┌────────────────────────────────────────────────────────────────┐
│ Tauri Desktop App                                               │
├────────────────────────────────────────────────────────────────┤
│ ① React 前端层（src/renderer）                                   │
│    Chrome 式多 Tab（每 Tab 一个独立 Agent 会话）                   │
│    Tab-scoped useTabState：apiGet/apiPost + SSE 订阅             │
│    工作区文件树 / 内嵌终端(xterm) / 内嵌浏览器 / 任务中心 / 想法    │
├────────────────────────────────────────────────────────────────┤
│ ② Rust/Tauri 层（src-tauri/src）                                 │
│    SidecarManager（进程编排+Owner 模型）  TaskStore+TaskScheduler │
│    HTTP/SSE Proxy（控制面必经）           SearchEngine(Tantivy)  │
│    Management API（axum，Node→Rust 反向通道）                     │
│    workspace_files（文件IO全部走Rust）    Terminal(PTY)/Browser   │
│    IM 适配器(Telegram/DingTalk/Bridge)   文档处理/Cloud Space     │
├────────────────────────────────────────────────────────────────┤
│ ③ Node.js Sidecar 层（内置 Node v24，esbuild 打包 server-dist.js）│
│    Global Sidecar（应用级：设置/Provider/OAuth）×1               │
│    Session Sidecar（每会话一个：Runtime + turn API + MCP）        │
│    Plugin Bridge（独立进程：OpenClaw 社区插件）                    │
├────────────────────────────────────────────────────────────────┤
│ ④ Runtime 层（可替换）                                           │
│    builtin: Claude Agent SDK 原生二进制（内嵌 Bun，stdio NDJSON）  │
│    external: Claude Code CLI(-p NDJSON) / Codex(JSON-RPC) /      │
│              Gemini(ACP JSON-RPC)                                │
└────────────────────────────────────────────────────────────────┘
```

**关键通信规则**（源码架构文档明文约束）：

1. **控制面**：Renderer ↔ Sidecar 的 HTTP/SSE 必须经 Rust 代理（`invoke` → Rust → reqwest → Node），WebView 不直连；仅大载荷**数据面**（`/refs/:id`、`/attachment/*`）允许原生 fetch
2. **Management API**：Node → Rust 的**唯一反向 HTTP 通道**（axum 监听 127.0.0.1 随机端口，`MYAGENTS_MANAGEMENT_PORT` 注入），承载 cron/task/document/im/plugin 等内部管理
3. **Tauri IPC**：终端/浏览器事件、文件操作、任务状态广播
4. **SSE 事件命名空间**：`sse:${connectionKey}:${eventName}`（如 `sse:tab-xxx:chat:message-chunk`），带 transport/subscription 双 generation 防旧进程事件污染

### 2.1 Sidecar Owner 模型（进程生命周期核心）

```rust
pub enum SidecarOwner {
    Tab(String),                  // 聊天 Tab
    Companion(String),            // 浮窗/桌面宠物
    Task(String),                 // 定时任务
    Goal(String),                 // 长程目标
    BackgroundCompletion(String), // 后台完成保活
    Agent(String),                // IM Agent Channel
}
```

- **Session : Sidecar = 1:1**，多个使用者（Tab/任务/Goal/IM）以 Owner 身份**共享**同一 Sidecar，全部释放才停止
- 每个 Sidecar 有单调递增 **generation**：`DispatchGate` 按 generation 拒绝旧进程的迟到请求/结果；端口动态解析（`sessionIdHint + owner`），不存 owner→port 副本
- Global Sidecar 用 `Stopped | DesiredRunning` 表达运行意图，进程崩溃不清除意图，按有界退避自动恢复
- 进程树用**精确句柄**管理（Job Object/进程组），不做全机进程名猜测
- 本机实证：`~/.myagents/sidecar.port` 记录当前健康 generation 端口；安装目录的 `server-dist.js`（7.6MB）即 Sidecar 单文件 bundle

### 2.2 多 Runtime 抽象（对 WorkPivot 极有参考价值）

`src/server/session-engine/` 门面层统一 builtin/external：

| 组件 | 职责 |
|------|------|
| `selector.ts` | 按 `MYAGENTS_RUNTIME` 环境变量分流 builtin（Claude Agent SDK）/ external（CC/Codex/Gemini） |
| `builtin-adapter.ts` / `external-adapter.ts` | 保持两类会话语义 |
| `runtimes/*` | CC（NDJSON stdio `-p`）、Codex（JSON-RPC 2.0 `app-server`）、Gemini（ACP JSON-RPC）协议适配 |
| `UnifiedEvent` | 三种 Runtime 归一的流式事件联合类型 |

配置门控链路：Rust 读 `config.multiAgentRuntime + agent.runtime` → spawn 时注入 `MYAGENTS_RUNTIME` → Node 工厂选择 → SessionEngine 分流 → 前端同构判断。

### 2.3 OpenAI Bridge（三方模型接入的巧思）

Claude Agent SDK 只说 Anthropic 协议，于是：

```
SDK subprocess → ANTHROPIC_BASE_URL=127.0.0.1:{sidecarPort}
  → /v1/messages → Bridge handler → translateRequest → OpenAI 兼容上游
  → translateResponse → Anthropic 格式 → SDK
```

- 模型别名映射：SDK 子代理请求 `sonnet`/`haiku` 时用 `ANTHROPIC_DEFAULT_{SONNET,HAIKU,OPUS,FABLE}_MODEL` 环境变量解析到实际供应商模型
- DeepSeek 等已提供 Anthropic 原生端点（本机 config 实证 `https://api.deepseek.com/anthropic`）时可绕过 Bridge 直连
- Context-window 后缀策略（`[1m]`）统一管理不同模型的上下文长度

---

## 3. 核心子系统

### 3.1 任务中心：想法 → 任务 → 调度 → 审计

- **ThoughtStore**：`~/.myagents/thoughts/<YYYY-MM>/<id>.md`（按月归档的想法速记）
- **TaskStore**：`~/.myagents/tasks.jsonl`（状态机权威）+ `tasks/<id>/task.md`（canonical 任务文档）+ `comments.jsonl`
- 调度三类：一次性 / 周期 / **Cron 表达式**；AI 统一经 `myagents-task-automation` Skill + `myagents task ...` CLI 操作（GUI 与 CLI 对等）
- **Activation Trigger（命令感知器）**：command Task 到点先跑**本地低成本 Detector**（Rust 子进程，输出仅 `quiet | activate`），`quiet` 不唤醒 AI（省 token），`activate` 才建立 Session 执行——「先检查再唤醒」的省成本设计
- 状态机 + 审计链：每次状态变更原子写 `statusHistory`；recurring 失败第 5 次才 Blocked；durable outbox（`trigger-state.json`）保证重启后事件只结算一次
- Rust 拥有唯一 timer handle map + 瞬时 execution authority map

### 3.2 Goal 模式（Session 级长程目标）

同一 current-session 进入长程工作状态（`/goal` 或 AI 调 `myagents goal create`），`SessionGoalManager` 持久化到 `~/.myagents/session_goals.json`。要点：queueId（Turn 唯一身份）、sidecarGeneration（防旧进程回写）、Goal id（防旧 incarnation 回写）三重 fence；自动 continuation 隐藏信封注入；pause/cancel 先落盘再精确停止。**Goal 与 Task 正交**：Task 定时投递 Turn，Goal 维护 Session 长程状态。

### 3.3 记忆体系（与 OpenClaw/OpenMino 同源）★重点

MyAgents 的记忆 = **OpenMino 人格工作区 + 系统级托管维护**，是「产品化 OpenClaw 记忆」的最完整实现：

**工作区侧（bundled-workspaces/mino 模板，即 OpenMino）**：

```
workspace/
├── CLAUDE.md                        # 主入口（SDK 自动加载）
├── INTRODUCTION.md                  # 自我介绍
└── .claude/
    ├── rules/                       # 全部自动加载的四件套（与 WorkBuddy 同源！）
    │   ├── 01-IDENTITY.md           # 身份卡（名字/生日/性格/emoji/座右铭）
    │   ├── 02-SOUL.md               # 性格（"You're not a chatbot. You're becoming someone."）
    │   ├── 03-USER.md               # 用户画像
    │   └── 04-MEMORY.md             # 核心记忆（自动加载，含三层记忆使用说明）
    ├── commands/
    │   ├── BOOTSTRAP.md             # 首次唤醒对话脚本（OpenClaw 原版文案）
    │   └── UPDATE_MEMORY.md         # /UPDATE_MEMORY 整理记忆指令
    └── skills/                      # 工作区技能（apple-notes/github/peekaboo...）
memory/
├── YYYY-MM-DD.md                    # 按日日志（OpenClaw 式）
└── topics/<name>.md                 # 主题记忆文件
```

**三层记忆**（04-MEMORY.md 官方定义）：Core memory（本文件，每次自动加载）→ Topic files（按项目主题，按需读）→ Daily logs（原始日志，维护时读）。

**系统侧托管维护**（把记忆维护做成定时任务——比 WorkBuddy 的「每晚整理」更工程化）：

| 机制 | 实现 | 频率 |
|------|------|------|
| Memory Auto-Update | `memory_auto_update.rs`：每 Agent 配置 `intervalHours:24 + queryThreshold:3 + 更新窗口(21:00-09:00)`，在 Session 内运行 `myagents-memory-update` Skill 做**增量固化**（只回顾自上次成功更新后新增的工作，非全量总结） | 每日/每3问 |
| Memory Gardener | `memory_evolution.rs` 注册**托管任务**（`MANAGED_KIND_MEMORY_GARDENER`），运行 `myagents-memory-gardener` Skill 修剪记忆 | 每 72 小时 |
| Memory Molt | 托管任务 `MANAGED_KIND_MEMORY_MOLT`，运行 `myagents-memory-molt` Skill 做「蜕皮」级重构 | 每 14 天 |

### 3.4 IM / Agent Channel

- 内置适配器：**Telegram**（Bot API 长轮询）、**钉钉**（Stream 长连接）
- **BridgeAdapter**：HTTP 双向转发到独立 Node Plugin Bridge 进程加载 **OpenClaw 社区插件**（飞书/微信/QQ 等）——入口按 OpenClaw 官方 `package.json["openclaw"].extensions[]` 解析，SDK Shim（手写+自动生成 stub）兼容 CJS/ESM 混用插件
- Agent 模型：Project（工作区）= path 权威 + stable agentId → AgentConfig（heartbeat 活跃时段/间隔/ACK 上限、memoryAutoUpdate、memoryEvolution、模型、权限模式）；Channel effective state 独立于 Agent 总开关
- Heartbeat：主动巡检（activeHours 09:00-21:00、intervalMinutes 240）

### 3.5 内嵌终端与浏览器

- **终端**：Rust `portable-pty` 管理 PTY pair，xterm 前端，Tauri event 直传（不走 SSE）；绑定 Tab 生命周期，面板关闭不杀进程；环境注入内置 Node + `~/.myagents/bin` + `MYAGENTS_PORT`
- **浏览器**：两套——① 标准 `playwright` MCP preset（上游原生，`--isolated`）；② **受管「myagents-browser」**：固定有头 Chromium，Rust 拥有资源安装授权（锁定官方 artifact URL+SHA-256，用户点安装才下载）、Browser Identity（Cookie checkpoint CAS 持久化）、每 Product Session 一个隔离 BrowserContext。内嵌预览用 Tauri Multi-Webview（`browser.json` Capability **零权限**，Webview 无法访问 Tauri IPC）

### 3.6 全文搜索

Rust `Tantivy + tantivy-jieba`（37 万词中文分词）子系统：Session 历史（全局索引 + notify watcher 5s 去抖自动流入）与工作区文件内容两类查询；schema 版本门控自动重建。

### 3.7 Skills 体系

- 来源：GitHub 链接 / `npx skills add` / HTTPS zip / 本地目录/zip；安装到 `~/.myagents/skills/`（全局）或工作区 `.claude/skills/`
- 四段流水线：url-resolver → source-loader → 安全限额 → installer（staging+锁内 rename）
- **安全限额**：总量≤50MB、单文件≤5MB、≤2000 文件、拒 Zip-Slip/symlink、SSRF 防护（拒绝 loopback/RFC1918、DNS 钉死防 rebinding）
- 全局 Skill 投影为工作区 junction/symlink，project skill 按 canonical name 覆盖 global

### 3.8 文档处理（AnyDoc）

独立 Rust worker 进程（`myagents-document-worker`），有界 FIFO 队列 + 30 天 job 元数据 + crash-durable 发布协议；集成 AnyDoc、pdf-inspector、PDFium、**PP-OCRv6 Small（离线 OCR）**、ONNX Runtime CPU——**完全不联网、不依赖系统 Python/Node/GPU**。产物固定 `<output-root>/<job-id>/document.md` + `assets/`。

### 3.9 自配置 CLI

`myagents` 命令行（esbuild 单文件 CJS）：MCP/Provider/Agent/Cron/Goal/Task/Thought/Plugin 全量管理，**AI 在会话内通过 Bash 调用**（`MYAGENTS_PORT` 环境变量寻址）=「Agent 自管理应用」；Rust 在 `~/.myagents/bin/` 投影薄启动器。

### 3.10 其他

- **Cloud Space**（实验室）：官方/团队空间、Registered Agent（按 `(userId, deviceId)` 注册的执行实例）、Issue/IssueDelivery；本地状态 `~/.myagents/space/`
- **桌面宠物/浮窗**（hatch-pet skill、floating_ball.rs）、全局快捷键、自动更新（updater 插件）
- **Theme 系统**：ThemeRegistry 契约校验（每 Theme 必须含 light/dark 与 xterm/Monaco/Mermaid adapter）
- **统一日志**：`~/.myagents/logs/unified-{date}.log` 汇聚 [REACT]/[NODE]/[RUST] 三源 + Boot Banner 自检行

---

## 4. 数据存储布局（~/.myagents 实测）

| 路径 | 内容 |
|------|------|
| `config.json`（+.bak） | 全局配置：agents[]（heartbeat/memoryAutoUpdate/memoryEvolution/模型/权限）、`availableProvidersJson`（**供应商 API key 明文**⚠️）、theme/i18n/autostart |
| `projects.json` | 工作区注册表（path/templateId/workspaceType: system-preset） |
| `projects/<name>/` | 工作区实例（如 mino：CLAUDE.md + .claude/ + memory/）——模板复制，升级不覆盖 |
| `sessions/` | 会话 JSONL（SessionStore 权威；本机暂空） |
| `thoughts/YYYY-MM/<uuid>.md` | 想法速记（按月归档） |
| `tasks.jsonl` + `tasks/<id>/` | 任务权威 + task.md + comments.jsonl + trigger-state.json |
| `session_goals.json` | Goal 状态 |
| `skills/` | 全局已装技能 |
| `plugins/` | OpenClaw 插件 |
| `credentials/` | 凭据 |
| `providers/` | 供应商数据 |
| `attachments/<session>/` | 用户图片附件 staging（首段=sessionId，≤10MB 为 vision ref） |
| `generated/tool-attachments/` | AI 产物附件 trusted root |
| `search_index/sessions/` | Tantivy 全文索引 |
| `space/` | Cloud Space 本地状态（session.json/registered_agents.json/delivery_log.json） |
| `runtime/`、`cache/`、`logs/`、`bin/`（CLI 启动器）、`device_id`、`sidecar.port`、`app.lock`、`mcp_oauth_state.json` | 运行时/缓存/日志/标识 |

**安装目录**（D:\Program Files\MyAgents）：`myagents.exe`（95MB，Tauri）+ `server-dist.js`（Sidecar bundle）+ `plugin-bridge-dist.mjs` + `claude-agent-sdk/`（SDK 原生二进制）+ `cuse.exe`（预置 Computer-Use MCP）+ `nodejs/`（内置 Node v24）+ `tsx-runtime/` + `sharp-runtime/` + `document-processing/`（AnyDoc/OCR 资源）+ `bundled-{agents,skills,workspaces}/` + i18n lproj + legal。

---

## 5. 安全设计

- Tauri FS scope 仅放行 `~/.myagents`；Capabilities 最小权限
- Sidecar 仅监听 127.0.0.1；`local_http` 强制 `.no_proxy()` 防系统代理劫持
- 内嵌浏览器 Webview 零权限 Capability + http/https scheme 白名单
- workspace 文件 IO：写侧 lexical / 读侧 canonical 解析防 symlink 逃逸；`symlink_metadata` 防断链误判；bounded read 防 TOCTOU OOM；附件 5 层路径校验 + SSRF DNS 钉死
- Skill 安装管线限额（见 §3.7）
- ⚠️ 弱点：`config.json` 供应商 API key 明文（与 WorkBuddy models.json 同病）

---

## 6. 工程实践亮点（开源项目里的高水准）

1. **架构文档文化**：specs/ARCHITECTURE.md 1169 行 owner/边界级文档 + tech_docs/ 30+ 专题文档 + CLAUDE.md/AGENTS.md，且文档与代码同仓同审
2. **Owner 模型 + fail-closed 原则**贯穿全部子系统（迟到结果拒收、generation fence、first-writer-wins 终态）
3. **测试分层**：unit/integration/credentialed 显式后缀；`setup-no-egress.ts` 在测试层阻断非 loopback 出网；测试分类脚本扫描
4. **静态边界执行**：ESLint no-restricted-syntax 封禁已删 endpoint、dependency-cruiser 锁模块依赖方向、Clippy
5. **AGPL + 商业双许可**（COMMERCIAL-LICENSING.md）——开源个人使用、商业需授权

---

## 7. 与 WorkBuddy 对照及对 WorkPivot 的启示

### 7.1 架构对照

| 维度 | WorkBuddy（闭源） | MyAgents（开源） |
|------|------------------|------------------|
| 桌面框架 | Electron（exe 204MB + asar 283MB） | **Tauri v2（exe 95MB）** |
| Agent 运行时 | 自研 CodeBuddy CLI（genie，OpenAI Agents SDK） | Claude Agent SDK 原生二进制 + 可换 CC/Codex/Gemini CLI |
| 进程模型 | 每工作区 CLI host，PID 注册文件+心跳 | **Sidecar Owner 模型**（共享+引用计数+generation） |
| UI↔运行时通信 | Renderer 直连 localhost HTTP | **控制面强制过 Rust 代理**（WebView 零直连） |
| 模型接入 | 云端网关（copilot.tencent.com）+ 用户自配 | 本地 OpenAI Bridge 协议翻译 / Anthropic 兼容端点直连 |
| 记忆 | OpenClaw 式四层（用户全局+项目 MEMORY+日志） | **OpenMino 工作区三层 + 托管维护任务**（auto-update/gardener 72h/molt 14d） |
| 扩展 | 插件市场体系（专家/技能/连接器） | MCP + Skills（Anthropic 格式）+ OpenClaw 插件 Bridge |
| 任务 | 会话任务 + 自动化（本地） | **Thought→Task 状态机 + Activation Trigger 省token检测器** |
| IM | 微信/企微/QQ/飞书/钉钉（自有通道） | Telegram/钉钉内置 + OpenClaw 社区插件 |
| 搜索 | 未见本地全文索引 | Tantivy+jieba 本地全文搜索 |
| 定价 | 积分制 | 开源免费（AGPL） |

### 7.2 对 WorkPivot 的启示（按优先级）

1. **桌面框架选型的实证**：MyAgents 证明 Tauri v2 + Rust 承担系统能力（PTY/搜索/文件IO/进程编排/文档OCR）+ 内置 Node Sidecar 承担 AI 运行时的混合架构完全可行，且体积/内存/安全边界显著优于 Electron 方案。这与我们「桌面端必有」的约束直接相关，**建议 Tauri 进入选型候选并加权**
2. **「Rust 承担系统层、Node 承担 AI 层」的分层**值得直接采纳：系统能力（文件/终端/进程/搜索/调度）用 Rust 做，AI Runtime 用 Node（生态所迫），两层经 localhost HTTP + Management API 双向通信
3. **Sidecar Owner 模型**：多入口（Tab/定时任务/IM/Goal）共享会话进程的引用计数设计，解决「多个触发源用同一个会话」的生命周期问题——WorkPivot 的多渠道（桌面/IM/定时）场景必需
4. **多 Runtime 抽象**：SessionEngine 门面 + UnifiedEvent 归一，让「换底层 Agent 引擎」不伤产品层——WorkPivot 私有化场景可能要对接不同国产模型/引擎，这层抽象是保险
5. **记忆维护产品化**：把记忆整理做成不同频率的托管任务（增量固化/修剪/蜕皮三级），比 WorkBuddy 的单一「每晚整理」更精细——WorkPivot 可采用「增量固化(日)+修剪(周)+重构(双周)」节奏
6. **Activation Trigger 模式**：定时任务先跑零成本检测器再决定是否唤醒大模型——私有化场景算力有限时价值更高
7. **OpenClaw 生态是事实标准**：MyAgents 与 WorkBuddy 的记忆/人格/插件体系均与 OpenClaw 同构（MyAgents 干脆直接用 OpenMino 模板和 OpenClaw 插件协议）——WorkPivot 的人设/记忆/插件格式应对齐该生态，白得社区内容
8. **AGPL 风险提示**：若 WorkPivot 借鉴 MyAgents 代码必须注意 AGPL 传染（商用闭源需商业授权）；**学架构思想、不抄代码**
9. **安全反面教材再+1**：MyAgents 的 config.json 同样明文存 API key——WorkPivot 的密钥加密（DPAPI/Keychain/KMS）要作为硬需求

### 7.3 可直接复用的清单（概念层面）

- Sidecar Owner/generation/DispatchGate 进程治理
- 控制面过原生层代理 + 数据面例外的通信纪律
- SessionEngine/UnifiedEvent 多运行时抽象
- OpenMino 三层记忆文件布局 + 记忆托管任务分级
- Thought→Task 状态机 + trigger-state durable outbox
- Skill 安装安全限额与 SSRF 防护参数（50MB/5MB/2000 文件/DNS 钉死）
- 统一日志（三源汇聚）+ Boot Banner 自检
- 测试 egress 阻断与分类扫描

## 附：快速验证路径（本机）

| 想看什么 | 去哪里 |
|----------|--------|
| 架构总纲 | `E:\project\MyAgents\specs\ARCHITECTURE.md` |
| 记忆模板原貌 | `E:\project\MyAgents\bundled-workspaces\mino\.claude\rules\` |
| 记忆维护调度 | `src-tauri/src/memory_evolution.rs`（GARDENER 72h / MOLT 14d） |
| Sidecar 治理 | `src-tauri/src/sidecar/`（manager/session_lifecycle/instances） |
| 多 Runtime | `src/server/session-engine/` + `src/server/runtimes/` |
| OpenAI Bridge | `src/server/openai-bridge/` |
| Skill 安装管线 | `src/server/skills/` |
| 全文搜索 | `src-tauri/src/search/` |
| 运行时数据 | `C:\Users\{user}\.myagents\`（config/projects/thoughts/skills…） |
