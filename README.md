# WorkPivot

## 当前交付状态（2026-09-13）

公网后台为 **v0.3.0-preview.32**：[用户端](https://workpivot.lichb.cc.cd/)、[管理端](https://workpivot.lichb.cc.cd/admin.html)。服务器为 192.168.1.158，前后端分离；用户业务数据按账号隔离，管理员不能查看其他账号的项目与任务。支持 Skill 包管理与加载、MCP、三层记忆查看编辑、成果浏览与下载、账号恢复及任务删除。任务删除入口在左侧任务旁和会话标题栏，清理范围见 [preview.32 发布说明](releases/v0.3.0-preview.32/README.md)。

本机 WSL 为 preview.31；Windows 安装包最新为 preview.31，网页由后台托管。macOS DMG 尚未生成，尚未发布 RC。

正式后台目前仍使用文件存储。PostgreSQL 基础代码及独立测试接口已实现，但尚未接入正式运行链路；RAG、项目级联删除、最近 5 轮对话分页、三层记忆自动更新仍待开发。详见 [数据库与知识开发计划](docs/03-project/tasks-postgresql-knowledge.md) 和 [服务器部署记录](releases/deploy/192.168.1.158.md)。以下早期里程碑记录仅供历史参考，以本节及各版本发布说明为准。

**2026-09-08 最新部署**：桌面v0.3.0-preview.2已改成纯客户端，默认连接独立后台http://192.168.1.158:39800，不再启动本地后台。管理入口为http://192.168.1.158:39800/admin；首次注册后由管理员配置模型。见[部署记录](releases/deploy/192.168.1.158.md)、[客户端安装说明](releases/v0.3.0-preview.2/README.md)与[架构说明](docs/02-design/architecture/独立后台与纯客户端.md)。旧单机数据未自动迁移，命令沙箱沿用未启用状态，暂未发布RC。

企业级智能工作台（类 WorkBuddy）：面向不同企业的智能化应用平台，支持多专家多模型协同、Agent 任务交付、企业知识库与团队协作，采用**私有化部署**交付，客户端以**桌面端**为主（Web 端 / IM 接入待研究后确定）。

## 当前阶段：M5 企业部署可靠性冲刺（4 周）· v0.2.1 已发布 🔄

M0 竖切已于 2026-09-05 收官（4 周全部完成，登录/权限四档/Agent 循环/技能/Word 生成跑通）。M1 迭代：批次 1 记忆系统、批次 2 验收反馈整改 + ZCode 式 UI 重构、批次 3 模型与文档补全（Anthropic 协议 / 企业 Word 模板 / PPT+Excel 生成 / 定时任务 / 记忆管理 UI / 计划工具）、批次 4a 拓扑二基础（任务所有权隔离：创建人私有/admin 全见；`WORKPIVOT_HOST` / `WORKPIVOT_MAX_PARALLEL` 可配；Docker 镜像 + compose 编排，浏览器 zero-install 访问）均已完成，评测 **156 项断言全绿**。已发布 v0.1.1（彩排修复 + 授权卡 AI 风险解读）→ v0.1.2（思考过程展示）→ v0.2.0（企业部署）→ v0.2.1（三栏拖拽调宽）。**当前进行：M5 企业部署可靠性冲刺**（2026-09-08 启动，4 周：权限与授权流程 → 文件与命令执行边界 → 账户·密钥·恢复 → 回归·整理与试点发布，达到受控企业试点条件，见 [tasks-m5.md](docs/03-project/tasks-m5.md)）；批次 4b 企业增强顺延。详见 [docs/03-project/plan-2026.md](docs/03-project/plan-2026.md)、[tasks-m1.md](docs/03-project/tasks-m1.md) 与本周 [周报](docs/03-project/weekly/2026-W37.md)。

## 目录导航

```
WorkPivot/
├── docs/                  # 全部文档，按工作流阶段编号
│   ├── 01-research/       #   产品研究：竞品 / 市场 / 用户 / 技术 / 研究结论
│   ├── 02-design/         #   设计：PRD / 架构 / UI-UX / 决策记录(ADR)
│   └── 03-project/        #   项目管理：里程碑、会议纪要、周报
├── code/                  # 源代码 monorepo（pnpm；见 code/README.md）
├── releases/              # 发行版本与私有化部署包（见 releases/README.md）
└── assets/                # 公共素材：logo、产品截图、架构图表源文件
```

最新版本 **v0.2.1**（[CHANGELOG](releases/CHANGELOG.md)）；企业 Docker 部署见 [部署说明](releases/deploy/部署说明.md)。

## 工作流程

各阶段的推进顺序与准入标准：

1. **研究（01-research）**：完成竞品、市场、用户、技术四条线的调研，产出《研究结论汇总》
2. **设计（02-design）**：以上一步结论为输入，产出 PRD、系统架构、UI/UX 设计与关键技术决策（ADR）
3. **开发（code）**：按设计文档实施，技术栈以 ADR 结论为准
4. **发布（releases）**：按语义化版本管理，每个版本含安装包、私有化部署包与发布说明

## 约定

- 目录名使用英文（小写 + 连字符），文档正文使用中文
- 文档模板统一以 `_template` 开头，新文档从模板复制后重命名
- 重要技术决策必须落 ADR（`docs/02-design/decisions/`），先决策后编码
