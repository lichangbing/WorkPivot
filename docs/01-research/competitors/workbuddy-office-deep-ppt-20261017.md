# WorkBuddy PPT 实现深入静态分析（2026-10-17）

## 结论与证据等级

本次从技能路由继续追踪到本产品托管 Node 中的实际 `@tencent/slidep` JavaScript 产物，使用 REA 分析，并对原始 bundle 的函数字节进行定点审阅。**当前可解析的 Windows shim 指向 slidep 6.6.1；它并非将 DSL 独立直接写成 OOXML，而是将页面布局转换为 editor SDK 的 mutation/revision，通过本地服务提交，再由本地服务保存 PPTX。** 技能文案的“编译成 OOXML”只描述最终格式，不能替代实现链。

未执行目标 JS、shim、WorkBuddy、Office、LibreOffice、HTTP 服务或模型请求；未安装依赖。这里证明静态代码存在及其参数关系，不证明该版本在某次真实任务中被加载或调用成功。

## 样本身份和搜索边界

有界搜索安装目录 `C:\Users\lichb\AppData\Local\Programs\WorkBuddy`，并按产品托管布局搜索 `C:\Users\lichb\.workbuddy\binaries\node`、`plugins`、`vendor`、`cache` 的文件路径。未读取用户会话、账号凭据或全盘搜索。

样本根目录（以下称 N）：`C:\Users\lichb\.workbuddy\binaries\node\versions\22.22.2-6`。

| 文件（相对 N） | 身份 / SHA-256 |
|---|---|
| `slidep.cmd` | `f8bfee739126aa26f776f55f6fedd9c5a0cb6ce504f042fa0026018fa757dd48` |
| `node_modules/@tencent/slidep/package.json` | version `6.6.1`；`de8530e71b13fd2a3acff65322c1355a7faa2c8c31e135b49f979839fec9767a` |
| `node_modules/@tencent/slidep/dist/index.js` | 43 bytes；`57f6279e7a6446e1f23df00a4868c2f061536716626e44f63aa8b81c9f232b66` |
| `node_modules/@tencent/slidep/dist/slidep.js` | 49,975,376 bytes；`6524387adaaa79643cc3ec38aff7490af1b5ec287feeb31a05854792b0857348` |
| `node_modules/@tencent/slidep/dist/resources/pptx/blank.pptx` | `a6d97a17a9b10667bf5ee9df16c906534c1ff9447487a9dca6642780140540eb` |
| `lib/node_modules/@tencent/slidep/dist/slidep.js` | 独立旧副本 version `6.5.1`；`11df0769b3ec3024c7cf11cd0b3b7fbcfb7a0e98ef85ee0c2e8249706d66c4b7` |

`slidep.cmd:5–8` 设置入口为 `%~dp0node_modules\@tencent\slidep\dist\index.js`，使用同目录 node.exe；`index.js:2` require `./slidep.js`。因此本分析以 shim 指向的 6.6.1 为主体，不把 `lib` 的 6.5.1 混入。shim 缺少实体时以 69 退出，提示后台下载，明确不在前台下载、不通过 npm 安装。存在实体不等于本次实际运行路径已经观测。

## REA 执行记录与限制

