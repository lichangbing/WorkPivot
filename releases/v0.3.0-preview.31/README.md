# preview.31 账号恢复与登录连接

后台用户管理增加“重置密码”。管理员可为其他非平台管理员账号生成随机临时密码；撤销目标账号旧会话并停止运行任务。临时密码仅在本次结果窗口展示，关闭后不再显示，账号文件保存 bcrypt 哈希，响应禁止缓存。本版本尚未接入数据库。

使用临时密码登录后，用户端和管理端要求先设置个人密码。服务端同时限制临时会话访问业务接口，仅允许查看登录状态、修改密码和退出。修改成功后撤销会话，使用新密码重新登录；禁止继续使用原临时密码。旧账号不会自动进入强制改密状态。平台管理员忘记密码仍需部署管理员恢复，自己的密码通过“修改密码”修改。

用户和后台登录页显示当前服务器。preview.31 桌面客户端可点击“更换服务器”打开本机连接设置；旧客户端显示顶部菜单指引；网页版使用当前网址。切换接口仅接受已连接来源的主窗口调用。

## 交付及部署

- Windows：`installers/WorkPivot-Setup-0.3.0-preview.31.exe`，87145909 字节，内部未签名安装包。
- Windows SHA256：`7E7D5C696DF0C5CD815DE463EC8C547D17E7166F366F2655F46C05CD8F383D2A`。
- 服务端归档：`../deploy/artifacts/workpivot-server-preview31.tar.gz`，257339511 字节。
- 镜像归档 SHA256：`7E6433E5330AAC5A5FF311AE10DCAC1EBE0EF070532B45E3CD0DDB620FC9FC76`。
- 镜像基于 preview.30，增量构建定义为 `../deploy/Dockerfile.preview31`；完整源构建仍使用 code/Dockerfile。
- 本机 WSL 已部署 preview.31，地址 `http://127.0.0.1:39880`；备份 `/home/lichb/workpivot-backups/pre-preview31-1789200708945`。
- 远端已于 2026-09-13 升级 preview.31，公网 `https://workpivot.lichb.cc.cd` 首页、管理页及健康检查通过，未登录业务接口返回 401，独立 worker active。备份 `/home/lichb/workpivot-backups/pre-preview31-1789300409643`。
- 远端镜像传输后 SHA256 校验一致，执行 `node upgrade-preview31.mjs lan` 完成更新。脚本验证旧版本、检查所有账号活动任务、备份卷，再更新现有 Compose，健康检查失败回退配置。账号、密钥及业务卷保留；未部署开发中的数据库原型。
- macOS DMG 仍待 Mac 构建及真机验收，本次未生成。

## 验证

类型、lint、Web 与桌面构建通过。W37 密码重置 Windows/Linux 各 23 项通过；Windows W26 账号隔离 60 项、W13 会话 34 项、W17 连接 14 项通过。

独立临时账号完成后台重置弹窗 → 临时密码登录 → 强制改密 → 重新登录的界面验收；浅色和深色截图检查通过。实际桌面主进程与预加载桥接的登录页服务器切换验收通过。测试未修改真实用户密码。
