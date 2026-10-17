# WorkBuddy Excel 实现深追：REA 与代码证据

后续动态样本见 [生成与重算](workbuddy-excel-create-runtime-20261017.md)、[读取与核算](workbuddy-excel-read-runtime-20261017.md)。读取样本已证实 sheet-agent 工具路径，并定位 server.mjs 的 POSIX 路径校验导致 Windows 盘符路径被拒绝；下文静态覆盖限制继续保留。

分析日期：2026-10-17。仅静态读取安装产物，未执行 WorkBuddy、MCP 服务、Worker、Python 脚本，未读取用户工作簿。本报告不提出替代实现方案。

## 样本与方法

样本根：`C:\Users\lichb\AppData\Local\Programs\WorkBuddy\resources\app.asar.unpacked\resources\plugins\workbuddy-builtin\builtin-plugins\workbuddy-sheetagent`。

主线核定当前 app.asar 版本为 5.8.3；以下独立文件本轮复核与初轮分析相同，未观察到切换样本：

| 文件 | SHA256 |
|---|---|
| mcp/server.mjs | `7c4945550273b7bebcbb171fe01edacd94ebd76f85b88c24c84cd5af19e7cfc4` |
| mcp/worker.mjs | `d00592a6ae84d9b9d0da239792b2818a4ec4b8e4a65bb12a6e8b34ac3f8c8f3d` |

REA 直接分析原始 mcp 目录，summary 模式，180000 ms/source、1024 MiB heap：目录摘要 SHA256 `cfffa4ea671af4505c295759da87fb35a690c03851f2e37658e8701985a0c621`。5 个 JS 解析完成、375071 AST 节点、无 parse failure；server.mjs 与 debug-cli/debug-server 在 semantic 阶段耗尽 heap，因此 application partial、semantic partial/truncated，5506 semantic unknowns。不能把成功返回 summary 等同于完整调用图。

| REA 操作 | Evidence |
|---|---|
| 父分析 | `ev_db3e933a3f0f336ee1427f324ca98ec6ad68663ff2239ffdd48cc4ede86914d4` |
| summary | `ev_41df04f2cd882a17b9d17ca5a2f3196ba1faa159ea8ce7d460ef92c8b31906af` |
| 模块页 | `ev_54941121611702bc63e616e831188c7dbabbca94a88db35d161c05bd237f159b` |
| server 资产及 hash | `ev_54c55510b4f551dd0c9a4acf0cd419d0405c146e2a5d8eb9beeebee592e11272` |
| worker 外部 node:path 模块关系 | `ev_74d9e5ec8f3aea6569e5b2d4e11c3516ec1ea90e272f14967a56dbfbddb89a1c` |
| run_command outgoing exact string trace | `ev_f7c044c05682e668043a2bbd4503ce657369b886a34574bfaa369b2f1f4f6f43` |
| read_table outgoing exact string trace | `ev_77000ab58a2412b829720d1ddd5dd03f303c270deef42cc7be2d1978923f94c0` |

两条 trace 均 no-match，源图 partial。工具明确指出 no-match 不证明功能不存在。以下链路来自同 SHA256 产物的惰性文本精读，不冒称 REA 已恢复完整语义路径。压缩 JS 定位采用 0-based UTF-16 字符偏移；源码 hash 用原始字节。

为修复明确的 heap 阻碍，改变参数为 4096 MiB 再分析一次；summary `ev_86bb887dfc1721aae9230f65063ed591cd68b13a80e679ff8649a2b66a5f0c7c`，父 Evidence `ev_e0bb52763150bbb6eada6b53be18d525b3074f17b9c92026c4e9a897146d6249`。目录摘要一致，仍报告三个大 bundle 的 semantic heap exhausted、相同 partial/5506 unknowns；没有继续重复同类分析。扩大预算未解决这个图恢复缺口。

## read_table：读取不是直接解析 XLSX

