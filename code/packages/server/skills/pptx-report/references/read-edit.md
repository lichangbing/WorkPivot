# PPT读取与限定修改

先read_document_structure按原versionId读取slide/shape对象；shapeId只绑定当前页与当前版本。可通过parent筛选页的直接对象。坐标单位EMU，分组内坐标为局部坐标，不能当作最终画布坐标；文字、图形与组合类型单独标记。next非空须续读，未覆盖备注、动画、完整图表和图片识别。

## 定位与修改

execute_skill输入原文件版本。changes.json使用原版本sha256及已读取的页和形状：

```json
{"sourceSha256":"原版本SHA256","changes":[{"slide":1,"shapeId":"2","expected":"阶段报告","replacement":"完成报告"}]}
```

```sh
python3 /skills/pptx-report/scripts/edit.py --source '/workspace/inputs/<版本ID>/原稿.pptx' --changes /workspace/changes.json --output /workspace/修改稿.pptx && python3 /skills/pptx-report/scripts/inspect.py --source /workspace/修改稿.pptx
```

只支持未分组、单段落的普通文字形状；不修改图片、表格、组合、字段、备注或动画。替换继承第一个文字片段样式；过长替换、原文冲突、重复目标或不支持对象会失败。原件及未修改页逐字节保留，不重建原稿来冒充局部修改。

## 布局与预览

inspect.py核对页对象和显式几何边界；继承布局或组合对象返回未完全检查提示。文字是否溢出、字体和内容遮挡仍需渲染核对：

```sh
python3 /skills/pptx-report/scripts/convert.py --source /workspace/修改稿.pptx --mode render --output /workspace/预览.pdf
```

宏、外部关系和嵌入对象拒绝转换，显式缺字体会报错。成功生成PDF不代表已完成视觉检查；如未查看每页预览，应保留visual=not-performed说明。使用outputs声明新成果和预览，更新旧成果须传documentId与revision。
