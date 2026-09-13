# WorkPivot 0.3.0-preview.13

修复添加文件后附件上下重复显示：删除底部旧托盘，仅保留输入框上方附件区，继续提供上传状态与移除操作。

类型检查、Lint 和前端构建通过；确认仅有一个待发送附件渲染入口。preview.13 镜像构建完成；WSL 部署因存在运行任务而中止，未重启服务，当前仍为 preview.12。待任务结束后运行 artifacts/update-attachment-wsl.mjs 完成备份与部署。
