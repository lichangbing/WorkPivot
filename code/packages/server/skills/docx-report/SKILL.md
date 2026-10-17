---
name: docx-report
description: Word办公流程：读取现有资料，按需求生成成果，并区分局部修改的支持边界。生成使用docx，需要已配置的隔离执行服务。
license: Proprietary. 内置技能，随 WorkPivot 发行。
---

# Word办公处理

先判断读取、修改还是新建；只加载本次需要的参考文件。Skill是工作指引，不会自动执行或增加权限。只调用当前实际提供的工具。

| 需求 | 下一步 |
|---|---|
| 读取、理解、核算 | 读取references/read-edit.md；通常直接调用read_uploaded_file，无需执行脚本 |
| 新建独立成果 | 读取references/create.md；使用docx生成，检查后发布；优先使用内置JSON参数脚本 |
| 修改已有文件 | 读取references/read-edit.md；先核对支持范围，保留原件，禁止默认重建整份文件 |

## 输入与执行

使用文件版本ID，读取list_uploaded_files和用户本轮指定附件，禁止静默换成最新版本。生成脚本只能通过execute_skill运行，inputs显式列出文件版本；资源在/skills/docx-report只读，工作目录/workspace。命令只访问获准输入和工作目录；不联网安装依赖。

outputs声明文件名；更新已有成果时先list_artifacts，再传documentId和当前revision。上传原件不能当作成果直接覆盖，修改上传文件默认生成新的成果。版本冲突、取消或检查失败，不声称发布成功。缺执行服务时说明限制，不编造Bash、文档引擎或尚未提供的结构化编辑工具。

先读取对应references中的参数说明，按文档直接调用内置脚本；不要为普通生成或修改逐个读取全部脚本源码。只有文档不足或执行报错需要定位时才读取相关脚本，避免挤占对话上下文。生成后在同一执行命令中调用检查器。结果区分文件生成、内容核对、公式重算、结构及视觉检查。首次成功后可建议沉淀私人Skill，但仍须用户弹窗确认；定时执行沿用计划固定的本技能版本，不临时依赖其他未加载技能。

模板生成使用references/create.md中的template.py入口，固定模板版本和字段JSON；缺字段或不支持范围必须失败。内置generate.cjs会重新打开并核对内容，不代表视觉检查或公式重算。
