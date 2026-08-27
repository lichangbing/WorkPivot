# WorkBuddy 扩展系统逆向分析：专家 / 技能 / 连接器 / 插件的动态加载

> 姊妹文档：[workbuddy-technical-analysis.md](workbuddy-technical-analysis.md)（总体架构）、[workbuddy.md](workbuddy.md)（产品分析）。
> 本文聚焦一个问题：**WorkBuddy 如何做到「专家、场景、技能（PPT/Word 等助手）在终端对话页自由加载」**，并给出 WorkPivot 可直接参考的实现设计。
>
> 证据来源：`~/.workbuddy` 目录实测（plugins / skills-marketplace / connectors / settings 等）+ 应用界面截图。文中目录、文件、字段均为实测摘录（个别 UTF-8 文件在控制台显示为乱码，此处已按原义转写）。

- **分析人**：ZCode
- **日期**：2026-08-27
- **对象版本**：桌面端 5.3.14 / CLI @tencent-ai/codebuddy-code 2.115.0

---

## 1. 界面形态（要解释什么）

从界面截图确认的产品行为：

1. **「专家·技能·连接器」页**：三 Tab 广场；专家卡片 = 头像 + 名称（如「小台」）+ 职业（「工作台搭建师」）+ 标签 + 行业分类；专家详情弹窗 = 介绍 + **「专家帮你做」预设 Prompt 模板（quickPrompts）** + **「召唤专家」按钮**
2. **对话/终端页**：
   - 输入框旁 **「⚡技能」按钮** → 技能面板（如「使用腾讯文档，查看、创建或编辑在线文档」），每项带 **「添加」** 按钮，可把技能**挂载进当前会话**
   - **「召唤专家」按钮** → 把某个专家人格加载进当前会话（以 defaultInitPrompt 开场）
   - 底部快捷芯片（帮我写周报 / 合同起草 / PPT / 翻译 / AI PPT / 公文写作…）= quickPrompts 的快捷入口
3. 用户自装的 PPT/Word 助手（tencent-pptx、tencent-docx、sheetagent 等）出现在对话页可加载列表中，**无需重启应用**（会话级挂载）

---

## 2. 核心结论（一段话）

**WorkBuddy 的整套「可自由加载的东西」都是同一套插件体系（沿用/兼容 CodeBuddy 插件规范）**：一个插件包可以同时声明 `agents`（专家人格）、`skills`（SKILL.md 技能）、`commands`、`hooks`、`mcpServers`（连接器）五类扩展点；通过**四个分发市场**（codebuddy-plugins-official / cb_teams_marketplace / **experts** / workbuddy-builtin）以 zip 形式下载到本地**按版本缓存**，靠 **PID 引用锁 + 孤儿标记**做版本垃圾回收；专家 = 插件 + 元数据（行业分类/双语文案/预设 Prompt）+ agent 提示词文件；PPT/Word 助手 = 插件捆绑的 SKILL.md + **hook 触发的懒加载运行时**（首次调用 Skill 时才解包 vendor 依赖）；连接器 = 远程 MCP 服务器注册 + 每用户启停状态 + 加密凭据。

---

## 3. 插件系统（整个体系的地基）

### 3.1 目录布局与生命周期

```
~/.workbuddy/plugins/
├── installed_plugins.json        # 已装清单：{插件名@市场: [{scope:"user", installPath, version, installedAt, lastUpdated}]}
├── known_marketplaces.json       # 市场注册表（见 3.2）
├── marketplaces/                 # 市场本体（每个市场一个目录）
│   ├── codebuddy-plugins-official/
│   ├── cb_teams_marketplace/
│   ├── experts/plugins/          #   ← 专家市场：每个专家一个插件目录
│   └── workbuddy-builtin/        #   ← 内置插件（随应用更新）
└── cache/                        # 安装缓存：{市场}/{插件名}/{版本}/
    └── workbuddy-builtin/tencent-pptx/
        ├── v20260712/.orphaned_at    # 旧版本：被新版本替代后打孤儿标记
        └── v20260727/                # 当前版本
            ├── .in_use/{11216,14384,...}   # ← 正在使用本插件的进程 PID 文件（引用锁）
            └── ...插件内容
```

