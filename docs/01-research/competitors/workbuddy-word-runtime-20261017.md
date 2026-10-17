# WorkBuddy Word 新建流程运行实证

日期：2026-10-17。样本：WorkBuddy 5.8.3。用户执行非敏感 Word 新建测试，本轮核对文件、测试时间窗内的工具记录和新增日志，并用 REA 验证被动调试连接。后续结果见 [读取运行实证](workbuddy-word-read-runtime-20261017.md)和[局部修改运行实证](workbuddy-word-edit-runtime-20261017.md)；Excel 尚待执行。

## 1. 产物与真实路由

生成文件为 `E:\project\WorkPivot\tmp\rea-office-test\rea-word-create.docx`，7,044 字节，SHA-256 `120ab97e2148c7687ef2113d5780d5c1a1301fa9653a113bd2867ce97330810d`。ZIP/XML 可解析，包含预期标题、两段正文、REA-WORD-001，以及项目/数量、苹果/3、香蕉/5 的三行两列表格。检查的是文字和结构，未做页面视觉验收。

**本例命中 brief-compose 短文快通道，而非完整三阶段子代理编排。** 观察到 17 次工具调用，没有本次 Task/子代理调用记录。不能把 full_pipeline 推广到所有 Word 新建请求。

## 2. 实际调用时间线

下表为北京时间，证据 JSON 保留原始 UTC 毫秒值。

| 时间 | 动作 | 证据意义 |
|---|---|---|
| 09:00:14 | Skill 加载 workbuddy-office-routing | 真实任务先选 Office 路由 |
| 09:00:30 | Skill 加载 workbuddy-docx | 选择 Word 专用能力 |
| 09:00:35、09:00:44 | Read 编排及 brief-compose 技能 | 实际读取短文分支说明 |
| 09:01:00–09:01:23 | 查找脚本、解析输出路径、查看参数 | 存在路径定位开销；completed 不自动等于每次探测都成功 |
| 09:01:57 | Write 完整 HTML | 本次未观察到先写 Markdown 再委派排版 |
| 09:02:05–09:02:07 | 执行 convert_doc.py | 实际带 --no-preflight --no-verify |
| 09:02:21 | 检查文件并解析 DOCX XML | Agent 另写命令核对内容，而非转换器内置 verify |
| 09:02:40–09:03:00 | 检查并写项目日期记忆 | 记录生成流程及路径定位经验，属于额外副作用 |
| 09:03:05 | present_files | 返回交付文件，结果 previewed=[]，不能据此认定视觉预览已验收 |
| 09:03:17 后 | 宿主创建文档预览 | 新增日志存在文件订阅及本地编辑页面启动 |

测试实际复用了既有会话。只分析测试基线之后的工具记录，不将该会话之前的调用纳入结论，也未读取其原有私人聊天或既有记忆内容。

## 3. HTML 转换与静态代码对应

中间文件位于 WorkBuddy 工作区 `output\brief-compose\rea-word-create.html`，1,494 字节，SHA-256 `192f6ce2a66befca69050f3fc8b3dca67115e868ac51f569212f187c9ef69ae4`。最终 DOCX 位于用户指定目录；中间 HTML 不随交付路径移动。

实际使用托管 Python 3.13.12，执行插件缓存的 `skills\html-to-doc\scripts\convert_doc.py`。其 SHA-256 `9b326657f4ed55d203410774e61fe15caee439528a4d5295e75cbc05550679fe` 与此前审阅的安装产物一致，可以将执行脚本联系到静态代码中的 create_doc→open_file→doc_insert_html_content→save_file 顺序。

本轮没有逐条抓到 MCP 网络调用；上述内部顺序来自同哈希静态代码，不是逐条请求的动态捕获。转换结果实际为 success=true、aigc_tag=true、error=null、Exit Code 0；preflight/verify 都为 null，与跳过参数一致。独立 XML 内容检查也不能替代分页、字体、图片和复杂版式验收。

## 4. 引擎与预览行为

新增 daemon 日志显示 editor_sdk 启动于端口 39099，健康检查从未就绪变为 ready。随后出现测试文件的路径归一化、会话归属检查、文件订阅和预览创建；renderer 日志显示本地 `/static/doc/pc.html`、local_edit=1、openWithExisting=true。

这些证明实际引擎和预览入口存在，不证明每个 HTML 节点如何映射原生对象或完整视觉正确性。部分 renderer 的 error 级别记录是性能计时，不能按“error”字样判生成失败。

## 5. REA 覆盖与来源区分

临时调试端口 9223、9224 均确认监听于 127.0.0.1。REA 成功发现和被动检查 WorkBuddy file 页面，看到 330 个脚本元数据；未读取源码、执行页面 JavaScript 或操作页面。

| 结果 | Evidence |
|---|---|
| 页面发现 | ev_e48e3b9266db67f0758462897c73d5514a81bf240a9a09605850d298c249a5f8 |
| 测试前页面基线 | ev_2f2ec2313b5c7c9d6b77e0770525e5a39afcbb0e7e32e380c1d7e1108dc2ba2b |
| 生成后页面快照 | ev_d3881d6edf5e98681b5abc68bd4943948c18e88a5bd9091609ad66f063258312 |
| 本地编辑页面发现 | ev_6a607abd2f79c7f9bb54635a1e62d01782ecadb442a5fc20f7f21e9db576f919 |

主进程 Inspector 响应元数据，但 REA 排除了其目标位置；HTTP 编辑器也未作为 eligible page target 返回。REA 快照本身不能解释原生内核，也没有实时记录整个工具执行过程。真实命令和结果来自测试范围的会话记录，进程/预览行为来自新增日志，文件内容来自独立 ZIP/XML 检查。

脱敏时间线、工具摘要和身份信息见 [运行证据摘要](workbuddy-word-runtime-evidence-20261017.json)。原始 REA 快照和本次测试摘录位于独立分析目录 `C:\Users\lichb\.codex\visualizations\2026\10\14\01a1385a-d7df-72c1-a100-bcaef9e98f1b\workbuddy-runtime-observation`，整份用户会话未放入仓库。

## 6. 当前还原程度

已证实本例路由、短文 HTML 生成、转换命令、成功结果、产物内容和预览入口；脚本内部顺序有同哈希代码支撑。后续读取和局部修改已在专项记录中验证，Word 原生导入、分页及导出算法仍未反编译完成；Excel 本轮尚未开始。
