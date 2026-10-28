# 竞品分析：Claude Code（闭源核心 + 开源卫星）

> **分析方式**：四个官方仓库本地实测（2026-09-05 shallow clone）：`E:\project\claude-code`（主仓库）、`E:\project\skills`（Agent Skills 官方源头）、`E:\project\claude-code-action`（MIT headless 实现）、`E:\project\knowledge-work-plugins`（岗位插件包）。核心 CLI 无源码可看，闭源部分的机制信息来自仓库内规格文本 + CHANGELOG + 姊妹文档的间接证据链。
> **一段话结论**：Claude Code 的"开源"是**卫星开源、核心闭源**——核心 npm 包是全版权保留 + 商业条款（连主仓库都整体套这个许可）；真正可用的开源资产是：SKILL.md 格式规范与写作方法论（agentskills.io 开放标准 + Apache-2.0 示例技能）、headless 集成工程蓝图（MIT）、岗位技能包内容范式（Apache-2.0，212 个领域技能）。⚠️ 但驱动 Claude.ai 生产力的**文档四件套技能（docx/pptx/xlsx/pdf）是 Proprietary**，内容与脚本不可复用——WorkPivot 的 H 模块必须自研。
>
> 姊妹文档：[**claude-code-internals.md**](evidence/claude-code/internals.md)（**泄露源码级分析**：51.2 万行 ground truth，2026-03-31 npm source map 事故版本，只读研究用途）｜[codex.md](codex.md)（同类官方开源对照）｜[workbuddy-technical-analysis.md](evidence/workbuddy/technical-analysis.md)（WorkBuddy 内嵌同源引擎的逆向）｜[myagents.md](myagents.md)（Claude Agent SDK 系）｜[qwenwork.md](qwenwork.md)（migration 里的 Claude Code 痕迹）

