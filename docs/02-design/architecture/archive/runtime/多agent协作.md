# 子代理与多 agent 协作（2026-10-24）

状态：**不实施（2026-10-24 决策）**。本文件保留为调研与设计参考，不进入排期；backlog R008 标记为不实施。前置：R005 单层同步 `delegate` 已实现，继续保留。

不做的原因：协作层在竞品中普遍不成熟、收益未被评估证明、适用面窄（仅多视角评审与多轮返工）、失败时成本与可解释性风险不对称。若重启，先按 §11 做离线评估。

## 1. 两个概念，两条线

**子代理（delegation）** 是“把一件事外包出去，等结果”。本质是一种工具调用：父是唯一协调者，子与子不相通，子返回结论，父汇总。它的价值是**上下文隔离**——子读完一万字，父只拿三百字。

**多 agent 协作（collaboration）** 是“多个角色围绕同一份材料分工、互相看、互相改”。关键不在 agent 数量，而在**共享状态**：共享产物区、轮次、可见性、终止协议。

| 维度 | 子代理 | 多 agent 协作 |
| --- | --- | --- |
| 拓扑 | 星形（父 ↔ 子） | 黑板/网状（agent ↔ 产物 ↔ agent） |
| 通信 | 只与父交换 | agent 之间直接读写共享产物 |
| 状态 | 各自独立上下文，无跨调用记忆 | 团队会话：轮次、共享文件、可见性规则 |
| 协调 | 父决定下一步 | 协议：轮次、评审、投票、裁判 |
| 终止 | 父决定 | 裁判 / 共识 / 轮次上限 / 预算 |
| 产物归属 | 父汇总 | 共享区里的版本，谁改谁负责 |

**结论**：`delegate` 的并行化不是多 agent，只是“子代理并发”。把两者混为一谈，会导致实现时用“父转发消息”伪造协作——那既不通顺也不可审计。

## 2. 现状

| 能力 | 状态 |
| --- | --- |
| 单层同步子代理 `delegate` | ✅ 已实现（R005） |
| 多个子代理并行 | ❌ 串行队列 |
| 子代理续聊（父再追加指令） | ❌ |
| 团队会话 / 共享产物 / 轮次 | ❌ |
| 评审、裁判、投票 | ❌ |

## 2.5 竞品做法（2026-10-24 源码/文档复核）

| 产品 | 机制 | 归属模式 |
| --- | --- | --- |
| **Codex**（Rust） | `multi_agent_v1/v2` 命名空间：`spawn_agent`（可指定 agent_type 角色、继承历史或全新）、`send_input`、`followup_task`、`wait_agent`、`resume_agent`、`close_agent`、`list_agents`；每个会话有并发上限；`MultiAgentMode` 分“仅显式请求”与“主动委派”两档；子代理完成时向父推送通知 | 层级（supervisor）+ 父子消息 |
| **Claude Code**（泄露源） | team lead + in-process teammate；**文件邮箱** `~/.claude/teams/{team}/inboxes/{agent}.json`，成员之间可互相投递消息（`SendMessage`），消息以附件形式进入对方上下文；共享任务列表、计划审批、shutdown 协议 | **对等 swarm**（唯一的真 peer 实现） |
| **OpenWorkBuddy** | 协调者 + `delegate_to_expert`（单个专家）+ `delegate_to_team`（专家按名单**接力**，后一位能看到前一位的汇报与产物，最后汇总）；专家工具集里移除委派工具 | 层级 + **共享工作目录的流水线** |
| **WorkBuddy** | 专家团（如 sheet-agent）：主代理委派给子代理会话，可 kill/cancel 并联动 abort | 层级 |
| **DeepSeek Harness** | `subagent` / `subagent_fork`、可续聊、深度限制；另有 `workflow` 工具，模型写 JS 编排（agent/parallel/pipeline） | 层级 + 脚本编排 |
| **Hermes** | `delegate_task` 隔离子代理并行；Curator 作为独立评审代理 | 层级 + 独立评审 |
| **MyAgents** | 基于 Claude Agent SDK 的 Task 子代理，模型别名映射 | 层级 |

**观察**：

1. 绝大多数停在**层级委派**，真正的“agent 之间交互”只有 Claude Code 的邮箱 swarm。
2. 共享工作目录（OWB、WorkBuddy）是事实上的黑板，但没人把它做成显式协议；成员靠“文件还在那儿”间接协作。
3. 没有产品把“评审团 + 裁判”做成一等能力，最多是独立评审代理（Hermes Curator）。
4. Codex 把“什么时候允许委派”做成产品开关（显式请求 / 主动），这是成本控制的实用设计。