1. 对实际 `dist` 调用 `analyze_javascript_application(format=directory, detail=summary, analysis_timeout_ms=60000, max_heap_mb=2048)`。父 Evidence `ev_ab1812b622ea17392cf8cb4ebd4028de9276a9b9f338c81b039445e20a057771`；summary `ev_e47659a9b4cfd477b8a28cb30381dfcbd41d9590261745f5f407df3d307c105d`；目录 digest `18e95df0e98b331dc7782a388ddbd83c8f6e86d48251cce13a0fb12eed453531`。
2. 结果读取两个 JS 共 49,975,419 bytes，但仅入口完成解析；大 bundle 在静态分析时耗尽 heap。application/semantic 均 partial，不能把 modules=0 当成没有模块。
3. 从原始 bundle 按下表半开 UTF-8 字节区间复制五个完整函数片段到临时分析目录，未改写函数体，合计 5,468 bytes。再调用 REA summary；父 Evidence `ev_08e01e6a22656daf022e8381c692b225c8284dbf2cfc3911e8197908e335d0a8`，summary `ev_c0f701ab94e3e8d3893b43b1a9b2222b574b8f7656f87d01b116f310960f2d39`。五文件全部解析，1,535 AST 节点，application complete（仅切片），semantic unknown，374 unknowns。切片缺少 bundle 闭包中的被调用实现与绑定，不能冒充完整应用图；REA 的 authority 标签不改变切片的派生性质。
4. 针对 `/localapi/commitrevision` 做 forward-influence trace，Evidence `ev_39c7f4f06c3069b11f0d7f352657916ce1728df644b1a25c852690c51605accc`，返回 partial、0 seed matches。该查询未证明调用链，不用其“无匹配”否认原始字节中的调用。

| 原始函数 / 半开字节范围 | 原样切片 SHA-256 |
|---|---|
| `NPe` / `[866354,867672)` | `6b2f6e173ff0307dddc3427c8bf7d9f828dde9cb0ac83e6a43843846639a18b8` |
| `rLe` / `[40300588,40302621)` | `fb4692cc9641f9338b4b49d702fab2be1298a038f6a5637fe31eb9efc01f4d9c` |
| `QC` / `[862705,863142)` | `a940da169be3bd41e101d73cdea84297e01ce9bac76d59251dedfddb8ec19f05` |
| `LUe` / `[49943061,49943523)` | `82025876cd41b666ab15a1d962ac444e79c9ecb73bec4bf0de3a67c68e67dbe2` |
| `FUe/EUe/cFe` / `[49943546,49944764)` | `d64a619bc773e753118d8ede27ddb76270aa0f016366cf34875aa6d1ec70aeac` |

以下调用关系来自原始 bundle 定点审阅；不是 REA 全图自动恢复成功的声明。混淆函数名只对上述 hash 有效。

## 新建文件的实际路径

bundle offset `49967564` 附近的 CLI 分派函数 `oEe` 按命令加载 create、upsert-dsl、inspect、lint 等实现，version 分支打印 6.6.1。`create` 进入 `GPe`，最终调用 `NPe`：

1. 将 outputPath 解析成绝对路径，确保父目录存在，从随包 `resources/pptx/blank.pptx` 复制模板。
2. POST `/localapi/open`，参数 `file_path`、`file_type:"slide"`、`wait:true`；检查 code 并取 file_id。
3. POST `/mcp`，JSON-RPC `tools/call` → `slide_get_info`，读取版本；检查 RPC error 与 result.isError。
4. 写 AIGC metadata，再 POST `/localapi/save`。元数据失败记录警告并继续，不会将 metadata 成功作为 create 的硬条件。
5. 返回 fileId/filePath/latestVersion。`OC/_Pe` 将命令输入、结果、耗时追加到工作目录 `.slidep/commands.jsonl`；这仅是代码定义的日志能力，本次未读取或生成用户运行日志。

`QC` 为本地请求公共包装：fetch POST JSON，AbortController+timeout，HTTP 错误附最多 512 字符响应，成功解析 JSON。该函数没有 Python 包装器的 Bearer token 逻辑；不能据此断言底层服务整体无鉴权。

## DSL 页面生成、替换、保存

`xHe`（offset `40303388`）从 `--dsl` 或 `--dsl-file` 获得文本，调用 `rLe`；默认 pageIndex=-1。`rLe` 的静态顺序：

