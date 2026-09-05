# 源码级分析：Claude Code 2.1.88（泄露源码）

> **来源与合规声明**：分析对象为 2026-03-31 经 npm source map 意外公开的 Claude Code 完整源码（51.2 万行 TS）。官方 npm 版本 2.1.88 已在数小时内被 Anthropic 撤下（本机实测 registry 404、npmmirror 亦未同步），本分析基于第三方镜像 `E:\project\claude-code-leak`（只读，未执行任何文件；已做安全扫描与真实性核验，见 §1）。**本文件仅供研究参考：依据 K05 红线，其任何代码与提示词原文不得进入 WorkPivot 代码库，只学设计。**
> **一段话结论**：这是目前信息密度最高的一份材料——把此前对 Claude Code 的所有推断换成了 ground truth：循环是**显式状态机**（每个续转原因可枚举可审计）；压缩是**五层管道**而非单阈值，且 prompt-cache 意识贯穿全部机制；权限是**四维规则系统**（behavior×工具×参数模式×模式变换）+ LLM 分类器兜底；沙箱默认关（与 Codex 相反）；系统提示词**编译进二进制**（与 Codex 目录下发相反），CLAUDE.md 不进 system prompt 而走首条 user 消息的 `<system-reminder>`；子代理=同一循环的递归复用+独立副作用边界；记忆系统（memdir）与 WorkPivot PRD-05 双层记忆高度同构。
>
> 姊妹文档：[claude-code.md](claude-code.md)（生态与许可）｜[codex.md](codex.md)（官方开源对照）｜[workbuddy-technical-analysis.md](workbuddy-technical-analysis.md)（内嵌同源引擎逆向）