**生命周期（实测推断，证据充分）**：

1. 市场以 **zip 包**分发（`known_marketplaces.json` 记录下载 URL，如 `https://download.codebuddy.cn/plugin-marketplace/{市场}-{uuid}.zip`），带 `autoUpdate: true` + 增量校验（`.connectors-marketplace.meta.json` 存 etag + sha256）
2. 插件按 `{市场}/{名称}/{版本}` 三级目录安装，**同插件多版本并存**
3. 进程加载某版本插件时写入 `.in_use/{pid}`；退出时移除
4. 升级后旧版本目录打 `.orphaned_at` 标记；无 `.in_use` 引用的孤儿版本可被安全清理
5. 启用状态在 `settings.json` 的 `enabledPlugins`（如 `"tencent-pptx@workbuddy-builtin": true`）

> **设计精髓**：版本目录 + PID 引用锁让「应用运行中升级/卸载插件」不需要重启——运行中的进程继续用旧版本目录，新进程用新版本。

### 3.2 市场注册（known_marketplaces.json 摘录）

```json
{
  "cb_teams_marketplace": {
    "type": "zip",
    "source": { "source": "zip", "url": "https://download.codebuddy.cn/plugin-marketplace/cb_teams_marketplace-{uuid}.zip" },
    "installLocation": "~/.workbuddy/plugins/marketplaces/cb_teams_marketplace",
    "isBuiltIn": true,
    "autoUpdate": true,
    "description": "CodeBuddy Teams Marketplace - 团队协作与文档处理插件集合",
    "manifest": { "name": "...", "...": "..." }
  }
}
```

四个市场分工：`codebuddy-plugins-official`（CodeBuddy 官方通用插件）、`cb_teams_marketplace`（团队协作/文档处理，如 document-skills）、**`experts`（专家）**、`workbuddy-builtin`（WorkBuddy 内置全家桶）。

### 3.3 插件清单格式（plugin.json）

清单目录**双规范兼容**：第三方插件放 `.codebuddy-plugin/plugin.json`，WorkBuddy 内置插件用 `.workbuddy-plugin/plugin.json`（内核两套都认，说明 WorkBuddy 在 CodeBuddy 插件体系上做了自有扩展字段）。

**最小插件**（agent-browser，技能型插件）：

```json
{
  "name": "agent-browser",
  "version": "1.3.0",
  "description": "基于 Vercel agent-browser CLI 的浏览器自动化插件...",
  "description_en": "Browser automation plugin...",
  "author": { "name": "..." },
  "repository": "https://github.com/...",
  "license": "MIT",
  "keywords": ["browser", "automation", "web"]
}
```

**全能插件**（sheetagent，腾讯文档团队表格助手）——一个包声明四类扩展点 + 内置 MCP 服务器：

```json
{
  "name": "sheetagent",
  "version": "0.1.1784877812",
  "description": "由腾讯文档团队出品的电子表格智能助手，支持通过自然语言创建、查询与编辑 xlsx 表格",
  "author": { "name": "Tencent Docs SheetAgent Team", "url": "https://docs.qq.com" },
  "keywords": ["spreadsheet", "excel", "xlsx", "tencent-docs"],
  "commands": "./commands",          // 扩展点1：斜杠命令
  "skills": "./skills",              // 扩展点2：技能目录（下有若干 SKILL.md）
  "hooks": "./hooks/hooks.json",     // 扩展点3：生命周期钩子
  "mcpServers": {                    // 扩展点4：随插件分发的 MCP 服务器
    "sheetagent": {
      "command": "node",
      "args": ["${CODEBUDDY_PLUGIN_ROOT}/mcp/start.mjs"],   // ← 插件根目录占位符
      "env": {
        "SHEETAGENT_MCP_TRANSPORT": "stdio",
        "SHEET_API_MODE": "local",
        "SHEET_REMOTE_MCP_URL": "https://docs.qq.com/api/v6/sheet/mcp"
      },
      "defer_loading": true          // ← 延迟启动：用到才拉起 MCP 进程
    }
  }
}
```

