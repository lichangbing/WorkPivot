# WorkBuddy 技术架构逆向分析（本机实测）

> 分析方式：对本机安装的 WorkBuddy 桌面端做文件级逆向分析（安装目录、配置目录、工作目录），不含任何动态调试或破解行为。
> 姊妹文档：[workbuddy.md](workbuddy.md)（产品层面分析）、**[workbuddy-extension-system.md](workbuddy-extension-system.md)（扩展系统专项：专家/技能/连接器/插件的动态加载机制，含 WorkPivot 实现参考）**。
> 隐私说明：本文只引用结构与机制，不引用本机用户的记忆内容与密钥原文。

- **分析人**：ZCode
- **日期**：2026-08-27
- **分析对象版本**：
  - 桌面端：**5.3.14**（build commit `825709d4`，构建于 2026-08-17，来自 `last-launch.json`）
  - 内嵌 Agent 运行时：`@tencent-ai/codebuddy-code` **2.115.0**（genie 框架 5.3.14）
- **信息来源**：
  - 安装目录：`C:\Users\{user}\AppData\Local\Programs\WorkBuddy`
  - 配置/数据目录：`C:\Users\{user}\.workbuddy`
  - 工作目录：`E:\workspace`（含多个实际项目）

---

## 1. 总体架构结论（一句话版）

**WorkBuddy = Electron 桌面壳 + 内嵌 CodeBuddy CLI 作为 Agent 运行时 + OpenClaw 式个人智能体/记忆/IM 通道层 + 腾讯云服务（模型网关/COS/Galileo 遥测）**，通过同一内核的 product 配置裁剪出 SaaS、iOA、云托管、**私有化（selfhosted）** 多种部署形态。

### 1.1 进程与拓扑

```
┌─────────────────────────────────────────────────────────┐
│ WorkBuddy.exe（Electron 主进程，~204MB，Chromium 渲染）      │
│  ├─ resources/app.asar（283MB 业务代码）                   │
│  ├─ resources/app.asar.unpacked/                         │
│  │    ├─ cli/  ← CodeBuddy CLI（@genie/agent-cli，核心）   │
│  │    ├─ node_modules/（better-sqlite3、koffi、node-pty…） │
│  │    └─ native/wechat-copydata-decoder（微信解码原生模块）  │
│  ├─ WorkBuddyRepair.exe（.NET 自修复工具）                  │
│  ├─ elevate.exe（提权辅助） / qimei.dll（腾讯设备指纹）      │
│  └─ qm/、vendor/genie-trash（电脑管家组件、回收站）           │
└──────────────┬──────────────────────────────────────────┘
               │ 按工作区 spawn 子进程 + localhost HTTP 通信
   ┌───────────▼───────────────────────────────┐
   │ CLI Host 子进程（每工作区一个）                │
   │  cwd = %TEMP%\workbuddy-host-cli\           │
   │        __workbuddy_cli_host__-{N}-{hash}    │
   │  起 HTTP 服务（如 http://127.0.0.1:56887）    │
   │  向 ~/.workbuddy/sessions/{pid}.json 注册    │
   │  （含 lastHeartbeat 心跳）                    │
   └───────────┬───────────────────────────────┘
               │
   ┌───────────▼─────────────┐   ┌──────────────────────────┐
   │ 本地常驻服务              │   │ 云端（SaaS 形态）           │
   │ · connector-proxy        │   │ · copilot.tencent.com     │
   │   （MCP 聚合代理，127.0.0.1）│   │   模型网关/认证/credits    │
   │ · tencent-docs-engine    │   │ · Centrifuge WebSocket    │
   │   （端口写入 .port 文件）    │   │   （edge-sync 实时通道）    │
   └─────────────────────────┘   │ · 腾讯 COS（产物/图片同步）  │
                                 │ · galileotelemetry.tencent │
                                 │   .com（Galileo 遥测）      │
                                 └──────────────────────────┘
```

关键证据：

