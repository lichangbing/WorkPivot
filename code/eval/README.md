# eval/ — 评测题库（K01）

网页专项：`pnpm eval:web`（URL/IP/DNS/重定向、解析和授权）；`pnpm eval:web-browser`（真实Chromium受控页面）；`pnpm eval:web-database`（临时PostgreSQL对话授权、定时采集、成果发布和撤销）。网络实测及测试浏览器路径见[部署与验收说明](../../releases/deploy/网页访问部署.md)。

- 自动回归脚本使用 `W序号-主题.mts`，由run-all.mts运行并写入断言级baseline.json。
- `pnpm eval` 跑当前账号隔离/独立后台架构的常规验收；Linux主机执行专项单独运行。历史设计套件可设置 `WORKPIVOT_EVAL_LEGACY=1` 一并比较，当前仍有与产品设计不一致的失败，不计入发布通过项。
- 模拟 LLM 原则：零成本跑 CI，不打真实模型（题库分层 L1/L2/L3 见需求清单 K01）。
- `pnpm eval:backup` 离线验证备份包完整性、篡改、符号链接、重复路径及额外文件拒绝，不连接真实数据库。
- `pnpm eval:backup-database` 在 Linux Docker 宿主创建一次性 PostgreSQL 16，调用真实 pg_dump/pg_restore，验证联合备份、安全快照、空目标恢复、权限/文件引用、登录/下载、遗忘清单及失败回滚；只挂载本次临时合成文件，结束后清理。详见[记录](../../docs/03-project/backup-recovery-20261016.md)。

- W20-skills：技能加载、参考资料、停用、项目访问撤销、路径/链接和大小边界。`pnpm eval:skills`。
- real-model-skills.mts：单独启用的真实模型专项，必须设置WORKPIVOT_LIVE_EVAL=1，读取已配置模型，在临时目录验证自主选择技能、读取参考资料和生成文件，结束清理；不加入pnpm eval，不替代完整浏览器业务验收。

- W21-worker.mjs：Linux Docker主机运行，验证无socket挂载的隔离执行服务，使用独立测试标签；需要workpivot-executor:0.1.0镜像。
- W22-worker-client.mts：回写、冲突、权限撤销和取消；纳入完整回归。
- W23-host.mjs：启动独立主机测试Worker，运行隔离后台测试容器中的W23-skill-service.mts；需要preview.7后台与执行镜像，验证Skill加载→Python脚本→模板→成果链，使用模拟模型，不改真实账户。

W26-accounts.mts：个人空间隔离专项，覆盖管理员跨账号读写拒绝、目录边界、旧数据复制迁移、共享目录保留、个人记忆、会话和定时任务身份。Windows 60 项，Linux 另加符号链接越界 1 项。替代 W25 的组织共享权限模型验收。

W28-task-workflow.mts：任务并发队列、取消与继续、等待授权恢复、失败状态、产物版本不可变与账号隔离、桌面精确版本下载、重启恢复；18 项。preview.16 Windows/Linux 均通过。

W29-skill-management.mts：技能编辑接口、格式校验、并发修改冲突、启停校验、账号隔离、模型加载编辑内容，共 19 项，Windows/Linux 通过。

W30-skill-packages.mts：37 项技能包集成测试，涵盖草稿/发布隔离、版本冻结与回退、二进制保真、ZIP 路径/链接/大小与校验保护、依赖及引用校验、账号隔离和旧编辑接口防绕过。Windows/Linux 通过。

W31 MCP：Streamable HTTP 握手、分页、凭据加密与账号隔离、真实任务逐次授权、SSE 中文结果、定义变更拒绝、断线不重试、禁用取消、地址变更清除凭据。Windows/Linux 26/26（preview.22）。

preview.23：W31扩展至39项，覆盖逐工具开关、旧引用撤销、复测保留、侧栏清单和调用名称/状态/耗时；Linux W31+W28+W19共63项通过。额外旧W3在preview.22/23同样失败，详情见preview.23发布说明。

## preview.24 当前架构验收与历史覆盖映射

W3使用SIGKILL并验证终止前running，修正Linux优雅退出与冷杀混用；W1/W7/W10按个人目录检查转写与定时任务存储。

| 历史套件 | 不再适用的前提 | 当前验收覆盖 |
| --- | --- | --- |
| W2 | 可授权访问账号外共享目录、后台直接运行命令 | W26账号路径边界、W28授权生命周期、W33四档权限矩阵、W31逐次外部授权 |
| W4/W9 | 在后台进程所在主机执行办公脚本 | W32发布Skill→独立Worker→三种办公文件→版本与下载，W22回写冲突/撤销 |
| W6 | 管理员看到双方任务、成员不能创建个人项目 | W26当前账号隔离/迁移、W27侧栏、W1核心任务链 |
| W11 | 全局个人设置共享、管理员代跑、共享项目成员变更 | W26个人设置与跨账号拒绝、W28等待/停止/恢复、W31回填与调用、W33权限矩阵 |
| W12/W14 | 跨用户共享工作目录和管理员代运行 | W26跨账号/链接边界、W13会话和数据损坏、W17连接中断、W18能力限制、W22回写保护、W28运行状态 |

