# WorkBuddy Agent 运行与记忆调用链：2026-10-14 本机静态证据

## 分析范围与证据定位

本报告只分析当前安装目录 `C:\Users\lichb\AppData\Local\Programs\WorkBuddy\resources\app.asar.unpacked\cli` 的交付代码；未启动目标程序、执行目标 JavaScript、请求模型或修改用户记忆。主报告另行分析 Electron 桥接与指定工作区的实际文件。本报告所述“实现”表示安装产物存在可执行调用路径，不表示本次实测已运行。

当前 ASAR `package.json` 的版本由主报告核实为 **5.7.7**；安装根 `version` 文件为 `37.10.3-24`，字段含义尚未确认，不能当作同一个版本号。历史 5.3.14 分析不能直接套用于本机。

| 文件（相对上述 CLI 根目录） | 字节数 | SHA-256 |
| --- | ---: | --- |
| `dist/codebuddy-headless.js` | 11,938,885 | `1a0356be6c1ea9c45274853120765e27e793201a2a2be6ecc8e6ca56ea383c87` |
| `dist/codebuddy-lite-wb.mjs` | 8,567,703 | `f30cb8ad2466daddb98318b34c1956f7350f3139d0868ef5a7537931cf90ee75` |
| `product.json` | 378,933 | `a1e1d6d66fe39c37cc29589684fa6bdf65ff71453d14c13e0c55c0037d7e7fe8` |

下面所有偏移均为 Python UTF-8 解码后字符串的 **零起始字符偏移**，不是原文件字节偏移或源码行号。对应原字节位置可由 `len(text[:offset].encode('utf-8'))` 计算；文件为压缩打包代码，行号意义有限。只列函数名和必要机制，避免复制大段厂商代码及用户数据。

## 1. Agent 本质：本地编排器驱动模型与工具

CLI 的结构不是一次性向模型发送提示词。它维护 session、历史、运行状态、取消信号、工具集以及输出流，并把 Agent 交给 Runner。模型响应可以包含工具调用，工具结果进入后续输入，直到结束、取消、错误或轮次限制。循环底层由动态加载的 Agents SDK 实现，WorkBuddy 在循环外侧和每次模型请求前加自己的控制层。

证据：lite `7483900–7484700` 的 `preloadOpenaiAgentsTypes()` 把动态模块的 `Agent`、`Runner`、`RunState`、`StreamedRunResult`、`OpenAIChatCompletionsModel` 和 `MaxTurnsExceededError` 绑定到本地导出。它还加载 `lazy-lite-wb/6724`、`4662`、`5607`、`1885` 等 chunk。本报告未展开这些 chunk 内的 SDK 主循环，因而没有断言具体 SDK 版本或所有工具并发规则。使用 OpenAI Agents 类型也不等于只能调用 OpenAI 模型。

实际主链（lite）：

1. `runDefault`（`6630388`）：申请运行准入，按 session 选择 Agent，并把准入信息与 AbortSignal 交给 `run`。
2. `AgentService.run`（`6618204`）：等待认证初始化、加载 Runner、建立/复用 session，确定有效 `maxTurns`，保存 `lastRunMaxTurns`。
3. 有序 interceptor pipeline（`6620100–6624000`）：按 priority 调用拦截器，处理队列、历史和上下文等；插件刷新完成后隔离本次运行的 managed Agent。拦截器可以设置 `skipRun`，此时不会启动模型。
4. 刷新工具与分派（`6625500–6627400`）：`ensureAgentToolsFreshForRun` 后执行 `sessionManager.run(... R.run(Z.agent,Z.input,W))`。
5. 将返回 stream result 发往 `session.resultSubject`，由消费者处理流式结果；通过 `getStreamPhysicalCompletion` 等待底层 stream loop 物理结束再清理（`6627000–6629000`）。

这意味着用户看到的界面“结束”与后台生成/工具资源真正结束，需要分别管理。`getStreamPhysicalCompletion`（`7484900` 附近）强制检查 SDK 补丁提供的 `whenStreamLoopSettled()`；缺失时抛兼容性错误，而不是假定输出流读取结束就已释放资源。

