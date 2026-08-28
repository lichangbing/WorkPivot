# 开源项目分析：OpenClaw（个人 AI 助理框架——记忆/人设/通道生态的事实标准源头）

> 分析方式：源码级分析（E:\project\openclaw，v2026.4.6）+ docs/concepts 架构文档精读。
> 姊妹文档：[workbuddy-technical-analysis.md](workbuddy-technical-analysis.md)（其记忆/人设/通道层借鉴 OpenClaw）、[myagents.md](myagents.md)（用 OpenClaw 插件协议）、[openworkbuddy.md](openworkbuddy.md)——本文补全三家共同引用的生态源头。

- **分析人**：ZCode
- **日期**：2026-08-28

---

## 1. 项目身份

| 项 | 值 |
|----|-----|
| 定位 | **个人 AI 助理**：跑在自己设备上，通过你已有的聊天渠道响应（22+ 通道），可语音、可渲染实时 Canvas。「Gateway 只是控制平面——产品是助理本身」 |
| 演化 | Warelay → Clawdbot → Moltbot → **OpenClaw**（作者 Peter Steinberger，2025 末爆红，2026 活跃迭代） |
| 许可 | **MIT**（可自由借鉴/使用代码） |
| 技术栈 | TypeScript / Node.js（Express 5 + ws）/ TypeBox 协议Schema → Swift 代码生成 / pnpm / vitest（30+ 配置分片） |
| 客户端 | 原生三端：macOS/iOS/Android（apps/，Swift/Kotlin）+ CLI + WebChat + TUI |
| 规模 | 单包大仓（src/ 60+ 模块）+ packages（plugin-sdk、memory-host-sdk、plugin-package-contract） |

**与 WorkPivot 的关系**：OpenClaw 定义了「个人 agent 的记忆/人设/通道/插件」事实格式——WorkBuddy 的 claw 配置段与 SOUL 四件套、MyAgents 的 OpenMino 工作区与 Plugin Bridge、OpenWorkBuddy 的记忆搬家扫描全都对齐它。**对齐 OpenClaw 生态 = 白得社区内容与互操作性**。

## 2. 总体架构

```
┌──────────────────────────────────────────────────────────────┐
│ Gateway 守护进程（每主机一个，唯一持有 WhatsApp 会话）             │
│  · Express 5 + WebSocket :18789（默认仅 127.0.0.1）             │
│  · 类型化 WS 协议：req/res/event 三帧式，TypeBox 校验             │
│    （JSON Schema 生成 → Swift 模型代码生成，三端共享契约）        │
│  · 事件：agent / chat / presence / health / heartbeat / cron   │
│  · Canvas Host：/__openclaw__/canvas/（agent 可编辑的 HTML/CSS/JS）│
│                /__openclaw__/a2ui/（A2UI 宿主）                  │
├──────────────┬───────────────────────────────────────────────┤
│ 控制面客户端    │ 节点 Nodes（macOS/iOS/Android/headless）         │
│ macOS/CLI/Web │ role:"node" + caps/commands                    │
│ 一连接一发      │ canvas.* / camera.* / screen.record / location │
├──────────────┴───────────────────────────────────────────────┤
│ 通道层（22+）：WhatsApp(Baileys)/Telegram(grammY)/Slack/Discord  │
│  /Signal/iMessage/Matrix/飞书/LINE/Teams/微信/Zalo/WebChat…      │
│  · allowlist 门禁、入站防抖、草稿流式、ACK 反应、会话绑定          │
├──────────────────────────────────────────────────────────────┤
│ 多智能体路由：Agent = 完全隔离的 brain                            │
│  workspace（AGENTS/SOUL/USER.md+记忆）+ agentDir（auth-profiles）│
│  + 会话库；多通道账号；按 bindings 路由到 agent                   │
├──────────────────────────────────────────────────────────────┤
│ Agent 运行时：嵌入式 pi-agent-core（@mariozechner/pi-* 0.65.2）  │
│  + ACP spawn 外部 agent + Anthropic Vertex/Bedrock 传输         │
│  每 session 串行 runId；skills 快照；事件桥接（tool/assistant/    │
│  lifecycle 流）                                                │
└──────────────────────────────────────────────────────────────┘
```

**关键工程细节**：

- **配对与信任**：所有 WS 客户端带设备身份；新设备需配对审批后发 device token；connect 必须签 challenge nonce（v3 签名还绑定 platform+deviceFamily，元数据变化强制修复配对）；环回可自动批准，尾网/LAN 仍需显式审批；幂等键强制用于副作用方法（send/agent）
- **协议即契约**：TypeBox 定义 → JSON Schema → Swift 代码生成——三端原生客户端与网关共享同一份协议契约，这是我们多端（桌面+未来移动）的参考

