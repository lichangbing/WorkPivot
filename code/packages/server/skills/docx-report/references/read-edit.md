# Word读取与限定修改

先按用户指定的versionId读取，不自动切换新版本。read_uploaded_file提供文字和出处，read_document_structure提供paragraph、table、table-cell及父子关系。next非空时按相同筛选条件续读。对象ID只在当前文件版本内有效；页眉页脚、修订视图和真实分页不在基础读取范围。知识问题用search_project_documents检索，再read_document_citation核对原文。

## 修改协议

通过execute_skill的inputs显式传入原文件版本，使用list_uploaded_files返回的sha256作为sourceSha256。若输入为已有成果，使用其固定版本与校验值。不要把源文件路径或新版本猜测为授权输入。

创建changes.json：

```json
{"sourceSha256":"原版本的SHA256","changes":[{"target":"paragraph:1","expected":"客户张三，原文保留","find":"张三","replacement":"李四"},{"target":"table-cell:1","expected":"原金额","replacement":"100元"}]}
```

expected必须为已完整读取的目标原文；find可省略（替换整段），提供时必须在目标内唯一。支持普通正文段落跨文字片段替换，以及只有一个段落的表格单元格。目标重叠、原文/哈希不符、复杂域/链接/修订/内容控件或纵向合并整格替换会拒绝；不插入或删除行列，不重建全文来冒充局部修改。

```sh
python3 /skills/docx-report/scripts/edit.py --source '/workspace/inputs/<版本ID>/原稿.docx' --changes /workspace/changes.json --output /workspace/修改稿.docx && python3 /skills/docx-report/scripts/verify.py /workspace/修改稿.docx --expect-text '客户李四'
```

修改器保留起点文字样式，重新读回目标并核对其他包成员；源码原件和已有输出均不覆盖。确认成果后再使用outputs发布；更新既有成果传documentId及当前revision，取消或冲突时整批不发布。

## 渲染

需要检查分页或版式时，可生成PDF预览：

```sh
python3 /skills/docx-report/scripts/convert.py --source /workspace/修改稿.docx --mode render --output /workspace/预览.pdf
```

转换依赖固定执行镜像中的LibreOffice和字体。宏、外部关系、嵌入对象和域指令拒绝转换；正文显式字体缺失会报错，主题/继承字体仍需人工核对。渲染成功仅表示生成PDF；未实际查看预览时不得宣称视觉验收通过。模板和新建流程见create.md。
