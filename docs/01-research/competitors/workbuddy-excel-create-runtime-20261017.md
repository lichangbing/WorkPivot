# WorkBuddy Excel 生成与重算运行实证

日期：2026-10-17。样本：WorkBuddy 5.8.3。用户执行非敏感新建工作簿任务。本轮核对实际输入、工具记录、生成脚本和 XLSX 内部 XML；没有执行目标脚本，没有逐调用网络抓包，也没有新的原生反编译结果。

## 1. 输入变化与结果归因

原拟测试要求 D4 为 `SUM(D2:D3)`，预期 50。但 WorkBuddy 实际收到的 user_query 是 `SUM(D2)`；A1:D1、A2:C2、A3:C3 等范围也分别变为 A1、A2、A3。范围在传递/粘贴后变化的原因尚未确认，不能归因于 WorkBuddy 生成器、重算器或某个界面组件。

实际 build.py 从一开始就写 `=SUM(D2)`；重算后的文件和 Agent 随后的独立核对都显示该公式、缓存值 30。因此它符合实际收到的公式，不是 LibreOffice 将正确求和范围算错，也不是预览阶段破坏了公式。本次不能当成原拟两行求和测试通过，更不能据此报告“生成器漏算香蕉”的产品缺陷。

## 2. 实际生成链

测试时间窗内共有 13 次工具调用，顺序为：

1. Skill 加载 workbuddy-sheet-generation。
2. 检查输出文件与目录，并读 schema_principle。
3. Write 生成 `.rea-excel-create.ref/build.py`。
4. 检查托管 Python 与隔离虚拟环境中的 openpyxl。
5. 使用 `binaries/python/envs/default/Scripts/python.exe` 执行 build.py。
6. 执行该版本 sheet-generation 的 recalc.py，参数含目标文件和 60 秒重算预算。
7. 执行 aigc_label.py。
8. 以 openpyxl 公式视图和 data_only 缓存视图核对结果，再检查目录、写入日期记忆，最后 present_files。

没有观察到本次 Task/sheet-agent 子代理调用，也没有通过本地表格编辑器 API 创建文件。这与“新文件生成”和“已有工作簿修改”分流相符。

recalc 实际输出 status=success、total_errors=0、total_formulas=3、engine=libreoffice，Exit Code 0。由此确认本次走 LibreOffice，而非 formulas 降级引擎。AIGC 步骤报告 labeled，最终 ZIP 存在对应自定义属性；不能据此评价其法律效果。

## 3. 产物独立核对

文件为 `E:\project\WorkPivot\tmp\rea-office-test\rea-excel-create.xlsx`，6,750 字节，SHA-256 `ed390ac792aaeb0598d7f58b06671fa8c7bda1c6e1990f4fa1ee903c3ae9b75c`。工作表为“销售”。字符串由 sharedStrings 解码，数值和公式由 worksheet XML 直接核对。

| 单元格 | 公式 | 缓存值 |
|---|---|---|
| D2 | B2*C2 | 30 |
| D3 | B3*C3 | 20 |
| D4 | SUM(D2) | 30 |

公式保留在 `<f>`，计算结果位于 `<v>`，没有以固定数值替代公式。生成脚本、重算输出、Agent 自查和最终文件相互一致。两份 Word 测试文件的 SHA-256 均与上一轮相同。

这只覆盖简单乘法和单参数 SUM。0 个公式错误表示未发现受检错误值，不代表满足原业务意图、任意复杂公式正确或视觉排版已验收。

## 4. 实现证据与边界

实际 build.py 使用 openpyxl Workbook、Worksheet、Font/Fill/Alignment/Border 等 API，设置单元格、列宽和文档标题后 save；文件位于用户指定输出目录旁的 `.rea-excel-create.ref`。本轮只读取并解析脚本，没有再次运行它覆盖产物。

调用摘要、真实接收的测试文本、XML 单元格、文件与脚本哈希见 [生成证据](workbuddy-excel-create-evidence-20261017.json)。原始记录仅在独立分析目录保留本次时间窗内容，整份用户会话和其中的系统上下文未放入仓库。

当前已验证“主代理生成 Python→openpyxl 写文件→LibreOffice 重算→标记→核对→交付”这一条路径。后续见 [读取与核算实证](workbuddy-excel-read-runtime-20261017.md)、[局部修改与修复实证](workbuddy-excel-edit-runtime-20261017.md)。修改测试经历公式格式异常和 Agent 修补后才最终重算通过；sheet-agent Worker 尚未动态测试，原生表格导入导出和复杂公式算法仍未还原。
