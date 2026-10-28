# 竞品研究：Hindsight 与 DSH 长期记忆插件

| 项 | 值 |
| --- | --- |
| 类型 | 开源 Agent 长期记忆系统及 DSH 接入方案 |
| 研究状态 | ✅ 已确认（源码与官方文档交叉核对，未做本机端到端运行） |
| 研究日期 | 2026-10-28 |
| 最后复核 | 2026-10-28 |
| 证据等级 | B：公开源码、官方文档与测试代码；未完成本地 DSH 真实会话验收 |
| 许可 | MIT |

> 一段话结论：Hindsight 最强的不是“向量检索聊天记录”，而是把长期记忆做成
> `原始事实 → 带证据的归纳 Observation → 预先生成的 Mental Model / Knowledge Page`
> 三层认知资产，再以 bank、标签和时间约束控制可见范围。DSH 接入层提供的另一项关键经验是：
> 记忆召回应发生在 Agent 生命周期中，但要使用预取、超时、Token 上限和失败降级，不能
> 让记忆服务决定聊天是否可继续。WorkPivot 应吸收这两类模式，继续保留自己的三层作用域、
> 用户确认和来源失效机制，不应直接替换为 Hindsight。

## 可直接借鉴的实现模式

| 模式 | Hindsight 的做法 | WorkPivot 应采用的部分 |
| --- | --- | --- |
| 写入与读取解耦 | 写入异步提取，读取按需召回或读知识页 | 后台整理不占聊天请求，来源失效仍即时生效 |
| 认知分层 | fact / experience / observation / knowledge page | 保留 user/project/task，再增加正交的记忆形态 |
| 证据化归纳 | Observation 附精确引文、来源和 proof count | 概览与归纳必须可回查有效修订，不覆盖原始来源 |
| 预计算稳定答案 | Mental Model 后台刷新，读取直接查数据库 | 用项目概况、用户偏好等知识页降低每轮综合成本 |
| 有界自动召回 | 查询限近期上下文，结果限 Token，超时不阻塞 | 先概览、后检索，严格控制条数、字节数、延迟和开关 |
| 宿主级作用域 | bank 严格隔离，DSH 按工作区、preset、session 细分 | scope 由服务端授权推导，RLS 仍是最终边界 |

## 1. 研究边界与名称辨析

“DSH 的 Hindsight 插件”存在三个容易混淆的实现，本文同时分析，但不把它们视为同一个产品：

