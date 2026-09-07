# v0.1.0 发布说明（发行候选）

- **日期**：2026-09-07
- **状态**：发行候选（RC）——自动化评测 147 断言全绿、安装态冒烟通过；待人工验收彩排后转正式
- **形态**：Windows 桌面端（Electron 形态 A：客户端与服务层同进程，本地持久化）

## 产物清单

| 文件 | 说明 |
|------|------|
| `installers/WorkPivot-Setup-0.1.0.exe` | NSIS 安装包（约 120MB，非一键、可选目录、含卸载器） |
| `installers/WorkPivot-0.1.0-portable-win-x64.zip` | 免安装便携版（约 129MB，解压即用） |

## 系统要求

- Windows 10/11 x64
- 无需预装 Node.js（运行时已内置打包）
- 模型供应商二选一：内网 Ollama / DeepSeek 等 OpenAI 兼容 API / Anthropic API（在管理后台配置）

## 安装方式

- **安装版**：双击 `WorkPivot-Setup-0.1.0.exe`，选择目录后安装；静默安装 `WorkPivot-Setup-0.1.0.exe /S`
- **便携版**：解压 zip 到任意目录，运行 `WorkPivot.exe`
- 首次启动进入初始化：注册首个账户（自动成为管理员）→ 管理员在后台「模型管理」配置供应商 → 创建任务开始对话

## 数据位置

| 内容 | 路径 |
|------|------|
| 应用数据（账户/任务/记忆/审计/供应商密钥） | `%USERPROFILE%\.workpivot\` |
| 任务工作区（真实文件交付物） | `%USERPROFILE%\WorkPivot\workspace\` |
| 日志 | `%USERPROFILE%\.workpivot\logs\{日期}\main.log` |

## 本版能力（M0 + M1 批次 1-3）

- **对话与任务**：流式对话、agent 循环（read/write/ls/bash/grep/find 七工具）、强制收尾、卡循环检测、成果核验闸门（谎报打回）、断点续跑、任务计划卡（update_plan）
- **项目结构**：项目-任务两级（项目共享工作目录）、临时任务（零记忆注入、可删除）
- **安全**：登录门（bcrypt）、权限四档（变更前确认/计划模式/自动编辑/完全访问）、界外授权卡、高危命令拦截、审计日志（按天 JSONL，后台可查看/导出）、回收站删除
- **记忆**：双层记忆（手写区 MEMORY.md + 条目区）、晋升确认卡、项目记忆、一键关闭、管理 UI
- **文档生成**：Word（docx 库 + 企业模板 `{{占位符}}` 替换）、PPT（pptxgenjs）、Excel（exceljs）——内置技能带写后自检
- **多协议**：OpenAI 兼容（DeepSeek/Qwen/GLM/Ollama…）+ Anthropic Messages 协议
- **定时任务**：cron 触发、错过补跑、运行通知
- **技能**：SKILL.md 三层发现（内置/全局/项目）、斜杠激活、后台启停
- **管理后台**（`/admin`，仅管理员）：用户/模型（含协议下拉、验活、激活）/Skill 启停/企业模板/定时任务/审计与回收站

## 已知限制

- 命令沙箱为进程树终止轻量版（Windows taskkill /T + POSIX 进程组），真正 Job Object 强隔离在 M2
- 企业形态（服务端集中部署、检索增强、策略下发）未包含，依赖 Q5/Q6 决策排期
- 未做代码签名（内部发行）；SmartScreen 首次运行可能提示，选择「仍要运行」即可
- 自动更新未实现，升级需重新安装

## 升级与回滚

- **升级**：直接安装新版（数据目录独立于安装目录，账户与任务数据保留）
- **回滚**：卸载后安装旧版安装包；数据目录不随卸载删除，如需彻底清理手工删除 `%USERPROFILE%\.workpivot\`

## 验证记录

- 自动化评测：十套件 147 断言全绿（`code/eval/baseline.json` = pass）
- 打包验证：win-unpacked 冒烟 ✅ → NSIS 静默安装（/S）✅ → 安装态冒烟 ✅
- 人工验收彩排：⬜ 待执行（见 [docs/03-project/M0-验收清单.md](../../docs/03-project/M0-验收清单.md)）
