# 产品研究

~~项目当前阶段的工作重心。~~ **研究阶段已收官（2026-08-28）**：竞品与技术选型完成、结论汇总落盘，正式进入设计阶段（`../02-design/`）。本目录转为存档与补充调研入口。

## 研究计划

| # | 方向 | 目录 | 核心问题 | 优先级 | 状态 |
|---|------|------|----------|--------|------|
| 1 | 竞品分析 | `competitors/` | WorkBuddy 等标杆产品的功能、架构、商业模式是什么？我们学什么、避什么？ | 🔴 高 | ✅ 已完成（9 个产品/项目，13 份文档；钉钉AI/Coze/Copilot 按需补充） |
| 2 | 技术调研 | `tech/` | 后端技术栈、桌面端框架（Electron/Tauri）、LLM 编排、RAG、私有化部署方案如何选型？ | 🔴 高 | ✅ 已完成（TECH-01/02 定案；后端栈随全栈 TS 定案关闭） |
| 2a | Cordis 动态插件架构 | `tech/` | DeepSeek Harness 实证分析；**最终结论：移出技术栈**——技能热加载自研（目录扫描），内核自研微内核；Cordis 留作 D09 二期候选 | 🟡 中 | ✅ 已闭环：[01-cordis-动态插件架构.md](tech/01-cordis-动态插件架构.md) |
| 2b | 桌面端框架选型 | `tech/` | Electron vs Tauri v2：基于 MyAgents(Tauri/95MB) 与 WorkBuddy+OWB(Electron/500MB) 三产品实测对照 | 🔴 高 | ✅ **已定 Electron**（形态 A 起步→A' 演进）：[02-桌面端框架选型.md](tech/02-桌面端框架选型.md) |
| 3 | 市场调研 | `market/` | 目标客群是谁？市场规模多大？私有化交付的竞争格局如何？ | 🟡 中 | ⬜ 未开始（画像假设已写入结论汇总 §3，随种子客户接触补充） |
| 4 | 用户调研 | `users/` | 企业用户现有的办公/AI 使用场景与痛点是什么？愿意为什么付费？ | 🟡 中 | ⬜ 未开始 |
| 5 | 结论汇总 | `conclusions/` | 汇总以上研究，形成产品定位与技术路线的初步决策建议 | 🔴 高 | ✅ [研究结论汇总.md](conclusions/研究结论汇总.md) |

> 状态图例：⬜ 未开始 / 🔄 进行中 / ✅ 已完成

## 竞品清单（初步）