**WorkBuddy 专属扩展字段**（welcomemode-work，场景插件）：

```json
{
  "name": "welcomemode-work",
  "category": "welcomeMode",
  "agents": ["agents/work.md"],      // 场景自带的 agent 定义
  "workbuddy": {
    "dependencies": [                // ← 声明式依赖：本场景需要哪些 MCP 能力
      { "type": "mcp", "name": "netdrive" }
    ]
  }
}
```

### 3.4 Hooks 机制（Claude Code 兼容）与懒加载运行时

`tencent-pptx/hooks/hooks.json`（这是「PPT 助手免预装」的关键）：

```json
{
  "hooks": {
    "PreToolUse": [                        // Agent 即将调用工具前触发
      {
        "matcher": "Skill",                // 只匹配 Skill 工具
        "hooks": [
          {
            "type": "command",
            "command": "\"${CODEBUDDY_PLUGIN_ROOT}/bin/run-node\" \"${CODEBUDDY_PLUGIN_ROOT}/scripts/ensure-runtime.mjs\"",
            "timeout": 120
          }
        ]
      }
    ]
  }
}
```

配合插件目录里的文件：

```
tencent-pptx/v20260727/
├── bin/run-node(.cmd)                 # 找可用 node 的包装脚本
├── scripts/ensure-runtime.mjs         # 运行时保障脚本
├── vendor/tencent-slidep-5.4.1.tar.gz # ← 腾讯幻灯生成库，按需解包
└── skills/tencent-pptx/SKILL.md       # 技能文档
```

**执行流**：用户挂载 PPT 助手 → agent 决定调 `Skill` 工具 → PreToolUse 钩子触发 → `ensure-runtime.mjs` 解包 vendor 运行时（首次才有开销）→ Skill 内容注入 → agent 用 tencent-slidep 生成 pptx。**重依赖不随安装包膨胀，首次使用时才落地**。

---

## 4. 专家系统（「召唤专家」的实现）

### 4.1 专家 = 插件 + agent 定义 + 展示元数据

experts 市场里每个专家一个插件目录，以「工作台搭建师·小台」（workspace-builder）为例：

```
experts/plugins/workspace-builder/
├── .codebuddy-plugin/plugin.json   # 专家元数据（全量见下）
├── agents/workspace-builder.md     # ← 专家的系统提示词（人格本体）
├── avatars/expert.png              # 头像
├── README.md
└── .downloaded_at                  # 下载时间标记
```

**plugin.json 全量字段**（专家卡片/弹窗的所有 UI 元素都来自这里）：

```json
{
  "name": "workspace-builder",              // 插件名（唯一标识）
  "version": "1.4.0",
  "agents": ["./agents/workspace-builder.md"],  // 指向 agent 定义
  "expertType": "agent",                    // 两种类型："agent"（单专家）/ "team"（多角色协作团）
  "agentName": "workspace-builder",
  "displayName":  { "en": "DeskCraft",      // 界面名称（双语）
                    "zh": "小台" },
  "profession":   { "en": "Workspace Builder",
                    "zh": "工作台搭建师" },
  "displayDescription": { "en": "...", "zh": "为不同人群定制专属数字工作台..." },
  "avatar": "avatars/expert.png",
  "categoryId": "02-Engineering",           // ← 行业分类枚举（专家广场的分组维度）
  "defaultInitPrompt": {                    // 「召唤专家」后的开场 Prompt（双语）
    "zh": "帮我给4岁宝宝做一个识字启蒙工作台...",
    "en": "Build a literacy learning workspace..."
  },
  "tags": [ { "en": "Workspace Builder", "zh": "工作台搭建" }, ... ],
  "quickPrompts": [                         // 详情页「专家帮你做」模板列表（双语多条）
    { "zh": "做一个健康打卡+记账理财务工作台...", "en": "..." },
    { "zh": "做一个计划表+进度看板工作台...", "en": "..." }
  ],
  "plugin": "workspace-builder",
  "author": { "name": "WorkBuddy 团队" }
}
```

