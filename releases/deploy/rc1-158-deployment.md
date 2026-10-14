# 192.168.1.158 RC.1 部署记录

2026-09-18：从 0.3.0-db-preview.38 升级到 0.3.0-rc.1，公网部署已完成，取代 RC.1 发布说明中此前“公网尚未更新”的状态记录。

- 发布包：workpivot-rc1-20260916.tar.gz；SHA256 为 9272150d19dcf7d7dc08326688beff2265de771c5a93d12d29072de512c5d558，服务器校验通过。
- 镜像：workpivot-server:0.3.0-rc.1；PostgreSQL schema v25。
- 升级前数据库、角色、配置与文件备份：/home/lichb/workpivot-backups/rc1-1789740373243（含敏感配置，仅服务器内保管）。
- Compose 增量配置：/home/lichb/workpivot-database-preview34/compose.rc1.yml；保留原数据库、文件卷、密钥与配置。
- 升级脚本检查无活动执行后停服备份，完成迁移和服务替换；默认研究员模板发布成功。
- 公网 https://workpivot.lichb.cc.cd/api/health 返回版本 0.3.0-rc.1；工作台与 /admin 返回 200；升级脚本验证未登录 /api/tasks 返回 401。
- workpivot-worker 用户服务 active；升级前已验证其带认证健康接口。
- docx-report、xlsx-report、pptx-report 均保留发布且启用状态；不修改用户加载选择。

本次为已验证 RC.1 包的部署，不包含尚未实现的按意图和重要程度整理记忆、计划模式。未在生产账号中新增测试对话或执行真实模型任务；仍为单用户规模候选版，productionReady=false。