- `sessions/{pid}.json`：`{"pid":10892,"lastHeartbeat":...,"cwd":"%TEMP%\\workbuddy-host-cli\\__workbuddy_cli_host__-1-...","url":"http://127.0.0.1:56887","mode":"local","version":"2.115.0"}` —— 桌面 UI 与 Agent 运行时是**进程隔离**的，通过本地 HTTP + 心跳注册发现彼此。
- `.workbuddy/.mcp.json`：`connector-proxy → http://127.0.0.1:{port}/mcp`，描述为「Aggregated proxy containing MCP servers: agent-mail」——所有连接器以 MCP 形态经本地代理聚合注入。
- `tencent-docs-engine.port`：腾讯文档本地引擎以独立本地服务运行（本机端口 39099）。
- `logs/edge-sync.log`：`[channel-sdk][ws-transport]`、`[presence] self-heal` —— 云端实时通道为 WebSocket 长连接（对应依赖 `centrifuge`），有断线自愈。

### 1.2 多部署形态（对我们最重要的发现）

`app.asar.unpacked/cli/` 下存在一组**产品形态补丁配置**，同一 CLI 内核构建出四种产品：

| 形态 | 配置文件 | 特征 |
|------|----------|------|
| 内部版 | `product.internal.json` | 腾讯内网域名 SSO |
| iOA 版 | `product.ioa.json` | 腾讯 iOA 安全接入域名，全量模型池，Galileo 遥测开启，credits 计费 |
| 云托管版 | `product.cloudhosted.json` | `*.sso.copilot.tencent.com` **多租户 SSO 通配域名** |
| **私有化版** | `product.selfhosted.json` | 见下 |

**selfhosted（私有化）形态的具体差异**（`product.selfhosted.json` 全文比对）：

- 模型池裁剪到**仅 1 个内置模型** `codewise-chat`（腾讯自有 Codewise，128K 输入、支持工具调用），不再暴露 Claude/GPT/Gemini 等外部模型
- `galileo.enable: false` —— 私有化部署**遥测关闭**
- `DisableMemoryPersonalization: true` —— 记忆个性化默认关闭（合规考虑）
- 保留 `CustomModelsJSON: true` —— 允许客户在私有环境**自行配置 OpenAI 兼容的自有模型**（本机 `models.json` 中用户自配了 DeepSeek/MiniMax 即为此机制，接口为 `https://api.xxx.com/chat/completions` OpenAI 兼容格式）
- 构建机制：`package.json` 的 `patch` 脚本用 genie patch 从同一代码基打四种形态补丁，通过环境变量 `ACC_PRODUCT_CONFIG_PATH` / `ACC_PRODUCT_CONFIG_V3` 在运行时注入

> **启示**：WorkPivot 主打私有化，这套「一份内核 + 形态配置补丁」的多形态构建机制可直接借鉴，避免分叉维护。

---

## 2. 技术栈清单（有据可查）

来自 `app.asar.unpacked/cli/package.json`（`@genie/agent-cli`）与安装目录文件：

| 层 | 技术 | 证据 |
|----|------|------|
| 桌面壳 | Electron（含 Chromium 全家桶：pak/icudtl/v8 snapshot） | `LICENSE.electron.txt`、`resources.pak` 等 |
| 语言 | TypeScript（主体）、.NET（修复工具，Newtonsoft.Json） | `WorkBuddyRepair.exe.config` |
| Agent 编排 | **`@openai/agents` 0.5.2**（OpenAI Agents SDK） | cli 依赖 |
| 模型接入 | `openai` SDK（OpenAI 兼容协议）；`@genie/agent-provider` | cli 依赖 + models.json 自定义模型 |
| 工具协议 | **MCP**（`@modelcontextprotocol/sdk` 1.29.0）、**ACP**（`@agentclientprotocol/sdk` 0.25.0） | cli 依赖 |
| 沙箱 | `@anthropic-ai/sandbox-runtime` + `@tencent-ai/sandbox-cli`（darwin/win32/linux 三平台原生包，5.3.3） | optionalDependencies |
| 终端 | `@lydell/node-pty`、`@xterm/headless` | cli 依赖 |
| 数据库 | **better-sqlite3**（WAL 模式） | node_modules + `edge-sync-mapping-v2.db-wal/-shm` |
| FFI | `koffi`（调用原生库，如微信解码） | node_modules |
| 代码解析 | `web-tree-sitter` + `tree-sitter-bash` | cli 依赖 |
| 实时通道 | `centrifuge`（Centrifugo WebSocket 客户端） | cli 依赖 + edge-sync.log |
| 云沙箱 | `e2b` 2.3.6（可选远端执行环境） | cli 依赖 |
| 可观测 | `@tencent/galileo-node-sdk`（LLM 链路追踪）+ `@opentelemetry/api` | cli 依赖 + product.json galileo 段 |
| 终端 UI | `ink` 6 + React 19（CLI 交互界面） | cli 依赖 |
| 构建体系 | 腾讯 Cell 框架（`@celljs/*`）+ rspack + goreleaser + changesets | cli scripts |
| 设备识别 | qimei（腾讯设备指纹 SDK，`qimei.dll` + `qimei-cache.json`） | 安装目录 + 配置 |