| 对象 | 关系与定位 | 固定版本 | 本文用途 |
| --- | --- | --- | --- |
| [Hindsight 核心](https://github.com/vectorize-io/hindsight) | Vectorize 开源的独立记忆服务，可自托管或使用云服务 | commit `1e3a4841a7eed5d76e796d2f31e5f0a13e78e5cf` | 理解记忆模型、写入、召回和固化机制 |
| [Hindsight coding-agents](https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/coding-agents) | Hindsight 官方仓库内的编码 Agent 接入包，已支持 DSH native Cordis 插件 | `@vectorize-io/hindsight-coding-agents` 0.8.2 | 参考官方 DSH 生命周期接入与工作区隔离 |
| [Ryu6Zero/dsh-hindsight](https://github.com/Ryu6Zero/dsh-hindsight) | 第三方轻量 DSH 插件，只是 Hindsight REST 客户端和工具层 | `0.4.0`，commit `200eab8ab5cf395e86d0ddb3cc809061f6ee09c4` | 参考简单、可观测的工具接入 |
| [paulalesius/dsh-hindsight-advanced](https://github.com/paulalesius/dsh-hindsight-advanced) | 第三方高级 DSH 插件，含自动召回、快照和失败经验 | package `0.1.0`，commit `efedc48db900a5facfdc3ced14e6edae167f8e2c` | 参考自动召回、降级和上下文治理 |

需要明确：

- Hindsight 官方支持 DSH，不等于 DeepSeek 官方发布了 Hindsight 插件。
- `dsh-hindsight` 的 README 使用“官方级”作为质量描述，但仓库和包均未证明它由 DeepSeek 或 Hindsight 官方维护。
- `dsh-hindsight-advanced` 明确声明只兼容 DSH commit
  `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`，不应直接用于当前 WorkPivot 或作为长期依赖。
- 本文只提炼设计模式。没有复制插件代码，也没有把任何第三方凭据或运行数据写入仓库。

## 2. 产品与用户

- **作者/厂商**：Hindsight 核心由 Vectorize.io 维护；另外两个 DSH 插件由社区作者维护。
- **目标用户**：需要跨会话复用用户偏好、项目事实、历史决策和 Agent 操作经验的个人 Agent 与编码 Agent 用户。
- **产品形态**：独立记忆服务 + REST/SDK/MCP/框架适配器 + DSH Cordis 插件。Hindsight 也可嵌入运行或使用托管服务。
- **典型场景**：编码 Agent 记住仓库决策；客服 Agent 复用用户背景；项目 Agent 记住约束、风险和此前失败经验；在新会话开始时加载已沉淀的项目知识。

## 3. 核心能力

| 能力 | 成熟度 | 观察 |
| --- | --- | --- |
| 长期记忆写入 | ✅ | `retain` 从原始内容提取事实、实体、关系和时间信息 |
| 混合召回 | ✅ | 语义、关键词、图关系、时间四条路径并行，再做融合与重排 |
| 深层综合 | ✅ | `reflect` 对多条记忆做推理，不等同于一次关键词查找 |
| 记忆固化 | ✅ | Observation 合并多源事实并保留证据；Mental Model 预生成稳定答案 |
| 隔离 | ✅ | bank 严格隔离；DSH 接入还可按工作区、preset、session 细分 |
| 自动接入 Agent | ✅ | 官方 DSH 插件绑定 session-start、pre-step、turn-stopping 和工具注册 |
| 可观测性 | 🧪 | 轻量插件公开异步操作状态；核心支持指标和 Webhook |
| 企业办公闭环 | ❌ | 不负责 Office 成果、文件版本、任务授权和交付验收 |

Hindsight 是“记忆基础设施”，不是 WorkPivot 这类“办公 Agent 工作台”的直接替代品。

## 4. 分层记忆模型

```text
原始会话 / 文档 / 工具经验
          │ retain + LLM 提取与规范化
          ▼
World fact / Experience fact
事实、实体、关系、发生时间、来源
          │ 后台 consolidation
          ▼
Observation
去重后的信念或模式 + 精确引文证据 + proof count + 时间趋势
          │ 自动或按计划刷新
          ▼
Mental Model / Knowledge Page
针对固定问题的稳定答案、目录页或项目知识文档
```

这四层不是按聊天层级划分，而是按“证据密度和读取成本”划分：

1. **World fact**：关于外部世界、用户、项目或组织的事实。
2. **Experience fact**：Agent 自己做过、观察到或经历过的事情，可用于复用成功方法和失败教训。
3. **Observation**：由多条事实归纳出的去重信念，必须附带来源证据，新证据到达时细化和扩展，不做静默覆盖。
4. **Mental Model / Knowledge Page**：预先回答“用户偏好是什么”“项目架构和决策是什么”等固定问题的稳定文档。读取时直接查数据库，不再临时检索和调用 LLM。

与 WorkPivot 当前模型相比，这两组维度是正交的：

| 维度 | WorkPivot 已有 | Hindsight 补充 |
| --- | --- | --- |
| 权限与生命周期作用域 | `user` / `project` / `task` | bank，以及标签级 scope |
| 知识形态 | 当前主要是已保存事实和候选 | fact / experience / observation / synthesized page |
| 可信度 | revision、来源、确认状态 | 证据引文、proof count、stale/fresh 信号 |
| 读取方式 | 概览 + 按需读取 | 召回事实，或直接加载预生成知识页 |

因此，不建议把 WorkPivot 的 `user/project/task` 改造成 Hindsight 的四类事实。更合理的方案是保留
`scope`，另外增加 `memory_kind` 和 `derivation_status`。

## 5. 写入与召回链路

### 5.1 Retain：先提取，再存储

Hindsight 的 `retain` 不只是把文本插入数据库：

1. 用 LLM 从会话或文档中提取可独立引用的事实。
2. 区分 `world` 与 `experience`，避免把 Agent 自己做过的事误记为外部事实。
3. 提取实体、因果/时间关系和事实发生时间。
4. 规范化实体，建立向量、关键词和知识图谱索引。
5. 后台继续生成或细化 Observation。

源码中的提取模型同时保留 `occurred_start`、`occurred_end`、`where`、`entities` 和
`causal_relations`，说明“何时发生”与“何时被写入”是分开的。对项目办公场景，这比只保存
`created_at` 更重要：统计口径在某日变更、合同在某季度有效、任务只在本周适用，都需要明确
有效时间。

### 5.2 Recall：多路检索而不是单一向量库

官方文档和源码确认 `recall` 组合四类路径：

| 路径 | 解决的问题 | 对 WorkPivot 的价值 |
| --- | --- | --- |
| Semantic | 同义表达和语义相似 | “交付物”召回“成果文件” |
| Keyword / BM25 | 人名、编号、产品名和精确术语 | 合同号、项目代号、统计口径 |
| Graph | 实体、时间、语义和因果关系 | 人物→项目→决策→风险 |
| Temporal | 按发生时间过滤和分桶 | “去年”“上季度”“版本生效前” |

经过去重后使用 Reciprocal Rank Fusion（RRF，`k=60`）融合排名，再经过 cross-encoder 重排，
最后按 Token 预算裁剪。这个顺序的重要含义是：

- 各路原始分数尺度不同，不直接相加；先使用名次共识。
- 召回质量不只看相似度，还要经过 query-document 联合重排。
- 结果数量不是目标，Token 预算才是 Agent 上下文的硬约束。
- 当前证据不足以支撑 cross-encoder 的部署成本时，可以先实现“关键词 + 向量 + 时间过滤 +
  RRF”，把图和语义重排作为后续增强。

### 5.3 Reflect：先读稳定知识，再回退到原始证据

`reflect` 采用分层检索：

1. 先找 `Mental Model / Knowledge Page`，命中且新鲜时可直接回答。
2. 再找 Observation，并检查其是否已经落后于新事实。
3. 最后回退到原始 fact 和 chunk 核对。

这比每次把整个 bank 历史送进模型便宜，也更容易得到稳定答案。Mental Model 读取是数据库读取，
不在用户请求路径上运行 LLM；只有后台刷新内容时才产生模型成本。

## 6. Observation 与知识页的关键设计

### 6.1 证据先于结论

Observation 数据结构要求每条证据包含：

- source memory id；
- 精确引文 `quote`；
- 证据与结论的关系；
- 来源时间。

Observation 还按证据时间计算 `new / strengthening / stable / weakening / stale` 趋势。结论不是
不可追溯的摘要，而是可下钻到原始记录的派生对象。新证据到达时，系统细化原结论并保留历史，
而不是用最后一次模型输出直接覆盖。

**可借鉴结论**：WorkPivot 已有 `evidence`、revision 和冲突复核，应继续强化“Observation
永远指向当前有效 source set”。任何来源被删除、撤权或版本变化，都应使依赖它的 Observation
和概览失效，而不是只更新 Observation 正文。

### 6.2 知识页解决“每次重新检索”的浪费

适合生成知识页的不是所有记忆，而是读取稳定、跨任务反复使用的问题，例如：

- 用户稳定偏好和表达要求；
- 项目目标、范围、统计口径、已确认决策；
- 系统架构、关键模块、长期约束；
- 当前风险、待办与近期决策。

知识页需要保存：

- 问题或主题；
- 当前内容；
- 所依据的记忆/证据版本；
- 生成时间与最后验证时间；
- 是否 stale；
- 上一版本或版本历史；
- scope 与授权来源。

WorkPivot 设计中的 `memory_overviews` 与这个概念接近，但目前仍属于规划项。Hindsight 说明它应
独立于详细记忆发布，并与修订集合/epoch 绑定，不能成为一套可静默漂移的第二事实库。

## 7. DSH 插件的三种接入模式

### 7.1 Hindsight 官方 coding-agents：生命周期驱动

官方 DSH 插件直接绑定 Cordis 生命周期：

| 生命周期点 | 行为 |
| --- | --- |
| `agent/session-start` | 识别工作区、检查冷热 bank、后台导入 Git/代码库知识 |
| `agent/pre-step` | 只在有新的用户输入时召回，追加一条 sourced message |
| `agent/turn-stopping` | 把本轮结束后的增量转录写回 bank |
| `ctx.tools` | 注册 knowledge page、ingest、reflect 等 native tools |
| `agent/disposed` | 释放会话引用，避免长期进程累积内存 |

其中有三点比普通“记忆工具”成熟：

1. **按会话工作区解析 bank**：一个 DSH 进程可能同时服务多个仓库，不能按进程启动目录统一写库。
2. **只召回新用户输入**：工具续步和插件注入行不触发第二轮召回，避免同一轮重复污染上下文。
3. **不重复注入相同内容**：从会话历史读取上一份注入文本，相同则跳过；fork/重启后也不会因为
   内存状态丢失而重复追加。

官方集成还会跳过 subagent 的自动召回和写入，因为子会话内容最终会由父会话归档，重复写入会
扩大提取成本。这个原则适用于 WorkPivot 后续的子 Agent：子任务输出应由父运行统一沉淀，而不是
每个子 Agent 自建一套长期记忆。

### 7.2 `dsh-hindsight`：轻量工具层

轻量插件提供 `status / recall / related / list / remember / forget` 等显式工具和
`/hindsight` 命令，主要实现方式是调用 Hindsight REST：

- 工具结果最多返回 10 条，正文单项约 900 字上限；
- 请求有超时，支持 AbortSignal；
- 60 秒召回缓存，写后按 bank 失效；
- 写操作固定使用默认 bank，只有只读探索可切换 bank；
- 异步提取状态可查询，避免“刚写入但搜不到”无法诊断；
- system prompt 只注入“何时应召回/保存”的使用说明，不注入整库记忆。

它适合评估 Hindsight API 和做显式查询，但不具备自动写入、跨轮召回快照、上下文预算和证据确认，
不能据此判断长期记忆的产品体验是否完整。

### 7.3 `dsh-hindsight-advanced`：自动召回与宿主边界

高级插件在 DSH 原生生命周期上补了更多上下文工程：

- 在 turn-stopping 预取下一轮记忆，下一轮通常无需等待；未就绪时回退到同步查询。
- 自动召回默认总预算 2,500 ms，失败或超时直接继续 Agent 工作。
- 查询由当前用户消息和最近 5 轮组成，整体上限 1,000 字，优先保留当前消息。
- 每次最多返回 4,096 Token 的记忆快照，不把整个 bank 注入。
- 相同快照不重复追加，只保留一条“本已生效”的紧凑提示。
- 可选只保留最新完整快照，历史位置显示摘要标记；完整历史仍留在会话日志中审计。
- 人工中途纠偏时按纠偏消息重新召回；上下文压缩后可再次召回。
- 可选按上一轮工具调用匹配 `experience` 类失败经验，作为下一步前的提醒。
- 实验性 `lessonGate` 可在执行前按分数拒绝 Bash/run_code；超时或服务失败时放行。
- 凭据使用 `apiKeyRef` 动态解析，避免把密钥值写入配置。

这些机制中最值得 WorkPivot 借鉴的是“**记忆服务是增益，不是聊天主链路的硬依赖**”。其余如快照
墓碑、双挂载 owner、推理文本召回等，是为 DSH 自身事件模型设计的复杂方案，不应整体移植。

## 8. 作用域与安全

Hindsight 的 bank 是严格隔离边界；官方 DSH 接入按工作区解析 bank。高级社区插件进一步在
bank 内使用：

- `global`：无标签，bank 内所有会话可见；
- `preset:<id>`：同一 Agent preset 的会话可见；
- `session:<id>`：仅当前会话可见；
- subagent 的 session tier 归属父会话。

这是有效的“在宿主事件中缩小可见范围”示例，但不能直接作为 WorkPivot 的最终权限模型：

1. bank 只解决物理分区，不替代租户、项目成员和 RLS。
2. 高级插件把 `scope` 暴露给模型，写错 scope 的后果较大；WorkPivot 应由服务端从登录身份、
   项目和任务授权推导可写范围。
3. 召回结果只能是参考事实，不能提升为系统指令或扩大工具权限。
4. 删除、撤权和来源失效必须由服务端确定性执行，不能依赖下一轮模型记得“不要使用”。

因此在 WorkPivot 中，跨项目隔离必须继续由服务端身份和数据库行级安全控制，Hindsight 标签至多
是索引过滤条件。

## 9. 优势

- 记忆形态分层，兼顾原始证据、归纳结论和低延迟稳定答案。
- 多路检索覆盖语义、精确词、关系和时间的互补场景。
- Observation 有证据、来源、proof count 和时间趋势，支持纠错而不抹除历史。
- Knowledge Page 把高频读取从“每轮检索 + LLM 综合”变成数据库读取。
- 官方 DSH 接入覆盖会话开始、输入、结束和工具注册，形成完整生命周期。
- 自动接入普遍采用失败降级、限时、上下文上限和子 Agent 跳过。
- 支持自托管、可替换模型与多语言，和 WorkPivot 的私有化方向一致。

## 10. 限制、风险与未验证项

- 这是记忆基础设施，不提供 WorkPivot 需要的任务、文件版本、Office 成果和审批闭环。
- `retain / reflect / consolidation / mental model refresh` 都依赖额外 LLM 调用，成本与延迟不能忽略。
- 向量、关键词、语义重排和图检索适合大记忆量；小团队早期数据量下可能投入过高。
- Observation 和 Mental Model 都可能因提取、合并或过期判断出错，必须有来源、版本和用户纠错入口。
- 自动召回会污染上下文；需要回放、去重、时效和可关闭能力。
- 高级插件的 `lessonGate` 会阻止合法动作，超时又自动放行，不适合作为 WorkPivot 默认安全策略。
- 高级插件强绑定旧 DSH commit；轻量插件不负责自动持久化；两者都不适合作为生产核心依赖。
- 本次未安装或运行 DSH 插件，也未验证真实 Hindsight 集群的召回质量、延迟、故障恢复和成本；
  所有性能参数来自源码默认值和官方说明，不代表 WorkPivot 实测。

## 11. 对 WorkPivot 的启示

### 11.1 值得借鉴

| 优先级 | 方案 | 与 WorkPivot 的落点 |
| --- | --- | --- |
| P0 | 保留 `scope`，新增正交的记忆形态 | `fact / experience / observation / overview` 不取代 user/project/task |
| P0 | 将项目概览做成受版本约束的知识页 | 扩展 `memory_overviews`，先读概览、再按需读详细记忆和原始来源 |
| P0 | Observation 绑定 source revision，并保留 proof/evidence | 强化现有 revision、证据和来源失效；禁止模型摘要覆盖来源 |
| P1 | 召回输入限定为当前请求 + 最近有限轮次 | 不把全项目历史或整个记忆库塞进上下文 |
| P1 | 使用 Token 预算和单轮召回上限 | 记忆概览、细节读取和调用次数分别设上限 |
| P1 | 记忆服务严格超时，失败不阻塞聊天 | 聊天主流程与服务降级解耦，用户可看到“本次未加载记忆” |
| P1 | 写入与整理作业可观测 | 展示 queued/running/completed/failed、重试和延迟，不暴露私人正文 |
| P1 | 相同召回快照去重 | 避免每轮追加同一块记忆；只保留一条仍然生效的提示 |
| P2 | 关键词 + 向量 + 时间过滤 + RRF | 先补精确实体与数字匹配，再评估图和 cross-encoder |
| P2 | turn-stop 预取下一轮可能相关的记忆 | 不改变当前请求语义时使用预热；未命中再同步召回 |
| P2 | 从工具失败中沉淀 `experience` | 下一步前提供提示，由模型和用户决定是否调整，不默认硬阻断 |

建议的逻辑读取顺序：

```text
当前任务授权
  → 已启用且有权限的知识页概览（直接数据库读取）
  → 与当前请求相关的 Observation / fact 检索（有 Token 和超时上限）
  → 用户明确要求时读取详细记忆
  → 必要时回查原始来源
```

写入与固化顺序：

```text
每轮明确事实
  → 生成候选与逐字证据
  → 按服务端 scope 校验
  → 无冲突新增自动发布
  → 冲突/修订/合并逐条确认
  → 从已确认记忆重建概览与 Observation
  → 来源变更时基于 epoch 标记过期或重建
```

### 11.2 应当规避

- 不把 Hindsight 直接变成 WorkPivot 的第二个事实数据库。当前 PostgreSQL 记忆、来源、权限、
  修订和确认流仍是权威数据源。
- 不让模型自行选择 bank、项目或个人 scope；范围必须由服务端授权上下文决定。
- 不把 Observation 或 Knowledge Page 当作不可质疑的真相，也不把它们变成系统指令。
- 不在每次聊天中异步写入全部转录并立即重新提取；需要游标、去重、幂等和成本上限。
- 不把自动召回的失败表现为聊天失败，也不让旧记忆覆盖用户当前明确要求。
- 不复刻高级插件的快照墓碑、双挂载合并和前置拒绝门，除非 WorkPivot 先证明有相同问题。
- 不把被注入的记忆再次写回 bank，避免 `retain → recall → retain` 闭环放大。
- 不因开源就复制代码；核心、官方接入和社区插件都是 MIT，但本项目仍应独立实现数据模型和测试。

### 11.3 差异化机会

Hindsight 解决“如何记得更多、更强”，WorkPivot 已有机会解决“哪些记忆有资格进入企业工作、为何
进入、何时失效、谁能看见”。因此差异化应放在：

1. 用户确认与来源证据统一，而不是只比召回命中率。
2. user/project/task 作用域和项目 RLS 强一致。
3. 记忆概览、原始来源、修订历史和遗忘形成同一条可审计链路。
4. 记忆只影响上下文，不影响任务授权、文件权限和执行策略。
5. 中文办公事实、时间口径、项目决策和成果引用可一起追溯。

### 11.4 与当前架构的兼容判断

| Hindsight 模式 | WorkPivot 当前基础 | 建议 |
| --- | --- | --- |
| 严格 bank 隔离 | 用户、项目、任务作用域与 PostgreSQL RLS | 保留服务端授权，不引入第二套主权限 |
| fact / experience / observation | 已确认记忆、证据和专家经验 | 增加形态字段与派生关系，不重做 scope |
| Knowledge Page | `memory_overviews` 设计 | 优先实现，绑定 revision/epoch 与 freshness |
| 四路混合检索 | 文档已有混合检索经验 | 记忆先做关键词+向量+时间，验证后再扩展 |
| 自动写回 | memory worker/analysis + outbox | 增加游标、空闲触发和失败可观测，保留确认规则 |
| 自动召回 | 当前以概览和工具读取为主 | 增加有界预取/召回，但保留关闭开关和跳过逻辑 |

## 12. 许可与复用边界

- **Hindsight 核心**：MIT。可以研究并在保留版权和许可声明的前提下复用；数据库、模型服务和
  运维依赖仍需另行评估。
- **Hindsight coding-agents**：MIT；它是 Hindsight 官方仓库的一部分。
- **`dsh-hindsight`**：`package.json` 声明 MIT，仓库声明包含 LICENSE。
- **`dsh-hindsight-advanced`**：`package.json` 声明 MIT，但固定 commit 下未观察到独立的
  `LICENSE` 文件；若未来复用其代码，应先向作者确认完整许可文本并做依赖审查。
- 本文只复用公开设计思想，不复制上述仓库的实现代码、Skill 文本、品牌素材或私有数据。
- 本节不是法律意见；正式集成前应重新核对固定版本的许可证、NOTICE 和第三方依赖。

## 13. 证据

| 结论 | 证据 | 类型 | 日期 |
| --- | --- | --- | --- |
| Hindsight 定义世界事实、经验、Observation 和 Mental Model | 核心 README、`engine/reflect/observations.py` | 官方文档/源码 | 2026-10-28 |
| `retain` 提取事实、实体、关系、时间和来源 | `engine/retain/fact_extraction.py`、官方 Retain 文档 | 源码/官方文档 | 2026-10-28 |
| `recall` 组合语义、BM25、图和时间路径 | `engine/search/retrieval.py`、官方 Retrieval 文档 | 源码/官方文档 | 2026-10-28 |
| 使用 RRF 融合和 cross-encoder 重排 | `engine/search/fusion.py`、`engine/search/reranking.py` | 源码 | 2026-10-28 |
| Observation 保存精确引文证据、时间趋势和 proof count | `engine/reflect/observations.py`、官方 Observations 文档 | 源码/官方文档 | 2026-10-28 |
| Mental Model 读取是数据库读取，后台刷新 | 官方 Mental Models 文档、`engine/reflect/agent.py` | 官方文档/源码 | 2026-10-28 |
| Hindsight 官方 coding-agents 支持 DSH native 插件 | `hindsight-integrations/coding-agents/src/dsh.ts`、README、`cordis.patch.yml` | 官方源码 | 2026-10-28 |
| 官方 DSH 接入按工作区解析 bank，并跳过子 Agent 自动召回/写入 | `src/dsh.ts` | 官方源码 | 2026-10-28 |
| 轻量插件提供显式工具、缓存、超时和异步状态 | `dsh-hindsight` README、`src/tools.ts`、`src/cache.ts` | 第三方源码 | 2026-10-28 |
| 高级插件提供预取、召回超时、有界快照和上下文预算 | `src/autorecall.ts`、`src/config.ts`、`src/snapshot.ts` | 第三方源码 | 2026-10-28 |
| 高级插件强绑定特定 DSH commit | 高级插件 README | 第三方文档 | 2026-10-28 |
| 本轮未做 DSH + Hindsight 端到端运行 | 研究环境未安装该插件；仅固定源码和文档 | 研究限制 | 2026-10-28 |

## 14. 参考链接

- [Hindsight 源仓库](https://github.com/vectorize-io/hindsight)
- [Hindsight 官方文档](https://hindsight.vectorize.io)
- [Retain](https://hindsight.vectorize.io/developer/retain)
- [Retrieval / Recall](https://hindsight.vectorize.io/developer/retrieval)
- [Observations](https://hindsight.vectorize.io/developer/observations)
- [Mental Models](https://hindsight.vectorize.io/developer/mental-models)
- [Knowledge Pages](https://hindsight.vectorize.io/developer/knowledge-pages)
- [Hindsight coding-agents](https://hindsight.vectorize.io/sdks/integrations/coding-agents)
- [轻量插件 dsh-hindsight](https://github.com/Ryu6Zero/dsh-hindsight)
- [高级插件 dsh-hindsight-advanced](https://github.com/paulalesius/dsh-hindsight-advanced)
- [DeepSeek Harness 主卡](deepseek-harness.md)

## 15. 变更记录

| 日期 | 变化 |
| --- | --- |
| 2026-10-28 | 初版：核对 Hindsight 核心、官方 DSH 接入和两个社区插件；完成 WorkPivot 取舍分析 |