### 4.2 专家人格文件（agents/*.md）格式

YAML frontmatter + 长提示词正文（实测摘录）：

```markdown
---
name: workspace-builder
description: "Expert at building custom digital workspace HTML pages... 
              Prioritizes WorkBuddy built-in library skill (skill-library)... 
              Follows strict standards: single-file HTML, all CSS/JS inline, 
              zero external dependencies, SVG-only icons and charts."
displayName:  { en: "DeskCraft", zh: "小台" }
profession:   { en: "Workspace Builder", zh: "工作台搭建师" }
maxTurns: 50                              # ← 会话预算：单次任务最多 50 轮
---

# 工作台搭建师 - 小台

你是一位专业的个人数字工作台搭建专家……你不是通用的 HTML 生成器，
而是深耕「个人工作台」垂直领域的专家，内经 48 个真实案例验证的规范……

## ⚠️ 前置动作（每次任务必须首先执行，不可跳过）
1. **加载资料库 skill**（skill 名称：`library`，属于 `workbuddy-builtin` 内置插件 `skill-library`）
2. **判断加载结果**：加载成功 → 后续必须同步……
```

要点：

- 提示词里可以**引用其他插件的技能**（如 skill-library），专家与技能可组合
- `maxTurns` 给专家会话设定轮次预算（对应界面上的专家会话模式）
- **专家可以引用专家**：workspace-builder 内置使用 `skill-expert-manager` 的规范

### 4.3 召唤流程（端到端）

```
用户点「召唤专家」
  → 专家广场（experts 市场 + 已装专家列表，按 categoryId 分组）
  → 选中专家 → 详情弹窗（displayDescription + tags + quickPrompts）
  → 点「召唤」/选一条 quickPrompts
     1. 若未安装：经市场下载插件到 plugins/cache（search_plugins/suggest_plugin_install 工具也可在对话内完成）
     2. 当前会话切换 agent：加载 agents/*.md 作为系统提示（含 maxTurns 预算）
     3. 切换交互模式为 expert：注入 interactionmode-expert 插件的 prompt fragments
        （agent-loop.md / interaction.md / result-presentation.md / tool-use.md / current-mode.md）
     4. 记录召唤历史：app/data/expert-history.json
        { id, name, profession, avatarUrl, industryId, defaultInitPrompt,
          pluginName, summonedAt, source: "builtin", isCustomExpert: true }
     5. 以 defaultInitPrompt（或所选 quickPrompt）作为开场消息发起会话
```

### 4.4 专家的推荐与运营（也是技能）

- **skill-recommend-experts**：当任务需要专业判断且当前会话未选 Expert 时，自动搜索并内联推荐专家。其 SKILL.md frontmatter 声明 `allowed-tools: search_plugins suggest_plugin_install`——即 CLI 内置了**插件搜索/建议安装两个工具**，对话中就能完成「发现 → 推荐 → 安装 → 召唤」闭环
- **skill-expert-manager**：「专家包管理器」skill，负责专家包**全生命周期运营**：从开源仓库/本地项目转化创建专家、修改已有专家、合规审查、批量更新、质量审查；遵循《WorkBuddy 专家开发规范 v2.0》；支持 `expertType: agent / team` 两种类型；交互式收资或直接生成两种输入模式
- **skill-skill-creator**：创建新技能的技能（用户可自造技能）
- **skill-marketplace-skill-installer** / **skill-recommend-connectors**：市场安装与连接器推荐