---

## 3. Agent 架构

### 3.1 主 Agent 的工具面（约 45 个工具）

主 agent `cli` 的工具清单（product.json），完整勾勒能力边界：

- **文件/代码**：Read、Write、Edit、NotebookEdit、Glob、Grep、LSP
- **执行**：Bash、PowerShell（沙箱内）、DeferExecuteTool（延迟执行工具）
- **规划/任务**：EnterPlanMode/ExitPlanMode、TaskCreate/Get/Update/List/Stop/Output
- **子代理/协作**：Agent（派生）、SendMessage、TeamCreate/TeamDelete、DelegateTool
- **信息**：WebFetch、WebSearch、StructuredOutput、AskUserQuestion
- **IM 回复**：**WeChatReply、WeComReply**（微信/企微通道回信，桌面 IM 机器人的落点）
- **桌面操控**：**ComputerUse**
- **多模态生成**：ImageGen、ImageEdit、VideoGen
- **生态**：Skill、SkillManage、ListMcpResources/ReadMcpResource/WaitForMcpServers
- **自动化**：CronCreate/CronDelete/CronList（定时任务，productFeatures `ScheduledTasks: true`）
- **工作流**：Workflow、EnterWorktree/LeaveWorktree（git worktree 隔离）

### 3.2 内置子代理（product.json agents 段，17+ 个）

除通用 Agent 外，有一批**专职小模型子代理**构成产品体验的「暗物质」：

| 子代理 | 职责 | 模型 |
|--------|------|------|
| `memorySelector` | **为当前查询挑选相关记忆**（记忆注入的检索器） | lite |
| `contextSummary` | 会话压缩与超长上下文恢复 | - |
| `summaryGenerator` | 会话摘要生成 | lite |
| `autoModeClassifier` | 自动模式下工具调用风险分级 | - |
| `promptHookEvaluator` | 用 LLM 评估 prompt hook 条件 | lite |
| `contentAnalyzer` | 内容分析 | lite |
| `promptSuggestion` | 下一句输入建议 | lite |
| `enhance-prompt` | 桌面输入框提示词改写（ioa 版） | - |
| `terminalTitleGenerator` | 终端窗口标题生成 | lite |
| `insightsAnalyzer` | `/insights` 使用洞察分析 | - |
| `pulse` | 联网资讯推荐（ioa 版） | - |
| `Explore` / `Plan` | 快速代码勘察/规划（asTool 子代理） | lite/- |
| `compact`、`statusline-setup`、`agentInstructions` | 压缩、状态栏、指令生成 | - |

> **启示**：主模型只做主链路，记忆检索/风险分级/摘要/建议全部用 lite 模型分流，成本结构清晰。

### 3.3 专家智能体 = 插件化人格

`app/data/expert-history.json` 显示「100+ 行业专家」的实现方式——**专家是插件**：

```json
{ "id": "GovernmentDigitalPresalesConsultant", "name": "政通通",
  "profession": "政府数字化售前顾问", "industryId": "07-SalesCommerce",
  "defaultInitPrompt": "...", "pluginName": "government-digital-presales-consultant",
  "source": "builtin", "isCustomExpert": true }
```

即专家 = 插件包（prompt + 技能 + 头像）+ 行业分类 ID + 预置开场白，支持自定义专家。
（专家插件的完整 manifest、召唤流程、市场分发机制详见 [workbuddy-extension-system.md](workbuddy-extension-system.md) §4。）

### 3.4 团队智能体

`teams/`、`_auto_{conversationId}` 目录 + TeamCreate/TeamDelete 工具 + `app-config.json` 的 `disableAgentTeams` 开关：多智能体组队协作（一个会话可派多 agent 并行工作）。

---

## 4. 数据存储全景

