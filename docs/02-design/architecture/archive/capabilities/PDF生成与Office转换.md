# PDF 生成与 Office 转换（2026-10-26）

## 目标与路线

用户要求补齐生成 PDF 的工具。采用两条互不替代的路线：

| 场景 | 路线 | 原因 |
| --- | --- | --- |
| 从零生成报告、方案、分析等 PDF | `create_pdf`：安全 HTML → Chromium `page.pdf()` → 版本化成果 | CSS 分页、中文字体、表格、页眉页脚和页面方向可控，复用现有浏览器服务，不增加 Office 运行时 |
| 已将 Word、Excel、PPT 转换为 PDF | 对应 Office Skill 的 `convert.py` → LibreOffice → PDF | 保留 Office 文档原有页面模型更合适；不能用 HTML 重排冒充原稿转换 |

直接生成 PDF 不依赖 LibreOffice。Office 转换仍要求执行镜像安装 LibreOffice 和 Noto CJK 字体；缺少依赖时必须明确失败，不发布半成品。

## `create_pdf` 安全边界

- 模型只提交不含目录的 `.pdf` 文件名、标题和有界 HTML 片段，不提交宿主路径、脚本或浏览器导航地址。
- HTML 最大 256 KiB，纸张仅允许 A4、Letter、Legal，边距 5–40 mm，最多 100 页、16 MiB。
- 浏览器上下文关闭 JavaScript 和 Service Worker，并阻断全部网络请求；CSP 仅允许内联样式和 `data:` 图片。
- 禁止完整 HTML 文档及 script、表单、iframe、object、embed、link、meta、base 等标签和事件处理器。
- 生成结果校验 PDF 文件头和页数，再通过现有不可变文件版本链路保存为成果；更新已有成果必须携带 `documentId` 和当前 `revision`。
- 页面打印成功只证明 PDF 结构有效，不能自动宣称视觉验收通过。模型必须如实区分“生成、结构有效、视觉未检查”。

## 竞品观察

- WorkBuddy 的 document-skills 插件同时捆绑 `pdf` 与 `pdfkit-py` 技能；其 Office 预览链路使用 LibreOffice → PDF → 图片。证据见[WorkBuddy 扩展系统分析](../../../../01-research/competitors/evidence/workbuddy/extension-system.md)和[Office 处理分析](Office处理开发参考.md)。现有证据只确认技能/插件与转换链存在，不能据此断言其所有 PDF 都由同一底层库生成。
- Codex 没有固定的“PDF 生成 API”，而是使用当前执行环境中的文件、命令和代码工具调用 PDF 工具链。实际质量取决于选用的 Chromium、LibreOffice、Python/Node 库和字体；本环境访问 OpenAI 官方文档站返回 403，未把未读取的官方页面内容当作依据。

## 验收

1. 纯输入边界：拒绝脚本、iframe、表单、事件处理器、完整 HTML、非法页边距和超长正文。
2. 真实 Chromium：中文标题、表格及显式分页生成两页 PDF，文件头为 `%PDF-`，页数一致。
3. 安全：外部图片请求被阻断，JS 不执行，输出不包含宿主路径。
4. 归档：PDF 作为成果可列出、下载和按 `documentId + revision` 更新；失败、取消或超限不发布。
5. Office 转换：在含 LibreOffice 的隔离镜像中验证 DOCX、XLSX、PPTX → PDF 和 PDF 文件头；视觉检查单独记录。
