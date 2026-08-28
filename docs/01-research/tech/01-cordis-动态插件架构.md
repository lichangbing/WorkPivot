# 技术调研 01：Cordis 动态插件架构（DeepSeek Harness 实证）

> 使用说明：按 [_template.md](_template.md) 结构整理。调研对象为 `E:\project\deepseek-harness`（DeepSeek 官方开源 Agent Harness，本地源码级分析 + 项目文档精读）。
> 结论状态：🔄 **已有倾向**——建议 WorkPivot 编排内核采用 Cordis（或其核心模式），待 PoC 验证后落 ADR。

- **调研人**：ZCode
- **日期**：2026-08-28
- **课题编号**：TECH-01（对应需求清单 D 模块「扩展体系」与 C05「多 Runtime 抽象」）

---

## 1. 背景与目标

- **为什么调研**：WorkPivot 的产品定位是「支撑不同企业的智能化应用」，需求清单 D 模块要求技能/插件/专家动态加载、热更新、企业自定义扩展。WorkBuddy 的插件体系（文件清单+市场+版本缓存）解决了**分发**问题，但代码级能力扩展仍是静态的（product.*.json 构建期裁剪）。用户指出 DeepSeek Harness 用 Cordis 实现了「插件/skill 动态生成、热加载、页面状态动态注入」——若成立，这直接决定我们扩展内核的选型。
- **决策截止**：架构设计（ADR-001/002）前；阻塞 `code/` 工程骨架搭建。

## 2. 调研对象身份

| 项 | 值 |
|----|-----|
| 项目 | **DeepSeek Harness（dsh）**，DeepSeek AI 官方开源 agent harness（developer preview，v0.1.1-rc.2） |
| 许可 | **MIT**（dsh 与 vendored cordis 均为 MIT——可与 AGPL 的 MyAgents、PolyForm 的 OpenWorkBuddy 区分开：**这个可以真正用代码**） |
| 架构理念 | **「一切皆插件」**：模型适配器、工具注册表、会话日志、agent 循环本身都是插件，全部可从配置替换 |
| 核心框架 | **Cordis v4.0.1**（vendored，源自 cordiverse/cordis，Koishi 框架作者作品，配套论文《A Programming Paradigm for Spatiotemporal Composability》） |
| 技术栈 | TypeScript / pnpm monorepo（50+ 包）/ Node 22+ / host+client 双面架构 / native landlock-run（Linux 沙箱） |
| 产业验证 | 腾讯 CodeBuddy CLI 的 Cell 框架（`@celljs/*`，WorkBuddy 内嵌运行时）同样构建于 Cordis 生态——**两大厂商同选型** |

## 3. Cordis 核心机制（五个概念，源码+文档实证）

1. **插件即 Service**：函数或 Service 子类，带 `apply(ctx)` 生命周期
2. **上下文即服务仓库**：服务认领稳定键（`ctx.tools`/`ctx.llm`/`ctx.sessions`），其他插件按键查找而非 import 具体实现
3. **`inject` 声明依赖**：声明所需服务的插件会等到服务就绪——**加载顺序由服务需求表达，不需要手工编排启动序列**
4. **类型化事件，四种派发模式**（模式是事件公开契约的一部分）：
   | 模式 | 是否等待 | 顺序 | 返回值 |
   |------|---------|------|--------|
   | `emit` | 否 | 注册序 | 无（观察） |
   | `waterfall` | 否 | 注册序 | 有（环绕中间件，`next()` 委托/短路） |
   | `parallel` | 是 | 并行 | 无 |
   | `serial` | 是 | 注册序 | 有 |
5. **注册即可逆效应（本次调研最重要发现）**：提示词段、工具 schema、适配器、监听器全部经 `ctx.effect()`/`ctx.on()` 安装并返回 disposer——**卸载/热重载时按预期顺序自动回滚**。「每个注册都应有清理器」是框架纪律

## 4. dsh 对 Cordis 的工程化运用

### 4.1 Profiles / Bundles / Patch：运行时形态组合（对标我们的私有化裁剪）