### 4.1 三个存储区域

| 区域 | 路径 | 性质 |
|------|------|------|
| 安装区 | `AppData\Local\Programs\WorkBuddy` | 程序本体 + 修复工具，只读 |
| **全局状态区** | `~/.workbuddy` | 跨项目共享：配置、账号、记忆、市场、审计、日志、SQLite |
| **工作区** | `E:\workspace\{项目}` | 用户交付物 + 项目本地 `.workbuddy/`（记忆） |

### 4.2 全局状态区 `~/.workbuddy` 目录详解

| 目录/文件 | 机制 | 说明 |
|-----------|------|------|
| `settings.json` | JSON | 插件开关、沙箱写入白名单（`sandbox.extraAllowWrite`）、`claw` 段（IM 通道配置，按用户 UUID 配置 wechatmp webhook） |
| `models.json` | JSON | 用户自配第三方模型（OpenAI 兼容 URL + key + 能力位）。⚠️ **API key 明文** |
| `mcp.json` / `.mcp.json` / `mcp-approvals.json` | JSON | MCP 服务器注册（用户级）+ 工具调用审批记录 |
| `sessions/{pid}.json` | JSON | CLI 子进程注册表（pid、心跳、本地端口、版本） |
| `app/sessions.json` | JSON | 会话索引：conversationId + userId + **workDir** + startedAt/resumedAt |
| `app/session/` | Chromium | 渲染层 Session（Cache/DIPS/Local Storage） |
| `app/Crashpad/`、`argv.json` | - | 崩溃收集（可关）+ 启动参数（zh-cn、crash-reporter-id） |
| `projects/{路径slug}/` | 目录 | **会话转录归档**：`{conversationId}.jsonl`（转录）+ `.meta.json`（migratedFrom/isPlayground/cwd）+ `{cid}/subagents/`（子代理转录）。slug 规则：`e-workspace-中新融创项目` |
| `tasks/{conversationId}/N.json` | JSON | 会话内任务清单（TodoList 持久化） |
| `file-history/{conversationId}/{hash}@v{N}` | 文件 | **文件修改快照版本链**（同 hash 多版本 v2/v3…） |
| `blobs/{xx}/{sha256}.{ext}` | 内容寻址 | 图片等二进制：SHA-256 哈希为名、2 字符前缀分片（本机 72 个） |
| `clipboard-images/` | 文件 | 剪贴板图片（时间戳命名） |
| `artifact-index/{cid}.json`、`media-index/` | JSON | 产物索引：`{type: media/tasks, uri: file:/// 或 agent:///, sourceTool: "PresentFiles"}` |
| `audit-log/YYYY-MM-DD.jsonl` | JSONL | **按天滚动安全审计**（见 §6） |
| `logs/YYYY-MM-DD/` | 目录 | 按天 + 按进程/工作区命名（`{workspace}__{hash}.log`、`edge-sync.log`） |
| `edge-sync-mapping-v2.db` | **SQLite(WAL)** | 云端同步映射（见 §4.3），v1→v2 有迁移（`.migration-history`、`.workbuddy-sqlite-migrations`） |
| `local_storage/entry_*.info` | gzip+base64 | 自研 KV 存储（值压缩） |
| `plugins/` | 目录 | 插件缓存 `cache/{marketplace}/{name}/{version}` + `installed_plugins.json`（scope: user）+ 多市场（codebuddy-plugins-official / cb_teams_marketplace / workbuddy-builtin） |
| `skills/`、`skills-marketplace/` | 目录 | 技能市场：每技能 = **SKILL.md + scripts**（Anthropic Skills 兼容格式），100+ 技能（腾讯文档/会议/IMA/乐享 + 12306/airbnb/arxiv…），带 etag/sha256 增量更新（`.connectors-marketplace.meta.json`） |
| `connectors/{userId}/` | 目录 | 连接器状态 + **`.master.key` 主密钥**（凭据加密）+ `connector-states.v3.json` + README-DO-NOT-DELETE.txt（OpenClaw 同款结构） |
| `connectors-marketplace/` | 目录 | 连接器市场 |
| `binaries/`、`extensions/` | 目录 | 二进制/扩展 |
| `pending-telemetry/` | 目录 | 遥测暂存（离线补报，`install-*.json.reported`） |
| `device-id`、`qimei-cache.json` | 文件 | 设备标识双轨：自有 UUID + 腾讯 qimei 指纹 |
| `.policy-cache.json` | JSON | **企业策略缓存**（配合 `@genie/enterprise-policy`） |
| `ioa-im-override.json` | JSON | `{"allowNonTencentIM": false}` —— IM 接入白名单管控 |
| `expert-history.json`、`app/data/expert-history.json` | JSON | 专家智能体使用历史（全局 + 应用级） |
| `inspiration/`、`plans/`、`inspiration` 相关 | 目录 | 灵感/计划暂存 |
| `shell-snapshots/snapshot-bash-{ts}.sh` | 脚本 | Shell 环境快照（agent 执行命令前保存 PATH/env，与 Claude Code 同款机制） |

