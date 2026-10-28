# 运维文档

> 状态：✅ 当前操作入口
> 最近更新：2026-10-28
> 适用版本：`v0.3.0-rc.1`，schema v63

本目录面向部署和运维人员。操作前先确认目标版本、数据库 schema、镜像 ID、备份和回退路径。历史部署记录不能替代当前手册。

## 常用入口

| 任务 | 文档 |
| --- | --- |
| 新机器安装 | [快速部署](快速部署.md) |
| 日常健康检查与故障定位 | [运行与排障](运行与排障.md) |
| 最近一次远程部署证据 | [远程部署记录](../03-project/远程部署-20261026.md) |
| Cloudflare Tunnel 与正式域名 | [域名和 Tunnel 运维](Cloudflare-Tunnel与正式域名.md) |
| 本地发布与升级流程 | [本地发布手册](../03-project/local-release-runbook-20261017.md) |
| 备份与隔离恢复 | [备份恢复](../03-project/backup-recovery-20261016.md) |
| 回退基线 | [回退基线](../03-project/回退基线-20261020.md) |
| 发布说明与版本材料 | [releases](../../releases/README.md) |

## 环境要求

- Linux x64、WSL 或支持 Docker 的 macOS；生产优先 Linux。
- Docker Engine + Compose Plugin。
- OpenSSL、curl；部分升级/备份流程需要 Node.js 22。
- 生产域名与 HTTPS 终止代理（Caddy/Nginx）。
- 建议至少 4 GB 内存；启用 LibreOffice、浏览器和 Worker 时应按实测容量扩容。

## 关键原则

1. **版本配套**：服务端镜像、数据库 schema、Worker、浏览器和执行器必须来自兼容发布。
2. **配置受保护**：`stack.env`/`.env` 权限 0600，不提交、不打印、不随业务备份公开。
3. **入口最小暴露**：数据库、浏览器、Worker 仅容器网络访问；只公开 HTTPS 入口。
4. **先备份再升级**：数据库和文件卷同时备份，并保留旧镜像与旧配置。
5. **不绕过隔离**：Worker、浏览器或 LibreOffice 不可用时明确失败，不回退宿主命令或伪造成果。
6. **先验证再宣布完成**：健康检查、首页、登录、任务、文件下载和关键工具至少各验证一次。

## 当前外网实例

| 入口 | 地址 |
| --- | --- |
| 用户端 | `https://workpivot.lichb.cc.cd/` |
| 管理端 | `https://workpivot.lichb.cc.cd/admin` |
| Android 内测包 | `https://workpivot.lichb.cc.cd/downloads/WorkPivot-android-1.3.apk` |
| 迁移回退 | `https://115-191-1-188.sslip.io:80/` |

正式域名通过 Cloudflare Tunnel 提供标准 HTTPS。`cloudflared` 从服务器主动向
Cloudflare 建立出站连接，再把请求转发到仅监听本机的 Nginx `127.0.0.1:8080`。
旧 `sslip.io` 入口暂时作为迁移回退，不应继续扩展新客户端。

## 当前组件

| 组件 | 容器/进程 | 对外暴露 |
| --- | --- | --- |
| 服务端 | `workpivot-server` | 经反向代理或受控端口 |
| 数据库 | `workpivot-database` | 否 |
| 浏览器 | `workpivot-browser` | 否 |
| 搜索 | `workpivot-searxng` | 否 |
| Skill Worker | 宿主进程或独立服务 | 仅容器网络 |
| 执行器镜像 | 按任务临时启动 | 否 |
| `cloudflared.service` | 系统服务 | 否，仅建立出站 Tunnel |

## 安全提醒

- 本仓库不保存生产密码、API Key、主密钥和数据库口令。
- 备份包含业务正文，也应视为敏感数据并限制访问。
- 故障日志提交前必须移除 Token、Cookie、URL 查询参数、文件正文和用户隐私。
- 生产变更需要变更记录、影响范围、验证项和回退负责人。