此表是按现行设计的覆盖映射，不代表历史用例逐条迁移或完全等价。旧脚本保留，失败记录在 `releases/deploy/artifacts/preview24-eval-windows.log`，未修改产品来满足旧共享权限预期。

- W33-permissions.mts：在个人账号上下文运行28项四档权限矩阵，纳入常规入口。
- W32-host.mjs：在WSL Docker主机运行，启动专用39994测试Worker与临时后台容器，均不挂载Docker socket；默认镜像preview.24，可通过WORKPIVOT_TEST_SERVER_IMAGE覆盖。21项全流程验收。
- preview.24 Windows常规19组400项通过，另行W33 28项通过；Linux常规核心213项、目录映射11项、主机W32 21项通过。文档测试验证OOXML结构，不等同于Office GUI视觉验收。

preview.25：W33更新为两种模式32项，验证旧设置转换、默认自动、读取/写入/命令/高风险/MCP判定，以及API仅暴露ask/auto。历史四档矩阵保留在W11-permission-matrix.mts，不再代表现行产品模式。Linux W33/W26/W31/W28共150项通过。
# W35 三层记忆与默认角色模板

`node --import tsx eval/W35-memory-layers.mts` 使用临时账号及模拟模型，覆盖三层编辑、版本冲突、公共角色管理权限、个人/项目/任务隔离、实际模型注入、角色停用删除、自动加载关闭及待确认写入取消。已加入默认评测入口。现有 remember/promote/forget 继续由 W5 覆盖。
# W36 成果交付与本地同步

`node --import tsx eval/W36-deliverables.mts` 在临时目录运行真实服务接口与模拟模型，覆盖最终成果显式发布、过程材料排除、账号隔离、服务器快照下载、增量同步、冲突另存、取消成果不删本地、暂停、非法文件名/链接拒绝与哈希校验。已纳入默认评测。
# preview.32 补充验证

`W39-task-deletion.mts` 覆盖普通/临时任务删除、跨账号拒绝、运行状态保护、附件和产物清理、共享材料保留与符号链接越界保护：Windows 18 项、Linux 20 项。`task-deletion-ui.mts` 为独立临时账号页面验收入口，不连接真实业务数据。

历史说明：preview.32 当时未包含 PostgreSQL 原型。此描述不适用于后续数据库版和 RC 部署。


## 当前数据库与工程检查入口

- 真实单用户浏览器验收：`WORKPIVOT_LIVE_EVAL=1 WORKPIVOT_LIVE_ENV_FILE=/绝对路径/model.env WORKPIVOT_TEST_PG_IMAGE=pgvector/pgvector:pg16 node scripts/test-rc-browser.mjs --live`。配置文件提供 `DEEPSEEK_API_KEY`，可选 `DEEPSEEK_MODEL`（默认 deepseek-flash）；请求仅发送到 DeepSeek 官方地址，会产生真实用量。使用生产 createDatabaseRuntime 和临时数据库，账号 `live-test / Live-Test-2026!` 只用于本机测试。需要 Office 联调时，另启动专用测试 worker，通过 `WORKPIVOT_LIVE_WORKER_FILE` 指定仅本地可读的 JSON `{ "url": "http://127.0.0.1:端口", "token": "测试worker凭据" }`，或设置既有 WORKPIVOT_WORKER_URL/TOKEN；夹具预置 office-acceptance 技能。worker 需预装 Node、exceljs、docx、Python 及 poppler，文件仍由浏览器上传。60 分钟后清理临时数据库，也可在请求完成后通过认证的 POST /fixture/stop 提前关闭。外部 worker 生命周期由启动方管理，密钥文件不提交。本入口与 --workflow 互斥，不自动调用真实模型、不自动完成界面验收。结果见[单用户收尾记录](../../docs/03-project/single-user-closeout-20261016.md)。

- pnpm eval:browser-workflow：临时 PostgreSQL + 当前数据库 API/执行器/记忆作业 + 当前构建前端，使用可控模型响应做浏览器人工验收。Windows 需 WSL Ubuntu-24.04 和本地 postgres:15-alpine，页面为 127.0.0.1:39987，临时账号 workflow-test / Workflow-Test-2026!。覆盖审批恢复、停止、文本成果、记忆建议确认/纠错/拒绝及新任务读取；15 分钟后关闭，或 POST /fixture/stop 正常结束。先在 apps/web 构建前端；脚本启动不等于所有浏览器检查自动通过。步骤、结果与限制见 [2026-10-16 验收记录](../../docs/03-project/browser-workflow-20261016.md)。

