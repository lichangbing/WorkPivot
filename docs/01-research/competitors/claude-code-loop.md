# Claude Code agent loop 逆向分析（2026-10-24）

来源：本机泄露源码 `E:\project\claude-code-leak\src`（约 51 万行 TypeScript，非推测）。关键文件：`query.ts`（1729 行）、`QueryEngine.ts`、`services/tools/toolOrchestration.ts`、`services/tools/StreamingToolExecutor.ts`、`services/compact/*`、`tools/AgentTool/runAgent.ts`、`utils/context.ts`。

## 1. 顶层结构

- `query()` 是 `AsyncGenerator`，返回 `queryLoop()` 的产物；UI 通过消费事件流渲染。
- 循环是一个**显式状态机**：每次 `continue` 都带 `transition.reason`（`max_output_tokens_recovery`、`stop_hook_blocking`、`token_budget_continuation` 等），状态里包含 `messages / turnCount / autoCompactTracking / hasAttemptedReactiveCompact / stopHookActive`。这与“改一个 messages 数组继续跑”的隐式循环有本质区别：每个续转原因可枚举、可审计。
- 每轮迭代顺序：预取（记忆/技能）→ 上下文治理 → 采样 → 工具执行 → 停止判定 → 构造下一轮 State。

## 2. 一轮的完整步骤

1. 启动旁路预取（`startRelevantMemoryPrefetch`、`skillPrefetch`），与模型流式并行，工具后统一消费。
2. 取 `messages` 中 compact boundary 之后的部分。
3. 工具结果预算：`applyToolResultBudget` 按消息聚合限制工具结果体积（可按工具 `maxResultSizeChars` 豁免）。
4. snip 压缩（可选特性）→ microcompact（按 `tool_use_id` 缓存替换）→ collapse → autocompact（阈值触发）。
5. 采样（流式），处理 `prompt_too_long`（反应式压缩）、`max_output_tokens`（升级重试）、模型错误（fallback）。
6. 工具执行（见 §3）。
7. 停止判定（见 §4）。
8. 若继续：构造下一轮 State（消息 + 新的 `turnCount`），`continue`。

## 3. 工具编排（最值得借鉴的一段）

`runTools` 先**分批**：

```
partitionToolCalls: 按 tool.isConcurrencySafe(parsedInput) 判定
  - 连续的安全调用 → 合成一批并发执行
  - 其余 → 每个一批串行执行
```

- `isConcurrencySafe` 是**工具自带的谓词，按解析后的入参判定**（例如 Bash 看命令是否只读），谓词抛错则保守当作不安全。
- 并发上限默认 **10**，可用 `CLAUDE_CODE_MAX_TOOL_USE_CONCURRENCY` 覆盖。
- 并发批次里各工具产生的 `contextModifier` 先按 `toolUseID` 排队，批次结束后**按原顺序**逐个应用，避免并发改上下文互相覆盖。
- 另有 `StreamingToolExecutor`：工具在**流式响应还没结束时**就开始执行，进一步压延迟。

## 4. 停止与恢复路径

| reason | 触发 |
| --- | --- |
| `completed` | 正常结束（含 API 错误直接收尾，不跑 stop hooks，避免“错误→hook 拦截→重试”死循环） |
| `max_turns` | 超过 `maxTurns`（`QueryParams.maxTurns`，未设为不限） |
| `prompt_too_long` | 反应式压缩后仍过长 |
| `max_output_tokens` | 升级重试仍被截断 |
| `aborted_streaming` / `aborted_tools` | 用户中断 |
| `hook_stopped` / `stop_hook_prevented` | 停止钩子干预 |
| `model_error` | 模型错误且 fallback 不可用 |

配套机制：

- **输出上限升级**：`MAX_OUTPUT_TOKENS_DEFAULT` 32k、上限 64k，但**默认封顶 8k**（`CAPPED_DEFAULT_MAX_TOKENS`）；被截断时先升级再恢复，`ESCALATED_MAX_TOKENS`。
- **反应式压缩**：`prompt_too_long` 且未尝试过时，压缩后重试一次；用 `hasAttemptedReactiveCompact` 防重复（注释里明确写了不加这个守卫会造成数千次 API 调用的死循环）。
- **模型 fallback**：`fallbackModel` + `FallbackTriggeredError`，流式期间也能切换。
- **token 预算续跑**：本轮 token 没跑满预算时，注入一条 `isMeta` 的 nudge 消息让模型继续；并检测“边际收益递减”提前停。