### 4.3 SQLite：edge-sync-mapping-v2.db（唯一 SQLite 库）

三张表，职责是「**本地 ↔ 云端（COS）同步映射**」，不存业务数据：

```sql
-- 会话↔对话↔消息通道映射
CREATE TABLE edge_sync_mapping (
  session_id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL,
  msg_channel TEXT NOT NULL DEFAULT '',          -- 如 convmsg:{userId}
  created_at INTEGER NOT NULL DEFAULT (unixepoch()));

-- 图片 blob → 腾讯 COS URI 映射
CREATE TABLE edge_sync_image_mapping (
  blob_id TEXT PRIMARY KEY, cos_uri TEXT NOT NULL,
  session_id TEXT NOT NULL, created_at INTEGER);

-- 产物文件云同步缓存（哈希去重 + 过期）
CREATE TABLE edge_sync_artifact_cache (
  file_path TEXT PRIMARY KEY, mtime_ms INTEGER, size INTEGER, file_hash TEXT,
  download_url TEXT NOT NULL, smh_path TEXT,      -- SMH：腾讯智能媒体仓库路径
  content_type TEXT DEFAULT '', expires_at INTEGER, uploaded_at INTEGER);
```

> **启示**：本地优先（local-first）架构——主数据在本地文件/JSONL，SQLite 只做云同步的映射与缓存索引，WAL 保证高频写性能；迁移机制（migrations 目录）保证 schema 演进。业务转录用 JSONL 追加而非入库，可回放、易调试。

---

## 5. 记忆架构（核心章节）

WorkBuddy 的记忆是**四层结构**，全部是 Markdown 文件（人读机读两用），配合一个专职检索子代理：

```
┌─ 第 0 层：人设层（OpenClaw 体系，~/.workbuddy/）─────────────┐
│  SOUL.md       性格/价值观/边界（"你不是聊天机器人"）           │
│  IDENTITY.md   名字/形象/语气/签名 emoji（首轮对话填写）        │
│  USER.md       用户画像（称呼/城市/关注点）                    │
│  BOOTSTRAP.md  首次引导对话脚本（引导建立上述三件套，完成后删除）│
└──────────────────────────────────────────────────────────┘
┌─ 第 1 层：用户全局记忆（~/.workbuddy/memory/{userId}_memory.md）┐
│  结构：# User Memory Profile（带更新时间戳/版本号）            │
│  正文四段：**工作背景 / 个人背景 / 当前关注 / 近期动态**         │
│  文末嵌 RAW_JSON 块（uid/memoryBlock/version/updatedAt）       │
│  → 人类可读 Markdown + 机器可解析 JSON 双格式，带 .bak 自动备份 │
└──────────────────────────────────────────────────────────┘
┌─ 第 2 层：项目长期记忆（{workspace}/.workbuddy/memory/MEMORY.md）┐
│  项目基本信息、甲方背景、长期约束等「不随时间过期」的项目知识      │
└──────────────────────────────────────────────────────────┘
┌─ 第 3 层：项目按日日志（{workspace}/.workbuddy/memory/YYYY-MM-DD.md）┐
│  当日工作日志：做了什么/用户需求/调研结论/输出物路径             │
│  （由沙箱内命令追加写入，审计日志可见写入过程）                  │
└──────────────────────────────────────────────────────────┘
```

**记忆的读写机制**：