- pnpm eval:worker-recovery：在 WSL/Linux Docker 宿主运行（Windows 可执行 `wsl -d Ubuntu-24.04 -- node /mnt/e/project/WorkPivot/code/eval/worker-recovery.mjs`）。默认使用本地 `workpivot-executor:0.2.0`，可通过 WORKPIVOT_TEST_IMAGE 指定兼容镜像。使用随机实例名、临时目录、动态本地端口和随机凭据，真实终止执行沙箱与 worker 子进程，验证取消、失败不返回半成品、重启清理及显式重试。仅清理本次实例资源，不挂载 Docker socket。该入口不覆盖数据库产物发布和浏览器联动。
- pnpm eval:database：W38 及其引入的数据库专项，运行于独立临时 PostgreSQL，不使用业务数据。与 pnpm eval 分开运行。
- pnpm eval:service-recovery：独立 Docker 整服务强制终止/重启回归；Windows 使用 WSL Ubuntu-24.04，默认需要本地 `workpivot-server:0.3.0-rc.1-recovery-validation-20260929` 与 `postgres:15-alpine` 镜像。可用 WORKPIVOT_TEST_SERVICE_IMAGE / WORKPIVOT_TEST_PG_IMAGE 指定兼容镜像。复制当前 server/core/shared 源码到临时容器，依赖使用指定镜像；不更新已有部署、不挂载 Docker socket。等待真实租约过期后核对 HTTP、SSE 和数据库状态，结束清理临时容器与网络。除预置任务/授权/Skill 执行记录外，真实 MCP 客户端还会调用独立测试服务：经持久化一次性授权后写入远端标记、暂缓响应，在 API 崩溃并两次重启后核对调用次数仍为一且未声称收到结果。MCP 服务为可控协议夹具，不代表真实供应商、模型决策或 Skill worker 中断已验收。
- pnpm eval:chat-state：W39-database-chat-state.mts，事件排序、去重、预览替换和分组；不要与历史 W39-task-deletion.mts 混淆。
- pnpm test:licenses：八个合成依赖场景，覆盖普通包、作用域包、空扫描、损坏清单、缺少许可声明以及严格检查的失败/成功结果。
- pnpm check:licenses:strict：缺失许可证声明返回非零状态；当前两个旧依赖仍未有充分授权材料，严格检查预期失败，不应通过添加未经核实的白名单绕过。
- pnpm eval 默认写入 eval/baseline.json；临时审计应使用 WORKPIVOT_EVAL_BASELINE 指向独立记录，避免覆盖原验收基线。
- 以上检查不替代真实模型、浏览器、执行服务或线上环境验收；文中旧版本数字是历史记录。

## 2026-10-17 对话 Skill 构建与测试

`pnpm eval:skill-build` 使用独立临时 PostgreSQL 和真实 Docker，验证私人文件树、脚本语法、断言及 Excel→Word 草稿。`WORKPIVOT_LIVE_EVAL=1` 显式启用本机 DeepSeek 配置，`WORKPIVOT_SKILL_LIVE_OFFICE=1` 补真实模型生成办公技能及下一轮执行，`WORKPIVOT_SKILL_BROWSER_HOLD=1` 保留临时浏览器页。密钥只从本机配置读取，不写命令或记录。

数据库回归新增45项，累计630/630；真实恢复28项、聊天10/10通过。详见[验收、命令与边界](../../docs/03-project/skill-build-closeout-20261017.md)。这些结果不代表已经部署或ST定时已完成。

- `pnpm eval:embeddings`：隔离 pgvector 数据库和合成 HTTP 服务，验证持久索引、项目/用户隔离、异步暂停、重试、重建切换及过期租约；不调用云端模型。schema31起数据库镜像必须提供vector扩展。

- `pnpm eval:hybrid`：混合检索与引用64项隔离检查；设置`WORKPIVOT_REAL_VECTORS`为由固定语料生成的JSON映射路径可复用真实向量做质量评测，缺少条目明确失败，不回退模拟结果。

- `pnpm eval:parser-metadata`：合成DOCX/PDF执行真实Python解析器，验证程序指纹、媒体/无文字页的部分覆盖和契约拒绝。
- `pnpm eval:parsed-content`：共享分页、来源定位、Unicode及密集片段边界。schema32解析指纹、失效重建和部分覆盖另由数据库/向量/恢复专项验收。

- `pnpm eval:office-resources`：生成三种Office文件并运行包内检查脚本，验证正文缺失和XML损坏拒绝；数据库回归另含完整资源安装、更新草稿保护、轮次/计划固定版本。

文档B1：`pnpm run eval:parser-metadata`现在覆盖33项，包括真实docx/exceljs文件、嵌套表与合并、共享公式、区域/对象筛选、空白文档和UTF-16实体拒绝。`pnpm run eval:database`新增结构化读取的版本/权限/删除/索引兼容性检查。均使用合成资料；不代替真实模型与生产容器验收。

文档B2：`pnpm run eval:office-generation`覆盖22项真实生成/模板读回与失败边界；`pnpm run eval:office-resources`现为18项，检查新增脚本完整打包且不包含解释器缓存。生成测试仅操作临时合成文档，不覆盖业务原件，不代替真实模型/生产容器验收。

### 2026-10-17 文档03B/03C验证