1. 解析目标路径与项目目录；`Iee` 取得基准版本（后续定点追踪见下节）。
2. POST `/localapi/keyframe`，解码 Base64 keyframe 到 presentation owned data，读取已有 slideList 与 sldSz。
3. pageIndex 在已有页范围内时标记替换，否则追加；新页索引取当前 slideList 长度。
4. `evaluateJsxInput(dsl,{development:false})` 得 JSX tree；构建 `IconResolver`、`NodeImageLoadService`，后者使用项目目录解析资源。
5. `createSlideManagerJsx` → `insert(tree,{jsxCode:dsl})` → `layout(0,{validateOverflow:validateDsl??false})`。此 upsert 默认未启用 overflow；不能用 upsert 成功代替 lint。
6. 构建仅含生成页、资源、画布尺寸的 presentation 数据；`bPe` 把可识别绝对本地图片路径读取为 data URL，收集读取失败。
7. `IM` 将 presentation 数据转为 mutation。提取 AddPage、页面 mutation 与 type=46 mutation；替换时加入原页删除 mutation，过滤 type=6。
8. `AHe` 为 pageId/shapeId/groupShapeId 加随机后缀，原页删除保持旧 ID，减少新生成对象碰撞；本路径用到的 mutation type 后续已从实际枚举核实，见下节。
9. `b8.fromValidMutationData` → command data → Base64 revision。revision_id 是结合目标、页、索引、base_version、revision 内容生成的 SHA-1。
10. POST `/localapi/commitrevision`，传 revision、revision_id、base_version、from_third_party:true，检查 code；然后 POST `/localapi/save`，检查 code，返回 newPageId、revisionId、资源 failures。

因此 **DSL 页面形成和落盘分属 JS 布局/修订构建及 editor SDK 服务**。最终 PPTX OOXML 的具体序列化、兼容性及保真行为落在服务/原生引擎之后，不能声称已从 slidep JS 复原全部。

## 补充：实际 revision 数据结构与版本来源

本节继续对同一 SHA-256 的原始 6.6.1 bundle 做定点字节审阅，没有重跑全包分析，也未访问其他原生分析 session。

### IM：拆分演示文稿级与页面级 mutation

`IM` offset `852487`：从 presentation 拆出 slideList/noteSlideMap/sectionMap；其余字段送 `gee` 生成文稿级 mutations。对每页调用 `MS`，type=3 的 AddPage 放进 `presentation`，其余按 pageId 放进 `pages[pageId]`；备注页另建键；最后追加章节 mutations。

`gee` offset `851415`：收集主题、母版、页、章节、备注母版、资源，连同文稿属性展开。`MS` offset `270233`：创建 AddPage（pageId、slideOptions.layoutId、shapeTreeId、index、pageType=1），再生成 SetPageProperties、文本/形状树、动画及备注 mutation。

因此 `IM` 的返回形状是 `{presentation: Mutation[], pages: Record<PageId, Mutation[]>}`。`rLe` 只取目标新页 AddPage、UpdateResourceMap 和新页 mutations；显式过滤 SetPageProperties，不能把它描述成把整个新 presentation 覆盖回旧文件。

### 已核实的类型与包装字段

原始 `BF` 枚举 offset `33281` 与 `Sge` 字段映射 offset `42773` 相互对应：

| type | 枚举 | command 中 payload 字段 |
|---|---|---|
| 3 | AddPage | addPage |
| 4 | RemovePage | removePage |
| 6 | SetPageProperties | setPageProperties |
| 46 | UpdateResourceMap | updateResourceMap |

`b8` offset `831121` 的 `fromValidMutationData` 将每个裸 mutation `m` 包装为 `{type:m.type, [camelCase(BF[m.type])]:m}`，形成 command 的 mutations 数组；可选 command.type 未传时为 undefined。`getCommandData()` 返回该数据。这里的“Valid”是函数名称，不意味着该调用自动执行完整校验：`validate()` 是另一个方法，本路径没有显式调用。

`MC` 定义起点 offset `853049` 用 `fromCommandData` 包成 `{commands:[command]}`，`toBase64String` 先 `_P.codec.encode(data,8237)`，再 `EM.fromUint8Array` 转 Base64；这是二进制 codec，不是把 JSON 字符串直接 Base64。codec 16 对应单 command；8237 对应 revision 编码入口，8528 对应 keyframe 外层 decode 入口。这些数字是 schema 表的类型起始索引，不是网络字段号或协议版本。

