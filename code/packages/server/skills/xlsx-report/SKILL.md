---
name: xlsx-report
description: 生成规范的企业 Excel 表格/数据报表。Use when 用户要求生成 Excel、表格、清单、台账、数据汇总等 .xlsx 交付物时。基于内置 exceljs 库（NODE_PATH 已预配置），生成后必须自检。
license: Proprietary. 内置技能，随 WorkPivot 发行。
---

# Excel 表格生成（内置技能）

生成 .xlsx 的标准流程：**先定表头，再写生成脚本，运行，最后自检**。不要手工拼二进制。

## 第一步：结构纪律

- 先在回复中给出表头与行数估算，确认列设计合理后再写脚本。
- 一张工作表一个主题；列宽要设置（表头中文约 12-24）；数字列右对齐由库默认处理。
- 单元格内容不换行填长文——长文本放 Word，不放 Excel。

## 第二步：写生成脚本（Node + exceljs）

- 新建 `gen-xlsx.cjs`（注意 .cjs 后缀，用 require），内容骨架：

```js
const ExcelJS = require('exceljs');
(async () => {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'WorkPivot';
  const ws = wb.addWorksheet('汇总');

  ws.columns = [
    { header: '名称', key: 'name', width: 24 },
    { header: '数量', key: 'qty', width: 10 },
    { header: '金额（元）', key: 'amount', width: 14 },
    { header: '备注', key: 'note', width: 30 },
  ];
  ws.addRow({ name: '项目甲', qty: 3, amount: 1200.5, note: '' });
  ws.addRow({ name: '项目乙', qty: 5, amount: 3000, note: '含加急费' });

  // 表头样式：加粗+底色
  const header = ws.getRow(1);
  header.font = { bold: true };
  header.eachCell((cell) => { cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEEEEEE' } }; });

  // 数字列格式
  ws.getColumn('amount').numFmt = '#,##0.00';

  await wb.xlsx.writeFile(process.argv[2] ?? '报表.xlsx');
  console.log('written');
})();
```

常用能力：`ws.addTable()` 结构化表格；`cell.note` 批注；色值是 **8 位 ARGB**（如 `'FFEEEEEE'`，不带 #）。

## 第三步：运行

```
node gen-xlsx.cjs "数据报表 v1.0 <日期>.xlsx"
```

## 第四步：自检（必须）

```
node -e "const b=require('fs').readFileSync('<输出文件名>');const ok=b[0]===0x50&&b[1]===0x4b&&b.includes(Buffer.from('xl/workbook.xml'))&&b.length>2000;if(!ok){console.error('自检失败');process.exit(1)}console.log('自检通过',b.length,'字节')"
```

- 自检失败 = 文件损坏：检查脚本（最常见：argb 色值位数不对、把 .xlsx 当纯文本写）。
- 修复后重新运行与自检（最多重试 2 次）。