- **分析人**：lichb
- **日期**：2026-09-05
- **信息来源**：本地源码实测 + [anthropics/claude-code](https://github.com/anthropics/claude-code) / [anthropics/skills](https://github.com/anthropics/skills) / [anthropics/claude-code-action](https://github.com/anthropics/claude-code-action) / [anthropics/knowledge-work-plugins](https://github.com/anthropics/knowledge-work-plugins)

## 1. 开源地图：哪里开放、哪里不开放

| 仓库 | 许可 | 里面是什么 | 对 WorkPivot |
|---|---|---|---|
| 核心 CLI（npm `@anthropic-ai/claude-code`） | ⛔ **全版权保留 + 商业条款**（LICENSE.md 仅 150 字节） | 压缩 bundle，无源码 | **一行不能进** |
| anthropics/**claude-code**（主仓库） | ⛔ 同上，**整体套用**（非 mixed license） | issues 设施 + examples（gateway/MDM/settings）+ 13 个官方插件 + plugin-dev 规格技能 + 防火墙 devcontainer | 只读参考：plugin-dev 规格、企业配置范例 |
| anthropics/**skills** | ⚠️ **无根许可，按技能分**：文档四件套 Proprietary；其余 14 个 Apache-2.0 | SKILL.md 规范 + 19 个技能（文档四件套、skill-creator、mcp-builder…） | 规范/写作法/多数示例可复用；**四件套不可** |
| anthropics/**claude-code-action** | ✅ **MIT** | TypeScript 源码：GitHub 事件→headless Claude 的完整流水线 | headless 集成蓝图，可合法借鉴 |
| anthropics/**knowledge-work-plugins** | ✅ **Apache-2.0** | 12 个领域"岗位包"（212 个 SKILL.md）：finance/legal/HR/marketing… | 岗位技能包范式，内容可改造复用 ★ |

与 Codex 对照：Codex 是"全开源 + 不收 PR"，Claude Code 是"核心不开源 + 生态开放"。但论**标准制定权**，Claude Code 是事实标准的源头——SKILL.md、AGENTS.md、hooks、subagent 这些格式经由它和 agentskills.io 成为全行业收敛点（WorkBuddy/QwenWork 内嵌其引擎衍生品、MyAgents 建在其 SDK 上、Codex/千问办公也采纳 SKILL.md）。

## 2. 闭源核心：间接证据链汇总

- **内嵌同源引擎的实证**（详见姊妹文档）：WorkBuddy asar 内嵌 CodeBuddy CLI（同源衍生）；QwenWork migrations 出现 `anthropic_multi_account`/`remove_claude_code_credentials`；MyAgents 内置 Claude Agent SDK。→ 它的循环工程（压缩/核验/权限档位）已被三个产品实战验证。
- **CHANGELOG 即演进规格**（630KB，386 个版本，0.2.21→2.1.261，**每天 1-2 版**）。近半年主线：sandbox 深化（网络 allowlist/凭证 masking）、subagent 治理（并发上限/缓存 TTL）、**workflows/agent teams**（多 agent 编排）、云会话与 Remote Control、`/goal` 跨 turn 持续工作、skills 生态治理（/skill-doctor、热重载）、参数级权限规则 `Tool(param:value)`。→ 演进方向与 WorkPivot 的 F 层/I 层/D 层高度重叠，可当免费的趋势预报看。
- **仓库内第二好的官方规格**：`plugins/plugin-dev/` 的 7 个 skill（agent-development/hook-development/command-development/mcp-integration/plugin-structure/skill-settings…）。要点：agent=自主子进程（frontmatter：name/description 触发示例/tools/model/maxTurns），"agents 用于自主工作，commands 用于用户发起"；**9 个 hook 事件**（PreToolUse/PostToolUse/Stop/SessionStart/PreCompact…），支持 prompt-based hook（LLM 判定）；settings 四层级（企业 managed→项目→用户），企业专属键（`allowManagedHooksOnly`/`permissions.disableBypassPermissionsMode` 等）——→ 直接对标 WorkPivot M05 策略下发。
- 企业实物范例：`examples/settings/`（lax/strict/bash-sandbox 三档组织配置）、`examples/mdm/`（macOS plist/Windows ADMX + Intune）、`.devcontainer/init-firewall.sh`（iptables 域名白名单沙箱）。

## 3. skills 仓库：SKILL.md 规范源头（★ D01 直接输入）

### 3.1 规范本体（agentskills.io，开放标准，可实现于任意产品）

- **frontmatter 6 字段**：`name`（必填，≤64 字符，kebab-case，**必须与目录名一致**）、`description`（必填，≤1024 字符，"做什么+何时用"，是**唯一触发依据**）、`license`、`compatibility`（≤500 字符，环境要求）、`metadata`（任意键值）、`allowed-tools`（预批准工具，实验性）。官方校验器：`skills-ref validate`。
- **三级渐进披露**：① Metadata（~100 tokens，启动全量加载，触发判断）② SKILL.md 正文（激活时加载，**建议 <500 行**）③ `scripts/ references/ assets/`（按需，scripts 可执行不占上下文）。文件引用相对路径、只深一层。
- **官方模板只有 7 行**——最小合法技能 = 两个字段 + 正文标题。WorkPivot D01 的实现面可以很小。

### 3.2 skill-creator：技能写作方法论（Apache-2.0，可复用）

- description 要写得 **pushy**（明确列触发词，"即使没明说也要用"——模型倾向 undertrigger）；
- 正文 = **决策表开局 + gotchas 坑清单 + 纪律条款**，解释 why 优于堆 MUST；重复操作固化为 `scripts/`；
- 自带 **eval 体系**：evals.json（prompt+expectations）、with/without skill 基准对比、description 触发率自动优化循环（60/40 train/test 防过拟合）——→ WorkPivot K01 评测可对齐到技能粒度。

### 3.3 ⚠️ 文档四件套：实现哲学可学，内容不可抄（Proprietary）

驱动 Claude.ai 生产的 docx/pptx/xlsx/pdf 技能是 source-available、**明确禁止复制/演绎/实施所含发明**。可学（思想层面）：

1. **按任务分治的混合策略**：新建→高层库（docx-js/pptxgenjs/openpyxl，模型预训练里 API 知识最多）；编辑既有文件→**unzip 后直接改 OOXML 再 zip**（高层库打不开已有文件/保不住格式）；读取→pandoc/markitdown 转 Markdown。刻意避开 python-docx/python-pptx（点名的缺陷：不能复制 slide、赋值塌缩格式）。
2. **验证闭环是一等公民**：生成后 LibreOffice→PDF→转图→**模型亲眼看图**；XSD 全套 schema 校验（ISO 29500，约 40 个 XSD，每个失败"点名修复方法"）；xlsx 强制公式重算（openpyxl 写公式无缓存值），"零公式错误才可交付"——→ WorkPivot H04 写后自检的直接蓝本。
3. **知识组织**：决策表（3 行定分治）+ 十余条"会损坏文件/静默失败"级 gotchas + 修订/注释专节——不是教程。
4. **CJK 缺口 = 差异化机会**：字体安全清单全是西文字体，无任何中文处理——WorkPivot 面向中国企业，宋体/黑体/雅黑的宽度与 fallback 知识要自建（QwenWork 工作区的 docx_lib.py 已示范）。

## 4. claude-code-action：headless 集成蓝图（MIT）

- **用 SDK 消息流而非 CLI 子进程**：`for await (message of query({...}))`（`@anthropic-ai/claude-agent-sdk`），消费到 `result` 显式 break，全量消息落 `execution-output.json`，session_id 可续会话，`--json-schema` 强制结构化输出。
- **双块 prompt**：宿主把"系统上下文+安全规则"写 `claude-prompt.txt`、把用户原始请求（含 `/slash` 命令）写 `claude-user-request.txt`，构造 multi-block 用户消息——**宿主注入的企业规则与用户指令分层**，且保留斜杠命令能力（→ PRD-02 对话注入、S03 企业层组装的现成范式）。
- **权限三层**：① 工具白名单最小集（只有读类+评论更新，**故意不含 Edit/Write**）② `--permission-mode acceptEdits` 做目录级写围栏（注释引用真实事故 Asana-1213310082312048）③ disallowed 黑名单兜底（WebSearch/WebFetch 默认禁）。细节：解析 `claude_args` 时对 shell 元字符做保护——`Bash(gh:*)` 被解析成裸 `Bash` 会**权限静默扩大**。
- **跟踪评论 = 宿主侧持久任务对象**：agent 唯一可见输出是"更新那条评论"，进度 UI 在宿主侧，agent 只被允许改这一个对象（→ A03 任务卡片的 headless 版）。
- **`agent-approval-check`**：对含 AI 参与的 PR 强制 N 个人类批准（可设 required check），威胁模型文档完整——"AI 产出的独立人审门禁"的官方实现（→ PRD-02 授权卡/F02 的企业延伸）。

## 5. knowledge-work-plugins：岗位技能包范式（Apache-2.0，★ 定位最贴合）

- 12 个领域目录（finance 8 技能/legal 9/data 10/marketing 8/HR 9/operations 9/sales 9/CS 5/PM 8/design 7/企业搜索 5/生物研究 6…），共 **212 个 SKILL.md**。
- **"岗位包"解剖——5 种文件、零代码**：`.claude-plugin/plugin.json`（仅 name/version/description/author）+ `.mcp.json`（预配远程 MCP）+ `CONNECTORS.md`（占位符映射表）+ `skills/*/SKILL.md` + README。
- **`CONNECTORS.md` 是最有借鉴价值的设计**：技能正文写 `~~data warehouse`、`~~erp`、`~~chat` 占位符，由 CONNECTORS.md 表格映射到具体产品（含"尚无 MCP"三态）。→ **技能是工具无关的流程知识，连接器是运行时注入的实现**——WorkPivot 的企业技能包（S01）可直接套用：同一份"尽调技能"在不同客户处绑定不同数据源。
- SKILL.md 实战写法：frontmatter 统一 `name`/`description`（"Use when…"句式）/`argument-hint`（74 处）/`user-invocable`（57 处）；正文形态 = `/命令 用法 → 按连接状态分叉 → 领域规则逐条写死 → 固定输出模板 → Review Checklist → 免责声明`。
- 工作流与通用办公高度重合：**取数（连接器）→ 领域规则 → 结构化文档产出**。做私有化交付时，把 `.mcp.json` 的 SaaS 端点换成企业内网连接器即可复用整套内容——这就是 WorkPivot 技能市场的企业版模板库现成素材。

## 6. 对 WorkPivot 的启示

### 6.1 值得借鉴（按模块）

1. **D01**：6 字段 frontmatter + 三级渐进披露 + 500 行正文 + 目录约定，agentskills.io 是开放标准可安心实现；校验逻辑照 `quick_validate.py`（Apache-2.0）。
2. **H01-H04**：文档技能采用"高层库新建 + XML 直改编辑 + 视觉 QA + XSD 校验"架构；H04 的"零公式错误才可交付"写进验收。内容自研（CJK 知识自建），架构思想零风险。
3. **S01/S02 企业技能包**：CONNECTORS.md 占位符机制——技能与数据源解耦，管理员配连接器即全员生效，与 S 模块设计天然互锁。
4. **PRD-02/I03**：双块 prompt 分层注入（宿主规则 vs 用户指令）、最小工具白名单+目录写围栏+黑名单三层、AI 产出独立人审门禁（agent-approval-check 威胁模型文档值得全文读）。
5. **M05 策略下发**：examples/mdm + settings 三档配置 = 企业管控界面与配置分层的产品级参照（managed 顶层用户不可覆盖）。
6. **K01**：skill-creator 的"with/without skill 基准对比 + 触发率优化"——评测不只测任务，还测技能本身是否被正确触发。
7. **趋势预报**：CHANGELOG 的 workflows/agent teams、云会话、sandbox 深化——WorkPivot P1/P2 排期可对照它的演进顺序校准优先级。

### 6.2 许可红线（本次分析最重要的结论）

| 资产 | 可否进 WorkPivot | 依据 |
|---|---|---|
| 核心 CLI / 主仓库全部内容 | ⛔ | 全版权保留+商业条款，无任何授予 |
| skills 文档四件套（docx/pptx/xlsx/pdf 的 SKILL.md+scripts） | ⛔ | Proprietary，禁止复制/**演绎**/实施所含发明——"参考重写"亦有 IP 风险，H 模块全部自研 |
| skill-creator 等 14 个示例技能 | ✅ | Apache-2.0（保留 NOTICE） |
| knowledge-work-plugins 全部内容 | ✅ | Apache-2.0，可改造进技能市场 |
| claude-code-action 源码与设计 | ✅ | MIT |
| SKILL.md 格式规范本身 | ✅ | agentskills.io 开放标准，规范允许任意实现 |

注意 skills 仓库 THIRD_PARTY_NOTICES 中的 **FFmpeg（GPLv3）**——分发含该依赖的技能需过 K05 检查。

### 6.3 与 Codex 的取舍（同类官方参考，两种姿势）

Codex 给的是**引擎内部的设计图纸**（循环/压缩/沙箱可读源码）；Claude Code 给的是**格式标准与内容生态**（SKILL.md/插件解剖/领域技能库）+ 企业管控实物。两家都不给的东西——多用户、审计导出、私有化模型自由——恰是 WorkPivot 的立足空间。WorkPivot 的复用姿势：**格式对齐 Claude Code 系，工程细节参照 Codex，内容资产取 Apache-2.0 子集，核心全自研**。

## 7. 泄露事件（2026-03-31）：事故复盘

> 本节只引用公开发布的事故报道与第三方分析,不接触任何泄露代码镜像。

- **经过**：npm 发布的 Claude Code 包因缺失 `.npmignore`,把 **59.8MB 的 source map**（`.map`）一并发了出去——内含约 **51.2 万行原始 TypeScript 源码**,可完整还原出未压缩源（此前 npm 上一直是压缩 bundle,代码本身人人可下载,只是不可读）。见 [Layer5 复盘](https://layer5.io/blog/engineering/the-claude-code-source-leak-512000-lines-a-missing-npmignore-and-the-fastest-growing-repo-in-github-history)、[dev.to 分析](https://dev.to/gabrielanhaia/claude-codes-entire-source-code-was-just-leaked-via-npm-source-maps-heres-whats-inside-cjo)。
- **第三方解读的要点**（转述公开分析,未经本机验证）：CLI 运行时是 **Bun** 而非 Node.js,利用 Bun 的死代码消除做特性开关与启动提速;源码中可见约 **44 个未公开的隐藏特性**。
- **后续**：GitHub 出现大量重建镜像（一度号称"史上涨速最快仓库"）;⚠️ [Zscaler 报告](https://www.zscaler.com/blogs/security-research/anthropic-claude-code-leak)：**威胁者借泄露热度分发伪装成泄露源码的恶意软件（Vidar 窃密木马 + GhostSocks）**——下载这类镜像同时是版权风险与供应链风险。
- **本机验证**：安装的 2.1.228（2026-08）已无 `.map`,发布物改为 **296MB 的 Bun 编译原生 `claude.exe`**（Bun 结论侧面得到印证）;包内唯一可读的规格性文件是 `sdk-tools.d.ts`（152KB,SDK 工具类型定义）。
- **对 WorkPivot 的启示**：① 发布 checklist 必须含"构建产物审计"（.map/.npmignore/.env 随包发布是高频事故,K02 原子落盘纪律应延伸到 CI 发布环节）;② **公开可见 ≠ 许可授予**——事故不改变代码权属,K05 合规黑名单逻辑对"泄露源码"同样适用;③ 热点事件的"源码镜像"是恶意软件高发载体,研究纪律=只碰官方渠道与公开分析报道。

## 附：快速验证路径（本机）

| 想看什么 | 去哪里 |
|---|---|
| 核心闭源声明 | `E:\project\claude-code\LICENSE.md`（150 字节全文） |
| 官方机制规格（agent/hook/command） | `E:\project\claude-code\plugins\plugin-dev\skills\`（7 个 skill） |
| 企业管控配置实物 | `E:\project\claude-code\examples\settings\`、`examples\mdm\` |
| 版本演进轨迹 | `E:\project\claude-code\CHANGELOG.md`（630KB，386 版） |
| SKILL.md 规范 | `E:\project\skills\spec\agent-skills-spec.md` → agentskills.io/specification |
| 官方最小模板 | `E:\project\skills\template\SKILL.md`（7 行） |
| 技能写作方法论+eval | `E:\project\skills\skills\skill-creator\`（⚠️ 注意区分：Apache-2.0） |
| 文档四件套（⛔ 不可复用，仅学习架构） | `E:\project\skills\skills\{docx,pptx,xlsx,pdf}\`（XSD 校验器在 `scripts\office\`） |
| headless 集成源码 | `E:\project\claude-code-action\src\create-prompt\index.ts`、`base-action\src\run-claude-sdk.ts` |
| AI 产出门禁 | `E:\project\claude-code-action\agent-approval-check\`（威胁模型文档） |
| 岗位技能包范式 | `E:\project\knowledge-work-plugins\finance\`（CONNECTORS.md + skills/） |
| 本机安装的官方二进制（Bun exe） | `%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\`（2.1.228：296MB claude.exe + sdk-tools.d.ts,无 map/无 js） |
