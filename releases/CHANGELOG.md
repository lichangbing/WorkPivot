# 变更日志

所有对外发行版本的变更记录。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循[语义化版本](https://semver.org/lang/zh-CN/)。每个版本发布时同步在其 `vX.Y.Z/RELEASE-NOTES.md` 中写详细说明。

## [Unreleased]

### 计划中

- 企业形态批次 4（服务端集中部署 / 检索增强 / 策略下发）——待 Q5/Q6 决策排期
- 自动更新、代码签名

## [v0.1.0] - 2026-09-07（发行候选）

> 详细说明见 [v0.1.0/RELEASE-NOTES.md](v0.1.0/RELEASE-NOTES.md)

### 新增

- M0 全量：登录门与权限四档、agent 循环七工具、成果核验闸门、断点续跑、任务/转写持久化、Word 生成（OWB 范式）、技能热加载、评测基线
- M1 批次 1：双层记忆（手写区/条目区）+ 晋升确认 + 项目记忆 + 一键关闭
- M1 批次 2：项目-任务两级结构、临时任务、/admin 管理后台、ZCode 式 UI 重构（附件托盘/@补全/拖拽上传）
- M1 批次 3：Anthropic 协议、企业 Word 模板（占位符替换）、PPT/Excel 生成、定时任务（cron+补跑+通知）、审计查看/导出、回收站、bash 进程树终止、记忆管理 UI、计划工具（update_plan）
- 桌面打包：NSIS 安装包 + 便携 zip，安装态冒烟通过

### 私有化部署注意事项

- Windows 10/11 x64；数据目录 `%USERPROFILE%\.workpivot\` 与 `%USERPROFILE%\WorkPivot\workspace\`
- 升级直接覆盖安装（数据保留）；回滚卸载重装旧版
- 未代码签名，SmartScreen 首次运行需「仍要运行」

## 模板

```markdown
## [vX.Y.Z] - YYYY-MM-DD

### 新增
- （新特性）

### 变更
- （对现有功能的修改）

### 修复
- （缺陷修复）

### 破坏性变更
- （不兼容的改动与迁移方法）

### 私有化部署注意事项
- （环境要求变化、升级/回滚要点）
```