- `pnpm run eval:office-generation`：Word/Excel生成、模板字段、读回核对22项。
- `pnpm run eval:office-editing`：真实文件局部修改、原件/样式/其他成员保留、实际LibreOffice重算及PPT结构/溢出16项；宿主需Python及LibreOffice。
- `pnpm run eval:office-resources`：完整包、资源边界、实际格式/正文检查18项。
- `WORKPIVOT_TEST_IMAGE=<已构建执行镜像> pnpm run eval:office-container`：真实无网络Worker，OCR扫描/混合/旋转/JPEG、空白失败、公式及错误、PPT渲染和字体缺失11项；保留临时PDF/PNG便于人工视觉检查，运行结束回收测试Worker。
- `WORKPIVOT_TEST_IMAGE=<已构建执行镜像> pnpm run eval:worker`：执行器超时、断线回收和失败无产物16项。
- `WORKPIVOT_LIVE_EVAL=1 WORKPIVOT_LIVE_ENV_FILE=<本地密钥配置路径> node scripts/test-office-browser.mjs`：显式启用真实DeepSeek和真实Worker的一次性PostgreSQL网页夹具，默认39989，仅合成数据；会产生模型用量。登录凭据只用于夹具，启动日志可见。浏览器结束后认证POST `/fixture/stop`，父进程清理容器。勿指向业务数据库或业务Worker。

本阶段数据库674、混合检索64、向量29、自动化49、联合备份恢复37通过。真实模型、视觉人工复核与确定性自动化测试分开记录，完整证据及已知限制见统一主计划03B3/03C实施记录。


### 2026-10-17 用量与会话验证

- `pnpm eval:model-usage`：5项模型流协议夹具，验证OpenAI统计请求与空choices usage、非法统计过滤、Anthropic累计/缓存、工具循环兼容。
- `pnpm eval:database`：702项，新增用量/预算/诊断及会话隔离、撤销；一次性Docker数据库，不连接业务库。
- `pnpm eval:backup-database`：40项，包含真实pg_dump恢复后的用量/单价、预算提醒及新会话管理。
- `node scripts/test-rc-browser.mjs --usage`：39990隔离页面，合成用量和短期测试账号，不调用真实模型；900秒自动退出，或使用认证POST `/fixture/stop`结束后由父进程清理一次性容器。用量/预算及登录会话入口位于设置菜单。

本批不包含个人数据批量清空及完整导出，不代表SU-R3全阶段或生产部署完成。

### Office正确性修复回归

`pnpm eval:office-reliability`：30项，合成OOXML与真实exceljs表对象，覆盖1900/1904基准、日期边界/时间/公式缓存、未支持格式警告、Word移动与删除修订、三个Skill包的孤立字符串拒绝/坐标核对、Excel及Word行分块、表头与引用、长行续片。既有文档115项通过，数据库706、混合检索64、向量29通过。向量用受控HTTP夹具，不代表真实业务问答准确率。生产发布需重建解析和索引，并显式更新Skill发布版本。

回收站界面：`node scripts/test-rc-browser.mjs --trash` 启动一次性数据库和39991页面，合成项目/子任务、记忆及到期任务，不连接业务库。用于验证统计、筛选空状态、恢复依赖、确认窗口；认证POST `/fixture/stop`结束，或15分钟自动退出。


SU-R3个人数据及来源追溯（2026-10-17）：`pnpm eval:trash`现含个人数据专项63项，使用一次性数据库/合成原件；覆盖事务中断回滚、同用户独占/跨用户不阻塞、归档哈希、HTTP鉴权、清空恢复与保留清单回放。`pnpm eval:database`710项包含摘要事实引用与无效来源拒绝。`pnpm eval:backup-database`40项通过schema36联合恢复。`node scripts/test-rc-browser.mjs --trash`另含一个在线合成任务，可检查设置→个人数据的导出及清空预览；不连接业务数据库。

当前镜像运行恢复专项：`WORKPIVOT_TEST_SERVICE_IMAGE=workpivot-server:local-browser-ui-20261017 WORKPIVOT_TEST_PG_IMAGE=pgvector/pgvector:pg16 pnpm eval:service-recovery`。脚本向临时容器复制当前源码及eval目录；13项断言、两次重启通过，不等于长稳验收。


### 持续恢复与资源基线（2026-10-18）

在code目录运行：

```bash
WORKPIVOT_TEST_SERVICE_IMAGE=workpivot-server:local-strict-url-20261018 \
WORKPIVOT_TEST_PG_IMAGE=pgvector/pgvector:pg16 \
WORKPIVOT_TEST_SOAK_SECONDS=300 \
WORKPIVOT_TEST_SOAK_REPORT=/tmp/workpivot-soak-new.json \
node scripts/test-service-recovery.mjs
```

持续时间范围0至86400秒，0保持原故障恢复专项。先执行强制终止和两次重启，再循环17项检查：恢复状态、旧审批/旧执行器拒绝、MCP副作用不重放、SSE游标续接、固定请求ID上传不重复、下载字节一致及数据库连接池上限。只使用内部网络的一次性数据库/API/MCP容器，不挂载业务卷或Docker套接字。停止信号经finally清理本轮资源；SIGKILL/主机掉电仍需人工确认残留测试资源。

