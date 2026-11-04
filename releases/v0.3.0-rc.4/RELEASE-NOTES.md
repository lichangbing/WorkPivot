# WorkPivot v0.3.0-rc.4

| 项 | 值 |
| --- | --- |
| 发布日期 | 2026-11-04 |
| Git 提交 | `5a6a58a` |
| 发布阶段 | RC 文档只读增强 |
| 数据库 schema | v71 |
| 上一版本 | `v0.3.0-rc.3` / schema v70 |
| 部署范围 | 已部署本地测试环境；远程环境保持 RC.3，等待后续安排 |

## 发布重点

RC.4 完成文档预览 RO-1～RO-6，不增加应用内编辑。预览只负责展示和下载；任何修改继续通过 Agent 生成新的不可变文件版本。

## 新增

- 预览派生 PDF 与 Agent 读取、知识入库和业务事实证据严格分离，不写入原件卷。
- Office 预览返回源文件哈希、PDF 哈希、转换器版本、字体包哈希、阶段、耗时、生成时间和文本层状态。
- 新增 `GET /api/tasks/:id/file-versions/:versionId/preview-metadata` 派生预览契约接口。
- 新增 `GET /api/tasks/:id/file-versions/:versionId/structure` 固定版本结构化读取接口。
- 结构化读取支持 DOCX 段落/表格、XLSX 工作表/单元格/合并区域，以及 UTF-16 偏移和有界续页。
- PDF 解析增加原生文本层状态；扫描件显示 `hasTextLayer=false`，OCR 来源、旋转和置信度继续单独保存。
- 前端预览失败按能力不可用、忙碌、超时和系统故障分级；能力不可用时引导下载原件。

## 变更

- 预览缓存 key 从仅 `versionId` 扩展为 `versionId + sourceSha256 + converterVersion + fontPackSha256`。
- `document_versions` 增加派生预览元数据；`document_processing` 增加 `has_text_layer`。
- 只读预览和结构化读取接口只接受固定原始文件版本，不接受当前路径或派生预览 ID。
- 修复右侧工作区纵向高度链：预览页签、PDF iframe 和共享浏览器画面均占满页签以下空间。

## 验证

- PostgreSQL 回归：852/852。
- `eval:document-preview`：转换契约、复合缓存、派生隔离和错误分级通过。
- `eval:parser-metadata`：37/37，包含 PDF 文本层和结构化对象。
- `eval:workspace-right-panel`：真实 PDF 阅读器、Markdown、错误分级、三页签和状态恢复通过。
- 1440×900 实际布局断言：面板 900px、预览区 852px、PDF 约 825px、浏览器画面约 722px。
- TypeScript、ESLint、Web 生产构建、严格许可和依赖边界通过。

## 未包含

- 应用内文档编辑、协同批注和人工 Office 引擎。
- 远程正式环境部署；RC.4 按要求仅完成本地测试环境，远程仍为 RC.3 / schema v70。
- 第二物理设备、24 小时真实业务负载和目标企业 IdP 验收。
- 复杂 Office 版式的像素级无损保证。

## 升级与回退

升级需执行 schema v70 → v71，并重建服务端镜像。新增列均可空，旧文件版本和既有解析记录不需要回填；旧解析会在解析器指纹变化后按原有机制重新解析。

回退时应同时保留 schema v71 数据和升级前服务端镜像标签。旧应用不读取新增列，但正式回退前仍需在隔离环境验证。

本地部署详情见 [RC.4 本地部署](../../docs/03-项目/部署记录/本地部署-20261104.md)。
