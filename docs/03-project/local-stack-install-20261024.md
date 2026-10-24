# 本地一体化栈安装（2026-10-24）

## 目的

把本地部署从"多步手工拼装"收敛成一条命令：一次装齐数据库、服务端、Playwright 浏览器服务、
宿主机 Skill 执行 Worker、隔离执行器镜像，并自动发布内置 Office 技能（含 PPT）与默认模板。

解决的具体问题：

- 之前浏览器服务、Worker、技能与模板都是独立步骤，容易漏装，表现为"界面里没有 `browser_visit`/`execute_skill`"。
- `release-local.mjs` 首次安装时文件卷初始化只授予了 `CAP_CHOWN`，在 `cap_drop: ALL` 下 `chmod` 会 `EPERM`，导致安装中断（已修复）。

## 入口

```bash
# 默认：项目 workpivot-stack、端口 39990、数据目录 ~/workpivot-stack
bash releases/deploy/install-local-stack.sh

# 自动创建管理员并打印初始密码（本地联调方便）
bash releases/deploy/install-local-stack.sh --auto-admin

# 额外安装 LibreOffice，支持 docx/xlsx/pptx → PDF（镜像体积大、构建慢，按需开启）
bash releases/deploy/install-local-stack.sh --with-office-convert --rebuild

# 已有实例：只重跑技能/模板发布与加载（例如注册管理员之后）
bash releases/deploy/install-local-stack.sh --seed-only
```

支撑文件（均在 `releases/deploy/`）：

| 文件 | 作用 |
|---|---|
| `install-local-stack.sh` | 安装器主流程（7 步，幂等） |
| `compose.local-stack.yml` | 数据库 + 服务端 + 浏览器服务编排（外部网络、不暴露浏览器端口） |
| `Dockerfile.local-stack-server` | 服务端镜像：`node:22-alpine` + 镜像源装依赖 + 前端构建 + 严格许可门禁 |
| `Dockerfile.local-stack-browser` | 浏览器镜像：Playwright 基础镜像 + 仅在服务端需要的依赖 |
| `Dockerfile.local-stack-executor` | 执行器镜像：服务端镜像 + python/poppler/tesseract；`WITH_OFFICE_CONVERT=1` 时加 LibreOffice |
| `local-stack-load-skills.mts` | 为管理员加载内置技能（由安装器挂载进临时容器执行） |

## 安装器做了什么

1. **预检**：docker、compose 插件、openssl、curl；目标端口被占用时直接报错退出。
2. **受保护配置**：`<数据目录>/stack.env`（0600）生成数据库口令、初始化令牌、主密钥、浏览器令牌、Worker 令牌；已存在则沿用。
3. **网络**：创建外部网络 `<项目>_net`，读取其网关地址作为 Worker 的绑定地址。
4. **镜像**：缺失才构建；`--rebuild` 强制重建。执行器构建失败（镜像源不稳、apk 长时间无响应）时退化为服务端镜像并显式警告，此时 PDF 解析、OCR、Office 转 PDF 不可用，但 Office 生成能力不受影响。
5. **Worker**：以 `setsid` 在宿主机启动，绑定网关地址，健康检查带令牌。
6. **数据库**：空库时创建 `workpivot_app`/`workpivot_auth` 角色、执行 schema 迁移、初始化文件卷权限；已有结构则跳过。
6b. **可选 chat 存储（R007）**：`--with-chat-store` 时用管理员连接创建 `chat` schema、`chat.tasks`/`chat.messages` 与受限角色 `workpivot_chat`，并把运行时连接串写入 `stack.env`；不加参数则保持 JSONL，行为不变。
7. **启动**：`docker compose up -d --wait`，随后校验服务端、浏览器、Worker 健康。内置 SearXNG 随栈启动（`--with-office-convert` 等开关不影响它；拉不到镜像只警告并关闭 `web_search`）。
8. **内容**：必要时先建管理员 → 发布 4 个 Office 技能 + `bull-bear-debate` → 发布默认记忆/专家模板 → 为管理员加载技能。
9. **验收**：健康接口、首页、浏览器服务、Worker 四项。

## 验收记录（2026-10-24）

在全新项目上执行 `--project workpivot-t2 --port 39996 --auto-admin`：

| 项 | 结果 |
|---|---|
| 阶段 | 7/7 全部完成 |
| schema 版本 | 52 |
| 内置技能 | `office-routing`、`docx-report`、`xlsx-report`、`pptx-report` 均"已发布 + 已加载" |
| 默认模板 | 记忆模板 4 条 |
| 管理员 | 自动创建并可登录 |
| 验收 | 服务端 / 首页 / 浏览器 / Worker 四项全绿 |

同一轮还验证过执行器实际产出：`doc-check.docx`、`ppt-check.pptx`、`xlsx-check.xlsx`，
以及（含 LibreOffice 的镜像下）`doc-check.pdf` 转换成功。验收实例验证后已清理，未影响运行中的 `workpivot-dsh`。

## 正式安装记录（2026-10-24 09:13）

在 WSL 上用默认项目名 `workpivot-stack` 完成正式安装，端口 `39997`（`39990` 被先前手工搭建的
`workpivot-dsh` 占用，安装器现在会直接拒绝占用端口）。

| 项 | 结果 |
|---|---|
| 容器 | `workpivot-stack-{database,server,browser}-1` 均 healthy |
| schema | 52 |
| 内置技能 | 4 个全部已发布且已加载 |
| 默认模板 | 记忆模板 4 条 + 专家模板 1 个 |
| 管理员 | 自动创建（用户名 `admin`，密码见安装输出，需登录后修改） |
| 验收 | 服务端 / 首页 / 浏览器 / Worker 4/4 通过 |
| 端到端 | 通过 Worker 真实生成 `ppt-check.pptx`（45,398 字节，ZIP 头正确） |
| Windows 侧 | `http://127.0.0.1:39997/api/health` 返回 200 |

执行器本次复用了已验证的含 LibreOffice 镜像（`workpivot-executor:local-dsh-20261024` 重打标签），
因此该实例实际支持 Office → PDF；默认参数重建时不包含 LibreOffice。

## 边界与已知限制
- Worker 跑在 WSL 宿主、以 `setsid` 脱离会话；**WSL 重启后需重跑 `worker/run-worker.sh`**，安装器不自启。
- 网络被重建导致网段变化时，需重跑安装器刷新 `WORKPIVOT_WORKER_URL` 与 Worker 绑定地址。
- 默认执行器不含 LibreOffice，**不支持 Office → PDF 转换**；需要时用 `--with-office-convert` 重建。
- 向量检索（BGE-M3）仍不在本安装器范围：本机缺少可用的模型来源。
- 安装器只负责"从零装好一套"；升级/回退仍走 `release-local.mjs` 的发布流程与备份。