1. `server.mjs @472592` 的 `registerTool(gv, ...)` 注册 read_table，handler 调 `oN(api,{file_id,sheet_id})`。
2. `oN` 调 `sheetGetSheetInfo`；无 sheet 返回空表；多 sheet 未明确 sheet_id 报错（校验 `Va/Ga`），再选目标 sheet。选出的 row_count/col_count 为零也返回空表。
3. `iN` 对首个窗口探测表格，`tv=500,rv=20`（@459516），即最多 500 行 ×20 列发现窗口；`iv` 根据非空行列块识别区域，判断 ROW/COLUMN/MATRIX、表头和 structured。这里是启发式识别，不是完整工作簿对象还原。
4. `aN @474056` 对每个识别区域读取数据；`lN @475973` 使用 `Af=200` 限制显示单元格预算，行数约为 `floor(200/区域列数)`、至少一行。超出时返回 has_more、shown_end_row 和继续读取提示；探测边界不足还返回 truncated/actual_rows/actual_cols。不能把初次 read_table 的 grid 视为全表。
5. `yv @476089` 调 `sheetGetCellData`，将自身 1-based 坐标减一传上游，`return_csv:false`；返回 cells 映射为 display_value 等结构。
6. 本地 adapter `_s @376706` 调 upstream.sheetGetCellData 并归一化显示值；原子 adapter `sheetGetCellData @369287` 调 `this.call("sheet_get_cell_data",args)`。
7. `callJsonTool @555407` 用 MCP client.callTool({name,arguments})，读 structuredContent 或 content JSON；isError 转异常。连接失败等允许一次 reset/retry，过载也有一次延迟重试。
8. 本地配置 @556928 默认上游 `http://127.0.0.1:39099/mcp`，可用 SHEET_LOCAL_UPSTREAM_URL 覆盖；bridge 监听默认 127.0.0.1:39800/mcp。另有远程 adapter 分支，不能把所有部署都断言成本地。

已确认的是“工具注册→区域探测→范围读取→MCP 上游”的源码路径；底层编辑器如何导入 OOXML/XLS、持久化公式对象不在这两个文件中。

## run_command：受限 JS 批处理映射到原子编辑工具

1. `server.mjs @502422` 注册 run_command；handler @504492 先 `zN(query)` 危险字符串过滤，命中则拒绝。通过后调 `Rv({api,script,fileId,sheetId})`。
2. `Rv @499573` 创建 worker.mjs Worker，传 SharedArrayBuffer 与脚本/ID；默认 buffer 8388608 字节，主线程循环接收 op 并交给 `wv @499251`，按 `zs[op]` 白名单分派，未知 op 返回错误。
3. `worker.mjs @89102` 使用 node:vm createContext；隐藏 process/Buffer/require/module/global/globalThis，禁字符串/wasm codeGeneration；动态 import 抛错，runInContext 带 timeout。这里只确认存在这些约束，未验证完整安全隔离或绕过可能性。
4. `zs @478084` 实际提供 sheet.refreshInfo/insertSheet/copySheet/deleteSheet、range.getValues/setValue/setValues/setFormula 等 op。`range.getValues @479112` 调 api.sheetGetCellData；`range.setValues @479876` 把二维数组映射成 row/col/value_type，再调 api.sheetSetRangeValue。
5. `Pf @498696` 区分 finite number、bool、以等号开头的 formula、string、空值；`zf @498950` 生成 NUMBER/BOOL/FORMULA/STRING 参数。不是把生成的 JS 交给 Excel 宏引擎运行。
6. 本地 adapter→原子 `sheet_set_range_value`→上游 MCP，和读取共用路径。每个 op 是独立调用，精读范围未发现脚本级事务/回滚。
7. `Rv` 默认 120000 ms 到时 terminate Worker；输出超过 12000 字符截取前 8000+后 2000；返回 logs、opsCount、结果或异常。
8. 脚本失败不意味着此前写入撤销；`NN` 错误提示明确写道失败前已入队写入仍会落盘。未指定 sheet_id 默认活动表，并在结果中警告；此路径不像 read_table 那样总是拒绝多表省略 ID。

## 保存与未知边界

SubagentStop hook 实际扫描上游 get_pool_status 所有 is_dirty 实例，逐一 save_file、默认最多三次；异常记录后仍 exit(0)。这不是事务成功凭据，也没有按本次子代理文档筛选。相关脚本 `../hooks/save-on-subagent-stop.mjs` L114–145、149–210；SHA256 `9ace24c19e3b0a9ce38c315813f87c8c74a53cb31d4e1a360382074f66d377f2`。

仍未知：上游 editor SDK 原生导入/导出实现、完整格式保真、复杂公式引擎支持、保存文件占用与并发效果、Worker 超时后已发上游操作是否还能完成、实际模型是否按技能选择路由。没有动态提交文档，不能把源码路径写成已观察的运行记录。
