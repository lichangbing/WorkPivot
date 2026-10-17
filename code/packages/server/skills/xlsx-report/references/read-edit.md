# Excel读取、限定修改与重算

read_document_structure固定versionId，可按sheet和range（如A1:C20）读取。只返回存储单元格和相交合并范围；next非空必须续读。formula、cached、styleId、numberFormatId及可用的numberFormatCode来自源文件，不是当前计算结果或完整视觉样式。工作表隐藏状态明确返回。

## 修改

execute_skill的inputs列出源文件版本。changes.json包含list_uploaded_files返回的sha256与已核对的原值：

```json
{"sourceSha256":"原版本的SHA256","changes":[{"sheet":"预算","address":"A1","expected":"10","value":15},{"sheet":"预算","address":"A3","expected":"formula=SUM(A1:A2); cached=30","value":{"formula":"SUM(A1:A2)"}}]}
```

expected使用共用读取返回的完整text。value支持字符串、有限数字、布尔值、null和显式formula对象；普通字符串不转公式。只修改已存储单元格，不扩展区域或插入行列；合并范围只允许左上角，受保护工作表、共享/数组/数据表公式以及外部工作簿拒绝修改。数值格式引用保留。

```sh
python3 /skills/xlsx-report/scripts/edit.py --source '/workspace/inputs/<版本ID>/预算.xlsx' --changes /workspace/changes.json --output /workspace/修改稿.xlsx
```

修改后全工作簿普通公式缓存被保守清空，并移除旧计算链、请求客户端重新计算。只有modified状态不代表重算成功；原文件不变，其他包成员核对保留。

## 真实重算及检查

```sh
python3 /skills/xlsx-report/scripts/convert.py --source /workspace/修改稿.xlsx --mode recalculate --output /workspace/成果.xlsx && python3 /skills/xlsx-report/scripts/verify.py /workspace/成果.xlsx --expect-text '预算说明'
```

首批支持同表A1/绝对引用、区域、四则/比较运算，以及SUM、AVERAGE、MIN、MAX、COUNT、COUNTA、IF、ROUND、AND、OR、NOT、ABS、TRUE、FALSE。不支持跨表、字符串常量、名称、外部链接或其他函数；错误公式、缺失缓存或公式变化均失败。转换在无网络、有限内存和65秒子进程上限内执行；重新核对公式后，仅将计算缓存移回原包，避免引擎重写无关样式。

生成器以源参数为准；重算只校验公式身份及有效缓存，业务期望仍须独立核对。公式支持扩展需测试，不能自行放宽检查冒充通用Excel引擎。渲染PDF使用相同convert.py的`--mode render`，不能把PDF生成视为已经做过视觉检查。

outputs只声明最终成果；需要保留修改稿、重算稿、预览时显式声明多个产物。更新成果提供documentId和revision，任一失败/冲突/取消不得发布部分成果。未提供重算环境时报告缺口，不编造缓存。