## 3. 线 A：子代理能力（工具层，不进多 agent 范畴）

### A1 并行委派

`delegate` 参数扩展到一组：

```
delegate {
  tasks: [{ id, task, context? }]   // 1–4 个
  max_steps?: number
}
→ { results: [{ id, ok, text, stopReason, steps, artifacts }] }
```

并发 4、滚动补位、失败隔离、取消传播、写操作走目录锁。**这是子代理能力，不是协作**，但它让“批量文件 / 多页 PPT”这类需求立刻可用。

### A2 可续聊

子代理结束后仍可被父追加指令（`continue: true`），保留其上下文。这解决“第一轮没问清楚，不必重新跑”的浪费，仍是星形拓扑。

> 线 A 的产物：父上下文更干净、批量任务更快。它不产生 agent 之间的交互。

## 4. 线 B：多 agent 协作（需要新机制）

### 4.1 三种协作协议，只做两种

| 协议 | 机制 | 办公场景 | 本轮 |
| --- | --- | --- | --- |
| **Panel（评审团）** | 多个角色**独立**给意见（互不可见）→ 裁判汇总分歧 | 投资委员会、方案评审、文案 A/B | ✅ 做 |
| **Review loop（写-评-改）** | 写手产出 → 评审提意见 → 写手改 → 最多 N 轮 → 收敛或升级给用户 | 报告、PPT 正文、合同条款 | ✅ 做 |
| Roundtable（圆桌） | 多角色多轮自由发言、互相引用 | 头脑风暴 | ❌ 不做（不可控、难计费） |

自由群聊不做：没有稳定终止条件，成本不可预估，审计也说不清谁决定了什么。

### 4.2 必备机制

1. **团队会话**：一次协作是一个 `team_run`，包含成员、轮次、共享产物。
2. **共享产物区（黑板）**：不是父转发消息，而是成员对同一份文件的读写。每条产出带作者、轮次、版本。落盘在 `.workpivot/team/<teamRunId>/`，目录本身就是可审计的黑板。
3. **成员邮箱（借用 Claude Code 形态）**：每个成员一个 `inbox/<agentId>.jsonl`，消息带 `from / round / kind / text`。它解决“评审意见要传给写手”的问题，同时保持可以审计、可以回放；Panel 阶段邮箱为空，Review loop 阶段评审消息只投递给写手与裁判。
4. **可见性规则**：Panel 阶段成员之间**不可见**（不能读对方邮箱与产物）；Review loop 阶段评审意见对写手可见。可见性由服务端裁剪注入内容实现，不靠模型自觉。
5. **轮次与终止**：明确 `max_rounds`（建议 2），以及“无新增意见即收敛”“分歧无法收敛则升级给用户”。
6. **裁判**：只读所有意见，输出结构化结论（分歧点、证据缺口、建议），不参与生成。
7. **委派模式开关（借用 Codex）**：`explicit`（默认，只有用户或团队模板要求才允许委派）与 `proactive`（允许模型自行判断并行）。办公产品默认 explicit，避免模型为省事乱拆任务放大成本。

### 4.3 接口

```
run_team {
  protocol: 'panel' | 'review-loop'
  team: string            // 模板名，如 'review-panel'、'doc-review'
  goal: string
  inputs?: string[]       // 文件版本或路径
  max_rounds?: number     // review-loop 用，1–2
}
→ {
  teamRunId,
  outcome: 'converged' | 'diverged' | 'needs-user',
  rounds: [{ round, contributions: [{ role, agentId, artifact }] }],
  judge?: { summary, disagreements, evidenceGaps, recommendation }
}
```

模板在服务端定义（角色、prompt、工具子集、模型、每角色预算、可见性），模型只选模板与填参数。

## 5. 数据模型