- **写入**：agent 在会话中以 Bash 追加方式维护第 3 层（按日）；第 1 层由主对话总结更新（memoryBlock 整体替换，version 递增，写 .bak）
- **读取注入**：`memorySelector` 子代理（lite 模型）对当前查询做相关性挑选，只把相关记忆注入上下文，而非全量塞入
- **会话内记忆**：`contextSummary`/`compact` 代理做上下文压缩；`summaryGenerator` 生成可检索的会话摘要
- **项目叙事**：`{workspace}/STORY.md`——项目目标/用户意图对齐文件（OpenClaw 同款）
- **并发保护**：`app/memory/polling-lease-{user}.json` 轮询租约，避免多会话并发写记忆
- **历史包袱**：`memery/`（拼写错误目录）+ `user-memery-state.json` 是旧版迁移残留；`desktop_conversation_migrated`、`session_fragment_repair_done520` 等标记文件记录迁移完成点
- **私有化差异**：selfhosted 形态 `DisableMemoryPersonalization: true`——记忆个性化默认关闭（企业合规）

> **启示（重点借鉴）**：
> 1. 「Markdown 正文 + 内嵌 RAW_JSON」双格式让记忆既可人工审阅修订（企业客户刚需）又可程序解析，WorkPivot 可直接采用；
> 2. 四层分域（人设/用户全局/项目长期/项目日志）天然匹配「不同企业、不同项目」的多租户诉求——项目记忆随工作区走，用户记忆随账号走；
> 3. 记忆检索用小模型专职代理，而非全量注入；
> 4. 记忆文件全部落本地明文，私有化客户可审计、可导出，但需在产品层提供加密选项。

---

## 6. 工作目录机制（E:\workspace 实测）

`E:\workspace` 是多项目根（本机：AI研发平台、中新融创项目、金宇咨询项目），每个项目目录的特征：

1. **交付物直接落在项目目录，以版本号入文件名**：如 `2.整体技术架构白皮书 v2.0→v2.5.docx`（一天内 6 个版本）、`4.SOP全流程线上化设计方案 v1.1→v1.4.docx`、`14.流程角色与岗位对应关系 v1.0.pptx`——「任务交付」的落地形态就是**可交付文件本身的版本链**，用户无需进应用找历史
2. **agent 的临时工作痕迹**：`_tmp_check_flow.py`、`_tmp_visual_check*.py`（生成文档后的自校验脚本）、`__pycache__/`、`*.bak`——agent 会写一次性校验脚本验证产物再交付
3. **项目本地状态**：`.workbuddy/memory/`（第 2/3 层记忆）+ `STORY.md`
4. **全局侧登记**：项目以路径 slug 注册到 `~/.workbuddy/projects/`，会话转录按 `{conversationId}.jsonl` 归档在项目目录下；文件修改快照进 `file-history/`，产物登记进 `artifact-index/`（uri 支持 `file:///` 与 `agent:///` 两种寻址）

---

## 7. 安全与管控体系

