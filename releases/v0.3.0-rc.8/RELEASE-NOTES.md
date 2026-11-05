# WorkPivot v0.3.0-rc.8

> 发布日期：2026-11-05
>
> 状态：候选版，已部署本地和正式服务器
>
> schema：v72（无迁移）
>
> 正式标签：不创建

RC.8 聚焦客户端更新、移动恢复和正式业务交付验收。服务端、Web、Windows 和 Android 继续保持同一套项目、任务、记忆、业务事实和成果版本事实源。

发布提交：`5e4dd00b9f3ab0e5a9ffa541c5433eeec03f7c81`；候选标签 `v0.3.0-rc.8` 已推送 GitHub。

## 主要变更

### 客户端更新

- Web 检测服务端版本变化并显示非阻塞刷新提示，不自动打断运行中任务。
- Android 1.11 支持更新检查、前台恢复检查、HTTPS 断点续传、200 MB 上限和 APK 身份校验。
- Android 安装前校验 SHA-256、包名、versionCode 和签名摘要；最终安装由系统安装器确认。
- Windows RC.8 支持启动、唤醒和手动检查更新，下载后校验 ZIP/EXE 摘要并打开已验真制品。
- `/api/client-updates` 可配置、可暂停；清单只允许 HTTPS，并按平台、渠道、版本、API 协议和发布日期筛选。

### 移动端恢复

- 工作区和任务 SSE 使用带抖动的指数退避，网络恢复或应用回到前台时按持久水位立即重连。
- 正常长连接轮换保持静默，恢复后清除传输故障状态。
- 多个局部轮询共享一个全局恢复提示；401 去重退出，409 游标重新取快照。
- 待确认消息复用原请求标识，恢复连接不会重复提交。
- Android 1.11 保留发送按钮、草稿、当前任务和三层记忆设置。

### Office 与 PDF

- 真实 DeepSeek、Worker 和 Office 链路生成 DOCX、XLSX、PPTX、6 页 PDF 和 Markdown 校正报告。
- Office 生成、修改/转换和固定视觉集回归通过。
- 直接 PDF 仍由受控 HTML 生成，Office 转 PDF 仅作为预览派生，不作为读取、知识入库或事实证据。

## 客户端制品

| 平台 | 版本 | SHA-256 |
| --- | --- | --- |
| Android | `1.11` / build `12` | `bf90c325c077275d0cd3d8686a43f88c32c3a2e1f330d063bcf978560161ee6f` |
| Windows | `0.3.0-rc.8` / build `8` | `41c79f54152ca634e3457bc27191fae4a80620e7f3fa8d290c8ec2d0ae7f76c6` |

Android 下载：<https://115-191-1-188.sslip.io:80/downloads/WorkPivot-android-1.11.apk>

Windows 下载：<https://115-191-1-188.sslip.io:80/downloads/WorkPivot-Windows-0.3.0-rc.8-portable.zip>

## 验证结果

| 门禁 | 结果 |
| --- | --- |
| 全量评测 | 44 个套件、693 项断言通过 |
| PostgreSQL | 867/867 |
| TypeScript / ESLint / 依赖边界 / 文档链接 | 通过 |
| 客户端更新 | 8/8 |
| 移动端断网恢复 | 7/7 |
| Office 生成 | 22/22 |
| Office 修改与转换 | 16/16 |
| Office 固定视觉样本 | 20/20 |
| 真实业务验收 | 5/5 |
| Android 1.11 真机安装 | 通过 |
| HONOR Wi-Fi/蜂窝切换 | 通过 |
| 断网草稿保留 | 通过 |
| RC.8 隔离短稳 | 602 秒、81 轮通过 |

真机证据位于 `local-runtime/acceptance/android-runtime/`；真实业务报告位于 `local-runtime/acceptance/rc8-business/report.json`；短稳报告位于 `local-runtime/reports/soak-rc8-20261105-201400.json`。这些是本地运行证据，不提交敏感凭据或真实客户资料。

## 部署

- 本地：`http://127.0.0.1:39990/`，镜像 `workpivot-server:rc8-20261105`。
- 正式：<https://workpivot.lichb.cc.cd/>，schema v72。
- 健康、就绪、首页、管理端、客户端更新清单和 Prometheus 抓取通过。
- 正式服务器发布时磁盘使用率约 95%；2026-11-05 清理旧镜像、退出容器、日志和临时制品后降至约 52%，可用约 19 GB。当前 RC.8、RC.7 回退镜像、业务卷和历史备份均保留。

## 未关闭门禁

- RC.8 真实模型、Browser、Worker 和 Office 混合 24 小时负载未完成。
- 1.9 → 1.11 原地覆盖升级未完成。HONOR Android 16 拒绝 release 包从 versionCode 12 降级到 10，`adb install -r -d` 返回 `INSTALL_FAILED_VERSION_DOWNGRADE`；未通过卸载清数据规避该限制。
- Windows RC.8 尚未在目标 Windows 机器执行实际安装、替换和失败回滚。
- 正式 `v0.3.0` 版本仍不能在上述门禁关闭前发布。

## 使用与回退

1. 更新前确认当前运行任务已结束或可从持久检查点恢复。
2. Android 更新由应用下载并校验后交给系统安装器；拒绝来源、摘要或签名不一致的包。
3. Windows 便携包替换前保留上一解压目录；服务端任务状态不以本地客户端目录为准。
4. 服务端回退使用 RC.7 镜像并保留 schema v72；本次无数据库迁移。
5. 若部署异常，先停止流量并核对数据库、文件卷和配置备份，禁止只恢复其中一项。