报告路径必须是尚不存在的文件，防止覆盖历史证据；每轮记录Docker内存及PIDs。前两轮预热后，以第三轮为基线，检查后续样本内存增长不超过128MiB、PIDs增长不超过8；连接总数不超过40。短于三轮时以最后一轮为基线，不能据此判断长期资源趋势。这是异常增长阈值，不是证明没有内存泄漏。受控夹具不调用真实模型、Office Worker或浏览器；短时通过不能关闭全天长稳和业务效果门槛。

2026-10-18本机基线：300秒42轮、每轮17项通过；预热后131.3→139.2MiB、峰值140MiB，PIDs固定22。SIGTERM清理另行验证通过。结果不是全天长稳或零内存泄漏保证。


### 合成 Office 业务样本验收（2026-10-18）

用户暂未提供真实资料，允许生成样本。在code目录运行 `node scripts/test-postgres.mjs --synthetic-office`。需要Docker、已构建的Office执行器镜像（默认workpivot-executor:office-stage-20261017-v2，可用WORKPIVOT_TEST_IMAGE覆盖）、主机LibreOffice、pdftoppm、pdfunite和Python Pillow。使用一次性PostgreSQL与独立Worker，不访问业务数据库或原件。

每次在local-runtime/acceptance/synthetic-office-随机目录保留7份原件：跨页Word、1900/1904两种日期基准Excel、带原生图表和备注的PPT、原生PDF、扫描PDF和混合PDF；manifest.json记录标准答案和SHA256，outputs保存解析及修改结果，report.json记录断言与能力边界。失败也保留报告，数据库和隔离上传存储在结束时清理。

本轮37项通过：真实容器解析/入库、日期基准、公式缓存、带表头单位的行检索、版本引用、撤销范围与跨项目隔离、跨页末行、OCR金额、混合页定位、正文读取、受限编辑/真实重算和7份原件哈希保护。PDF空格允许排版差异，同时核对末行地区、金额、日期。PPT图表内部数值与备注未提取，明确记录为缺口，不纳入通过的理解能力。未调用真实模型或向量服务，仅验证PostgreSQL关键词检索；不能替代真实业务问答、第二物理设备或全面视觉验收。


### 依赖许可整改回归（2026-10-18）

工作区定向覆盖nopt5→abbrev1.1.1、ExcelJS4.4.0→unzipper0.12.3，锁文件不再含buffers/binary旧链。`node eval/excel-dependency.mjs`验证实际ExcelJS依赖版本、普通/流式读取、1904日期、公式缓存、中文和损坏ZIP拒绝，共9项。干净的冻结锁文件安装后运行`pnpm check:licenses:strict`，本轮767包通过；旧node_modules可能残留未引用包，须按锁文件重新安装，不能通过许可豁免掩盖。

本轮源码Office六套回归共145项、许可检查器8项、全仓类型检查、桌面代码构建通过。使用替换全部Node依赖的独立候选执行器workpivot-executor:license-20261018，容器Office11项及合成业务37项通过。未执行桌面安装包验收，也未切换生产API或Worker。

Worker恢复测试发现Docker自动删除容器与finally删除竞争，导致暂存目录遗留；修复为删除报错后确认本实例容器已不存在，再清理目录。Docker查询失败或容器仍在时保留现场，不伪造成功。`WORKPIVOT_TEST_IMAGE=workpivot-executor:license-20261018 pnpm eval:worker-recovery`修复后9项通过，涵盖取消、沙箱崩溃、Worker被杀、重启回收和显式重试。不代表长期负载验收。

候选执行器补充：W21隔离执行16项通过，覆盖只读资源、无网络、链接拒绝、超时与断线回收，结束无本轮残留沙箱。


### 发布候选文件系统门禁（2026-10-18）

`node code/scripts/build-local-release.mjs workpivot-server:<版本> <新目录>`从工作区准备完整运行目录，保存锁文件和工作区配置。Dockerfile在COPY前删除旧运行目录，并在最终文件系统执行严格许可扫描。候选检查应确认旧buffers/abbrev目录确实消失，再运行`WORKPIVOT_TEST_RELEASE_IMAGE=<候选> node code/eval/local-release.mjs`。本轮候选local-license-gated-20261018通过13项安装/升级/失败恢复/回退演练；不触碰当前业务库。该门禁不扫描基础镜像历史层与系统包，不能替代完整镜像合规审计。


### PPT图表备注与容器调度（2026-10-18）

`pnpm eval:ppt-content`11项异常与结构检索检查通过；合成Office数据库专项更新为41项，包含实际图表分类/数值、备注检索。`pnpm eval:automations`更新为53项，含跨用户持久轮转、API关闭后的独立调度及正常停止。`node eval/container-controller.mjs`使用随机实例与一次性目录，需先构建Dockerfile.controller；本轮8项通过，检查真实沙箱限制、socket不下传以及控制器崩溃回收。不会连接业务数据库或操作业务Worker。容器控制器镜像默认workpivot-controller:cn-20261018，执行镜像默认workpivot-executor:license-20261018，可分别用WORKPIVOT_TEST_CONTROLLER_IMAGE、WORKPIVOT_TEST_IMAGE指定。