> **运营闭环**：用 skill 管理技能生态本身——推荐、安装、创建、审查全部 agent 化。

### 4.5 本机召唤记录示例（app/data/expert-history.json）

```json
{
  "version": 1,
  "sessions": {
    "__global__": [
      { "id": "GovernmentDigitalPresalesConsultant", "name": "政通通",
        "profession": "政府数字化售前顾问",
        "avatarUrl": "https://openplatform-cdn.codebuddy.cn/public/{uuid}/avatar/expert/....png",
        "summonedAt": 1785564653356,
        "industryId": "07-SalesCommerce",
        "defaultInitPrompt": "我们想拓展政府数字化业务...",
        "pluginName": "government-digital-presales-consultant",
        "source": "builtin", "isCustomExpert": true }
    ]
  },
  "lastUpdated": 1785718669293
}
```

---

## 5. 技能系统（「⚡技能」面板与 PPT/Word 助手）

### 5.1 SKILL.md 标准格式

每个技能一个目录：`SKILL.md`（入口）+ `references/`（进阶文档）+ `scripts/`（可选脚本）。格式与 Anthropic Skills 同构：

```markdown
---
name: pptx-generator
description: "Generate, edit, and read PowerPoint presentations. ...
              Triggers: PPT, PPTX, PowerPoint, presentation, slide, deck, slides."
              # ↑ 触发词直接写在 description 里（模型据此自主决定何时调用）
description_zh: "PowerPoint 演示文稿生成"
description_en: "Generate and edit PowerPoint presentations"
version: 1.0.2
license: MIT
metadata:
  version: "1.0"
  category: productivity
  sources: [https://gitbrent.github.io/PptxGenJS/, ...]
allowed-tools: ...          # 可选：限制本技能可用的工具（recommend-experts 中见过）
disable: false              # 可选：软开关
---

# PPTX Generator & Editor
## Quick Reference
| 任务类型 | 执行路径 |
| 从零创建 PPT | 阅读 references/create-from-scratch.md |   ← 渐进式披露
```

**渐进式披露（progressive disclosure）**：SKILL.md 只放概览与路由表，详细 API/设计系统放 references/，agent 按需再读——控制上下文成本。

### 5.2 技能的三个分发渠道

| 渠道 | 位置 | 特点 |
|------|------|------|
| 技能市场 | `skills-marketplace/skills/`（本机 268 个） | 独立技能，`version.txt` + README + icons，etag/sha256 增量更新 |
| 插件捆绑 | 插件内 `skills/` 子目录（plugin.json `"skills": "./skills"`） | 随插件安装；document-skills 插件捆绑 `skills/pdf`、`skills/pdfkit-py` |
| 连接器附带 | `connectors/skills/`（如 fbs-connector） | 连接器带来的操作技能 |

### 5.3 PPT/Word/表格助手实现对照（重点案例）