| 竞品 | 类型 | 分析文档 |
|------|------|----------|
| WorkBuddy（腾讯） | 企业 AI 智能体工作台，最直接对标 | 产品分析：[workbuddy.md](competitors/workbuddy.md) ✅ 初稿<br>技术拆解（本机逆向）：[workbuddy-technical-analysis.md](competitors/workbuddy-technical-analysis.md) ✅<br>扩展系统专项（专家/技能/连接器/插件动态加载）：[workbuddy-extension-system.md](competitors/workbuddy-extension-system.md) ✅<br>官方文档纪要（功能/流程/企业版定价/私有化）：[workbuddy-official-docs.md](competitors/workbuddy-official-docs.md) ✅ |
| 千问办公 QwenWorkCN（阿里） | 大厂桌面 AI 工作台（钉钉/Qoder 团队，Electron + VM 沙箱 + AgentSkills 技能生态 + agent CLI），与钉钉 AI 助理同厂不同形态 | 本机逆向 + 工作区实测：[qwenwork.md](competitors/qwenwork.md) ✅ |
| 钉钉 AI 助理 | IM + AI 助理生态 | ⬜ 待补充 |
| 飞书智能伙伴 | 协同办公 + AI | ⬜ 待补充 |
| Coze（扣子） | Agent 构建平台 | ⬜ 待补充 |
| Microsoft 365 Copilot | 国际标杆，办公套件 + AI | ⬜ 待补充 |
| MyAgents（开源） | **开源参考实现**：Tauri v2 + Claude Agent SDK 桌面个人 Agent 工作台（AGPL）——桌面端技术选型与架构参考 | 源码级分析：[myagents.md](competitors/myagents.md) ✅ |
| OpenWorkBuddy（开源） | **WorkBuddy 的极简开源复刻**（纯手写 agent 循环 + 评测驱动开发）——agent 工程经验宝库；PolyForm 非商业许可，只学思想不抄码 | 源码级分析：[openworkbuddy.md](competitors/openworkbuddy.md) ✅ |
| OpenClaw（开源） | **个人 AI 助理框架，记忆/人设/插件格式的事实标准源头**（WorkBuddy/MyAgents 均对齐）——Gateway 架构、Dreaming 记忆固化、pi 运行时；MIT | 源码级分析：[openclaw.md](competitors/openclaw.md) ✅ |
| Hermes Agent（开源） | **自改进智能体**（Nous Research，Python/MIT）——技能自动生成四层闭环（工具策略/nudge/Curator 治理/状态机） | 源码级分析：[hermes.md](competitors/hermes.md) ✅ |
| Pi Agent Harness（开源） | **极简自扩展内核**（7 内置工具 + jiti 动态加载 TS 扩展）——OpenClaw 运行时、OWB 压缩设计的源头；引用链终点 | 源码级分析：[pi-agent.md](competitors/pi-agent.md) ✅ |
| OpenAI Codex CLI（开源） | **OpenAI 官方编程 agent**（Rust 160 万行，Apache-2.0）——工具面收缩/压缩工程/审批沙箱四层模型的顶配参考实现；可合法复用设计件但 Rust 代码不复用，且不收外部 PR | 源码级分析：[codex.md](competitors/codex.md) ✅ |
| Claude Code（Anthropic） | **闭源核心 + 开源卫星**——SKILL.md 格式与内容生态的事实标准源头：headless 集成蓝图（MIT）、岗位技能包范式（Apache-2.0，212 领域技能）；⚠️ 核心 npm 与文档四件套技能 Proprietary 不可复用，H 模块必须自研。另：2026-03-31 泄露源码已做完整源码级分析（仅供研究，K05 红线） | 生态分析（四仓库实测）：[claude-code.md](competitors/claude-code.md) ✅<br>泄露源码级分析（51.2 万行 ground truth）：[claude-code-internals.md](competitors/claude-code-internals.md) ✅ |

新建竞品分析请复制 [competitors/_template.md](competitors/_template.md)。

### 2026-10-14 WorkBuddy 补充复核

- [REA：Agent 运行与项目记忆复核](competitors/workbuddy-rea-20261014.md)：当前安装包身份、桌面到 CLI 的进程生命周期、ACP 流式协议、会话状态、REA 覆盖限制及历史结论修正。
- [CLI Agent 内核与记忆触发](competitors/workbuddy-agent-runtime-20261014.md)：模型/工具编排、压缩取消、子代理与记忆触发的静态证据及缺口。
- [项目本地记忆实证](competitors/workbuddy-local-memory-20261014.md)：中新融创项目的长期文件、43 份日期日志、脱敏结构与完整文件哈希清单。

本次为安装产物静态分析和项目文件快照，未执行目标程序或验证真实会话；原研究收官状态不代表这些动态问题已经验收。

## 技术调研课题（初步）

1. **后端技术栈选型**：Java/Spring Boot vs Python/FastAPI vs Node.js/NestJS vs 混合架构
2. **桌面端框架**：Electron vs Tauri（桌面端已确定为必有形态）
3. **LLM 接入与编排**：多模型网关、Agent 编排框架（自研 vs LangGraph 等开源方案）
4. **RAG 与企业知识库**：向量库选型、文档解析、权限隔离
5. **私有化部署**：Docker/K8s 交付形态、离线安装、模型私有化（是否支持内网无外联环境）

新建技术调研请复制 [tech/_template.md](tech/_template.md)。

## 产出要求

- 所有研究文档须注明信息来源（链接/访谈对象/日期），保证可追溯
- 每完成一项研究，更新本页状态表
- 最终在 `conclusions/` 产出《研究结论汇总》，包含：产品定位建议、目标客户画像、功能范围建议（MVP）、技术路线建议、风险清单
