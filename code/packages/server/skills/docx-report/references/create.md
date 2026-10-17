# Word新建与模板生成

先依据用户目标确定内容、大纲和必要资料；信息足够时直接生成。优先使用内置参数脚本，只有超出其明确能力时才编写定制生成脚本。内容通过JSON文件传入，不能将用户文字拼接成代码或命令。

## 无模板新建

在/workspace创建`spec.json`，示例：

```json
{"title":"项目周报","paragraphs":["本周完成资料整理。","下周进行业务核对。"],"tables":[[["事项","状态"],["资料整理","完成"]]]}
```

支持可选title、必填paragraphs数组和可选tables二维文本数组；表格放在正文段落之后。最多500段、20表，每表200行30列；每项文本最多10000字符，参数文件最多1MB。表格列数须一致，不支持任意排版配置。采用宋体正文，标题使用标题样式。

在execute_skill中运行：

```sh
node /skills/docx-report/scripts/generate.cjs /workspace/spec.json /workspace/成果.docx && python3 /skills/docx-report/scripts/verify.py /workspace/成果.docx --expect-text '本周完成资料整理。'
```

生成器会重新打开产物，核对正文顺序、表格数量和行列；失败删除本次新文件并退出。额外expect-text须来自用户要求或输入资料，用于核对业务要求，不能只验证任意生成文字。

## 根据用户模板填充

先用read_document_structure读取用户明确指定的模板版本。占位符格式为`{{字段名}}`，字段名支持字母、中文、数字、下划线、点和连字符。创建fields.json，例如：

```json
{"客户":"张三公司","金额":"1000元"}
```

通过execute_skill的inputs显式传入模板版本ID。输入路径由服务映射为`/workspace/inputs/<版本ID>/<原文件名>`，不要假设主机路径可访问。在同一命令中运行：

```sh
python3 /skills/docx-report/scripts/template.py --template '/workspace/inputs/<版本ID>/模板.docx' --fields /workspace/fields.json --output /workspace/成果.docx && python3 /skills/docx-report/scripts/verify.py /workspace/成果.docx --expect-text '张三公司'
```

支持正文及表格段落中的普通文本字段，包括跨TextRun和重复字段。插入文本继承占位符起点的文字格式；其余文字和包成员保留。字段为单行文本，不接受换行、嵌套占位符或循环/条件语法。缺字段、未使用字段、格式错误或不支持区域中的字段均失败，不输出貌似成功的半填充文件。页眉页脚、图形、文本框和公式字段不在本批范围内。不得把此能力宣传为任意Word模板或完整保真编辑。

## 发布与限制

outputs只声明最终成果文件名；字段JSON和脚本是过程文件。生成与检查必须用`&&`连接，失败不发布。新建成果不覆盖上传原件；更新既有成果需documentId和当前revision，沿用冲突/取消及整批发布机制。

内置脚本只接受不存在的输出路径。模板生成会重新打开ZIP/XML核对结构，不执行宏、外链或文档脚本。结构和内容通过不等于分页、字体或视觉检查通过。需要复杂排版时使用现有docx库编写有界脚本，并调用相同检查器；不把定制脚本自动视为已验收。