- **Profile** = 命名组合（存于 Harness home），声明堆叠的 bundles + 自有 `cordis.patch.yml`；`web`/`headless` 作为模板发行
- **Bundle** = Cordis 配置行+代码的分发格式；`dsh-base`（模型适配/工具/持久化/沙箱/审批/设置/凭据）→ `dsh-web-app`（浏览器应用）/ `dsh-headless`（无服务器一次性运行）
- **层序应用**：profile 列出的 bundles → profile patch → home 级 patch → `--patch` 覆盖；patch 按 id 整行替换或插入新行；`dsh --dump-config` 可查看实际启动树
- **对照**：WorkBuddy 用 product.*.json 在**构建期**裁剪四种形态；dsh 用 profile/bundle 在**运行期**组合——我们的私有化/SaaS 形态裁剪可以两者结合（构建期裁剪默认形态 + 运行期 patch 企业定制）

### 4.2 Capability Seams：能力接缝（Definition/Provider/Consumer 三角色）

- 一个能力 = Service Definition（接口）+ Provider（实现）+ Consumer（通常是模型面工具）
- 精髓案例：**文件系统和子进程共享同一执行世界**——把 provider 指向远程沙箱，Bash/PTY/LSP 工具**整体迁移**，无 provider 分叉。对我们私有化场景的「本地执行 ↔ 集中沙箱」演进路径极有价值
- Subagent 也是 seam：从子 agent 到「委派给另一个产品的 turn」都藏在同一接口后（与 MyAgents 的多 Runtime 抽象异曲同工，但更彻底）

### 4.3 会话日志不变量：「模型可见即已记录」

`deriveMessages()` 从 append-only SessionEvent log 投影模型历史；任何进入模型请求的内容必须可从日志重建（运行时断言强制）——**新增模型可见输入必须新增会话事件**。Fork/resume/转录/遥测全部从这条流派生。这是我们 F01（转写持久化）的更强表述，建议直接采纳为 WorkPivot 不变量。

### 4.4 Skill 体系（D01 需求的直接参考实现）

- `ctx.skills` 纯注册表 + **Provider 模式**（本地文件系统只是其中一个 provider；HTTP/嵌入数据源均可注册）
- host + per-scope 分层：全局层与 agent preset 层叠加，重名按「最近层胜出」
- 目录优化：每个 `agent/pre-step` 做快照，目录消息只含 `name/description`（正文/路径/来源不进目录），**基于 durable digest 判断是否需要重发目录**——比 WorkBuddy 的全量技能注入更省 token

### 4.5 自指工具集 tool-cordis：agent 动态生成插件 + 页面状态（用户点名的核心能力）

五个模型面工具操作**当前进程的活运行时**：

- `cordis_inspect`：只读报告当前进程的服务、插件纤维（fiber）、已注册工具、`api`/`events` 契约、`client` 插槽——**agent 先读运行时再写扩展**
- `cordis_define`：定义「**双半插件包**」——宿主半 `code` + 浏览器半 `client`，双侧先语法编译检查（不运行），铸 `dyn-<n>` id，对话中出卡片待用户点「启动」——**定义即登记，不产生副作用**
- `cordis_run`/retract：
  - 宿主半在 `node:vm` 沙箱内、`cordis-dynamic` 组 fiber 下求值
  - 浏览器半作为 async 闭包在页面执行（参数为符号面：React/console/styles/host + 教学陷阱遮蔽 setTimeout/fetch/require）；`apply` 收到**白名单代理**——只有插件自己 `inject` 声明的服务可达，`slots` 插槽注册即遮蔽（最新运行优先）
  - 带 `client` 半的运行需**真人审批**（frame 级全局面板，跨会话可达——审批可达性专门设计）
- **这就是「插件/skill 动态生成+加载+页面状态」的完整实现**：agent 写的插件可以同时贡献后端行为和页面 UI（通过 `slots` 插槽 + keyed renderer），卸载自动回滚

### 4.6 双面（host/client）架构与页面状态

- 宿主（Node，cordis）与浏览器（client，**同样是 cordis 插件**：ui-renderer 把 slot 数据绑定到 React、connection 维护 RPC、modules 加载客户端模块、**hmr 开发期热刷新客户端插件**）
- Web UI 的会话节点 = 注册 `ConversationNodeDefinition` + keyed renderer——UI 扩展点与后端扩展点同构
- 对 WorkPivot 桌面端的意义：client half 概念可映射到桌面 WebView（Tauri/Electron 均适用），「插件同时带后端半+界面半」的模式比纯文件清单插件（WorkBuddy）强一代

