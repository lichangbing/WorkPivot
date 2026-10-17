# PPT生成

先整理故事线、大纲和来源，每页一个主题。首批内置版式采用16:9、中文Noto Sans CJK SC字体，标题及最多5条正文；复杂设计可继续使用既有pptxgenjs，但必须独立核对布局，不能宣称支持任意PPT模板。

在/workspace创建spec.json：

```json
{"slides":[{"title":"阶段报告","bullets":["已完成资料整理","下一步业务核对"]},{"title":"验收要求","bullets":["核对文字与来源","检查每页布局"]}]}
```

最多30页，标题40字、每条正文70字以内；参数文件不超过1MB。内容经JSON传入，不拼接为代码。通过execute_skill执行：

```sh
node /skills/pptx-report/scripts/generate.cjs /workspace/spec.json /workspace/成果.pptx && python3 /skills/pptx-report/scripts/convert.py --source /workspace/成果.pptx --mode render --output /workspace/预览.pdf
```

生成器会重新读取页数、文字及对象边界，与大纲逐页核对；失败删除本次新文件。内置版式限字和几何核对不能保证字体排版无溢出，应检查每页预览后再声明视觉验收通过。没有实际检查时明确visual=not-performed。

输入资料必须来自用户授权版本；outputs声明最终PPTX和需要的PDF。原件、已有输出不覆盖；更新成果时传documentId与revision，任一检查失败或取消/冲突时整批不发布。现有文件局部修改见read-edit.md。
