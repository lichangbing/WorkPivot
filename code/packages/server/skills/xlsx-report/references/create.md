# Excel新建与模板生成

根据用户要求确认表头、数据来源和业务公式，优先使用内置参数脚本；内容通过JSON文件传入，不拼接为可执行代码。

## 无模板新建

在/workspace创建spec.json：

```json
{"sheets":[{"name":"汇总","rows":[["项目","金额"],["收入",100],["支出",30],["余额",{"formula":"B2-B3"}]]}]}
```

单元格支持字符串、有限数字、布尔值、null，以及显式`{"formula":"SUM(A1:A3)"}`。公式不带开头等号，禁止传入伪造缓存。普通字符串即使以等号开头，也保持文本。最多20张表，每表10000行、每行200列，全文件50000格，参数文件最多1MB。工作表名称不能重复；未知参数直接拒绝。

在execute_skill中运行：

```sh
node /skills/xlsx-report/scripts/generate.cjs /workspace/spec.json /workspace/成果.xlsx && python3 /skills/xlsx-report/scripts/verify.py /workspace/成果.xlsx --expect-text '收入'
```

生成器在输出前重新加载工作簿，对照参数检查工作表、各格值及公式，确认没有声称已计算的缓存。文件请求客户端打开时重算，这不等于本次已经重算；不能用空缓存作为计算结果。expect-text来自本次要求或资料。

## 根据用户模板填充

先按固定versionId调用read_document_structure核对工作表、区域与字段。模板普通文本单元格使用`{{字段名}}`，支持共享字符串、富文本跨片段和inlineStr；字段值仅是单行字符串，保持文本类型，不会自动转数字、日期或公式。不要使用文本字段代替业务公式或金额数字列。

创建fields.json，例如`{"客户":"张三公司","月份":"2026年10月"}`。execute_skill的inputs列出模板版本ID，运行：

```sh
python3 /skills/xlsx-report/scripts/template.py --template '/workspace/inputs/<版本ID>/模板.xlsx' --fields /workspace/fields.json --output /workspace/成果.xlsx && python3 /skills/xlsx-report/scripts/verify.py /workspace/成果.xlsx --expect-text '张三公司'
```

缺字段、多余字段、残留或不支持区域的占位符均失败。公式、图表、批注和条件/循环模板不支持字段填充；原公式与缓存仅保留，不能据此宣称重算。修改文本不会更新任何依赖它的公式缓存。

## 发布与边界

输入模板和已有输出均不会覆盖。outputs仅声明最终成果文件，字段JSON作为过程文件丢弃。生成与检查用`&&`连接；更新成果时传documentId和当前revision，复用原有取消、冲突与整批发布规则。

模板填充重新打开ZIP/XML检查结构，保留未修改的包成员；不承诺完整视觉保真。需要数字格式、复杂公式或排版时可按现有exceljs库编写定制脚本，仍要读回核对，并明确公式重算、图表渲染和视觉检查尚未执行。

需要本次计算公式结果时，按read-edit.md调用convert.py的recalculate模式，并核对返回的公式与缓存；不要仅依赖客户端重算标志。只声明实际执行的检查。