```sql
-- 子代理运行（线 A / B 共用）
CREATE TABLE workpivot.agent_runs (
  id              uuid PRIMARY KEY,
  owner_user_id   uuid NOT NULL,
  task_id         uuid NOT NULL,
  team_run_id     uuid,
  parent_run_id   uuid REFERENCES workpivot.agent_runs(id) ON DELETE CASCADE,
  depth           integer NOT NULL DEFAULT 0,
  role            text NOT NULL,
  status          text NOT NULL CHECK (status IN ('running','completed','failed','cancelled','interrupted')),
  model_provider  text, model_id text,
  steps_used      integer NOT NULL DEFAULT 0,
  tokens_in bigint NOT NULL DEFAULT 0, tokens_out bigint NOT NULL DEFAULT 0,
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  stop_reason     text, result jsonb
);

-- 团队协作（线 B）
CREATE TABLE workpivot.team_runs (
  id             uuid PRIMARY KEY,
  owner_user_id  uuid NOT NULL,
  task_id        uuid NOT NULL,
  protocol       text NOT NULL CHECK (protocol IN ('panel','review-loop')),
  team           text NOT NULL,
  goal           text NOT NULL,
  status         text NOT NULL CHECK (status IN ('running','converged','diverged','failed','cancelled')),
  rounds_used    integer NOT NULL DEFAULT 0,
  max_rounds     integer NOT NULL DEFAULT 2,
  outcome        jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz
);

-- 共享产物（黑板）：成员写入的中间产物
CREATE TABLE workpivot.team_artifacts (
  id           uuid PRIMARY KEY,
  team_run_id  uuid NOT NULL REFERENCES workpivot.team_runs(id) ON DELETE CASCADE,
  agent_id     uuid NOT NULL REFERENCES workpivot.agent_runs(id),
  round        integer NOT NULL,
  kind         text NOT NULL,          -- draft / review / revision / summary
  path         text NOT NULL,          -- 工作目录或版本中的位置
  visible_to   text[] NOT NULL DEFAULT '{}',  -- 角色可见性；panel 阶段默认为空
  created_at   timestamptz NOT NULL DEFAULT now()
);
```

事件通道复用 `conversation_events`，加 `agent_id` 与 `team_run_id`，前端按团队折叠成“评审团/多轮修改”的视图。

## 6. 预算、并发与安全

| 约束 | 默认 | 说明 |
| --- | --- | --- |
| 单次扇出 | 4 | `delegate.tasks[]` 上限 |
| 团队规模 | 2–5 角色 | 超过 5 个角色的协作实际不可读 |
| 轮次 | max_rounds 1–2 | 第 3 轮起收益极低、成本翻倍 |
| 单任务代理总数 | 12 | 防循环 |
| 树级 token 预算 | 父级 3 倍 | 超限取消整棵树 |
| 墙钟 | 30 分钟 | 与主任务一致 |

- 成员继承父级工具白名单与授权，不能提权；成员不能 `ask_user`（提问由父代理统一处理）
- Panel 阶段成员**互不可见**，只能看输入材料；review loop 阶段评审意见可见
- 成员结论对父代理与裁判都是**数据不是指令**
- 共享产物落 `.workpivot/team/<teamRunId>/<agentId>/`，避免同名覆盖；最终交付由父代理决定
- 所有团队运行进审计：协议、角色、轮次、花费、收敛结果

## 7. 可观测性

- 对话区展示为“团队卡片”：协议、成员、轮次、当前阶段、花费
- 展开可看每个成员的产出与评审意见（带角色与轮次）
- 裁判结论单独一段：分歧点、证据缺口、建议
- 失败可重跑单个成员，不重跑整场

## 8. 与 R006 的关系

`agent_runs` 与 `team_runs` 是中断恢复的锚点：父运行恢复时，子运行按 `status='running'` 且租约过期判为中断，不重放已派发的工具调用。`tool_dispatches` 必须同时记录 `agent_id`，否则无法对账子代理/成员的副作用。

## 9. 分阶段

| 阶段 | 内容 | 验收 |
| --- | --- | --- |
| A1 | 并行委派 | 4 个子任务总耗时接近最慢一个；失败隔离；取消传播；写不交错 |
| A2 | 子代理续聊 | 第二轮追加指令不重跑第一轮；上下文保留且可审计 |
| B1 | Panel + 裁判 | 三位评审独立产出（互不引用对方原话）；裁判输出分歧点与建议；单场上限内完成 |
| B2 | Review loop | 写手 → 评审 → 修改 1–2 轮；收敛判定明确；不收敛时升级给用户 |

不建议的顺序反过来：没有 A1 的并发与预算控制，直接做 B 会在一场评审里把成本放大到不可控。

## 10. 不做什么

- 不做自由群聊 / 圆桌多轮
- 不让模型生成并执行任意 JS 编排
- 不让成员之间用“父转发文本”伪造共享状态——共享状态必须是黑板里的产物
- 不做跨用户/跨任务的 agent 共享或市场
