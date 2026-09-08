# WorkPivot

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