继续读取实际 `Xwe.typeTable`（offset `734076` 附近）和 `fieldTable`（offset `788131`），按随包 `shiftMask` 解码数字，未运行目标 JS，恢复的局部字段如下：

| selector | wire 字段号 → 名称 / 子类型 |
|---|---|
| 8237 | 1 → commands / 16，repeated |
| 16 | 1 → type / int32；2 → operateType / int32；3 → hasTransformed / 22；4 → version / 24；5 → mutations / 26，repeated |
| 26 | 1 → type / int32；2 → setPresentationProperties / 82；3 → setSlideSize / 2440；4 → addPage / 2451；5 → removePage / 2473；6 → movePage / 2480；7 → setPageProperties / 2489；8 → addShape / 2813（仅列前八项） |
| 8528 | 1 → slideChunkData / 8530 |
| 8530 | 1 → presentation / bytes；2 → pages / 8533，repeated |

`$we` offset `829187` 用 `fieldNumber << 3 | wireType` 写 uint32 tag，嵌套结构 fork/ldelim；`W1e` offset `828426` 用 tag>>>3 取字段号、tag&7 跳过未知字段，支持 packed repeated；`ree` offset `830449` 使用 Reader/Writer。**这些实际算法及类型表支持“Protocol Buffers wire 编码”判断**，但 bundle 没有可确认的 protobufjs 名称标识，本报告不把它归因于某特定第三方包或声称恢复了原始 .proto。

`_P` 还以 `fieldNameI=true` 表达 null，decode 时恢复为 null；该自定义语义说明即使采用通用 protobuf 库也不能忽略随包 schema/处理器。

### keyframe 解码链

`VM` offset `861453`：Base64 → bytes → `Oze` 添加首字节 10 和 payload 长度 varint → `SM.fromEGChunkDataBuffer` → command data → `Aee.fromCommandData` → presentation owned data。结合上表，首字节 10 为外层字段 1 的 length-delimited tag；不是任意文件头。

`SM` 定义起点 offset `853641` 调用 `_P.codec.decode(buffer,8528)`，读取 `slideChunkData.presentation` 及 `slideChunkData.pages[{id,data}]`；缺失数据以空 revision 代替。`getCommandData` 依次解码 presentation、各 page 与 revisions；每段经 `MC.fromBufferOrBase64(...).getMutationData()` 合并，最终得到 `{mutations:[...]}`。`Aee.fromCommandData` 从默认 presentation 初始化，再 `applyCommandData(data,"keyframe")` 构造模型。

该链确认读取的是演示文稿/分页修订模型。局部 schema 已按数字表恢复，完整 schema、所有 mutation 的二进制字段定义，以及原生端对这些修订的验证仍未完整恢复。

### base_version 的真实来源及地址差异

`aLe` offset `40299848` POST `${UT()}/localapi/editor/status`，body 为 `{file_path}`，超时 5 秒；取 `open_editors[0]` 的 file_id 和 version，version 非 number 时回退为 0；异常返回 null。`Iee` offset `40300171` 没找到实例时 `eLe` reopen，再查一次，仍无则报错。

`eLe/hHe` offset `40298503` 先检查磁盘文件存在；查询 editor/status，有实例则复用，否则 `/localapi/open`，检查 code，取 file_id，缺失时再查 status，仍缺失报错。open 超时是 30 秒。

`UT` 的服务地址来源是 `TENCENT_DOCS_LOCAL_MCP`（截去 /mcp 后缀）、产品 `~/.workbuddy/tencent-docs-engine.port`，最后 localhost:39099；定义位于 offset `860632` 附近。**aLe/eLe 使用 UT()，不消费 Iee 入参中的 baseUrl/timeoutMs；rLe 的 keyframe/commit/save 使用 GM(te.baseUrl)。** 因此手动指定不同 `--base-url` 时，版本查询与修订目标存在静态上的地址不一致风险；默认地址相同时没有此差异。未实际运行验证，不宣称已复现产品缺陷。