| 机制 | 实现 | 证据 |
|------|------|------|
| 命令沙箱 | 跨平台原生 sandbox-cli + 写入白名单 | settings.json `sandbox.extraAllowWrite`（放行 ~/.lark-cli、~/.tmeet 等第三方 CLI 目录）；productFeatures `Sandbox: true` |
| 命令安全审计 | 按天 JSONL：sessionId/requestId/toolCallId/category=`command-safety`/eventType=`sandbox-executed`/decision/commandPreview/**commandHash** | `audit-log/2026-08-27.jsonl` |
| 工具审批 | MCP 调用审批记录 | `mcp-approvals.json` |
| 风险分级 | `autoModeClassifier` 子代理对自动模式工具调用做风险分类 | product.json agents |
| 企业策略 | 策略下发缓存 | `.policy-cache.json` + `@genie/enterprise-policy` |
| IM 管控 | 非腾讯 IM 接入禁用 | `ioa-im-override.json: allowNonTencentIM=false` |
| 凭据加密 | 连接器主密钥 | `connectors/{userId}/.master.key` |
| 设备标识 | UUID + qimei 双轨 | `device-id`、`qimei-cache.json` |
| 遥测可控 | 私有化关闭 Galileo | selfhosted 配置 |

**⚠️ 对我们的安全警示（WorkBuddy 的反面教材）**：

1. `models.json` 第三方模型 **API key 明文存储**——WorkPivot 必须做密钥加密（DPAPI/密钥环/KMS）
2. 审计日志 `commandPreview` 记录完整命令原文（含路径与可能的敏感参数）——审计与隐私需分级设计
3. 记忆/转录全部明文落盘——私有化产品应提供静态加密选项与保留期策略

---

## 8. 与开源体系的关系（证据链）

1. **CodeBuddy CLI 本体即开源项目**：`homepage: https://cnb.cool/codebuddy/codebuddy-code`，npm 包名 `@tencent-ai/codebuddy-code`——WorkBuddy 桌面端内嵌的就是 CodeBuddy CLI 的 genie 内核（bin 名 `codebuddy`/`cbc`）
2. **OpenClaw 痕迹明确**：SOUL/IDENTITY/USER/BOOTSTRAP 四件套（文案与 OpenClaw 模板一致，含 "You're not a chatbot. You're becoming someone."）、STORY.md、connectors（.master.key + README-DO-NOT-DELETE.txt）、BOOTSTRAP 中引导连接 WhatsApp、配置段名直接叫 **`claw`**（wechatmp 通道 webhook 模式、legacyOwnerUid）——个人智能体/IM 通道/记忆层基于或深度借鉴 **OpenClaw**
3. **技能生态对齐 Anthropic Skills**：每个技能 = `SKILL.md + scripts`，与 Claude Skills 同构；插件市场沿用 CodeBuddy 官方市场（codebuddy-plugins-official）
4. **协议开放**：MCP（模型上下文）+ ACP（Agent Client Protocol，编辑器对接）双协议

> **启示**：WorkPivot 不应重造协议——MCP + SKILL.md 格式 + ACP 是既成生态；「CLI 内核开源 + 桌面产品闭源」的双轨也值得研究。

---

## 9. 对 WorkPivot 的总体借鉴清单

**直接采纳：**

1. **桌面壳 + CLI Agent 内核 + 本地 HTTP 通信**的进程拓扑（UI 与运行时解耦，CLI 可独立成产品线）
2. **一份内核 + product.*.json 形态裁剪**的多部署形态构建（私有化/云托管同源）
3. **四层记忆架构**与 Markdown+RAW_JSON 双格式记忆文件
4. **项目目录即交付目录**、版本号入文件名的交付方式
5. **本地优先存储**：JSONL 转录 + 文件快照 + 内容寻址 blob，SQLite 仅做同步索引
6. 沙箱 + 命令哈希审计 + lite 模型风险分级的**安全三件套**
7. 专家智能体**插件化**（人格 + 技能 + 行业 ID + 开场白）

**规避/超越：**

1. API key 与记忆**静态加密**（WorkBuddy 明文）
2. 审计内容分级脱敏（WorkBuddy 记全文命令）
3. 私有化形态下模型池不能只剩 1 个——WorkPivot 私有化应支持**多模型热插拔网关**（自建 vLLM/Ollama + 商用 API 混合），这是 WorkBuddy selfhosted 的明显短板，也是我们的差异化机会
4. WorkBuddy 深度绑定腾讯生态（文档/会议/IMA/微信支付）；WorkPivot 面向不同企业需保持**集成中立**（连接器化，不绑任何一家）
5. 记忆个性化在私有化下被整体禁用——可设计「企业知识记忆（开）+ 个人画像记忆（可关）」的分级记忆策略

**待进一步调研：**

- [ ] CodeBuddy CLI 开源仓库（cnb.cool/codebuddy/codebuddy-code）源码级分析
- [ ] OpenClaw 记忆/通道架构对照（确认 WorkBuddy 借鉴边界）
- [ ] codewise-chat 模型在私有化形态的部署方式（随包分发？API 回源？）
- [ ] E2B 云沙箱在产品中的实际启用路径

## 附：版本与构建指纹

| 项 | 值 |
|----|-----|
| 桌面版本 | 5.3.14 |
| CLI 包 | @tencent-ai/codebuddy-code 2.115.0（@genie/agent-cli 0.0.0 内部版） |
| genie 框架 | 5.3.14 |
| 构建提交 | 825709d4641e734288fccb0f3c04114e67f713dd |
| 构建时间 | 2026-08-17 |
| 主程序体积 | WorkBuddy.exe ~204MB；app.asar 283MB |
| 遥测端点 | galileotelemetry.tencent.com（SaaS 形态） |
| 模型网关 | copilot.tencent.com |
