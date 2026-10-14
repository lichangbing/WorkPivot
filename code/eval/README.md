# eval/ — 评测题库（K01）

- 自动回归脚本使用 `W序号-主题.mts`，由run-all.mts运行并写入断言级baseline.json。
- `pnpm eval` 跑当前账号隔离/独立后台架构的常规验收；Linux主机执行专项单独运行。历史设计套件可设置 `WORKPIVOT_EVAL_LEGACY=1` 一并比较，当前仍有与产品设计不一致的失败，不计入发布通过项。
- 模拟 LLM 原则：零成本跑 CI，不打真实模型（题库分层 L1/L2/L3 见需求清单 K01）。

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

- pnpm eval:database：W38 及其引入的数据库专项，运行于独立临时 PostgreSQL，不使用业务数据。与 pnpm eval 分开运行。
- pnpm eval:chat-state：W39-database-chat-state.mts，事件排序、去重、预览替换和分组；不要与历史 W39-task-deletion.mts 混淆。
- pnpm test:licenses：八个合成依赖场景，覆盖普通包、作用域包、空扫描、损坏清单、缺少许可声明以及严格检查的失败/成功结果。
- pnpm check:licenses:strict：缺失许可证声明返回非零状态；当前两个旧依赖仍未有充分授权材料，严格检查预期失败，不应通过添加未经核实的白名单绕过。
- pnpm eval 默认写入 eval/baseline.json；临时审计应使用 WORKPIVOT_EVAL_BASELINE 指向独立记录，避免覆盖原验收基线。
- 以上检查不替代真实模型、浏览器、执行服务或线上环境验收；文中旧版本数字是历史记录。