| 助手 | 实现方式 | 关键文件 |
|------|----------|----------|
| **pptx-generator**（通用） | 纯文档技能：PptxGenJS 从零生成 + markitdown 读取 + XML 工作流编辑模板；自带设计系统（色板/字体/版式配方） | SKILL.md + references/{design-system, editing, pitfalls, pptxgenjs, slide-types}.md |
| **tencent-pptx**（腾讯） | 文档技能 + **vendor 运行时懒加载**（hook 触发解包 tencent-slidep 幻灯库）；组件化参考文档（animation/box/chart/diagram/math/qrcode/svg/slide…每个幻灯片组件一篇） | skills/tencent-pptx/SKILL.md + references/component-*.md + hooks + vendor/*.tar.gz |
| **tencent-docx**（Word） | 同 tencent-pptx 模式（文档技能 + 运行时） | 插件结构同上 |
| **sheetagent**（Excel） | **MCP 服务器型**：`node mcp/start.mjs` stdio + `defer_loading: true`，本地模式 + 远端 `docs.qq.com/api/v6/sheet/mcp` 兜底；同时带 commands + skills | plugin.json 的 mcpServers 段 |
| **tencent-docs**（在线文档） | 技能教会 agent 调用**本地 tencent-docs-engine 服务**（端口写在 `~/.workbuddy/tencent-docs-engine.port`），文档引擎负责在线文档的创建/编辑/导出 | SKILL.md + references/{auth, docengine, slide, smartsheet, space, workflows} |
| **document-skills**（PDF） | 插件捆绑 pdf / pdfkit-py 两技能 | plugin.json `"skills": ["./skills/pdf", ...]` |

> **三种助手范式**：纯文档技能（教知识，零依赖）/ 文档技能 + 懒加载运行时（vendor 解包）/ MCP 工具型（结构化操作，强一致性）。WorkPivot 的文档助手应按操作类型选范式：生成类用文档技能+运行时，编辑类用 MCP。

### 5.4 会话级挂载（⚡技能「添加」）

界面上技能可逐个「添加」到当前会话。结合内核证据（product.json 工具 `Skill`、`SkillManage`、feature `DeferToolLoading`）推断的机制：**会话维护一个已挂载技能列表，挂载即把该 SKILL.md 注入会话上下文（或注册为可被 Skill 工具按触发词调用），`DeferToolLoading` 允许延迟注册**。会话级挂载状态的持久化未见独立文件（推测在会话/对话状态内），此处标注为「界面行为已证实、存储位置待验证」。

---

## 6. 连接器系统（Connectors）

### 6.1 连接器 = 远程 MCP 服务器 + 启停状态

`connectors-marketplace/connectors/` 有 40+ 连接器（baidu-netdisk、canva、camscanner、cloudbase、ctrip…）。安装后在 `connectors/{userId}/mcp.json` 注册为 `connector:{name}`：

```json
{
  "mcpServers": {
    "connector:linear-mcp": { "url": "https://mcp.linear.app/mcp", "disabled": true },
    "connector:canva-ai":   { "type": "streamableHttp", "url": "https://mcp.canva.com/mcp",
                             "timeout": 60000, "disabled": true }
  }
}
```

所有连接器再经**本地聚合代理**（`~/.workbuddy/.mcp.json` 中的 `connector-proxy → http://127.0.0.1:{port}/mcp`）统一暴露给 agent——agent 只见一个 MCP 端点，代理负责路由/鉴权/聚合（实测该代理聚合了 agent-mail 等）。

### 6.2 每用户状态与凭据加密

`connectors/{userId}/connector-states.v3.json`：

```json
{
  "enabled": [],
  "accountIdentityKey": "{userId}|fq9v0egzbhfk|enterprise",   // ← 含租户/企业标识
  "userDisabled": {},                    // 用户级停用
  "disabledToolsOverrides": {},          // 工具粒度停用
  "headerOverrides": {}, "envOverrides": {},
  "encryption": {                        // ← 凭据加密方案（配合 .master.key 文件）
    "scheme": "aes-256-gcm",
    "kdf": "hkdf-sha256",
    "salt": "...", "keyCheck": "...", "createdAt": ...
  },
  "version": 3
}
```

目录内还有 `.master.key`（每用户主密钥）——连接器凭据 aes-256-gcm 加密存储（对比：自配模型的 API key 是明文，见主文档 §7）。

---

## 7. 场景与交互模式（也是插件！）

「场景」在 WorkBuddy 里的落地 = **welcomemode 插件**；对话的行为风格 = **interactionmode 插件**。全部在 workbuddy-builtin：

| 插件 | category | 内容 | 作用 |
|------|----------|------|------|
| welcomemode-work | welcomeMode | agents/work.md + prompt.tpl + settings.json + `workbuddy.dependencies: [{type:mcp, name:netdrive}]` | 「工作」场景：专属 agent + 提示模板 + 声明依赖的 MCP（网盘） |
| welcomemode-code / welcomemode-design | welcomeMode | 同上 | 编码场景 / 设计场景 |
| interactionmode-expert | interaction | fragments/{agent-loop, current-mode, interaction, result-presentation, tool-use}.md | 专家模式的提示词分片与**工具策略** |
| interactionmode-ask / craft / plan | interaction | fragments | 问答 / 制作 / 规划模式的提示词分片 |

fragment 中出现模板占位符（`{# {{ PluginAgentPrompt }} #}`），说明运行时用模板引擎组装各插件贡献的提示词分片。

---

## 8. 整体加载链路图

```
                    ┌────────────── 分发层（云）──────────────┐
                    │ codebuddy-plugins-official / cb_teams   │
                    │ / experts / workbuddy-builtin（zip 市场）│
                    └───────┬───────────────────┬─────────────┘
                        zip 下载               内置随应用
                            │ (etag/sha256 增量)  │
                    ┌───────▼───────────────────▼─────────────┐
                    │ ~/.workbuddy/plugins/                     │
                    │  marketplaces/{市场}/  + cache/{市场}/    │
                    │  {插件}/{版本}/  (.in_use/{pid} 引用锁)    │
                    │  installed_plugins.json + settings.json  │
                    │  (enabledPlugins 启用开关)                │
                    └───────┬──────────────────────────────────┘
            ┌───────────────┼────────────────┬─────────────────┐
            ▼               ▼                ▼                 ▼
      agents/*.md       skills/*/         hooks/hooks.json   mcpServers
      （专家人格，       SKILL.md         （PreToolUse 等，   （插件自带 MCP：
       maxTurns 预算，   （触发词+         懒加载运行时）      stdio/defer_loading）
       双语元数据）       references）
            │               │                │                 │
            └───────┬───────┴────────┬───────┘                 │
                    ▼                ▼                         ▼
              会话 Agent 上下文组装（interactionmode fragments 注入 +
              Skill 工具注册[DeferToolLoading] + connector-proxy 聚合）
                    │
                    ▼
        对话页：⚡技能挂载 / 召唤专家 / 快捷芯片(quickPrompts)
