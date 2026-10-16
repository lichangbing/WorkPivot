# 数据库与 Skill worker 联合故障验收（2026-10-16）

## 范围与实现

按照已确认的单用户版收尾计划，串联真实 PostgreSQL、HTTP 消息/停止/成果接口、DatabaseExecution Agent 循环、一次性自动授权、DatabaseSkillExecution 和生产 startWorker 实现。模型响应使用可控工具调用夹具，不接真实供应商，不以此证明模型决策质量。

新增入口：

```powershell
wsl -d Ubuntu-24.04 -- node /mnt/e/project/WorkPivot/code/scripts/test-database-worker.mjs
```

Linux 可直接在 code 目录执行 `node scripts/test-database-worker.mjs`。默认使用已有 `workpivot-server:0.3.0-rc.1-recovery-validation-20260929` 依赖镜像、`workpivot-executor:0.2.0` 与 `postgres:15-alpine`，通过 WORKPIVOT_TEST_SERVICE_IMAGE、WORKPIVOT_TEST_IMAGE、WORKPIVOT_TEST_PG_IMAGE 可指定兼容镜像。API 测试容器复制当前 server/core/shared 源码，测试不构建或替换运行中的业务服务。

PostgreSQL 使用临时 tmpfs、随机本地端口和凭据；worker 使用随机实例标签、动态本地端口和临时目录。可信 API 夹具使用 Linux host 网络访问这些本地随机端口；实际执行命令的沙箱仍使用 network=none，无 Docker socket 挂载、不接业务卷。结束删除本次容器和临时目录。故障控制端点仅在本次临时宿主进程中存在并校验随机令牌，不进入产品 API。

## 场景与结果

WSL 实际执行 **14/14 通过**，新增两份脚本的 ESLint 通过。

| 场景 | 验证结果 |
| --- | --- |
| 正常生成 report.txt | HTTP 任务正常完成，执行记录与成果关联，下载字节为实际命令输出 |
| 覆盖旧成果时 HTTP 停止 | 等到部分文件确实产生后取消；任务 stopped、执行 interrupted、流返回 aborted，旧内容和版本保留 |
| 覆盖旧成果时沙箱 SIGKILL | 执行记录 failed，成果列表不新增半成品版本 |
| 要求两份成果但只生成一份 | 整批不发布，原有文件及版本保持不变 |
| 显式重新执行 | 仅发布修订 2，修订 1 内容仍可读取 |
| 汇总 | 五次请求恰好五条终态执行记录，只有两次完成，未遗留 running 或 pending 确认 |

HTTP 停止、沙箱故障后等待 worker 释放执行槽和沙箱，再开始下一场景，避免误终止上一任务资源。本轮未发现需要修复的业务缺陷；临时容器和目录清理成功。

## 验收边界与后续

本项覆盖实际 Skill 命令执行到数据库成果提交的取消/失败路径，不包含浏览器渲染、真实模型、网络分区、数据库进程崩溃或“提交成功但确认响应丢失”的完整链路。此前 API/MCP/worker 整进程重启测试与本项分别记录，不合并宣称所有故障场景均已验收。

下一步核对浏览器记忆/专家与多端验收进展，继续处理旧依赖许可，按用户授权更新 WSL/158。本轮不修改页面、不更新部署。工作区已有的浏览器工作流和竞品研究改动保留，不纳入本轮提交。