管理监控补充：自动化联合专项现为59项（增加实际监控API鉴权、跨用户和隐私6项）；`pnpm eval:admin-monitor-ui`须先构建web，使用受控API及真实Chromium检查展示、切换清空、失败重试、窄屏和无JS异常。截图保存到local-runtime/acceptance/admin-monitor-时间戳；不替代真实管理账号端到端验收。

### 集中网页采集配额（2026-10-18）

运行 `pnpm eval:web-quota`，默认使用 `/usr/bin/google-chrome`，可设置 `WORKPIVOT_TEST_CHROME`。通过本机真实 HTTP 服务与 Chromium、合成上游传输验证：两个调用方和浏览器共享配额、总并发/主机串行、默认 2 秒间隔、队列容量、取消、异常释放、完整 URL 和重定向检查、页面关闭、服务关闭、禁止出口失败回退。合成上游没有访问真实站点；不是生产网络负载测试。

本轮结果：新增配额检查 10 项通过（含真实 Chromium）；既有网页/共享浏览器回归 22 项通过；全工程 TypeScript 检查、相关文件 ESLint、调度器 Compose 合成配置校验与 `git diff --check` 通过。没有执行生产负载、多副本或登录网站验收。

### 自动化用户容量（2026-10-18）

- `pnpm eval:automation-capacity`：创建并清理独立 PostgreSQL 容器，以受限角色和 RLS 验证并发启用、手动与定时共用额度、满额幂等、草稿保留、跨用户隔离、额度恢复、补跑/跳过策略、历史超额兼容和停用提示清理。
- `pnpm --filter @workpivot/web build && pnpm eval:automation-capacity-ui`：真实 Chromium、合成 API 验证额度和等待原因、确认启用被拒、额度刷新、390px 窄屏与无 JS 错误；不冒充后端端到端测试。
- 完整自动化回归仍运行 `pnpm eval:automations`，覆盖原有授权、固定版本、执行、取消、成果隔离、恢复与独立调度器。

本轮结果：新增容量专项 17 项、既有自动化回归 59 项通过；页面交互专项、全工程类型检查、相关文件 ESLint、前端构建与差异检查通过。页面截图存于 `local-runtime/acceptance/automation-capacity-1792319422859/mobile.png`。尚未进行生产升级与真实多用户负载验收。

### 管理员自动化额度与审计（schema39，2026-10-18）

容量专项现覆盖管理员授权、目标用户隔离、前后值、并发版本冲突、请求重试、审计不可修改删除、审计失败时事务回滚及分页；`eval:admin-monitor-ui` 同步覆盖额度编辑确认、成功审计展示和切换用户清除旧额度/记录。新增表不含私人正文，原因由管理员输入且提示勿填秘密。

本轮 schema 安装/历史升级数据库专项 770 项、容量专项27项、真实联合备份恢复41项通过；恢复新增断言验证额度和成功审计仍在。前端构建和 Chromium 管理页面检查通过。管理审计尚不覆盖失败/拒绝操作或保留清理，当前测试不能代表通用审计模块已完成。

管理员额度API联动回归现为64项，通过未登录拒绝、成员写入拒绝、管理员实际HTTP更新和读取审计、超范围游标拒绝；全工程类型检查和定向lint通过。

schema39下网页数据库专项22项通过；旧URL迁移测试直接重放v38的数据变换，避免人为删除中间版本破坏后续迁移链；仍验证离线计划不受影响、旧联网计划需重新确认与重复安装幂等。

### 额度修改失败审计（schema40，2026-10-18）

新增成功/失败两条独立记录链；失败审计只存已认证操作人、目标、固定动作/分类和时间。容量专项35项通过，覆盖拒绝/错误分类、原始输入不落库、无效目标归属、审计不可改删、同微秒稳定分页、非法日期游标和审计存储失败明确报错。自动化/API联合68项通过，新增实际HTTP拒绝后的审计查询及普通用户不可读。

数据库安装/历史升级770项、真实备份恢复42项通过；恢复新增断言检查失败事件。管理页面真实Chromium（受控API）覆盖分类、分页、查询失败清空/重试、用户切换隔离、390px窄屏及无JS异常。修复重复React key导致的旧额度组件残留；前端构建、类型检查、定向lint与差异检查通过。

此验收不覆盖公共认证层提前拒绝、无效JSON、全站其他操作、审计导出和保留清理。没有生产部署或真实负载验收。

### 采集正文快照与管理（schema41，2026-10-18）

- `node scripts/test-automations.mjs --web`：隔离PostgreSQL与真实自动化执行器、受控网页和模型，40项通过。覆盖初次/不变/变化/内容回退、同次HTTP复用、模型失败保留快照、撤销阻止迟到写入、用户隔离、管理元数据不含正文、同微秒分页、回收/恢复/30天手动永久删除及相应审计。
- `node scripts/test-postgres.mjs`：安装与历史升级770项通过；`node scripts/test-backup-database.mjs`：44项通过，新增恢复正文版本、观察记录及审计关联断言，已完成历史不会被排队中断检查误判。
- 构建web后 `node eval/capture-history-ui.mjs`：真实Chromium+受控接口验证版本查看、文本转义、截断提示、版本对照、窄屏和回收站确认。`node eval/admin-monitor-ui.mjs`：管理统计/审计渲染及切换用户清除旧记录。截图位于本机 `local-runtime/acceptance/capture-history-1792321591867` 和 `admin-monitor-1792321593678`，不入库。