## 2. 每次模型请求前有维护动作

`RunnerFactory.create`（lite `6659100–6661600`）构建带 `modelProvider` 和 `callModelInputFilter` 的 Runner。模型请求前依次执行：

- 非辅助任务刷新 session 历史。
- `toolCallLoopDetector.check(modelData)` 检查重复工具循环，命中后返回替代结果。
- `checkAutoCompact()` 检查上下文预算。
- 过滤被截断或参数非法的工具调用。
- 注入运行中收到的 steer、send-now 消息、通知与后台 draining 输入。
- 发出 `MODEL_REQUEST_STARTED` 状态转换；已消费队列项写入历史。

`injectSendNowItems`（`6661700` 附近）表明“用户运行中追加消息”存在进入当前 turn 的实现，不必一律等整次 Agent 完成。队列开关、主会话判断和压缩状态会影响该路径，不能仅凭代码存在就断言每次 UI 操作都采用它。

输出截断恢复说明（`6657800–6659100`）明确要求把过大的 Write/MultiEdit/Edit/Bash 调用拆小；这属于模型请求恢复逻辑，不是无限重发原调用。

## 3. 工具执行经过控制、hook 与沙箱

`executeToolWithHooks`（lite `5194846–5198500`）给出实际执行路径，而不只是产品配置中的工具名称：

1. `toolControlPolicy.assertToolExecutionAllowed` 检查本次工具是否允许执行。
2. 已有 session 时检查循环 guard；用户选择停止会抛专门停止错误。
3. 读取缓存或执行 `PreToolUse` hook。hook 可以拒绝、修改输入，或以 `preventContinuation` 结束后续流程。
4. 执行网络/读取规则检查、后台写入隔离及写入准备。
5. `authorizeToolEgress` 处理外发授权；必要时创建文件备份。
6. 执行真实工具函数，处理成功/失败，再调用 `PostToolUse` hook，允许修正工具输出。

因此模型提出工具调用并不直接等于操作系统动作获准。不同层还可能因权限模式、session 属性、产品开关而改变结果。本次未实际触发沙箱或权限对话框，不能证明任意具体命令的最终允许/拒绝行为。

## 4. 取消、并发准入和子 Agent

主运行通过独立 controller 连接请求及 session 的取消信号；启动、插件刷新、拦截器后和真实分派前均调用 `assertRunStartupActive`（lite `6616500`、`6618204`、`6620100`）。session 已被新运行接管时，旧 controller 的 bypass/normal re-admission 会报 `AbortError`；session 忙时设置 `forceMessageQueue`，避免旧任务错误地把新任务置为空闲。

子 Agent `kill` 与 `cancel`（`1034751`、`1034952` 附近）更新任务状态，abort 自身 controller，并异步 abort 子 session。`executeAgent`（`1055579`）通过同一个 AgentService 执行子 Agent，而不是另造一套无状态模型请求。它携带子 session、可选 `maxTurns`，执行 SubagentStart hook；父 session 的权限变化默认订阅同步，固定权限模式可阻止继承（`1054900–1055900`）。

子任务到达最大轮数时，AgentTask 可取最后助手文本或空输出说明，把部分输出作为 completed 返回（`1036463`）；这只是该子任务分支的语义，不能推广为所有主任务都把超限算成功。压缩期间 finalOutput/abort 另有等待逻辑（`1057643–1058525`），避免把压缩辅助 Agent 的结果误当业务完成。

## 5. 上下文压缩与长期记忆是两套机制

`compactAndSummarize`（lite `6714996–6719500`）检查正在压缩、等待用户中断/权限决策、空历史、递归 compact、模型有效上下文预算、近期输入 token 与尾部工具结果估算。它按策略选择执行，不是单一固定长度截断。

`checkAutoCompact`（`6660400` 附近）在 input 加 max output 可能超窗时等待 blocking compact，否则安排异步 compact。失败会记录并保留后续 fallback 路径；本次未验证 fallback 的运行结果。

