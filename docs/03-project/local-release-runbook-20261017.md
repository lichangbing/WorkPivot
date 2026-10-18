# Linux 单机发布入口与验收（2026-10-17）

范围：SU-R4-01，当前 Linux Docker Compose 部署。前提是 Docker、Compose、Node.js 22、pnpm 及依赖可用，数据库镜像和运行基础镜像已在本机，Compose、受保护凭据、宿主 Worker、浏览器网络已配置。本入口不是跨平台安装器，也不负责自动安装 Docker、下载模型或初始化远程服务器。

## 固定入口

在仓库根目录执行：

```bash
node code/scripts/build-local-release.mjs workpivot-server:<版本> tmp/local-deploy/<新目录>
node code/scripts/release-local.mjs preflight local-runtime/release-local.json workpivot-server:<版本>
node code/scripts/release-local.mjs upgrade local-runtime/release-local.json workpivot-server:<版本>
node code/scripts/release-local.mjs status local-runtime/release-local.json
node code/scripts/release-local.mjs start local-runtime/release-local.json
node code/scripts/release-local.mjs rollback local-runtime/release-local.json
```

全新实例使用 `install` 替代 `upgrade`，要求没有应用容器、业务数据库为空且应用/认证角色尚不存在，文件卷为空。它创建受限角色、迁移 schema、初始化卷权限并启动检查；初始化令牌仅从受保护配置读取。凭据最少24字符，主加密密钥应至少32字符。失败后保留现场，不自动删除数据库或重设已有角色。

配置 JSON 包含 compose、envFile、stateRoot 的绝对路径，以及 project、databaseContainer、adminUser、network；可选 protectedFiles 保存浏览器和 Worker 配置。实际配置和所有快照位于 Git 忽略的 `local-runtime/`，目录0700、配置0600。不要将配置内容、环境变量或完整 Compose 展开结果贴入日志。

**升级后必须通过上述入口启动，或显式叠加 stateRoot/active.compose.json。** 单独运行旧基础 Compose 会选择升级前数据库和文件卷。覆盖文件保存当前镜像ID、数据库及文件卷映射，不能删除。宿主 Worker 独立管理，升级执行器需单独确认空闲、备份环境文件并重启服务。

## 数据保护与失败处理

预检检查活动任务、镜像、配置权限和磁盘余量；空闲后停止 API，再次检查后台作业。升级前离线转储数据库、复制文件及配置，记录 SHA256。副本数据库和命名卷使用唯一名称；只对副本执行迁移，随后核验迁移校验和、受限数据库角色、RLS、在线及回收站原件哈希。成功后切换应用，保留原库与原卷。

辅助容器的卷挂载设置 `volume-nocopy`，防止 Docker 对空卷自动复制镜像目录、意外改变文件卷的属主。文件写入用认证后的上传接口验证，不能只检查 `/api/health`。

发布目录保存 release.json、previous.json、schema.env、backup/，active.json 指向当前发布。备份格式为 `workpivot-offline-release`，用于该发布入口，不应直接传给既有 `workpivot-backup.mts`。原库、原卷和失败候选副本不会自动清除；人工清理前需确认保留策略和备份。

迁移失败恢复原服务。启动失败先停止新实例，仅在数据库和文件无新增写入时切回。手动 rollback 同样先备份当前数据，并比较全库与文件指纹；升级后即使只是登录会话写入也可能阻止直接回退。此时使用匹配版本的联合备份、遗忘保留清单和隔离恢复流程，不能删迁移记录或强行指向旧库。进程异常留下 release.lock 时，先核对 PID、发布阶段与容器，不能盲目清锁。

## 验收与交付状态

专项测试：`WORKPIVOT_TEST_RELEASE_IMAGE=<候选镜像> node code/eval/local-release.mjs`。使用独立 Compose 项目、临时数据库和合成原件，完成后只清理本次夹具。

本轮一次性Compose演练13项通过：安装、认证上传、重复安装拒绝、迁移失败恢复、升级与原件校验、原库保留、备份、损坏拒绝、无写入回退、有写入拒绝及数据保留、发布锁。真实业务文档、长稳、第二台物理设备及跨平台安装均不在本轮已验收范围。


## 本机部署记录

- 地址：http://127.0.0.1:39986；schema36。
- 应用镜像：workpivot-server:local-su-r4-release-20261017；ID `sha256:910736efc0b67e195009d3a60f877eb5ddf4be1d3d933af2408ab26fc959e4be`。
- 执行器：workpivot-executor:office-stage-20261017-v2；原Worker配置受保护备份于local-runtime/worker.env.before-su-r4-20261017。
- 当前数据库：wp_r1792232252550；卷：workpivot-local-r1792232252550-files。
- 原数据库workpivot/schema31与原文件卷workpivot-local_files保留。
- 升级前备份：local-runtime/releases/r1792232252550/backup；凭据不入库。
- 四项Office资源已发布；新office-routing未自动加载，已有自动化固定版本不变。
- 本轮部署检查：健康/首页/管理页/未认证401；登录后个人数据、回收站、用量、会话、自动化、任务接口均200；Worker健康且空闲。浏览器回收站实际显示8条保留数据、各类型过滤和30天提示。

登录及发布技能已产生新写入，直接rollback会拒绝。此为保护机制，不应手工删基线或迁移记录绕过。完整故障矩阵、长稳、安全补强和真实业务文档仍待后续验收。本轮新增发布代码尚未提交推送。

本轮新增脚本ESLint、JavaScript语法检查及git diff --check通过。未改动业务实现，未重复运行历史710项数据库回归。


## 2026-10-18 候选验证（未切换业务服务）

schema37候选完成一次性Compose安装/迁移/回退13项及API强制终止、两次重启恢复3+13+13项检查，原业务schema36未变。候选浏览器镜像也已准备；浏览器源码和API必须配套升级，不能仅切换API。旧自动化域名授权向严格URL的兼容规则尚待用户确认，故目前不部署。最终许可/参数绑定的后续小修复通过源码回归，最终发布前需重建候选镜像，不能使用较早构建快照冒充最终代码。

本轮联合备份恢复40项、数据库770项、工具授权18项、浏览器21项、自动化49项通过。真实业务样本、第二设备、长稳及真实模型配置仍缺；历史依赖abbrev/buffers许可声明缺失未豁免，未宣称正式版全门槛通过。
