# 开源项目分析：Hermes Agent（Nous Research——自改进智能体与技能自动生成）

> 分析方式：源码级分析（E:\project\hermes，Python）+ README/文档精读。重点回应两个问题：**① skill 自动生成的技术实现；② 与 DeepSeek Harness 的关系**。
> 姊妹文档：[01-cordis-动态插件架构.md](../tech/01-cordis-动态插件架构.md)（dsh 的 agent 生成**代码插件**路线）、[openclaw.md](openclaw.md)（hermes 提供 `hermes claw migrate` 从 OpenClaw 迁移，同生态位）。

- **分析人**：ZCode
- **日期**：2026-08-28

> 2026-10-16 补充：下文保留历史分析，不代表当前 main 的全部默认行为。本轮补核了官方[技能文档](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/skills.md)及[管理工具](https://github.com/NousResearch/hermes-agent/blob/main/tools/skill_manager_tool.py)：默认技能目录为 `~/.hermes/skills/`，支持按需读取；写审批是可选配置，不能将下文的用户确认描述理解为所有当前安装均强制审批。WorkPivot 已确认采用对话沉淀与修订闭环，但强制应用弹窗确认、私人隔离、数据库不可变版本和软删除恢复，具体采用边界及验收见[对话 Skill 与基础定时任务设计](../../02-design/architecture/对话搭建Skill与基础定时任务.md)，统一排期见[主计划](../../02-design/architecture/单用户正式发布补强方案.md)。这些均为设计，尚未实现；本轮未复验历史 Curator、提醒间隔等其余细节。

---

## 1. 项目身份

| 项 | 值 |
|----|-----|
| 定位 | **自改进（self-improving）AI Agent**（Nous Research）：「唯一内置学习闭环的 agent——从经验创建技能、使用中改进技能、周期性提醒自己沉淀知识、检索自己的历史会话、跨会话深化用户模型」 |
| 许可 | **MIT** |
| 语言 | **Python 3.11**（单进程 agent 内核 + gateway，无 Electron/前端框架，TUI + Web Dashboard） |
| 模型 | 任意供应商：Nous Portal / OpenRouter / NVIDIA NIM / MiMo / GLM / Kimi / MiniMax / HF / OpenAI / 自建端点，`hermes model` 热切换 |
| 通道 | 单 gateway 进程：Telegram / Discord / Slack / WhatsApp / Signal / Email / CLI |
| 终端后端 | **7 种**：local / Docker / SSH / Singularity / Modal / Daytona / Vercel Sandbox（serverless 休眠，闲时近零成本） |
| 技能标准 | 兼容 **agentskills.io** 开放标准（SKILL.md 格式，与 Claude/WorkBuddy/OpenClaw 同构） |
| 版本节奏 | v0.2→v0.13 半年 12 个大版本（RELEASE_*.md 每版 3-6 万字说明，工程活跃） |

## 2. 总体架构

```
单进程 Python Agent（run_agent.py ~15000 行，核心 Agent 类）
 ├─ 主循环：迭代计数器驱动的 nudge 逻辑（memory/skill 两种）
 ├─ 工具注册表（40+ 工具）：skills / memory / terminal(7后端) / files / web / MCP / cron…
 ├─ 上下文引擎：context_engine + compressor + references + prompt_caching
 ├─ 记忆：memory_manager（FTS5 会话搜索 + LLM 摘要跨会话召回 + Honcho 用户建模）
 ├─ Curator（agent/curator.py）：后台技能策展人
 ├─ Gateway（gateway/）：多通道消息进出
 ├─ ACP 适配器（acp_adapter/）：把 Hermes 暴露为 ACP 服务端（编辑器等 ACP 客户端可接入）
 ├─ Skills Hub（tools/skills_hub.py）：技能注册表（GitHub 源/PAT/gh CLI/GitHub App 认证，
 │   provenance lock、隔离区、审计日志、taps——类 Homebrew 的技能包管理）
 └─ RL 就绪：batch_runner（轨迹批量生成）/ trajectory_compressor / Atropos 环境
```

## 3. 重点一：技能自动生成的完整闭环（本项目最值得学的部分）

Hermes 的「自改进」不是单一工具，而是**四层机制咬合的闭环**：

### 3.1 工具层：`skill_manage`（tools/skill_manager_tool.py）

模型面工具，动作集：`create / patch（old_string→new_string，修复首选）/ edit（全量重写，仅大改）/ delete / write_file / remove_file`。**工具描述本身就是策略文档**（编码进 prompt 的行为准则）：

- **何时创建**：复杂任务成功（5+ 次工具调用）、克服了报错、用户纠正后的方法有效、发现非平凡工作流、用户要求记住流程
- **何时修补**：指令过时/出错、OS 特定失败、使用中发现缺失步骤或坑——「**用了技能且遇到它没覆盖的问题，立即 patch**」
- **好技能的形状**：触发条件、带精确命令的编号步骤、坑列表、验证步骤
- 删除时须传 `absorbed_into=<伞技能名>`（合并）或 `""`（纯修剪）——**让策展人无需猜测就能区分合并与修剪**，下游（引用旧技能名的 cron 任务等）可正确改写

安全与校验（同文件实现）：`skills.guard_agent_created` 配置闸（默认关）、写入后 `_security_scan_skill` 安全扫描、`_pinned_guard`（钉住的技能拒删可改——「pin 只防不可恢复的丢失，不妨碍持续改进」）、名称/分类/frontmatter/内容尺寸校验、辅助文件限定在 references/templates/scripts/assets/ 下。

### 3.2 触发层：双通道触发

1. **任务后自主判断**：靠工具描述里的策略（3.1）——模型在成功完成复杂任务后主动提议存为技能（「Confirm with user before creating/deleting」）
2. **周期性 nudge 提醒**（run_agent.py）：`_skill_nudge_interval`（默认 **10 次迭代**，`skills.creation_nudge_interval` 可配）——主循环里 `_iters_since_skill` 计数，达阈值置 `_should_review_skills` 注入提醒；**技能/记忆工具实际被使用时计数器归零**；跨会话从持久化历史重建计数（避免重启后提前或永不触发）。记忆侧有对称的 `_memory_nudge_interval`

### 3.3 治理层：Curator 策展人（agent/curator.py，1700+ 行）

后台定期运行的「技能评审官」：

- **调度**：`interval_hours` 定期 + `min_idle_hours`（用户空闲才跑）+ `is_paused` 开关
- **自动状态迁移**：`apply_automatic_transitions`——按使用锚点（最近使用时间）判定 active → stale（超 `stale_after_days`）→ archived（超 `archive_after_days`），支持 dry_run
- **LLM 评审**：`run_curator_review` fork 一个**独立 review agent**（`_memory_nudge_interval=0`、`_skill_nudge_interval=0` 关闭其自身 nudge、`suppress_status_output` 防评审过程噪音泄漏给用户）评审技能集，产出**结构化结论**：建议合并/重命名/归档的候选清单
- **可解释性**：每次运行写 markdown 报告（状态迁移记录、重命名摘要、候选清单）；`_classify_removed_skills` 结合 `absorbed_into` 声明做分类对账
- CLI：`hermes curator unpin <name>` 等管理命令

### 3.4 状态与溯源层

- **状态机**（tools/skill_usage.py）：`active ↔ stale ↔ archived`，使用记录驱动
- **Skills Hub 溯源**：HubLockFile 记录每个已装技能的来源（GitHub repo/官方 optional/本地），**quarantine 隔离区 + audit log + taps**（类 Homebrew 的第三方源）——企业内分发技能包时 provenance 是审计刚需

### 3.5 闭环全景

```
任务执行 ──成功(5+调用/踩坑/纠正)──► agent 提议 ──用户确认──► skill_manage create
   ▲                                                            │
   │ 10 次迭代 nudge「该回顾技能了」                                  ▼
   │                                                    使用中遇坑 → patch（立即）
   │                                                            │
   └── 技能进 system prompt（技能=程序性记忆）◄── Curator 定期治理 ◄──┘
                                              （stale/archive/合并/重命名，报告留痕）
```

## 4. 学习闭环的其余部分

- **记忆 nudge**：与技能对称的 `_memory_nudge_interval`（默认 10 轮）——「周期性提醒自己把该记的东西写盘」（agent-curated memory，与 OpenClaw 的 Dreaming 同思路，但由主循环内联而非独立相位）
- **跨会话召回**：FTS5（SQLite 全文索引）检索历史会话 + LLM 摘要化——与会话原始转写分离的「可检索层」
- **用户建模**：集成 Honcho（plastic-labs）dialectic 用户模型——第三方记忆后端可插拔（memory_provider.py）
- **子代理与 RPC 脚本**：spawn 隔离子代理并行工作流；**「写 Python 脚本经 RPC 调工具，把多步流水线折叠为零上下文成本的单一 turn」**——与 dsh 的 agent 写代码插件异曲同工，但落点在省上下文

## 5. 与 DeepSeek Harness 的关系（澄清）

**代码级关联：无**（全库 grep 无 deepseek-harness/dsh 引用；无共同依赖）。真实关系是三条：

1. **同一问题的两条路线**：dsh 用 `cordis_define` 让 agent 动态生成**代码插件**（node:vm 沙箱+浏览器半，能力上限高、安全要求高）；Hermes 用 `skill_manage` 让 agent 动态生成**知识技能**（SKILL.md，纯文本、可 diff、可人工审、安全面小）——**知识沉淀走技能、能力扩展走插件**是两个正交且可并存的维度
2. **共享开放标准**：双方都支持 ACP（Hermes `agent-client-protocol==0.9.0` 且有 acp_adapter 服务端；dsh 有 acp 包）；技能均为 SKILL.md/agentskills.io 系
3. **生态位相邻**：Hermes 提供 `hermes claw migrate`（从 OpenClaw 迁移用户数据），与 OpenClaw/dsh 同属「个人 agent 运行时」赛道；Nous 与 DeepSeek 均为模型厂商自证 agent 能力的官方作品

## 6. 其他工程亮点

- **7 种终端后端**（local/Docker/SSH/Singularity/Modal/Daytona/Vercel Sandbox）：执行环境作为可替换维度，serverless 休眠省钱——私有化/云端混布的执行层参考
- **Windows 原生 beta**：PowerShell 一键装（uv+Python3.11+Node+ripgrep+ffmpeg+**便携 MinGit**，免管理员、与系统 Git 隔离）——Windows 私有化交付的安装器范本
- **RL 就绪**：批量轨迹生成 + 轨迹压缩 + Atropos 环境——「agent 日志 → 训练数据」的通路内置
- 发布纪律：每版本 RELEASE 文档 3-6 万字；AGENTS.md 46KB（贡献者/agent 共用规范）

## 7. 对 WorkPivot 的启示

1. **技能生命周期治理直接采纳**（需求清单 D01/D02/D05）：`skill_manage` 的动作集与**策略编码进工具描述**的做法、`absorbed_into` 的合并/修剪语义、pinned 防删可改、写入后安全扫描——四件套可整体搬进我们的技能系统设计
2. **nudge 计数器模式**（F 模块）：「N 次迭代提醒一次 + 工具实际使用即归零 + 跨会话重建计数」是实现「agent 自我沉淀」的最轻机制（十几行代码），MVP 即可携带
3. **Curator 独立评审代理**：fork 子代理时**关闭其自身的 nudge/状态输出**的细节、定期+空闲调度、结构化产出+markdown 报告——对应我们 E04 记忆托管维护与 D05 市场治理
4. **知识技能 vs 代码插件分层**：结合 TECH-01 结论——WorkPivot 的自改进体系应双轨：SKILL.md 知识技能（低风险、MVP 可做 agent 自动生成）+ Cordis 代码插件（高风险、二期带审批），Hermes 证明了前者单独已有巨大价值
5. **Skills Hub 的 provenance/quarantine/audit 设计**：企业内技能分发的审计三要素
6. **Python 生态实证**：Hermes 证明纯 Python 可承载生产级个人 agent（1.5 万行主循环单进程）——后端栈选型（Java vs Python vs Node）讨论中，Python 路线的工程风险有了实际参照；但其单文件巨类的组织方式是反面教材，勿学

## 8. 待深挖项

- [ ] `agent/context_engine.py` 上下文组装与 prompt_caching 策略
- [ ] Honcho 用户建模的集成方式（memory_provider 抽象）
- [ ] `hermes claw migrate` 的字段映射（OpenClaw → Hermes，我们做导入器时可参考）
- [ ] trajectory_compressor 的压缩格式（若 WorkPivot 未来做 RL/蒸馏）

## 附：快速验证路径（本机）

| 想看什么 | 去哪里 |
|----------|--------|
| 技能管理工具与策略全文 | `tools/skill_manager_tool.py`（798-915 行为 schema） |
| nudge 计数器 | `run_agent.py`（搜索 `_skill_nudge_interval`，12175/15493 行附近） |
| Curator 策展人 | `agent/curator.py`（状态迁移 256 行起、评审 1369 行起） |
| 技能状态机与使用记录 | `tools/skill_usage.py` |
| Skills Hub（源/溯源/隔离） | `tools/skills_hub.py` |
| 内置技能库（分类组织） | `skills/`（apple/creative/data-science/devops/domain/email/gaming/dogfood…） |
| 中文 README | `README.zh-CN.md` |
