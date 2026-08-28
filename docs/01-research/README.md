# 产品研究

项目当前阶段的工作重心。研究结论是后续设计阶段（`../02-design/`）的唯一输入，**结论汇总完成前不启动设计**。

## 研究计划

| # | 方向 | 目录 | 核心问题 | 优先级 | 状态 |
|---|------|------|----------|--------|------|
| 1 | 竞品分析 | `competitors/` | WorkBuddy 等标杆产品的功能、架构、商业模式是什么？我们学什么、避什么？ | 🔴 高 | 🔄 进行中 |
| 2 | 技术调研 | `tech/` | 后端技术栈、桌面端框架（Electron/Tauri）、LLM 编排、RAG、私有化部署方案如何选型？ | 🔴 高 | 🔄 进行中 |
| 2a | Cordis 动态插件架构 | `tech/` | DeepSeek Harness 实证：插件/技能动态生成+热加载+页面状态（MIT 可用）；编排内核选型首选候选 | 🔴 高 | ✅ [01-cordis-动态插件架构.md](tech/01-cordis-动态插件架构.md) |
| 3 | 市场调研 | `market/` | 目标客群是谁？市场规模多大？私有化交付的竞争格局如何？ | 🟡 中 | ⬜ 未开始 |
| 4 | 用户调研 | `users/` | 企业用户现有的办公/AI 使用场景与痛点是什么？愿意为什么付费？ | 🟡 中 | ⬜ 未开始 |
| 5 | 结论汇总 | `conclusions/` | 汇总以上研究，形成产品定位与技术路线的初步决策建议 | 🔴 高 | ⬜ 未开始 |

> 状态图例：⬜ 未开始 / 🔄 进行中 / ✅ 已完成

## 竞品清单（初步）

| 竞品 | 类型 | 分析文档 |
|------|------|----------|
| WorkBuddy（腾讯） | 企业 AI 智能体工作台，最直接对标 | 产品分析：[workbuddy.md](competitors/workbuddy.md) ✅ 初稿<br>技术拆解（本机逆向）：[workbuddy-technical-analysis.md](competitors/workbuddy-technical-analysis.md) ✅<br>扩展系统专项（专家/技能/连接器/插件动态加载）：[workbuddy-extension-system.md](competitors/workbuddy-extension-system.md) ✅<br>官方文档纪要（功能/流程/企业版定价/私有化）：[workbuddy-official-docs.md](competitors/workbuddy-official-docs.md) ✅ |
| 钉钉 AI 助理 | IM + AI 助理生态 | ⬜ 待补充 |
| 飞书智能伙伴 | 协同办公 + AI | ⬜ 待补充 |
| Coze（扣子） | Agent 构建平台 | ⬜ 待补充 |
| Microsoft 365 Copilot | 国际标杆，办公套件 + AI | ⬜ 待补充 |
| MyAgents（开源） | **开源参考实现**：Tauri v2 + Claude Agent SDK 桌面个人 Agent 工作台（AGPL）——桌面端技术选型与架构参考 | 源码级分析：[myagents.md](competitors/myagents.md) ✅ |
| OpenWorkBuddy（开源） | **WorkBuddy 的极简开源复刻**（纯手写 agent 循环 + 评测驱动开发）——agent 工程经验宝库；PolyForm 非商业许可，只学思想不抄码 | 源码级分析：[openworkbuddy.md](competitors/openworkbuddy.md) ✅ |
| OpenClaw（开源） | **个人 AI 助理框架，记忆/人设/插件格式的事实标准源头**（WorkBuddy/MyAgents 均对齐）——Gateway 架构、Dreaming 记忆固化、pi 运行时；MIT | 源码级分析：[openclaw.md](competitors/openclaw.md) ✅ |

新建竞品分析请复制 [competitors/_template.md](competitors/_template.md)。

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
