# Skill 按需加载

普通请求先向模型提供技能名称和简介。模型按需求调用 `load_skill` 获取完整说明，再按说明读取参考资料和使用现有工具。用户仍可通过 `/技能名` 显式激活。Excel、PPT、Word沿用内置Skill，不改为业务接口。

## 部署技能

服务器全局目录：`/data/workpivot/skills/<技能名>/SKILL.md`（位于现有持久卷内）。项目目录：`<项目目录>/.workpivot/skills/<技能名>/SKILL.md`。同名技能按项目、全局、内置的顺序覆盖。管理员仍通过管理页启停技能；本批不包含在线下载或上传安装界面。

最小文件：

```markdown
---
name: meeting-note
description: 用户要求整理会议纪要、行动项和负责人时使用。
---
先读取 references/format.md 中的格式约定，再整理用户提供的会议记录并保存Markdown文件。
```

目录名须等于name，使用小写字母、数字及连字符。当前解析器支持简单逐行frontmatter，description写在单行。说明引用的文本资料放在技能目录内部，例如 `references/format.md`、`scripts/generate.cjs`。

## 模型工具

`load_skill({name:"meeting-note"})` 返回完整说明、来源及资源列表。`load_skill({name:"meeting-note",file:"references/format.md"})` 返回指定文本资料；文件路径相对于技能目录。每次加载重新发现技能，停用和项目权限变更即时生效。每个文本文件最大256KiB，资源列表最多扫描200项和4层目录。

加载不会执行脚本，也不会开放后台配置目录。目录穿越、资源链接逃逸、硬链接和二进制资料会被拒绝。二进制模板使用与执行环境集成留待后续；现阶段不能把读取脚本视为执行成功。

preview.7已增加独立主机执行服务：已加载Skill资源在一次性容器的/skills/<技能名>/下只读可用，支持Node.js/Python脚本、预装依赖和二进制模板；详见[执行服务部署说明](../../../releases/deploy/Skill执行服务部署.md)。目前服务器连接不可达，尚未上线该执行环境。办公Skill业务验收按用户要求后排。