## 3. 核心机制

### 3.1 Agent 运行时：嵌入式 pi-agent-core（值得注意的迁移）

agent loop 的权威路径：`agent` RPC 校验 → 解析 session → 立即返回 `{runId, acceptedAt}` → `runEmbeddedPiAgent`（每 session + 全局队列串行）→ pi 事件桥接为 `stream: tool/assistant/lifecycle` → 超时中止。**OpenClaw 已从早期 Claude Agent SDK 方案迁移到 pi-agent-core**（正是 dsh 与 OpenWorkBuddy 都引用的 earendil-works/pi）——pi 作为可嵌入 agent 内核在三个项目里得到独立验证。另有 ACP spawn（外部 agent 进程）与 Vertex/Bedrock 传输适配。

### 3.2 记忆体系（WorkBuddy/MyAgents 记忆的源头，且更进一步）

- **纯 Markdown，无隐藏状态**：「模型只记得写到磁盘的东西」——MEMORY.md（长期，每次 DM 会话开头加载）+ memory/YYYY-MM-DD.md（今日+昨日自动加载）+ DREAMS.md（梦境日记，人可审）
- **记忆工具**：`memory_search`（**混合检索**：sqlite-vec 向量相似 + 关键词匹配；embedding 供应商从已有 API key 自动检测——OpenAI/Gemini/Voyage/Mistral）+ `memory_get`（读指定文件/行范围）
- **记忆后端可插拔**：memory-core（默认，SQLite 内置）/ Honcho / QMD——记忆是插件（memory-host-sdk）
- **Dreaming（后台记忆固化，三相位）**：
  | 相位 | 职责 | 持久写入 |
  |------|------|----------|
  | Light | 整理近期短期信号，去重、staging 候选行 | 否 |
  | Deep | 加权评分（minScore/minRecallCount/minUniqueQueries 三门槛）+ 从活文件重水化（跳过已删片段）→ 晋升 | **是（MEMORY.md）** |
  | REM | 反思主题与反复出现的想法 | 否 |
  机器状态在 `memory/.dreams/`，人类可读输出在 DREAMS.md + 分相报告——**MyAgents 的 gardener/molt、WorkBuddy 的「每晚整理」都是它的简化版**

### 3.3 多智能体与隔离

- Agent = workspace + agentDir + session store 三件套的完全隔离；auth-profiles **按 agent**（`~/.openclaw/agents/<agentId>/agent/auth-profiles.json`），主 agent 凭据不自动共享
- 多通道账号（两个 WhatsApp）+ bindings（入站 → agent 的路由规则）
- `sessions_history` 跨会话召回是**有界净化视图**：剥离 thinking 标签、`<relevant-memories>` 脚手架、工具调用 XML、泄漏的模型控制 token、畸形 MiniMax 工具调用 XML——防提示词注入式的记忆污染
- 技能按 agent 允许清单过滤（`agents.defaults.skills` 共享基线 + `agents.list[].skills` 按agent替换）

### 3.4 插件体系（MyAgents Plugin Bridge 加载的目标格式）

- **能力模型**：原生插件按 capability 注册——文本推理（`api.registerProvider`：openai/anthropic…）、通道插件、Provider 插件、webhooks、bundles
- 清单：`package.json["openclaw"].extensions[]`（MyAgents Bridge 按此解析）；plugin-sdk + plugin-package-contract 独立成包；**jiti 加载 TypeScript 插件**
- 文档含完整的插件开发/测试/迁移指南（sdk-channel-plugins/sdk-provider-plugins/sdk-testing）

### 3.5 其他子系统（src/ 模块清点）

context-engine（上下文组装）、compaction/session-pruning（pi 式压缩）、cron（croner）+ tasks + polls、媒体生成（image/music/video/tts/realtime-voice/realtime-transcription）、link-understanding（readability+linkedom+pdfjs）、web-fetch/web-search、canvas-host、node-host（节点设备）、pairing、secrets（.detect-secrets + .secrets.baseline 433KB）、security（专用 Dockerfile.sandbox / sandbox-browser）、wizard（`openclaw onboard` 引导安装）。

## 4. 生态地位验证（三家如何用 OpenClaw）

