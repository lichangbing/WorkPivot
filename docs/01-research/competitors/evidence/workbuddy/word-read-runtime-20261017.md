# WorkBuddy Word 读取运行实证

日期：2026-10-17。针对前一轮生成的非敏感 `rea-word-create.docx`，用户要求实际读取并列出正文、表格、数量合计，不修改或另存。分析方式为测试时间窗内工具记录、查询结果和独立文件哈希核对，不是逐调用网络抓包。

## 结果

文档读取前后均为 7,044 字节，SHA-256 均为 `120ab97e2148c7687ef2113d5780d5c1a1301fa9653a113bd2867ce97330810d`。本例只读请求没有改变 DOCX 字节。测试继续复用原会话，并非新会话；但确有实际查询调用，不能把结果当成只凭聊天历史回答。

## 实际流程

共观察到 8 次工具调用：加载 workbuddy-local-office-edit，读取 doc.md，列出 doc 工具，分别查看结构与表格 schema，执行两个查询，最后 Edit 项目日期记忆。前 7 次用于读取能力及定位，最后一次是文件之外的记忆写入；“文档只读”不等于整个 Agent 任务没有其他写入。

WorkBuddy 没有重新 open_file，而是复用上下文中的编辑器 file_id。通过托管 Python 运行 edsdk.py，实际调用：

1. `doc_resolve_document_structure`，mode=full、text_preview_length=100、include_table_cells=true。
2. `doc_list_tables`。

两个查询输出都含结构化 JSON，Stderr 为空，Exit Code 0；记录中没有 doc 写工具、save_file 或另存命令。单独的 shell 退出码可能被 head 管道掩盖，因此结论同时依据有效的查询响应和独立哈希，不只依据 completed。

## 返回数据模型

结构查询返回 5 个顶层节点：一级标题、两段正文、一个 Table、末尾空段落；pagination 为 has_more=false、returned_nodes=total_nodes=5，version=0。正文和表格内容与 DOCX XML 一致；数值为 3、5，合计 8。

返回内容包含 paragraph_id、paragraph_index、start_index/end_index、table_id，以及表格每个 cells 的 row/col 和坐标。表格查询再次确认 3 行×2 列、6 个 editable_cells、无 merge_ranges。这表明本路径提供可编辑文档对象的定位信息，而非仅提取纯文字。

实测 schema 明确区分：DOC 位置是 UTF-16 code unit，包含结构占位；表格 table_start/table_end 为闭区间；paragraph_id 只保证当前打开实例内定位，不保证重新打开后稳定。不能把所有 API 的 end 一律视为相同边界，也不能按肉眼字符数猜坐标。

本例使用 full 但 text_preview_length=100；schema 上限为 200。短文本没有截断，不能把本次成功推广为任意长段全文读取。长文还涉及 limit/offset 分页；本次只有 5 节点，不覆盖其行为。

## 证据与未解决问题

脱敏调用、实际查询响应和哈希见 [读取证据](word-read-evidence-20261017.json)。只提取测试时间窗及测试文件相关会话，没有保存整份私人聊天。

已验证的是“真实编辑实例→edsdk 包装→结构/表格查询→有效结果”，以及该文件未变。file_id 最初如何注入、原生 DOCX 如何被解析成这些对象、复杂文档的完整性与保真仍未全部还原；本轮没有新的原生反编译结果，也没有完整的网络调用记录。

后续修改测试使用独立副本 `E:\project\WorkPivot\tmp\rea-office-test\rea-word-edit.docx`，初始字节与源文件一致；实际修改结果和源文件保护见 [局部修改运行实证](word-edit-runtime-20261017.md)。
