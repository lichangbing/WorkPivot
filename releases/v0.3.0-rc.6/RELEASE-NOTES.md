# WorkPivot v0.3.0-rc.6

| 项 | 值 |
| --- | --- |
| 发布日期 | 2026-11-04 |
| 发布阶段 | RC 正式发布工程门禁 |
| 数据库 schema | v72（无新增迁移） |
| 上一版本 | `v0.3.0-rc.5` / schema v72 |
| 部署范围 | 本地测试环境和正式服务器 |
| 服务端镜像 | `workpivot-server:rc6-20261104` |
| Windows 客户端 | `0.3.0-rc.6` 便携版 |
| Android 源码版本 | `1.8` / versionCode 9，待 SDK 和签名构建 |

## 发布重点

RC.6 不增加业务功能，集中关闭正式发布所需的可观测性、安全审计、依赖风险和制品门禁。正式服务器已完成 schema v70 → v72 升级，旧镜像、数据库、文件卷和配置均有回退材料。

## 新增

- `GET /api/ready`：检查业务数据库、认证数据库和文件存储，具备关键条件才返回 200。
- `GET /api/metrics`：提供 Prometheus 文本指标，支持独立 `WORKPIVOT_METRICS_TOKEN`。
- 管理后台“系统状态”：展示版本、依赖、连接池、文件容量、任务/自动化/记忆/解析队列、备份和告警。
- 结构化访问日志和 `X-Request-ID` 请求关联；日志不保存正文、查询参数、Token 或密钥。
- Prometheus 抓取配置和告警规则，覆盖未就绪、数据库、磁盘、连接池、过期租约和备份状态。
- 备份 CLI 可原子写入最近一次成功/失败状态供系统状态读取。

## 安全和依赖

- `express` 升级至 `5.3.0`。
- `adm-zip` 升级至 `0.6.1`。
- `pptxgenjs` 升级至 `4.0.1`。
- `body-parser`、`proxy-addr`、`image-size` 和 `brace-expansion` 使用已修复版本。
- 生产依赖审计从 1 critical / 10 high 降至 **0 critical / 0 high**；仍有 8 moderate、4 low，进入持续跟踪。
- 内部权限、路径、SSRF、密钥、审计和运行恢复测试继续通过。
- 仓库未发现已跟踪的 `.env`、私钥、keystore、常见云密钥或个人凭据。

## 验证

- PostgreSQL：867/867。
- 全量评测：42 个套件、678 项断言。
- Office 生成：22/22；Office 修改与转换：16/16。
- TypeScript、ESLint、依赖边界、严格许可、文档链接和 Web/移动端构建通过。
- 本地和正式服务器：服务 healthy，`/api/health`、`/api/ready`、首页和管理端通过。
- Windows RC.6 便携包已构建，SHA-256：`c4d090298b85c77e24023eef63423cf6f735c17abc57e661391a4b34bf8252d6`。

## 未完成外部门禁

- Android RC.6 APK 未构建：当前主机缺少 Android SDK、JDK 和发布签名环境。
- 第二台物理 Android 设备尚未完成登录、任务、纠正、审批和断线恢复验收。
- 24 小时真实混合业务负载尚未执行。
- 至少 5 个脱敏真实业务形态任务尚未执行。

因此 RC.6 可以部署和受控使用，但**现在不创建 `v0.3.0` 正式标签**。

## 升级与回退

- 升级前备份已保存；schema v70 → v72 已通过。
- 回退服务端镜像：`workpivot-server:pre-rc6-20261104`。
- 本地和远程回退记录见项目部署文档；回退数据库时使用各自的发布前联合备份。