## 5. 可借鉴点评估（对照需求清单）

| # | 借鉴点 | 对应需求 | 采纳建议 | 风险/成本 |
|---|--------|----------|----------|-----------|
| 1 | Cordis 作为编排内核底座（服务注入+类型化事件+可逆效应） | C01/D04 | ✅ **首选候选**：MIT 可用、腾讯/DeepSeek 双产业验证、热卸载安全 | 生态小众、团队需学 DI/事件模式；备选=自研精简版（只抄三概念） |
| 2 | Profile/Bundle/Patch 运行时形态组合 | J02 私有化交付 | ✅ 结合 WorkBuddy 构建期裁剪使用 | 低 |
| 3 | Capability Seams（fs+subprocess 同执行世界） | C05/I01 沙箱演进 | ✅ 设计阶段作为架构原则 | 设计成本中 |
| 4 | 「模型可见即已记录」不变量 | F01 转写 | ✅ 直接采纳 | 低 |
| 5 | Skill Provider 注册表 + 目录 digest 复发布 | D01 | ✅ 直接采纳（比全量注入省 token） | 低 |
| 6 | 双半插件 + slots 页面插槽 + 审批运行 | D04/D06（升级版）、「agent 自生成扩展」新需求候选 | 🔄 二期：安全边界要求高（vm 沙箱+白名单代理+人工审批三层缺一不可），MVP 先做只读 inspect | 高（安全评审必须） |
| 7 | waterfall 事件做工具/请求拦截 | C01/I06 审批 | ✅ 与 WorkBuddy hooks、MyAgents canUseTool 同类但更统一 | 低 |
| 8 | 客户端插件化 UI（hmr、keyed renderer） | A 模块桌面端 | 🔄 若选 Tauri+Web 前端，client half 模式映射到 WebView；PoC 验证 | 中 |

## 6. 关键验证（PoC，建议纳入 ADR 前置）

1. **最小 PoC**：以 vendored cordis（MIT）搭 20 行级 demo——两个插件（工具注册+事件拦截），运行中 load/unload，验证注册回滚与 `inject` 依赖等待
2. **桌面集成 PoC**：cordis host 进程 + WebView client half（Tauri 或 Electron 二选一同时验证），slots 插槽渲染动态 UI
3. **隔离验证**：node:vm 沙箱跑 agent 生成代码的逃逸面评估（决定借鉴点 6 的启用时机）
4. **候选对比**（若 PoC 不理想）：自研三概念精简内核（ctx+effect+waterfall ≈ 数百行）vs NestJS 插件化（重、无热卸载）vs 直接文件清单式（WorkBuddy 式，能力上限低）

## 7. 结论与建议

- **推荐**：WorkPivot 的 Agent 编排内核与扩展体系以 **Cordis 模式为蓝本**——优先直接采用 vendored cordis（MIT），PoC 失败则自研精简实现（三概念+可逆效应是必须保留的内核）
- **理由**：MIT 无传染（对比 MyAgents AGPL / OWB PolyForm）；腾讯 CodeBuddy（Cell）与 DeepSeek 官方 harness 双重产业验证；「注册即可逆效应」是热加载安全性的唯一系统化解法；双半插件为「agent 自生成扩展」预留了业界最完整的合规范本
- **风险与缓解**：生态小众（cordiverse/Koishi 圈）→ vendor 进仓库锁定版本（dsh 同款做法）；学习成本 → 从三概念最小集起步；安全 → 双半插件延后到二期并强制三层防线
- **是否落 ADR**：✅ 是——PoC 通过后落 `ADR-002-编排内核采用Cordis模式`（ADR-001 留给后端语言/桌面框架）

## 8. 参考链接

- 本地源码：`E:\project\deepseek-harness`（docs/architecture.md、docs/cordis-primer.md、packages/extensions/*、packages/skill/*）
- Cordis：<https://github.com/cordiverse/cordis>（论文：A Programming Paradigm for Spatiotemporal Composability）
- dsh 仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 关联文档：[workbuddy-extension-system.md](../competitors/workbuddy-extension-system.md)（文件清单插件体系对照）、[myagents.md](../competitors/myagents.md)（多 Runtime 抽象对照）、[../02-design/product/需求清单.md](../../02-design/product/需求清单.md)