类型检查、全量lint、前端构建和差异检查通过；无生产部署。本批不覆盖真实登录网站、RSS、完整HTML存档、真实负载或逐字差异算法。

### HTTP有限重试（schema42，2026-10-18）

- `node --import tsx eval/web-retry.mts`：9项通过，覆盖Retry-After秒数/日期/错误值、最多2次额外重试、非临时状态不重试、超长等待不提前发出、取消、DNS重绑定拒绝、共享冷却与跳转预算。
- `node --import tsx eval/web-quota.mts`：11项通过，新增真实集中服务协议下自动化重试及计数传回、普通调用不重试。
- `node scripts/test-automations.mjs --web`：42项通过，新增观察记录与管理员审计重试计数持久化、次数不改变正文版本。
- 完整数据库安装/历史升级770项、联合备份恢复44项通过，恢复核对审计重试计数；类型检查、全量lint、web构建、用户采集历史和管理员页面受控Chromium检查通过。

截图目录为本机 `local-runtime/acceptance/capture-history-1792321984434`、`admin-monitor-1792321986209`。本次为合成上游与隔离数据库验收，未进行生产部署或真实业务站点验收。无逐次请求审计、持久冷却或多出口协调。

### RSS/Atom订阅快照（schema42，2026-10-18）

- `node --import tsx eval/feed-content.mts`：9项通过。覆盖RSS字段关联、CDATA/HTML清理、Atom命名空间和xml:base、日期原文、DTD/错误XML/超深结构拒绝、截断总量、危险链接、外部正文不读取、内容扩展及声明编码。测试重复ID保留，避免伪造逐条增量语义。
- `node --import tsx eval/web-quota.mts`：12项通过，新增集中服务结构化订阅传递且不请求条目链接。
- `node scripts/test-automations.mjs --web`：45项通过，新增真实执行器采集订阅后结构化字段持久化、未授权链接零请求、跨运行复用快照。
- `node scripts/test-backup-database.mjs`：44项通过，恢复断言核对非空订阅条目ID。`node --import tsx eval/web-tools.mts`：12项通过。
- 类型检查、全量lint、web构建、采集历史受控Chromium交互和390px截图检查通过；严格许可扫描767个依赖未命中黑名单。saxes 5.0.1从既有传递依赖显式声明为直接依赖，没有增加解析库版本。

用户页截图：本机 `local-runtime/acceptance/capture-history-1792322683447/mobile.png`（不入库）。无新增schema迁移，未重复执行与此改动无关的全库安装测试。未使用真实业务订阅，未部署；RSS 1.0/RDF、全文存档、自动分页和逐条增量均不在本批验收范围。

### HTTP原始正文存档（schema43，2026-10-18）

- `node --import tsx eval/capture-original.mts`：原始二进制往返、无响应头、空正文、错误base64/媒体类型及2MiB边界通过。
- `node --import tsx eval/web-quota.mts`：13项通过，新增集中协议显式返回原始正文、普通调用不返回原始字段。
- `node scripts/test-automations.mjs --web`：52项通过，新增原始变化触发版本、创建者下载、其他用户拒绝、真实HTTP附件响应、哈希破坏拒绝、原始字节不进入模型、管理计数/下载审计及回收后不可下载。
- `node scripts/test-postgres.mjs`：770项通过；`node scripts/test-backup-database.mjs`：45项通过，新增恢复后原始bytea及哈希一致。
- 类型、全量lint、web构建、用户历史下载和管理员份数/大小受控Chromium交互通过；390px截图人工检查通过。截图在本机 `local-runtime/acceptance/capture-history-1792323536692` 与 `admin-monitor-1792323538348`，不入库。

测试使用合成响应与隔离数据库，未部署。存档是解压后的完整HTTP正文，不是子资源整站包；浏览器DOM和失败解析原文未覆盖。

### 浏览器DOM存档（schema44，2026-10-18）

- `node --import tsx eval/web-tools.mts --browser`：24项通过，新增真实Chromium点击后的DOM、独立/共享会话边界、2MiB超限拒绝，保留截图和完整URL策略回归。
- `node scripts/test-automations.mjs --web`：55项通过。测试现通过真实集中浏览器服务协议运行HTTP和browser_visit；新增DOM下载/类型、同次重复浏览实际执行两次并去重版本、原始字节不进入模型及管理员DOM计数。
- `node scripts/test-postgres.mjs`：770项；`node scripts/test-backup-database.mjs`：45项，检查存档类型随恢复保留。
- 类型、全量lint、web构建、用户DOM说明/下载与管理员存档统计受控Chromium交互通过。截图位于本机 `local-runtime/acceptance/capture-history-1792324091417`、`admin-monitor-1792324093359`，不入库。

上游为合成页面，未部署、未验收真实登录/内网系统。DOM不是可复现整站包，不含子资源、iframe子文档和完整运行状态。

### 连续收尾最终回归（schema49，2026-10-18，未部署）

