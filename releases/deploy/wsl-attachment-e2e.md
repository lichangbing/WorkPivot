# WSL附件联调环境

## 2026-09-16 当前状态

已切换为 `workpivot-server:0.3.0-rc.1`，PostgreSQL schema25。地址仍为 http://127.0.0.1:39986/ 和 /admin。使用真实模型配置及独立 Worker，默认通用研究员模板已发布，原账号和文件保留。不是下文早期的模拟模型/空账号状态。

数据库、文件已备份；上一容器保留停止状态，可回退。发布证据及限制见 [RC.1 说明](../v0.3.0-rc.1/RELEASE-NOTES.md)。

日期：2026-09-14。仅本机联调，不是公网发行版。用户要求清空本地账号后，已删除1个账号及关联测试数据，重启确认账号为0；关闭启动时自动种子账号逻辑。

- 地址：http://127.0.0.1:39986/
- 当前没有账号，刷新页面后自行创建首个管理员。初始化凭据见本机`artifacts/first-login-wsl-attachment.txt`（Git忽略）；仅本机测试使用。旧attachment-test账号已清除，verify-wsl-attachments.mjs的历史验收流程不再能直接重跑。
- WSL发行版：Ubuntu-24.04；应用容器`workpivot-attachment-e2e-web`、数据库容器`workpivot-attachment-e2e-db`。
- PostgreSQL15，schema v8，真实账号认证、真实数据库和原件文件卷；模拟模型返回固定联调回复，不访问外部模型/MCP，不提取附件内容。
- 独立卷：`workpivot-attachment-e2e-db`、`workpivot-attachment-e2e-files`；DB仅内部网络，网页绑定127.0.0.1:39986。没有挂载Docker socket。原39880服务、公网和其他WSL服务未修改。

浏览器已验证：登录→选择任务→选择CSV→已上传→输入消息回车发送→附件托盘清空→历史显示文件名与回复→页面刷新重新打开任务，历史附件恢复。

随后重启测试应用容器，通过真实HTTP检查同一浏览器上传文件的字节与本地CSV完全一致、历史引用仍在。通过文件删除接口删除该测试文件，下载返回404、历史名称为空并标记deleted；容器文件目录数量为0。浏览器标签页在重启阶段失效，重启及删除部分使用HTTP/磁盘核验，不声称全部通过浏览器点击完成。联调留下测试任务与删除占位，供用户查看。

环境保留运行，可继续手动上传测试。普通停止/启动（保留卷）：

```powershell
wsl -d Ubuntu-24.04 -- docker stop workpivot-attachment-e2e-web workpivot-attachment-e2e-db
wsl -d Ubuntu-24.04 -- docker start workpivot-attachment-e2e-db
wsl -d Ubuntu-24.04 -- docker start workpivot-attachment-e2e-web
```

首次构建与启动入口：`releases/deploy/Dockerfile.attachment-e2e`、`code/scripts/start-wsl-attachment-e2e.mjs`。脚本遇到已有测试容器/卷拒绝重建，避免覆盖。修改源码后需重建镜像并明确更新测试容器，普通restart不更新镜像；容器无自动重启策略，WSL关闭后需要手动启动。测试模型不可作为真实模型验收结果。

后续开发：解析队列及解析结果进入模型上下文；未解析附件保持明确提示。多用户执行池不作为当前单用户闭环前置条件。
# 2026-09-15 本地运行状态补充

网页与数据库容器已恢复，重启策略设为unless-stopped（原为no）。Docker启动后恢复服务，用户主动停止的容器不自动启动；不负责启动Windows上的WSL。
网页仍为39986，数据库v14，独立workpivot-database-worker已启用。产物历史版本及执行反馈已同步，W38 335/335。
只读检查：2个有效用户，0个启用模型；需在/admin配置并启用模型后进行真实办公聊天验收。现有账号、密钥和文件未清理。