| 项目 | 借鉴/使用 | 证据 |
|------|-----------|------|
| WorkBuddy | SOUL/IDENTITY/USER/BOOTSTRAP 人设四件套、STORY.md、connectors（.master.key + README-DO-NOT-DELETE）、settings.json 的 **claw 配置段**、BOOTSTRAP 引导 WhatsApp | 本机逆向（workbuddy-technical-analysis.md §5/§8） |
| MyAgents | Plugin Bridge 按 `package.json["openclaw"].extensions[]` 加载社区通道插件（飞书/微信/QQ）；内置 Mino 工作区 = OpenMino（OpenClaw 生态人格工作区） | myagents.md §3.4 |
| OpenWorkBuddy | 记忆搬家功能扫描导入 OpenClaw 系记忆文件；`AGENTS.md/CLAUDE.md` 工作区约定 | openworkbuddy.md |
| DeepSeek Harness | pi 的 compaction 设计（同一 pi 生态，间接同源） | dsh 架构文档 |

**结论**：OpenClaw 的记忆文件格式、人设文件、插件清单格式已是个人 agent 领域的事实标准。WorkPivot 的对应格式（记忆 Markdown 布局、SOUL 类人设、openclaw.extensions 插件清单）**对齐即可 interoperable**，且 MIT 许可无传染。

## 5. 对 WorkPivot 的启示（按价值排序）

1. **记忆：直接采用其文件布局 + Dreaming 三相固化**——MEMORY.md/按日/主题的布局已被三家验证；Dreaming 的「staging → 门槛评分晋升 → 主题反思 + 人类可审日记」比单纯定时整理更工程化，可作为 E04（记忆托管维护）的实现蓝本
2. **混合记忆检索**：sqlite-vec（SQLite 向量扩展）+ 关键词混合，**无需独立向量库**——私有化部署零外部依赖的实现路径（E03）；「从已配 API key 自动检测 embedding 供应商」的零配置体验值得抄
3. **跨会话召回的净化视图**：剥离工具调用 XML/控制 token/脚手架再给模型——防上下文污染的安全细节，直接采纳
4. **协议即契约（TypeBox → JSON Schema → 各端代码生成）**：桌面（Tauri/Electron）、Web、未来移动端共享同一 WS 协议契约的工作流
5. **设备配对模型**：challenge 签名 + 设备 token + 元数据绑定 + 幂等键——WorkPivot 的 IM 远程指挥/移动端接入的安全基线（I 模块）
6. **Agent = 隔离 brain 的多智能体模型**：workspace+agentDir+会话库三件套 + bindings 路由——对应我们「不同企业/不同专家」的多实例设计；按 agent 的凭据隔离是私有化安全刚需
7. **通道层工程细节清单**：allowlist 门禁、入站防抖（多条消息合并处理）、草稿流式（打字机效果）、ACK 反应——接 IM 时直接照单实现
8. **运行时选型信号**：OpenClaw（生产级个人助理）从 Claude Agent SDK 迁到 **pi-agent-core**，加上 dsh/OWB 引用 pi 的 compaction——pi 是比 Claude Agent SDK 更中立的可嵌入内核候选（TS、可 fork、MIT），应纳入 ADR-002 的候选对比
9. **Canvas（agent 可编辑的实时 HTML 界面）**：与 dsh 的双半插件 UI 同一思想——「agent 生成可视化面板」是企业场景（数据看板、报告预览）的高价值形态，列为二期候选

## 6. 风险与边界

- OpenClaw 本体是**单用户个人助理**（单 Gateway、每主机一个 WhatsApp 会话）——多租户企业化需要我们自建（对应 J 模块），它的价值在**格式与机制**而非整体架构
- 仓库巨大（CHANGELOG 1MB、vitest 30+ 分片），借鉴时按模块读，不要整体依赖
- 部分实验特性（Dreaming 默认关闭、DREAMS.md 实验性）需自行验证稳定性

## 7. 待深挖项

- [ ] `src/context-engine` 与 compaction 的具体策略（对照 pi 原版差异）
- [ ] `plugin-package-contract` 包的清单 schema（WorkPivot 插件格式对齐用）
- [ ] Canvas host 的沙箱与权限模型（agent 生成 HTML 的安全边界）
- [ ] pi-agent-core 本体（earendil-works/pi）源码分析——已被本项目/dsh/OWB 三方引用，建议单独立一份选型调研

## 附：快速验证路径（本机）

| 想看什么 | 去哪里 |
|----------|--------|
| 网关架构与 WS 协议 | `docs/concepts/architecture.md` |
| 记忆体系/Dreaming | `docs/concepts/memory.md`、`dreaming.md`、`memory-search.md` |
| 多智能体隔离 | `docs/concepts/multi-agent.md` |
| Agent loop（pi 运行时） | `docs/concepts/agent-loop.md` |
| 插件能力模型 | `docs/plugins/architecture.md` + `src/plugin-sdk` |
| 通道实现细节 | `src/channels/`（allowlist/debounce/draft-stream） |
| 愿景与贡献规则 | `VISION.md`（PR ≤5000 行等工程纪律） |