```

---

## 9. WorkPivot 实现参考（可直接抄的设计）

### 9.1 目录与数据结构规范（建议）

```
~/.workpivot/
├── plugins/
│   ├── installed_plugins.json          # {name@market: [{scope, version, installPath, installedAt}]}
│   ├── known_marketplaces.json         # 市场：zip url + autoUpdate + manifest
│   ├── marketplaces/{market}/          # 市场内容（experts 市场专门放专家）
│   └── cache/{market}/{plugin}/{ver}/  # 多版本并存 + .in_use/{pid} + .orphaned_at
├── skills-marketplace/skills/{skill}/  # SKILL.md + references/ + scripts/
├── connectors/{tenantUserId}/
│   ├── mcp.json                        # connector:{name} → 远程 MCP URL + disabled
│   ├── connector-states.json           # enabled/userDisabled/disabledToolsOverrides
│   └── master.key                      # aes-256-gcm + hkdf-sha256 凭据加密
└── settings.json                       # enabledPlugins + sandbox 白名单 + 通道配置
```

### 9.2 关键设计决策清单（按重要性）

1. **统一插件包格式**：manifest 声明 `agents / skills / commands / hooks / mcpServers` 五类扩展点——专家、技能、命令、钩子、连接器**不分五套系统**，一套包格式、一套生命周期
2. **多版本目录 + PID 引用锁 GC**：支撑运行中热升级，不重启应用
3. **懒加载三件套**：`defer_loading`（MCP 用到才起）+ PreToolUse hook 解包 vendor 运行时 + DeferToolLoading（技能延迟注册）——私有化离线包也能保持「核心小、按需装」
4. **专家 = agent 定义文件 + 展示元数据**：`agents/*.md`（frontmatter 含 maxTurns）+ plugin.json 双语字段（displayName/profession/displayDescription/tags/quickPrompts/defaultInitPrompt/avatar/categoryId）。UI 完全由元数据驱动，无需硬编码
5. **行业分类枚举**（categoryId 如 `02-Engineering`、`07-SalesCommerce`）作为专家广场的分组维度，也是推荐系统的输入
6. **触发词进 description**：技能自主调用依赖模型读到 description 中的 Triggers，不需要额外路由服务
7. **渐进式披露**：SKILL.md 概览 + references/ 细节，控上下文成本
8. **推荐/安装工具化**：内置 `search_plugins` / `suggest_plugin_install` 工具，让「发现→推荐→安装→召唤」在对话内闭环
9. **生态自举**：用 skill 管理生态（expert-manager / skill-creator / 合规审查），专家可以由用户/企业自建——这正是「支撑不同企业的智能化应用」的机制核心
10. **凭据加密**：连接器凭据 aes-256-gcm（WorkBuddy 已做），**且要把自配模型 API key 也纳入**（WorkBuddy 未做，明文是反面教材）
11. **场景（welcomemode）插件带声明式依赖**（`dependencies: [{type:mcp,name}]`），进入场景时自动确保依赖可用
12. **本地聚合 MCP 代理**：agent 只见一个 MCP 端点，路由/鉴权/启停集中在代理层处理

### 9.3 与 WorkPivot 私有化目标的结合

- 四个市场中 `experts` 市场的形态最适合我们演化为「**企业专属专家市场**」：企业自建专家包（本地 zip 目录 / 私有市场服务），`isBuiltIn: false`、支持企业内分发与审批（结合 expert-manager 的合规审查思路）
- 插件 zip + sha256 的分发方式天然适合**离线私有化环境**：市场可以是纯静态文件服务
- quickPrompts/defaultInitPrompt 的双语结构可扩展为「企业话术模板」，行业客户可定制开场引导

### 9.4 待验证项

- [ ] 会话级技能挂载列表的持久化位置（界面行为已证实，存储未见）
- [ ] experts 市场完整目录（本机仅 3 个专家缓存，云端目录规模待抓包/接口确认）
- [ ] `search_plugins` / `suggest_plugin_install` 工具的完整协议（在 CodeBuddy CLI 开源仓库确认）
- [ ] connector-proxy 聚合代理的路由/鉴权协议细节

## 附：本机实测样本索引

| 样本 | 路径 |
|------|------|
| 专家插件（工作台搭建师） | `plugins/marketplaces/experts/plugins/workspace-builder/` |
| 专家 agent 定义 | 同上 `agents/workspace-builder.md`（maxTurns: 50） |
| 召唤历史 | `app/data/expert-history.json` |
| 懒加载运行时 | `plugins/cache/workbuddy-builtin/tencent-pptx/v20260727/`（hooks + vendor tarball） |
| MCP 型助手 | `plugins/cache/workbuddy-builtin/sheetagent/0.1.1784877812/` |
| 纯文档技能 | `skills-marketplace/skills/pptx-generator/` |
| 插件捆绑技能 | `plugins/cache/cb_teams_marketplace/document-skills/1.0.0/skills/` |
| 场景插件 | `plugins/cache/workbuddy-builtin/welcomemode-work/0.1.5/` |
| 交互模式插件 | `plugins/cache/workbuddy-builtin/interactionmode-expert/0.1.1/` |
| 生态运营技能 | `workbuddy-builtin/skill-{expert-manager,recommend-experts,skill-creator,...}` |
| 连接器状态 | `connectors/{userId}/connector-states.v3.json` + `.master.key` |
