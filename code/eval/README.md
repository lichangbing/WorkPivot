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
