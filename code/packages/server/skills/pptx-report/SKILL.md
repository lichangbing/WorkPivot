---
name: pptx-report
description: 生成规范的企业 PowerPoint 演示文稿。Use when 用户要求生成 PPT、汇报材料、幻灯片等 .pptx 交付物时。基于内置 pptxgenjs 库（NODE_PATH 已预配置），生成后必须自检。
license: Proprietary. 内置技能，随 WorkPivot 发行。
---

# PPT 生成（内置技能）

生成 .pptx 的标准流程：**先写大纲，再写生成脚本，运行，最后自检**。不要手工拼二进制。

## 第一步：大纲纪律（先想清楚再写）

- 先在回复中列出每页幻灯片的标题与要点（一页一个主题），确认逻辑顺畅后再写脚本。
- 页数克制：汇报类 5-10 页；每页要点 ≤5 条，一条一行，不写长句。
- 中文字体统一 `fontFace: 'Microsoft YaHei'`；标题加粗；不要用 emoji。

## 第二步：写生成脚本（Node + pptxgenjs）

- 新建 `gen-pptx.cjs`（注意 .cjs 后缀，用 require），内容骨架：

```js
const pptxgen = require('pptxgenjs');
const p = new pptxgen();
p.defineLayout({ name: 'L16x9', width: 13.33, height: 7.5 }); // 16:9
p.layout = 'L16x9';
p.title = '汇报标题';

const cover = p.addSlide();
cover.addText('汇报标题', { x: 0.8, y: 2.6, w: 11.7, fontSize: 36, bold: true, fontFace: 'Microsoft YaHei', align: 'center' });
cover.addText('2026 年 9 月 · 汇报人', { x: 0.8, y: 4.0, w: 11.7, fontSize: 16, fontFace: 'Microsoft YaHei', align: 'center', color: '666666' });

const s1 = p.addSlide();
s1.addText('章节标题', { x: 0.5, y: 0.4, w: 12.3, fontSize: 28, bold: true, fontFace: 'Microsoft YaHei', color: '1F3864' });
['要点一，一行一条', '要点二', '要点三'].forEach((t, i) => {
  s1.addText(t, { x: 0.8, y: 1.6 + i * 0.9, w: 11.5, fontSize: 18, fontFace: 'Microsoft YaHei' });
});

p.writeFile({ fileName: process.argv[2] ?? '汇报.pptx' }).then(() => console.log('written'));
```

常用能力：`slide.addTable(rows, { x, y, w, fontSize: 12, border: true })` 表格；
`slide.addNotes('备注')` 演讲备注；色值是 **6 位 hex 字符串**（如 `'1F3864'`，不带 #）。

## 第三步：运行

```
node gen-pptx.cjs "汇报材料 v1.0 <日期>.pptx"
```

## 第四步：自检（必须）

```
node -e "const b=require('fs').readFileSync('<输出文件名>');const ok=b[0]===0x50&&b[1]===0x4b&&b.includes(Buffer.from('ppt/presentation.xml'))&&b.length>5000;if(!ok){console.error('自检失败');process.exit(1)}console.log('自检通过',b.length,'字节')"
```

- 自检失败 = 文件损坏：检查脚本（最常见：色值带 #、坐标写出画布、把 .pptx 当纯文本写）。
- 修复后重新运行与自检（最多重试 2 次）。
