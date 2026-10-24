# Skill 加载与执行部署

本批提供Skill按需加载、文本参考资料读取，以及Node.js/Python脚本、二进制模板和预装依赖的执行环境。Excel/PPT/Word Skill的业务验收后排。

执行服务运行在Docker主机，使用现有部署用户的Docker权限。后台只调用经独立令牌认证的 `/v1/run`；请求只能包含命令、任务文件、已加载技能资源，不能指定镜像、挂载、网络、用户或Docker参数。容器均不挂载Docker socket。

## 需要部署的文件

- 后台镜像 `workpivot-server:0.3.0-preview.7`
- 执行镜像 `workpivot-executor:0.1.0`，由 `code/Dockerfile.worker` 构建，预装Node.js、Python3及现有Node依赖。新增依赖由管理员构建新镜像，任务运行中不能联网安装。
- `code/scripts/skill-worker.mjs` → `/home/lichb/workpivot-worker/skill-worker.mjs`
- 本目录 `workpivot-worker.service` → 部署用户的 `.config/systemd/user/workpivot-worker.service`
- 本目录 `compose.worker.yml` → `/home/lichb/workpivot/compose.worker.yml`

## 主机服务配置

已提供 `install-worker.mjs` 收敛部署步骤：准备好以下输入目录、导入两个镜像并确认用户linger后，运行 `node install-worker.mjs <输入目录> /home/lichb/workpivot`。脚本检查无运行任务、保存卷快照和旧Compose、生成独立令牌、启动并验证Worker，再升级后台；不会替换原主密钥和初始化凭据。当前服务器连接超时，该安装脚本尚未在192.168.1.158实机执行，不能据此视为上线完成。

为Worker单独生成至少32字符的随机令牌，存入 `worker.env`（0600）；同一值追加到现有后台 `.env` 的 `WORKPIVOT_WORKER_TOKEN`。不替换已有主密钥和初始化凭据，也不要把令牌交给模型。

`worker.env`字段：

```text
WORKPIVOT_WORKER_BIND=<docker默认bridge网络的网关IP>
WORKPIVOT_WORKER_PORT=39990
WORKPIVOT_WORKER_TOKEN=<独立随机令牌>
WORKPIVOT_WORKER_IMAGE=workpivot-executor:0.1.0
# 可选：工作区卷名。配置后 run_code/bash 把任务目录直接挂进容器；留空沿用复制快照+回写。
WORKPIVOT_WORKSPACE_VOLUME=<docker volume ls 中的工作区卷名>
```

绑定地址必须先通过主机 `docker network inspect bridge` 核实，不能使用0.0.0.0开放到局域网。后台通过host.docker.internal访问此网关地址。环境文件不是模型执行环境，令牌不传入隔离容器。

`WORKPIVOT_WORKSPACE_VOLUME` 可选，两端都要配置同一个值（worker 的 `worker.env` 与后台 `.env`），后台通过 `compose.worker.yml` 读取。配置后容器用 `volume-subpath` 只挂载该任务目录到 `/workspace`，不复制、不回写，文件实时可见，其他账号目录与 `/data/workpivot` 不可见。前提：卷已存在于 worker 所在主机，Docker Engine 支持 `volume-subpath`（26.0+），且卷内文件属主与容器用户（1000:1000）一致。留空则保持原有“复制快照 + 回写”行为，功能不受影响。卷名以 `docker volume ls` 为准，Compose 未显式命名时会带项目名前缀。

启用用户服务：`systemctl --user daemon-reload`、`systemctl --user enable --now workpivot-worker`。确认 `/usr/bin/node` 可用；用户服务要开机自启且SSH退出后仍运行，需要主机已为该部署用户启用linger（管理员执行 `loginctl enable-linger lichb`）。未确认此项不得宣称完成重启验收。

后台启用：保留原Compose与卷，在备份且无运行任务后执行 `docker compose -p workpivot -f compose.lan.yml -f compose.worker.yml --env-file .env up -d`。查看主机用户服务日志和已认证 `/v1/health`；不要在日志输出环境文件。

## 执行约束与恢复

命令最长120秒，并行上限2，非root、只读根、禁网、CPU1核、内存512MiB、进程128。任务和技能输入合计16MiB，产物16MiB，文件扫描/结果最多4000项。任务输入复制到/workspace；配置了 `WORKPIVOT_WORKSPACE_VOLUME` 时改为直接挂载该任务目录（不复制、不回写）。仅已加载且仍获准访问的Skill资源只读挂载在/skills/技能名。

成功后先停止并移除全部容器进程，再验证产物路径、文件类型、写权限和原文件哈希；冲突、取消、超时或执行失败不回写。单文件写入原子替换，删除走回收站；多个文件不构成数据库级事务。后台和执行服务通讯中断会取消任务；容器150秒自毁作为进程崩溃兜底，执行服务重启清理本实例遗留容器及暂存目录。

回滚：用原 `compose.lan.yml`（不带worker覆盖文件）恢复之前镜像；停止主机用户服务。业务卷和密钥保持原值。切勿应用旧 `docker-compose.execution.yml`，它是另一种需要socket的模式，本方案不使用。

## 验收

W20：Skill加载边界；W21：Linux主机执行服务（含Node/Python、模板、依赖、无网络、取消和清理）；W22：回写权限及冲突；W23-host.mjs：独立后台容器→主机执行服务→一次性容器→成果回写完整链。W21/W23只在独立测试主机上运行，测试服务使用独立实例标签，不操作生产Worker容器。

真实模型加载专项仍需连接部署服务器后执行；本地模拟模型的完整链测试不代替真实模型验收。线上接入前必须完成原有数据备份和实际服务检查。