此外，版本读取选择的是返回数组 `open_editors[0]`，未对用户当前预览 file_id、实例身份或返回路径做二次核对；commit 请求使用 file_path 而不携带该 file_id。若同一路径存在多个 editor 实例，客户端是否绑定到预期会话取决于服务端筛选及排序；本次未证明服务端如何处理。应表述为“带版本字段的提交”，不能直接评价为“已完善协作版本校验”。

### commitrevision 请求、响应消费与失败边界

实际 JSON body（`rLe` offset `40302276`）为：

```json
{
  "file_path": "绝对目标路径",
  "revision": "codec 8237 编码后 Base64",
  "revision_id": "SHA1(path|newPageId|index|baseVersion|SHA1(revision))",
  "base_version": 0,
  "from_third_party": true
}
```

上例 0 只是说明字段为数值，并非固定值。客户端只消费响应 code/message：code 不严格等于数字 0 就抛错；成功后立即 `/localapi/save`，同样检查 code/message；未消费返回的新版本、转换结果、冲突详情或幂等状态。不能据此补写服务端没有观察到的响应字段。

静态可见的限制：

- 本路径没有自动重新取版本/重试冲突；commit 或 save 报错由 xHe 外层 catch 记录失败并 exit 1。
- commit 成功而 save 失败时没有客户端 rollback；内存状态是否已改变、保存是否部分落盘由服务端决定，仍未知。
- QC 的 timeout 在 fetch 返回后清理，之后才读取 JSON body；该定时器不覆盖整个响应正文解析时间。
- 资源失败作为 failures 数组返回，xHe 仍给结果加 ok=true；它表示修订与保存流程成功，不表示所有图片资源都成功。
- revision_id 含随机新对象 ID；不能仅凭 SHA1 构造就宣称重复执行同一 DSL 在服务端幂等。

## 读取不是单纯 ZIP 文本提取

`LUe` 请求 `/localapi/open` 与 `/localapi/keyframe`，将 keyframe 解码。`EUe` 检查文件存在且扩展名为 .ppt/.pptx，计算源 SHA-256，取得 keyframe，`KLe` 归一化、`NLe` 转 Markdown，最后再次比较源 hash，发现变化则拒绝输出成功。常规读取由编辑引擎模型提供结构，不是靠 python-pptx 读取全部文档。

此前技能里 MarkItDown/python-pptx/LibreOffice 路径属于“输入材料提取、素材提图、参考样式预览”辅助工作，不能替代这里已观察到的主要 inspect 实现。

## 与修改、视觉检查的边界

已有文档修改技能使用 `edsdk.py` 对本地 `/mcp` 的 `slide_*` 工具调用；这是另一入口，和 slidep 生成共同依赖本地 editor SDK。PPT 工具清单里的 77 个名称仍只是技能索引，实时 schema/原生处理实现本次未逐项验证。

真实 bundle offset `49949286` 附近定义 `visual-vlm`、`visual-unavailable`；`DUe` 以子进程运行 slidep screenshot，设置超时，收集 stdout/stderr，删除截图子进程环境里的 `WORKBUDDY_VLM_*`，失败清理临时目录。该静态代码支持独立截图及检查流程，但视觉模型请求的全部参数与 lint 汇总逻辑本次未展开，不能声称视觉检测一定成功。

## 对 WorkPivot 的具体意义

- 从竞品看，生成和编辑可以共享文档引擎，DSL 只负责生成页面到结构化修订，不必另建一套保存机制。
- 修改应绑定同一文档实例并带版本基线；静态可见的 base_version 比仅按文件路径覆写更适合后续协作，但服务如何拒绝冲突仍需另证。
- 将生成成功、布局通过、视觉通过、保存成功分别表达；此样本 upsert 默认不验 overflow、视觉存在降级，不能合并成一个“成功”。
- 本次不足以支持直接采用腾讯私有 SDK，也未证明其许可、可独立部署性或接口稳定性；应学习边界和流程，再评估我们可用的实现。
