# WorkBuddy Word 实现深入分析

日期：2026-10-17。目标为本机 WorkBuddy 的安装产物及该产品插件缓存。全程静态，不执行 WorkBuddy、转换脚本或本地文档服务。本轮补足前一份报告对实际实现分析不足的问题，不提出替代技术方案。

## 1. 本轮结果与未完成部分

| 问题 | 当前证据 | 状态 |
|---|---|---|
| Word 如何预览内容 | 已找到实际 JSZip、OOXML 文档模型解析、DOM 渲染代码 | 已回答一条预览路径 |
| Word 如何发起对象编辑与新建 | Python 包装及转换调用链已找到，并在原生二进制找到相关工具名与错误字符串 | 接口路径已回答，内部算法未回答 |
| DOCX→HTML 抽取的底层实现 | 脚本要求的 bundled CLI 在所查安装包、ASAR 清单、当前插件缓存未找到 | 未解决，不能认定此路径可用 |
| 原生 Word 导入、HTML插入、保存算法 | REA 原生反编译 provider 不可用 | 未解决 |

## 2. 找到的实际预览解析器

原始文件位于 `C:\Users\lichb\AppData\Local\Programs\WorkBuddy\resources\app.asar.unpacked\renderer\assets`：

- `docx-preview--QDNXici.js`：522 字节，宿主预览组件接线。
- `docx-preview-component-CuVqNtym.js`：80,013 字节，包含实际 OOXML 解析和 HTML 渲染实现。
- `jszip.min-CzoVRnZi.js`：96,664 字节，压缩包读取依赖。

对三文件制作原样分析副本，原始与副本路径及 SHA-256 见 [文件身份清单](office-word-artifacts-20261017.json)。没有把目标源码放入项目仓库。解析器文件 SHA-256 为 `16268de5e7d0ddc94fdc89203c8b40a7d32f49a12cde7af1261d16c5097191aa`。

以下偏移是原始 JS 解码后的 **0-based UTF-16 字符偏移**，不是文件字节偏移，也不是 REA 已完整恢复的调用图。函数关系由同哈希产物的惰性文本审阅确认：

1. `docx-preview--QDNXici.js` 的组件从 MediaPreviewContext 取 file，将文件交给 DocxPreviewComponent。
2. component @78965：React effect 收到文件后，在 requestAnimationFrame 中调用 `renderAsync(file,container,undefined,options)`，finally 取消 loading。
3. `renderAsync` @14823 → `parseAsync` @14613 → `WordDocument.load(file,new DocumentParser(options),options)`。
4. `OpenXmlPackage.load` @19283 用 `JSZip.loadAsync` 读取文件；`loadRelationships` @19538 读取 `_rels/.rels`，以及各 part 的关系文件。
5. `WordDocument.load` @24490 附近依据 OfficeDocument 关系加载正文，默认目标 `word/document.xml`；`loadRelationshipPart` @24968 分派正文、字体、样式、编号、主题、页眉页脚、注释和文档属性等 part。
6. `DocumentPart.parseXml` @19933 → `DocumentParser.parseDocumentFile`，形成段落、run、表格等文档对象。DocumentParser 定义 @28709。
7. `renderDocument` @14703 创建 HtmlRenderer，在浏览器 DOM 中渲染解析结果。它不是 Word 原生排版引擎。

组件传入的 options 关闭 renderAltChunks（@78965 前），所以不能仅凭库内部存在 iframe 渲染函数就认定本组件会渲染它。库默认关闭 renderChanges、renderComments，并忽略 lastRenderedPageBreak；预览不等于完全还原 Word 分页、修订和所有对象。

库内部虽有 ZIP update/save 方法，以上组件使用路径只观察到解析与渲染，没有观察到把用户编辑写回 DOCX 的调用。不能据此声称 Word 修改用这个预览库完成。实际编辑工具走前报告中的本地 SDK 路径。

## 3. REA 实际覆盖

父 Evidence：`ev_8652792890cf214ecf1fbd18fdaf62d9eae8a0d876fcbb2a392fb4cc2b937655`。分析副本目录 SHA-256：`99036a90391b3d9005fe99a9ee3727e42c6ec31aa7bdf1263c6afdad79c53078`。

