# WorkBuddy Excel 读取与核算运行实证

日期：2026-10-17。用户要求实际读取非敏感“销售”表，返回数据、公式和结果，并独立核算合计，不修改工作簿。本轮依据测试时间窗内主代理/子代理记录、独立 SHA-256 和同哈希安装代码核对；不是逐调用网络抓包或新的原生反编译。

## 1. 结果与真实委派

文件仍为 6,750 字节，读取前后 SHA-256 均为 `ed390ac792aaeb0598d7f58b06671fa8c7bda1c6e1990f4fa1ee903c3ae9b75c`。本例没有改变 XLSX 字节。

主代理有 3 次调用：加载 workbuddy-sheetagent，Agent 委派 sheet-agent，最后更新项目日期记忆。不同于新建文件的主代理 Python 建表路径，本次确实进入表格子代理。没有把 Skill 加载或主代理完成消息当成完整的子代理执行证据；已定位并核对子代理记录。

子代理实际调用 8 次：resolve_local_excel 五次均未成功；read_table 第一次传错 sheet_id，第二次成功；最后 get_cell_ranges 成功。记录外层 status 都为 completed，但返回内容明确包含失败，completed 不等于业务成功。

## 2. Windows 路径解析缺陷

真实过程为：

| 尝试 | 返回 |
|---|---|
| E:\\project\\...\\rea-excel-create.xlsx | INVALID_LOCAL_PATH，要求路径以 / 开头 |
| 省略 local_path | NO_DEFAULT_WORKBOOK |
| E:/project/.../rea-excel-create.xlsx | INVALID_LOCAL_PATH，同样要求 / 开头 |
| /E:/project/.../rea-excel-create.xlsx | LOCAL_PATH_NOT_FOUND，被 Windows stat 解释为错误路径 |
| /e/project/.../rea-excel-create.xlsx | LOCAL_PATH_NOT_FOUND |

核对实际插件缓存 `mcp/server.mjs`：SHA-256 `7c4945550273b7bebcbb171fe01edacd94ebd76f85b88c24c84cd5af19e7cfc4`，与此前 REA 静态样本一致。函数 UN 存在无条件的 `t.startsWith("/")` 检查，该表达式的 0-based UTF-16 偏移为 512537；失败后在 stat 之前返回校验错误。这与运行中拒绝 Windows 盘符路径的结果相互印证，属于已定位的路径兼容性问题，不是用户文件缺失。

错误 hint 将原因指向主代理路径缺失/错误，但本例前两种盘符路径实际有效。子代理随后尝试伪造斜杠前缀仍失败，增加了无效调用。

## 3. 成功读取路径

子代理最终没有取得 resolve_local_excel 的成功结果，而是把真实 Windows 路径直接作为 file_id，先调用 read_table，并把工作表名称“销售”误作 sheet_id。服务返回可用 sheet_id=000001 后，子代理改用该 ID，读取成功。

read_table 返回 4 行×4 列 grid、orientation=MATRIX、structured=true，数值和文字与文件 XML 一致。其 header_rows 只列出数量/单价/金额，未包含品名，说明自动表头识别结果与完整首行不是同一数据；grid 中首行完整。后续 get_cell_ranges 指定 A1:D4、include_formulas=true、include_number_formats=true，返回 values、formulas、空 number_formats。

| 单元格 | 返回公式 | 返回值 |
|---|---|---|
| D2 | =B2*C2 | 30 |
| D3 | =B3*C3 | 20 |
| D4 | =SUM(D2) | 30 |

子代理根据明细计算 3×10+5×4=50，指出 D4 只包含 D2、遗漏 D3、少计 20。实际输入来源变化的归因仍按 [生成实证](workbuddy-excel-create-runtime-20261017.md)记录，不能把合计不完整误写为重算器算错。

## 4. 能证明与不能证明的范围

子代理工具记录没有 set_cell_range、run_command 或保存调用，结合原文件哈希不变，确认本例文档只读。主代理仍更新了项目记忆，不能称整个 Agent 任务没有任何写入。

成功路径确认了“主代理→sheet-agent→表格 MCP 工具→工作簿数据/公式”。路径形式 file_id 可用于此实例；没有证明任意尚未打开的文件都可绕过解析器，也没有完整还原路径与真实编辑器 UUID 的映射。

这是一个小表。不能用它验证大表发现窗口、截断、隐藏区域覆盖、复杂公式或任意数据完整性；也没有执行 Worker JS，run_command 安全性和失败回滚仍未动态验证。

脱敏父/子调用、实际响应、哈希与代码定位见 [读取证据](workbuddy-excel-read-evidence-20261017.json)。只保留本次测试，不复制整个私人会话。后续局部修改使用独立副本 rea-excel-edit.xlsx，结果见 [修改与修复实证](workbuddy-excel-edit-runtime-20261017.md)。
