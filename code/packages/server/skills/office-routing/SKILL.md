---
name: office-routing
description: 为Office及PDF任务选择读取、局部修改或新建流程；按文件格式引导使用已加载的docx-report、xlsx-report、pptx-report，不执行文件操作。
license: Proprietary. 内置技能，随 WorkPivot 发行。
---

# 办公任务路由

判断目标，而不是只看扩展名。读取原稿、修改原稿、新建独立成果是三条不同流程。只使用本轮目录中已加载的技能和实际提供的工具。

| 任务 | 路线 |
|---|---|
| 读Word/Excel/PPT/PDF | 先read_uploaded_file，按nextOffset继续；基础读取不强制加载专项技能 |
| 定位Word表格/Excel区域 | read_document_structure，固定versionId，按parent或sheet/range筛选并依next续读 |
| 根据项目资料回答 | search_project_documents → read_document_citation → 使用原文引用 |
| 新建Word | 已加载docx-report → references/create.md → execute_skill生成、检查、发布 |
| 新建Excel | 已加载xlsx-report → references/create.md → execute_skill生成、检查、发布；需要公式结果时使用convert.py进行受限重算，失败不得伪造缓存 |
| 新建PPT | 已加载pptx-report → references/create.md → execute_skill生成、检查、发布；使用inspect.py与convert.py检查边界和生成预览，未查看预览须说明 |
| 修改已有Office | 读取对应技能references/read-edit.md → 核对定位和支持范围 → 修改副本并读回；不能支持时说明具体缺口 |
| PDF扫描页/图片文字 | 检查coverage和warnings；PNG/JPEG和无文字PDF页尝试有界OCR，不把少量文字或置信度当作完整识别 |

专项技能未加载时提示用户在技能市场选择；本技能不能代为启用。路由加载不自动加载其他技能，不使用主机文件路径，不调用虚构的WorkBuddy MCP工具。复杂任务可以分步骤处理，当前不要求多代理委派。

执行时必须使用目标专项Skill自己的资源，不能把本路由当作通用执行绕过入口。自动化任务选择实际执行的格式技能，所有操作固定在计划授权版本内，不动态切到市场最新版。输出保留原文件版本、读取/修改范围、成果与检查状态。