- `node scripts/test-postgres.mjs`：770项；`node scripts/test-backup-database.mjs`：49项，含请求审计/清理历史恢复、内网规则撤销、登录密文与租约清除。
- `node scripts/test-automations.mjs`：68项；`--web`：69项，真实集中浏览器、内网授权及撤销、跨用户隔离、无状态等待、等待释放槽、人工POST登录、加密保存、同运行恢复、登录失效、停止、20分钟超时。
- `node scripts/test-automations.mjs --capacity`：65项。请求审计涵盖匿名拒绝、畸形JSON、不记录正文/查询串、缺失结束、同微秒分页、导出上限、40并发关联、不可变记录、30天清理和撤权清除关联登录凭据。
- `node --import tsx eval/browser-login.mts`：真实Chromium坐标登录、POST只提交一次、两个HttpOnly Cookie、localStorage保存、私密画面、只读复用、不允许模型提交、拒绝storageState文件路径；修复跳转瞬间截图表面不可用时有界重取，不重放提交。
- `node --import tsx eval/web-tools.mts --browser`：26项；`eval/web-quota.mts`：13项；`eval/web-retry.mts`：9项；`eval/feed-content.mts`：9项。
- `node --import tsx eval/network-target.mts`、`eval/capture-original.mts`：精确地址/固定私网IP、内部系统DNS、不混用公网DoH、资源包字节和边界通过。
- `node eval/browser-profiles-ui.mjs`、`node eval/admin-monitor-ui.mjs`、`node eval/capture-history-ui.mjs`：用户/管理员真实Chromium受控接口交互，确认/撤销/保存、审计清理、内网规则、390px布局通过。截图仅在本机acceptance目录，不入库。
- `pnpm typecheck`、`pnpm lint`、`pnpm --filter @workpivot/web build`、`pnpm check:licenses:strict`及`git diff --check`通过。

工程测试使用合成网站、凭据及模型，没有发送真实网站密码。未做生产容量测试、真实业务站点/第二设备验收或本轮发布。无通用SSO、任意工作流崩溃后自动重放、完整离线整站复刻承诺。后续运行以上命令会使用可丢弃数据库，不能对业务库执行测试清理。

### 2026-10-19 候选发布回归

`node eval/local-release.mjs`默认使用本轮schema49候选与schema38源镜像，16项通过。新增有效/过期网页登录租约准入、独立401保护检查；无写入回退和写入后拒绝回退均实际执行。候选构建包含web生产构建及镜像内767项严格许可扫描。`pnpm exec eslint scripts/release-local.mjs eval/local-release.mjs`及脚本语法、差异检查通过。本次未重复全库770项，不以历史回归冒充本次执行；未更新业务容器。

同日最终浏览器容器补验：`eval/browser-login.mts`可通过`WORKPIVOT_BROWSER_EXECUTABLE_PATH`选择容器Chromium路径，默认宿主路径保持。候选容器使用`--network none --read-only --user 1000:1000 --cap-drop ALL`、既有seccomp、no-new-privileges、512MiB临时目录及256MiB共享内存。仅只读挂载测试文件至`/app/eval/browser-login.mts`，执行`node --import tsx eval/browser-login.mts`；最终镜像源码未覆盖。双Cookie、localStorage、一次POST、未授权跳转和307不重发通过。容器测试曾揭露3xx后不再拦截及跳转截图超时问题，修复后重新构建API/浏览器候选，不以宿主通过替代容器结果。网页数据库69项复验通过。

### 2026-10-19 IAM独立协议实验

`pnpm iam:lab start|status|stop`管理专用Keycloak26.8.0测试容器，`pnpm eval:iam-lab`使用真实Chromium完成21项授权码/PKCE和ID Token正反例。40190仅loopback，40191仅验收接收器临时监听；随机合成凭据位于被Git忽略的`local-runtime/iam-lab`，禁止复制至测试输出。

本次21项通过，另检查重复启动返回ready、目录0700/文件0600、loopback端口、专用标记和无业务卷挂载。相同邮箱/用户名的两个realm使用不同Keycloak内部ID（其单实例主键要求唯一）；跨issuer验收以有效签名令牌不匹配预期issuer被拒绝为证据，不能宣称已验证WorkPivot外部映射数据库唯一性。实验RS256验证器仅位于eval，不被生产导入。脚本语法、定向lint、差异检查通过，未执行业务全库回归。设计与运行方法见企业身份通用设计文档。

### 2026-10-19 模型上下文容量

`pnpm eval:database` 包含 `model-capacity.mts`：元数据总窗口识别、失败保留、重定向凭据保护、修订冲突、私人隔离与容量审计；`database-compaction.mts` 包含少于五轮的长历史整理、长轮次来源分片、当前输入与历史超限区分。最新777项通过；`pnpm eval:backup-database` schema50联合恢复49项通过。容量计量是含余量的启发式Token估算，并非供应商分词器或百万Token实测。

2026-10-19 用户取消私人网页登录页面：`browser-profiles-ui.mjs` 改为旧路由兼容、入口移除和不调用登录配置接口的检查；不再声称当前前端提供创建、人工登录与撤销页面。后台相关专项继续保留。
