---
name: docx-report
description: 生成规范的企业 Word 报告/文档。Use when 用户要求生成 Word、报告、纪要、方案等 .docx 交付物时。基于内置 docx 库（NODE_PATH 已预配置），生成后必须自检。
license: Proprietary. 内置技能，随 WorkPivot 发行。
---

# Word 报告生成（内置技能）

生成 .docx 的标准流程：**先写生成脚本，再运行，最后自检**。不要手工拼二进制。

## 第一步：写生成脚本（Node + docx 库）

- 新建 `gen-docx.cjs`（注意 .cjs 后缀，用 require），内容骨架：

```js
const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell } = require('docx');
const fs = require('fs');

const doc = new Document({
  styles: { default: { document: { run: { font: '宋体', size: 24 } } } }, // 24 半磅 = 12pt
  sections: [{
    children: [
      new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun({ text: '标题', bold: true })] }),
      new Paragraph({ children: [new TextRun('正文段落，一节一个论点。')] }),
    ],
  }],
});
Packer.toBuffer(doc).then((buf) => fs.writeFileSync(process.argv[2] ?? '报告.docx', buf));
```

## 内容纪律

- **先大纲后生成**：先在回复中给出文档大纲，确认结构合理后再写脚本。
- **一节一论点**：每个标题下只讲一个主题；段落 3-5 句。
- 中文字体用宋体/黑体（font: '宋体'）；标题加粗；不要用 emoji。

## 第二步：运行

```
node gen-docx.cjs "输出文件名 v1.0 <日期>.docx"
```

## 第三步：自检（必须）

```
node -e "const b=require('fs').readFileSync('<输出文件名>');const ok=b[0]===0x50&&b[1]===0x4b&&b.includes(Buffer.from('word/document.xml'));if(!ok||b.length<2000){console.error('自检失败');process.exit(1)}console.log('自检通过',b.length,'字节')"
```

- 自检失败 = 文件损坏：检查脚本（最常见：hex 色值写错、表格缺宽度声明、把 .docx 当纯文本写）。
- 修复后重新运行与自检（最多重试 2 次）。