`product.json` 声明 `ContextSummaryAgent=true`、`enablePreMessageCompact=true`，并配置 inputTokens warning=0.6、critical=0.7、emergency=0.9、preMessage=0.5。**这些是交付默认配置**；代码还参考模型限制、session override、环境及设置，不能写成所有会话都固定在 90% 自动压缩。

压缩解决当前会话输入长度；长期记忆解决跨会话知识。两者都可能调用辅助 Agent，但数据生命周期与触发条件不同。

## 6. 本地记忆的读取路径

> **桌面补证**：[主报告第 4 节](workbuddy-rea-20261014.md#4-项目记忆如何与运行原理衔接)已在 ASAR `main/tar.js` 找到 cwd/.workbuddy/memory 的 MemoryCollector 与模板消费链。这与下面 CLI 自身的自动记忆目录应分别理解；指定项目当前文件可对应桌面路径，但其历史会话是否启用仍未经运行验证。

### 6.1 项目自动记忆

`MemoryContextInterceptor.intercept`（lite `2949100–2952000`）在输入为数组、非 skipRun、非 compact Agent 且自动记忆开启时工作：

- 首次用户消息、续接或历史尚无 memory reminder 时注入记忆提示。
- 解析 colleague / team / project scope。
- 以 `<system-reminder data-role="memory">` 插入输入首部。
- 另调用 `injectRelevantMemories`，其是否开启取决于 relevance service。

`autoMemoryEnabled` 未设置时默认 true，typedMemory 未设置时默认 true；环境变量可覆盖。这只是代码默认，不代表指定项目实际设置已经读取确认。

`PathUtils.getProjectMemoryDir`（`6134720` 附近）优先 `<homeProjectsDir>/<compressedProjectId>/memory`；如果新目录不存在而旧 `<homeMemoriesDir>/<compressedProjectId>` 存在，则读旧目录。projectId 来自工作目录 canonicalize(realpath) 后 compress（`6140765`）。因此“本地记忆”不一定直接位于工作目录，工作区路径可能只是用户级项目存储的索引。

colleague 记忆为 project memory 下 `agents/<id>`，提示其写自己私有分区，可读共享 project/global 记忆；team scope 为 project home 下 `memories/@<userId>`（`2947764`、`6134865`）。这里的“不得写共享记忆”存在提示词约束，不应在未检查写入 guard 前称为强制文件系统隔离。

### 6.2 不要把自动记忆与工作区 `.workbuddy/memory` 混同

本次在 CLI `product.json` 与两个主 bundle 中查找字面量 `.workbuddy/memory`、`memory/MEMORY.md`、`daily memory` 均为零命中；lite 没有 `YYYY-MM-DD`，headless 的两个 `YYYY-MM-DD` 命中是通用日期格式化库，并非记忆规则。这只是有界静态查找结果，路径也可能动态拼接，不能据此证明整个产品绝不读取该目录。

已追踪的 **自动记忆** 调用链使用用户级 `getHomeProjectsDir()/compressedProjectId/memory`；**Agent 显式 project/local scope** 使用 project config 下 `agent-memory` 或 `agent-memory-local`；**team memory** 使用 project config 下 `memories/@userId`。三者都不能自动等同于用户指定工作区内的 `.workbuddy/memory/MEMORY.md` 与按日期命名的日记。后者是否由桌面注入、工作区规则或历史版本机制读取，需要主报告另行关联，尚不能从本节 CLI 自动记忆实现下结论。

目录名称也不是硬编码为 `.codebuddy`：lite `6133071` 的 `getHomeDir()` 优先产品 `dataLayout.configDir.userDirName`，再环境 `CODEBUDDY_CONFIG_DIR`，最后才 fallback `.codebuddy`；`getProjectHomeDir()`（`6136839`）优先 `CODEBUDDY_PROJECT_CONFIG_DIR`，其次产品 projectDirName，最后 fallback 工作区 `.codebuddy`。因此报告采用抽象 `<homeProjectsDir>` 路径，实际目录须结合本机 runtime profile/启动参数确认。

### 6.3 Agent 定义的显式 memory scope

另有 `buildAgentMemoryPrompt`（lite `1229828–1231700`）支持 `user/project/local`：user 位于 home `agent-memory/<agentType>`；project 位于 project home `agent-memory/<agentType>`；local 位于 project home `agent-memory-local/<agentType>`。Agent 类型会清理路径分隔符。入口 `MEMORY.md` 在此路径截断到 **200 行或 25,000 UTF-8 字节**。

不要与 legacy 自动记忆的限制混用：`generateLegacyMemoryPrompt`（`2951994–2955000`）读取 project `MEMORY.md`，截断 200 行，再按 **40,000 JavaScript 字符** 裁切。typed memory 默认分支调用共享 prompt builder；本报告只确认分支调用，未将 legacy 数值冒充全部 typed memory 的实现限制。

## 7. 本地记忆的写入与自动抽取

主 Agent 提示词（lite `2952000–2955000`）明确指导使用 Write/Edit 更新文件，按主题组织，`MEMORY.md` 保持简短并链接主题文件；跨会话显式记住/忘记/纠错请求应对应写入/删除。提示建议保存稳定模式、偏好、架构决策，排除临时任务状态与未经验证推测。这些属于行为指令，是否遵循需要对实际文件和日志另行核实。

还存在单独的 `MemoryExtractionStopHook`（`1942992`）：监听 STOP，调用 `extractAsync(session)`；非 TTY 场景等待抽取完成。该功能**不是无条件默认开启**：`isEnabled`（`1937631` 附近）要求未被禁用、autoMemoryEnabled 不为 false，且 **memoryExtraction === true**。

`doExtract`（`1937950–1941400`）的实际步骤：

1. 跳过已运行的抽取、无 session state、记忆目录不存在、新 user/assistant 消息少于 2 条。
2. 如果主 Agent 在新增历史中已经 Write/Edit 记忆目录，则跳过额外抽取并推进游标。
3. 扫描主题 `.md` 的 frontmatter/mtime 形成清单，排除 `MEMORY.md`（scanner `1929638`）。
4. 沿用当前 Agent 的 instructions、model、modelSettings，但工具仅保留 Read/Grep/Glob/Write/Edit，创建独立 extractor Agent，handoffs 为空。
5. 合并当前历史与抽取提示，最多 **5 turns**，连接取消信号，在 `runWithoutHistory` 中运行。
6. 临时把原 session permissionMode 改为 BypassPermissions，并标记 `MemoryExtraction` purpose，finally 恢复，再推进历史游标。

重要边界：工具集只保留文件/搜索工具，不等于本报告已证明 Write/Edit 被硬性限制到 memory 目录；是否仍经 session 沙箱规则需结合 guard 分析及运行验证。因此不能简单宣称“后台抽取绝对不会写其他路径”。本次静态分析不调用此功能。

typed 抽取提示（`1934903`）要求主题文件使用 frontmatter，`MEMORY.md` 只作索引、一条约 150 字符以内，重复内容优先更新而非新建。这是提示规范，不是本次对用户已有记忆文件内容作出的合规判断。

## 8. 对 WorkPivot 的可采纳结论

- 可借鉴运行生命周期与物理结束分离：取消必须传递到模型流、工具和子任务，完成后才释放资源。
- 当前输入组装、工具执行、模型请求前维护采用明确扩展点；WorkPivot 应先用最少模块覆盖当前需求，不直接复制其大型 DI/插件体系。
- 将项目规则、会话日志、上下文摘要和长期主题记忆分开存储，入口索引只加载少量内容，具体主题按需读取。
- 自动记忆写入应有明确开关、来源与可查看/删除能力；后台抽取的权限应限定写入目标，避免照搬临时全 bypass。
- 配置声明、安装代码、用户项目实际文件和运行验证应分别记录。仅凭 `MemoryManagement=true` 或存在 `MEMORY.md` 无法证明记忆被读取、更新或参与模型决策。

本报告已核实安装代码与调用路径；未进行模型调用、工具权限交互、取消压力测试或跨会话记忆行为验收。