## 5. 上下文治理（五层）

| 层 | 机制 | 关键参数 |
| --- | --- | --- |
| 工具结果预算 | 按消息聚合裁剪，可按工具豁免 | `maxResultSizeChars` |
| snip | 快照式截断历史 | 特性开关 |
| microcompact | 按 `tool_use_id` 替换旧工具结果，带缓存 | 特性开关 |
| collapse | 折叠中间过程 | 特性开关 |
| autocompact | 达阈值生成摘要 | 窗口 200k；阈值 = 窗口 − min(model max output, 20k) − **13k buffer**；摘要输出上限 20k |
| reactive | `prompt_too_long` 后压缩重试 | 只尝试一次 |

压缩在**每轮采样前**执行，且与缓存意识耦合：替换决策按 `tool_use_id` 冻结，避免 cache bust。

## 6. 子代理

`runAgent` 的关键点：

- 支持 `forkContextMessages`：fork 时带父上下文，但会 `filterIncompleteToolCalls` 丢掉未闭合的工具调用（与 R006 的对账同源）。
- 子代理自己的工具集、`maxTurns`、sidechain transcript（独立文件，`recordSidechainTranscript`）。
- 取消沿用父级 `AbortController`。
- sidechain 文件同时是 resume 的依据。

## 7. 会话持久化

- 消息是 `parentUuid` 链表；工具结果是 user 角色消息、用 `sourceToolAssistantUUID` 回指父消息。
- **用户消息在进循环前就落盘**，进程被杀也能 resume。
- compact boundary 用 `parentUuid:null` + `logicalParentUuid` 保持链完整。
- 子代理写独立 sidechain 文件，不污染主链。

## 8. 与 WorkPivot 现状对比

| 维度 | Claude Code | 我们 |
| --- | --- | --- |
| 循环形态 | 显式状态机 + transition 原因 | `while(true)`，靠 `break`/`continue` |
| 工具执行 | 按安全性分批，只读并发 10，写类串行 | 全串行 |
| 上下文治理 | 五层，每轮采样前 | 单层字符预算压缩（120k） |
| 输出截断 | 升级上限重试 | 直接截断 |
| prompt 过长 | 反应式压缩重试一次 | 报错 |
| 中断恢复 | parentUuid 链 + 先落盘 + sidechain | 内存循环 + JSONL（R006 设计中） |
| 子代理 | fork/全新、独立 sidechain、可 resume | 单层同步、事件前缀（R005） |
| 未闭合工具调用 | fork 时过滤 | 靠 `replayableMessages` 丢弃 |

## 9. 建议借鉴（按成本从低到高）

1. **工具按安全性分批并发**（O-13）：给 `Tool` 加 `isConcurrencySafe(args)` 谓词，连续安全调用并发（默认 10），写类串行；并发产生的上下文修改按序应用。改动集中在 loop，收益是延迟。
2. **输出上限升级**：被 `max_tokens` 截断时，用更高的输出上限重试一次，再失败才截断。成本低，直接减少“答到一半停”。
3. **prompt 过长反应式压缩**：捕获这类错误，压缩后重试一次并加守卫，避免死循环。
4. **transition 原因审计**（配合 R006）：把“为什么继续/为什么停”变成结构化字段，而不是隐含在代码路径里。
5. **fork/resume 时过滤未闭合工具调用**（R006）：与合成“结果未知”互为兜底。
6. **token 预算续跑**：预算未用满时 nudge，并检测边际收益递减。与我们现有的 `onIdle` 合并设计，避免两套 nudge 打架。

## 10. 不建议借鉴

- **五层压缩**：我们的上下文窗口与任务规模不同，单层字符预算 + 分段摘要够用；五层会带来大量状态与缓存耦合。
- **流式工具执行**：收益是延迟，复杂度高，且与我们的权限卡（需要用户确认后才执行）冲突。
- **stop hooks**：Claude Code 用它做“完成前自检”，我们已有 `verifyClaimedFiles` 门禁，再加一层容易互相干扰。

## 11. 一句话总结

Claude Code 的 loop 不是“更聪明的提示词”，而是**把循环的每个决策点显式化**：为什么继续（transition）、什么时候压（五层阈值）、工具怎么并发（安全性谓词分批）、失败怎么恢复（升级/压缩/fallback）。我们缺的不是能力，是这些决策点的显式化与可观测性。
