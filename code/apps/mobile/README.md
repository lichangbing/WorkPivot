# WorkPivot Mobile

Android/iOS 共用 React 界面与 Capacitor 原生工程。首批目标为荣耀 MagicOS 10。

## 本地预览

在 `code` 目录执行：

```sh
pnpm install --frozen-lockfile
pnpm dev:mobile
```

打开 `http://127.0.0.1:39990`。生产构建通过
`VITE_MOBILE_DEFAULT_SERVER_URL` 预置默认后台地址；当前外网内测构建默认连接
`https://115-191-1-188.sslip.io:80`，用户仍可在“服务器设置”中改为其他 HTTPS 根地址。
浏览器开发模式允许回环 HTTP，发行版仅允许 HTTPS。浏览器预览的令牌仅在内存保存；
原生端使用安全存储插件。

后台由部署方配置 `WORKPIVOT_MOBILE_ORIGINS`：

```text
https://localhost,capacitor://localhost
```

本机网页开发额外加入 `http://127.0.0.1:39990`。此设置仅允许匹配来源读取响应，不代替 Bearer 身份校验。不要使用通配符；未配置时保持原来的同源行为。后台不支持基于 URL 子路径的移动连接。

## 构建

```sh
pnpm build:mobile
pnpm --filter @workpivot/mobile sync
pnpm --filter @workpivot/mobile android
```

Android 通过 Android Studio、SDK 36 与 JDK 21 构建；签名密钥和本机 SDK 路径不入库。本机已确认安装 SDK 36 和 Android Studio 自带 JBR 21，构建时通过进程级 `ANDROID_HOME`、`JAVA_HOME` 指定，不使用系统默认 Java 17。资源同步后，在 `android` 目录运行 `gradlew.bat assembleDebug` 生成测试签名 APK，位置为 `app/build/outputs/apk/debug/app-debug.apk`。iOS 工程已生成，仍需 Mac/Xcode、签名条件与真机验证。`com.workpivot.mobile` 为研发包标识，正式分发前核定所有权。

内部发布签名由环境变量注入，不写入仓库：

```text
WORKPIVOT_ANDROID_KEYSTORE
WORKPIVOT_ANDROID_STORE_PASSWORD
WORKPIVOT_ANDROID_KEY_ALIAS
WORKPIVOT_ANDROID_KEY_PASSWORD
```

设置后执行 `gradle assembleRelease`，输出
`app/build/outputs/apk/release/app-release.apk`。缺失签名环境变量时只生成未签名包。

2026-10-20 已完成首次 APK：前端生产构建、Capacitor 同步、Android `assembleDebug` 215 项任务成功；本轮使用本机 Gradle 8.14.4（官方 SHA-256 核对通过），仓库 wrapper 仍为 8.14.3。产物为测试签名的 1.0（版本号 1），4,434,816 字节，最低 API 24、目标 API 36，APK v2 签名校验通过。本地交付副本位于项目根 `local-runtime/releases/WorkPivot-android-1.0-debug.apk`，不入 Git。尚未安装到荣耀手机实测，不能视为正式发布或原生功能验收。

2026-10-28 重新构建 Android 1.5：安装包默认连接
`https://115-191-1-188.sslip.io:80`，服务器地址收在“服务器设置”中；构建和 APK v2/v3
签名校验通过。内测下载：
<https://115-191-1-188.sslip.io:80/downloads/WorkPivot-android-1.5.apk>。
SHA-256：`bbb6787fe3f16d5794094757d1eea8d204214f40a9a5815f57be91edf0d0a22c`。
这是 WorkPivot 独立内测签名包（versionCode 6），用于内部安装测试，不是应用商店或正式分发版本。

## 当前边界

第一阶段包含服务器登录、会话恢复、临时密码修改、项目/任务创建与选择、基础对话和 SSE、停止、工具本次审批、主题与退出。事件解析复用现有模块。

M02 已接入聊天中的任务记忆/专家经验建议、摘要核对与确认；设置中支持三层记忆逐条新增、修改、锁定和移入回收站，技能加载/卸载、既有 MCP 服务/工具启停、任务专家选择及产物名称清单。附件实际上传到后台，成功发送后清除待发送列表，聊天内按类型显示图标与名称。执行模式保存到后台；模型仅显示管理员已配置的模型，不提供不存在的用户模型切换接口。当前后台的自动模式仍需逐次确认写入等操作。

服务端会在每轮消息前自动加载当前读取范围内相关的已确认个人、项目和任务记忆，手机端不依赖模型主动调用记忆工具。自动召回有数量和字符上限，召回失败不阻断聊天；完整细节仍可通过记忆工具按需读取。消息发送按钮使用固定触控区域和独立圆形视觉层，避免窄屏布局压缩。

工作区使用用户级 SSE 同步项目、任务和运行状态；同一任务的回复、思考、工具步骤和审批通过任务事件流实时到达其他终端。连接断开后按持久序号补拉，不依赖客户端定时猜测或重复提交。

“本轮资料”沿用后台返回范围，用户可选择记忆层、专家及文件；未选中的记忆不会因手机端接入而自动获得读取/整理许可。来自其他页面的范围变更可能导致发送冲突，可点击“读取后台最新范围”后重试。上传附件自动包含于发送范围。个人/项目长期建议由后台十轮分析产生，任务建议逐轮产生；用户确认前不生效。

产物支持按需下载：浏览器保存文件；原生端接入系统打开及保存/分享。下载先校验大小（最多 10MB）和 SHA-256，拒绝截断或篡改文件；退出和页面离开取消下载。原生缓存限定在专用目录，下次冷启动或退出清理，交给用户保存的副本由用户管理。Android 仅共享专用缓存目录，iOS 已登记文件时间戳隐私用途。

技能加载后实际读取、MCP 启用后审批调用以及浏览器产物下载已通过隔离后台联调。原生打开/分享仅完成代码接入和工程同步，尚未真机验证。仍待 M03/M04：生命周期、国内通知、荣耀设备验证及签名安装包。无推送、无全量离线聊天缓存。Android/iOS 原生项目生成不等于安装包或真机验收。

参考：[手机方案](../../../docs/02-design/architecture/手机客户端方案.md)。
