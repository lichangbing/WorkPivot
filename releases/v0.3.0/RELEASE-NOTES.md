# WorkPivot v0.3.0

> 发布日期：2026-11-05
>
> 状态：单服务器正式版，已部署本地与正式服务器
>
> schema：v72（无迁移）
>
> 发布范围：Web + Windows + Android Beta 客户端

`v0.3.0` 是 WorkPivot 首个单服务器正式版。Web、Windows 和 Android 客户端共用服务端的项目、任务、运行、审批、记忆、业务事实和成果版本事实源。

## 正式范围

- 单服务器 Docker Compose，PostgreSQL + pgvector，本地持久文件卷。
- Web 用户端和管理端正式支持。
- Windows 10/11 x64 便携客户端。
- Android 7.0 及以上 Beta 客户端。
- OpenAI 兼容和 Anthropic Messages 协议；Browser、Worker、SearXNG、Office 转 PDF 和 OIDC 按配置启用。
- 单机备份、恢复、监控、审计、限额、用户管理和运行排障。

不包含多 API/多 Worker、跨实例锁、共享对象存储、自动故障转移或 Kubernetes；这些属于 `v0.4.0` 及后续版本。

## 交付能力

- 项目、任务、流式过程、中断恢复、成果版本、预览和下载。
- Web、Windows 和 Android 客户端安全更新检查与下载校验。
- Android HTTPS 断点续传、APK 包名/版本/SHA-256/签名校验和系统安装确认。
- 三层记忆、项目业务事实、确认式知识入库、混合检索和来源引用。
- DOCX/XLSX/PPTX 生成与修改、直接 PDF、可选 Office 转 PDF 预览。
- 持久交互、运行中纠正和后续队列、资源范围增量、跨端 SSE 同步。
- 自助注册、停用/启用、密码重置、会话撤销、对话/Token/上传/并发限额。

## 发布验证

| 门禁 | 结果 |
| --- | --- |
| 全量评测 | 44 个套件、693 项断言通过 |
| PostgreSQL | 867/867 |
| TypeScript / ESLint / 依赖边界 / 文档链接 | 通过 |
| 生产依赖审计 | 0 high、0 critical |
| 真实 DeepSeek + Worker/Office 业务交付 | 5/5 |
| Office 生成 / 修改转换 / 视觉样本 | 22/22、16/16、20/20 |
| RC.8 隔离短稳 | 602 秒、81 轮、每轮 17 项 |
| HONOR Android 16 真机 | 安装、Wi-Fi/蜂窝切换、草稿保留通过 |
| Android 1.9 → 1.11 覆盖升级 | GitHub 硬件加速模拟器通过，应用数据目录标记保留 |
| Windows RC.6 → 0.3.0 覆盖替换 | Windows GitHub Runner 上两次启动成功，用户数据目录保留 |

Android 真机测试证据位于 `local-runtime/acceptance/android-runtime/`；真实业务报告位于 `local-runtime/acceptance/rc8-business/report.json`。

## 长稳豁免

产品负责人于 2026-11-05 明确决定不执行原计划的 24 小时真实模型/Browser/Worker/Office 混合负载，原因是耗时过长。

因此本版本发布依据是：全量自动化、PostgreSQL、真实业务交付、Office 视觉回归、602 秒 RC.8 隔离短稳、Android 真机/模拟器升级和 Windows 真实运行时覆盖替换。`v0.3.0` **不代表真实混合 24 小时长稳已通过**；后续部署应继续通过监控观察任务、资源、错误率和副作用。

## 客户端制品

| 平台 | 版本 | SHA-256 |
| --- | --- | --- |
| Android | `1.11` / build `12` | `bf90c325c077275d0cd3d8686a43f88c32c3a2e1f330d063bcf978560161ee6f` |
| Windows | `0.3.0` / build `9` | `0013159372c3fd372f8b6929133ae129f38e0b913a7840c57a7d3b85668f4ca9` |

Android 下载：<https://115-191-1-188.sslip.io:80/downloads/WorkPivot-android-1.11.apk>

Windows 下载：<https://115-191-1-188.sslip.io:80/downloads/WorkPivot-Windows-0.3.0-portable.zip>

## 部署与回退

- 本地：`http://127.0.0.1:39990/`，镜像 `workpivot-server:0.3.0-20261105`。
- 正式：<https://workpivot.lichb.cc.cd/>，镜像 `workpivot-server:0.3.0-20261105`。
- schema 保持 v72，无数据库迁移。
- RC.8 和 RC.7 镜像保留为回退材料。
- 发布前联合备份包含 PostgreSQL、文件卷和配置；恢复时必须一起核对，不能只恢复数据库或只恢复文件卷。

## 已知限制

- Android 仍是 Beta 客户端，不提供应用商店分发。
- Windows 客户端未做代码签名，SmartScreen 可能提示。
- 复杂 Office 版式不承诺与 Microsoft Word/WPS 像素级一致。
- 企业 IdP、共享知识/文件、跨项目审批和多服务器高可用仍属于后续版本。
- 24 小时真实混合负载未执行，属于已接受发布边界。