- **分析人**：lichb ｜ **日期**：2026-09-05
- **信息来源**：泄露源码镜像（v2.1.88）实测 + [Layer5 复盘](https://layer5.io/blog/engineering/the-claude-code-source-leak-512000-lines-a-missing-npmignore-and-the-fastest-growing-repo-in-github-history)

## 1. 来源核验与安全扫描

- **定位过程**：Layer5 复盘指认 map 在 **2.1.88**（59.8MB，约 1900 文件）；官方 npm 已撤下（数小时内），npmmirror 未同步；故取第三方镜像，clone-only。
- **真实性核验** ✅：`package.json` version=2.1.88；src 下 1934 文件 / **512,875 行**（与 Layer5 报道的 51.2 万行/约 1900 文件吻合）；`dangerouslySkipPermissions`/`CLAUDE.md` 等 629 处 anthropic 标识；目录结构（QueryEngine/Tool/memdir/ink/coordinator）与已知产品行为一一对应。
- **安全扫描** ✅：零二进制/可执行文件（无 exe/dll/node/wasm/bat/ps1）；package.json 仅 build/typecheck/lint 三个标准脚本、无生命周期钩子。

## 2. 总体架构

三条驱动路径汇入**同一个循环**：

```
交互式 REPL (screens/REPL.tsx) ────────────┐
headless/SDK (cli/print.ts → QueryEngine) ─┼─→ query.ts::queryLoop()   ← 全部智能的跑步机
子代理 (tools/AgentTool/runAgent.ts) ──────┘      （递归复用，非递归实现）
```

- `src/` 顶层 48 个目录：核心域（query/QueryEngine/Task/Tool/tools/）、UI（components/screens/ink——Ratatui 式自绘终端的 TS 版）、扩展（hooks/skills/plugins/commands/）、新大陆（memdir 记忆、voice 语音、remote+server+bridge 远程会话、coordinator 多代理编排、upstreamproxy 出口代理、vim/keybindings）。
- SDK 控制协议单一事实源：`src/entrypoints/sdk/coreSchemas.ts`（Zod：SDKMessage + control_request/response，含权限回调、hook 回调）——官方宿主嵌入协议，同一消息流 stdio/WebSocket 两栖（remote/、server/ 佐证）。

## 3. Agent 循环：显式状态机（★ ADR-002 最值得抄的一面）

- `queryLoop()` 是单文件 while+可变 State 的状态机；State 含 messages/toolUseContext/autoCompactTracking/turnCount/**transition**。
- **每个续转点都写 `transition.reason`，完全可枚举**：`next_turn / stop_hook_blocking / max_output_tokens_recovery / max_output_tokens_escalate / reactive_compact_retry / collapse_drain_retry / token_budget_continuation`——这就是可测试、可审计的循环设计，WorkPivot C01 应直接采纳。
- **循环唯一信号 = 流式响应中的 tool_use block**。源码注释明言 `stop_reason === 'tool_use'` 不可靠——"看流里有没有工具块"是唯一判据（对照：Codex 用 needs_follow_up，同思路）。
- **错误恢复是循环内控制流**：max_output_tokens 先一次性升到 64k 重试 → 再最多 3 次注入 meta 恢复消息（"Resume directly — no apology, no recap"）；413 分层兜底（collapse drain→reactive compact→报错）；autocompact **连续失败 3 次熔断**（注释留有生产事故数据：1279 会话曾浪费 25 万次 API 调用/天）。
- 终止类型枚举（`query/transitions.ts`）：completed/blocking_limit/max_turns/aborted_streaming/aborted_tools/model_error/image_error/prompt_too_long/hook_stopped/stop_hook_prevented。
- 工具并发：按 `isConcurrencySafe()` 分批，上限 10（env 可调）；流式中工具**边采样边并行执行**。
- 后台任务模型 `Task.ts`：`local_bash/local_agent/remote_agent/in_process_teammate/local_workflow/monitor_mcp/dream` 七类，输出落盘+增量读取+通知去重——与 Codex 的 write_stdin+通知队列同构但类型更丰富。

## 4. 会话持久化：parentUuid 链 JSONL（★ F01 直接对标）

- `~/.claude/projects/<编码cwd>/<sessionId>.jsonl`，append-only；**20 种 entry 混排**（消息 + Summary/CustomTitle/QueueOperation/ContentReplacementEntry/FileHistorySnapshot/ContextCollapseCommit…元数据同文件）。
- **消息是 parentUuid 链表**：tool_result 用 `sourceToolAssistantUUID` 回指父消息；compact boundary 置 `parentUuid:null`+`logicalParentUuid`——fork/branch/rewind-to-message 是链表的免费能力。子代理 sidechain 独立成 `<sessionId>/subagents/agent-<id>.jsonl`+meta，可单独 resume。
- **用户消息在进循环前就落盘**（进程被杀也能 resume）；重写保护：tombstone 慢路径全文件重写上限 50MB。
- 对照：Codex rollout=协议事件复放；Claude Code=链式消息+旁路元数据。WorkPivot F01 的"转写=事件流"取 Codex 形，"parentUuid 链"取 Claude 形，两者可合成。

## 5. 上下文工程：五层压缩管道（★ K04 的完整蓝本）

按 query 循环内执行顺序：

| 层 | 机制 | 触发 |
|---|---|---|
| ① 工具结果预算 | 单结果 >50k 字符→落盘、模型拿预览；单消息聚合 >200k→逐个替换最大块；**替换决策按 tool_use_id 冻结**（保 prompt cache 前缀字节稳定），决策持久化进 transcript | 即时 |
| ② snip | 剪中段消息 | feature |
| ③ microcompact | 白名单工具（Read/Bash/Grep/Glob/WebSearch/WebFetch/Edit/Write）旧结果清为占位符；**时间型触发=距上次 assistant >60 分钟（对齐服务端 1h cache TTL）**，留最近 5 条 | 时间/cache |
| ④ contextCollapse | 读时投影+分阶段提交，90% 提交/95% blocking | feature |
| ⑤ autocompact | 全量摘要（forked agent 复用父 cache）；**阈值=窗口−min(maxOut,20k)−13k**（200k 窗≈83%，推导值而非硬编码 90%）；摘要提示词 9 段（Primary Intent/Key Concepts/Files & Code/Errors/…/**All user messages**/Pending/Current Work/Next Step）；摘要附原 transcript 路径 | 推导阈值 |
| ⑥ reactive | 真 413 后才全量摘要 | 兜底 |

- **cache 意识贯穿一切**：替换决策冻结防 cache bust、微压缩对齐 TTL、子代理 fork 用字节一致前缀共享父 cache、系统提示词静态/动态边界（§10）——这是 Claude Code 与 Codex 最大的隐性工程差距。
- token 计数：最后一条带 usage 的响应 + 之后消息 ×4/3 保守粗估；并行工具回溯同 message.id 兄弟防漏数。

## 6. 工具面：外部默认约 20 个，纪律写在工具描述里

- 清单：Agent(旧名 Task)/TaskOutput、Bash/PowerShell、Glob/Grep、Read/Edit/Write/NotebookEdit、WebFetch/WebSearch、TodoWrite+TaskCreate 族、EnterPlanMode/ExitPlanMode、AskUserQuestion、**Skill**、SendMessage/TaskStop/TeamCreate/TeamDelete、**Brief**（主动给用户发消息）、MCP 资源三件套/ToolSearch。约 20 个 ant-only 工具被 feature 门控。
- **`CLAUDE_CODE_SIMPLE` 模式收敛到 Bash+Read+Edit 三件套**——与 Codex 的 exec_command 收缩路线趋同，验证"工具面可以很小"。
- **行为纪律的承载点在工具描述**（随工具集缓存，非系统提示词）：Bash 描述内嵌完整 git 安全协议（未要求不许 commit/禁 `git add -A`/禁 amend/HEREDOC 传 message/禁 sleep 轮询）；Edit"必须先 Read，old_string 必须唯一"；Write"NEVER create documentation files (*.md) unless explicitly requested"；Grep"NEVER invoke grep/rg as a Bash command"；Agent"Never delegate understanding"/"Don't peek, Don't race"。→ WorkPivot 工具描述要当作**带 cache 生命周期的程序**管理。

## 7. 权限：四维规则系统（★ I02 的完整蓝本）

- **规则四维**：behavior（`allow/deny/ask/defer`）× 工具 × 参数模式（精确 `Bash(npm install)` / 前缀 `Bash(npm:*)` / 通配符 `Bash(npm test *)`→正则，dotAll 跨换行）× 模式变换。MCP 规则 `mcp__server`、子代理规则 `Agent(Explore)`。
- **7 种 mode**：外部 default/acceptEdits/plan/bypassPermissions/**dontAsk**（2.1.88 新增，末端强制 ask→deny 不可绕过）+ 内部 auto（LLM 分类器）/bubble。
- **判定流水线 10 步**（`permissions.ts:hasPermissionsToUseToolInner`）：整工具 deny→整工具 ask→工具自定义检查→…→**内容级 ask 规则与 safetyCheck 是 bypass-immune**（bypassPermissions 也压不住 `Bash(npm publish:*)`）→bypass→整工具 allow→passthrough 转 ask。mode 变换在流水线**后置层**（防 early-return 绕过）。
- **Settings 5 层合并**：user→project→local→flag→**policy（managed）**；`allowManagedPermissionRulesOnly` 开启后其余源全部清空+UI 隐藏"always allow"——**策略锁**比"优先级高"更强（→ M05）。
- **Hook allow 也要过规则复核**（`resolveHookPermissionDecision`）：hook 可跳过交互询问，但 deny/ask 规则与 safetyCheck 仍然生效；hook deny 一票否决。
- 对照：OWB"四档"只对标 mode 层；Claude 的规则层比档位细一个维度。Codex 用"OS 沙箱默认+规则例外"，Claude 相反。

## 8. 沙箱与高危防护

- **沙箱默认关**（`sandbox.enabled` 默认 false）——与 Codex"默认开"是两大产品最大架构分歧。实现外置在 `@anthropic-ai/sandbox-runtime` 独立包（不在泄露范围），适配层显示：macOS seatbelt、Linux/WSL bubblewrap+**seccomp BPF 只封 AF_UNIX**（防 unix socket 逃逸网络隔离）、**Windows 原生无沙箱**（对照 Codex 的自研 restricted-token——WorkPivot Windows-first 反而该学 Codex）。
- **激励联动**：`autoAllowBashIfSandboxed`——沙箱内命令免询问。用体验换沙箱采用率，聪明的产品化设计（→ I01/I02 联动）。
- **高危防护四层**：① `rm -rf` 关键路径（/、盘根、根一级子目录、home、通配尾缀）**强制询问且不给"保存规则"建议**；`--` 后参数也提取（防绕过）；② DANGEROUS_FILES/DIRECTORIES 写保护（.gitconfig/.bashrc/.mcp.json/.claude 等，bypass-immune，大小写归一防绕过）；③ `bashSecurity.ts`（2592 行）22 项编号检查（命令替换/zsh 危险 builtin/IFS 注入/花括号展开/Unicode 空白/引号-注释失步…）；④ **auto 模式 LLM 分类器**（`yoloClassifier.ts` 1495 行）+ **iron gate**：云端开关控制分类器故障时 fail-closed/fail-open，连续拒绝 N 次强制降回人工询问。
- 对照：Codex execpolicy 是确定性规则层；Claude 的独门是 LLM-in-the-loop 审批 + 云端全局熔断。两者正交，可同时要。

## 9. Hooks / Skills / Plugins

- **Hooks 21+ 事件**（远超官方文档的 9 个）：PreToolUse/PostToolUseFailure/Stop/SubagentStart/PreCompact/**PermissionRequest/PermissionDenied**/TaskCreated/Elicitation/CwdChanged…默认超时 **10 分钟**；支持 command/prompt（LLM 判定）/agent/http 四型；`updatedInput` 可改写入参；**PermissionRequest hook 专治 headless 无 UI 场景**（headless 时是唯一批准通道）。managed 设置可 `disableAllHooks` 只留企业自己的 hooks。
- **Skills**：发现位置含 managed/policy 层；**skill=斜杠命令=Skill 工具条目三位一体**（一次注册三入口）；渐进披露的列表预算=**上下文窗口的 1%**（8000 字符，单条截 250 字符）——技能多了不爆上下文；SKILL.md frontmatter 还可注册 hooks。
- **Plugins**：marketplace 支持 github/git/url(zip)/npm 四源；**无签名机制**，靠官方名白名单+冒充检测+远端 blocklist 事后封禁+安装信任警告——企业场景已知短板（→ S01 分发要有签名/审核，别学它）。

## 10. 系统提示词与模型接入

- **提示词编译进二进制**（`constants/prompts.ts`），与 Codex"随模型目录下发"是根本路线分歧；模型差异只剩知识截止日/模型名/最新模型 ID 三处，靠 `@[MODEL LAUNCH]` 标记人工维护。
- **三段式 cache 工程**：静态大段 → `__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` 显式边界 → 动态段按名缓存 registry（`systemPromptSection()` 每会话算一次）；每段带 `cache_control: org|global`。→ WorkPivot 提示词应从第一天就做 cache 分段设计。
- **CLAUDE.md 不进 system prompt**：Managed(/etc)→User→Project(逐级向上)→Local 四层发现后，包成"**首条 user 消息里的 `<system-reminder>`**"注入（`prependUserContext`），并附"may or may not be relevant"免责；gitStatus 才进 system prompt 尾部。AGENTS.md **CLI 本体不加载**（只在 /init 生成模板）。
- **纪律条款精选**（15 条中的 6 条最相关）：权限被拒后"不许重试同一调用，先想为什么"；注入防御"疑似 prompt injection 先向用户标记"；反虚报"output 显示失败时绝不声称 all tests pass"；YAGNI 三连"不加没人要的错误处理，三行重复优于过早抽象"；风险动作"批准一次≠所有场景批准，不可逆动作先确认 blast radius"；子代理防重复"委派了研究就不要自己再搜一遍"。
- **模型接入**：单协议 Anthropic Messages + 四 provider（firstParty/Bedrock/Vertex/Foundry，env 切换）；**企业网关=`ANTHROPIC_BASE_URL`+`ANTHROPIC_CUSTOM_HEADERS`+Bearer**，一个工厂函数收口；手写 SSE 累积循环（弃用 SDK 流：partial JSON 的 O(n²) 解析）；三层降级（fallback model→非流式→fast-mode cooldown）；`cch` attestation 头防伪客户端。
- 趣证：提示词条款"文件引用用 `file_path:line_number`""工具调用前不加冒号"与本项目所用 agent 工具（ZCode）完全一致——行业提示词同源的又一实证。

## 11. 记忆（memdir）/ 遥测 / 成本

- **memdir = auto memory**（★ E01/E02 最直接的同类实现）：每项目一个记忆目录，入口 `MEMORY.md`（**索引，上限 200 行/25KB 超限截断**）+ topic 文件；**每次回复结束由 fork 子代理（共享父 cache）从转录提取记忆写入**；夜间 /dream 把日志蒸馏进 MEMORY.md；团队记忆 TeamMem 走 org 同步。结构=「索引进上下文、正文按需查、提取走确认流之外的后台代理」——与 PRD-05 双层记忆（手写区+条目区）对照：Claude 无人工确认环节（WorkPivot 的差异化点仍成立），但"索引+正文分离+后台提取"的机制值得吸收。
- **遥测三级隐私**（default→no-telemetry→essential-traffic）；Bedrock/Vertex 用户强制无遥测；**类型系统级防线**：遥测字段类型名为 `AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS`——用类型命名制度性禁止代码/路径进遥测，廉价有效（→ I03/遥测设计直接抄）。
- **无本地审计文件**：审计外置为客户 OTel 管道（权限决策=metric counter）——WorkPivot 的本地 JSONL 审计+导出仍是差异点，但建议**同时输出 OTel 格式**便于企业接入。
- 成本：按模型定价档位算钱、订阅用户只显示额度不显示美元；额度=服务端 unified limiter 响应头下发，客户端不自算。

## 12. 对 WorkPivot 的启示：证实 / 推翻 / 新增

**此前的推断被证实**：任务=对话+真实目录、工具面可极简（SIMPLE 模式三件套）、F 层韧性设计方向、skill=command 一体、企业 settings 层级。

**被推翻/修正**：
1. "权限=四档档位"太粗——真实设计是四维规则系统，档位只是 mode 层；I02 应升级为"档位×规则"双层。
2. "压缩=90% 阈值摘要"（Codex 式）只是最外层——内层还有结果预算/微压缩/时间对齐/cache 冻结；K04 应做分层管道。
3. "CLAUDE.md 进 system prompt"是错的——用户指令走首条 user 消息 `<system-reminder>`；WorkPivot 的工作区指令注入点要照此修正。

**新增可借鉴（按模块）**：
- **C01/ADR-002**：循环做成显式状态机+`transition.reason` 审计面；错误恢复是循环内控制流；循环信号只认流式 tool_use block。
- **F01**：转写加 parentUuid 链（fork/rewind 免费获得）+ 用户消息采样前落盘 + 子代理 sidechain 独立文件。
- **K04**：五层压缩管道 + 按.tool_use_id 冻结替换决策保 cache + 提示词 cache 分段边界。
- **I02/I05**：bypass-immune 的内容级规则、策略锁（managed-only）、沙箱免询问激励、iron gate 式云端熔断、四层高危防护拆分。
- **E01**：MEMORY.md 索引 200 行上限 + 后台 fork 代理提取 + 夜间蒸馏；保留 WorkPivot 的人工确认流作差异化。
- **A03**：TodoWrite/Brief/AskUserQuestion 三件"过程交互"工具 + 通知队列——过程可视化的工具侧设计。
- **D01**：技能列表 1% 上下文预算；skill=command=tool 三位一体注册。

**合规重申**：本文件所有内容为设计参考；提示词原文、代码片段不得复制进 WorkPivot（K05）；镜像仓库仅作只读分析用，不建立任何依赖。

## 附：快速验证路径（本机）

| 想看什么 | 去哪里（E:\project\claude-code-leak\） |
|---|---|
| 循环状态机 | `src\query.ts`（queryLoop）+ `src\query\transitions.ts` |
| SDK 控制协议 | `src\entrypoints\sdk\coreSchemas.ts` |
| 持久化格式 | `src\utils\sessionStorage.ts` + `src\types\logs.ts`（20 种 entry） |
| 压缩管道 | `src\services\compact\`（autoCompact/microCompact/prompt.ts 九段摘要） |
| 权限流水线 | `src\utils\permissions\permissions.ts`（1a→3 步）+ `permissionRuleParser.ts` |
| LLM 审批分类器 | `src\utils\permissions\yoloClassifier.ts` + iron gate 开关 |
| 高危四层 | `tools\BashTool\{pathValidation,bashSecurity,destructiveCommandWarning}.ts` + `utils\permissions\{filesystem,dangerousPatterns}.ts` |
| 系统提示词本体 | `src\constants\prompts.ts`（getSystemPrompt）+ `cyberRiskInstruction.ts` |
| CLAUDE.md 注入 | `src\utils\claudemd.ts` → `src\context.ts` → `src\utils\api.ts`（system-reminder） |
| 记忆系统 | `src\memdir\` + `src\services\extractMemories\` + `src\services\autoDream\` |
| 工具描述纪律 | `src\tools\*\prompt.ts`（Bash/Edit/Write/Agent 各自的 prompt.ts） |
| 遥测隐私防线 | `src\utils\privacyLevel.ts`（搜 I_VERIFIED） |