REA 解析 3 个 JS、177,199 文本字节、55,651 AST 节点，无 parse failure；application inventory 完整，但 semantic graph 达到 100,000 节点上限，partial/truncated、11,623 unknowns。已用模块页定位资产，并用 asset item 核对文件身份：`ev_bbcd1edca04fbfc1bd3306e5d69fce216d55ea755ab3f3a3037acea847d08b8e`。

对 JSZip import 的 exact module trace 返回 no-match：`ev_e7b2da1cb58588631eb240ccb4ba3d01ce1eade147b53b92f261247817f6d1ea`。这说明选择的图种子未命中，不证明源代码不存在该调用；不把它包装成成功的函数追踪。以上函数链由实际代码审阅补充。

REA summary、资产视图、trace 和原生资源证据已保存为 [本轮 REA 证据记录](office-deep-rea-evidence-20261017.json)，使关键覆盖限制不只存在于聊天中。

## 4. 原生引擎身份与阻碍

目标为安装包内 `node_modules\@tencent\tencent-docs-ai-engine\bin\win32-x64\editor_sdk.exe`。本轮 REA `inspect_pe_resources` 直接读取该原生文件，Evidence `ev_04a46977dff9f5213c2e64daee1ddd8514a8cd97e1b441ed214b27a4c73f8f8c`：

- PE32+、machine 34404（0x8664），209,234,760 字节。
- SHA-256：`b372679233c2ea586cc9e2ee9f491b06a702780bf72b8ef15cec1761994fd45c`。
- 标准 PE resource 树仅有 1 个 type 24、name 1、language 1033 的资源，323 字节；3 个目录条目全部检查。

这只证明标准资源表，不能推断没有在其他 section 嵌入模板、静态 ZIP、字符串或脚本。

另外以普通 Python 做有界字面量字节搜索，见 [原生字符串清单](office-native-strings-20261017.json)。这不是 REA 反编译。发现 `doc_insert_html_content`、`doc_find_and_replace`、`create_doc` 等工具名，且有以下可追踪线索：

- 文件偏移 185141804：create_doc 的报错提到 embedded blank.docx 和 DOCX_EMBED_STATIC_ZIPS。
- 185192707：create_doc 的 file_id 已使用错误。
- 184428946：doc_find_and_replace 的 old_text 不能为空。
- 184822764：scope.begin 必须小于 scope.end。
- 185086289：未保存时要求先 localapi/save，或用 force 丢弃。
- 166913003 附近存在 `word/document.xml` 与 ZIP 字节线索。

这些可以作为之后交叉引用和函数反编译的种子，但不能仅据字符串认定已经证明空白模板加载、参数检查和保存的完整执行路径。

初始 REA `binary_session` 报告 Ghidra 未配置，检测到 Java 17.0.18，而 provider 要求完整 64 位 JDK≥21。后续继续分析时，已补齐独立便携 Ghidra 12.1.4/JDK 21 环境，provider 就绪检查通过，原生自动分析已启动；详情见 [原生引擎分析](office-native-20261017.md)。原有聊天 REA 服务环境未被全局修改。环境就绪不能代替函数结果，本文的 Word 导入、编辑与导出内部算法仍未完整还原。

## 5. DOCX 抽取路径的分发缺口

此前报告描述 `skills/format-extract/run.py` 调 bundled `dist/cli.cjs`；这是脚本的实际契约，不是已确认的转换器实体。进一步枚举确认：

1. 当前安装目录中的 workbuddy-docx/skills/format-extract 下没有该 CLI。
2. 当前 app.asar 的 14,474 条文件清单也没有该目录下的 dist/cli.cjs，run.py 为 unpacked 条目。
3. 本机 `.workbuddy/plugins/cache/workbuddy-builtin/workbuddy-docx/5.8.3-wb.41334564.gdb0e9b51.h4da087921e4a` 的已检索文件中未找到该 CLI。
4. setup.sh 仅检查 Node，不安装或生成该 bundled CLI。

在这些搜索边界内，无法继续还原此转换器，也不能宣称重排版的 DOCX→HTML 路径已具备运行条件。其他历史 tencent-docx 插件存在不同实现，不应用其代码代替当前版本。

继续深入原生部分应围绕上述工具字符串交叉引用，追到注册 handler、文档对象变更、导出及失败处理。环境缺口已修复，当前 Word 核心仍是部分回答，最终函数证据见原生专项。
