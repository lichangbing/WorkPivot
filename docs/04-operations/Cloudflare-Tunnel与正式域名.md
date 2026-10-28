# Cloudflare Tunnel 与正式域名

> 状态：✅ 已部署
> 最近更新：2026-10-28
> 正式入口：<https://workpivot.lichb.cc.cd/>

## 1. 当前拓扑

```text
浏览器 / 手机
  → Cloudflare HTTPS
  → Cloudflare Tunnel 5d97f4a9-6199-45cc-9520-db9558748cc6
  → cloudflared.service
  → 127.0.0.1:8080
  → Nginx
  → 127.0.0.1:39800 WorkPivot Server
```

公网不直接访问源站域名：

- 8080 只监听回环地址。
- WorkPivot 容器仍只绑定宿主机 `127.0.0.1:39800`。
- 浏览器看到的是 Cloudflare 边缘证书。
- `cfargotunnel.com` 的 Public Hostname 路由由 Cloudflare 管理。
- 旧 `https://115-191-1-188.sslip.io:80/` 暂时保留为迁移回退。

## 2. DNS

Cloudflare 区域：`lichb.cc.cd`

公开主机名：

```text
workpivot.lichb.cc.cd
```

在 Cloudflare Tunnel 的 Public Hostname 中配置：

| 字段 | 值 |
| --- | --- |
| 子域名 | `workpivot` |
| 域 | `lichb.cc.cd` |
| 路径 | 空 |
| 服务类型 | `HTTP` |
| 服务地址 | `127.0.0.1:8080` |

Cloudflare 应生成代理 CNAME，目标为：

```text
5d97f4a9-6199-45cc-9520-db9558748cc6.cfargotunnel.com
```

公网 `dig` 返回 `104.x/172.67.x` 是 Cloudflare 代理后的正常结果，不能据此判断 DNS 错误。

## 3. 源站 Nginx

配置文件：

[nginx-workpivot-tunnel.conf](../../releases/deploy/nginx-workpivot-tunnel.conf)

安装目标：

```text
/etc/nginx/sites-available/workpivot-tunnel
/etc/nginx/sites-enabled/workpivot-tunnel
```

检查：

```bash
sudo nginx -t
sudo systemctl reload nginx
curl -fsS http://127.0.0.1:8080/api/health \
  -H 'Host: workpivot.lichb.cc.cd'
```

## 4. cloudflared

Token 文件：

```text
/etc/cloudflared/token
```

权限必须为 `0600`，不得提交仓库或写入文档。

Systemd 覆盖配置：

[cloudflared.service.override.conf](../../releases/deploy/cloudflared.service.override.conf)

安装目标：

```text
/etc/systemd/system/cloudflared.service.d/override.conf
```

应用并检查：

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now cloudflared
sudo systemctl restart cloudflared
sudo systemctl is-active cloudflared
sudo journalctl -u cloudflared -n 50 --no-pager
```

日志中应出现：

```text
Updated to new configuration
Registered tunnel connection
```

## 5. 验收

```bash
curl -fsS https://workpivot.lichb.cc.cd/api/health
curl -fsSI https://workpivot.lichb.cc.cd/
curl -fsSI https://workpivot.lichb.cc.cd/admin
curl -fsSI https://workpivot.lichb.cc.cd/downloads/WorkPivot-android-1.3.apk
```

手机来源预检：

```bash
curl -i -X OPTIONS https://workpivot.lichb.cc.cd/api/auth/state \
  -H 'Origin: capacitor://localhost' \
  -H 'Access-Control-Request-Method: GET'
```

应返回 204，且包含：

```text
access-control-allow-origin: capacitor://localhost
```

未认证 SSE 应返回 401；登录后工作区 SSE 首个事件应为
`{"type":"workspace",...}`。

## 6. 故障判断

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `1033` | Tunnel 离线或 Token 错误 | 检查 `cloudflared.service` 和 Token |
| `502` | Tunnel 在线，但本机 8080 无响应 | 检查 Nginx 和 WorkPivot 容器 |
| `525` | DNS 仍按 A 记录直连源站 | 删除 A/AAAA，保留 Tunnel CNAME |
| `530` | Cloudflare 找不到源站/隧道 | 检查区域、Public Hostname 和 DNS |
| 移动端 CORS 失败 | API 来源未进入白名单 | 检查 `WORKPIVOT_MOBILE_ORIGINS` |
| SSE 中断 | 代理缓冲或长连接超时 | 检查 Nginx `proxy_buffering off` 和 Tunnel 日志 |

## 7. 已知限制

当前使用 Cloudflare 免费网络和 HTTP/2 Tunnel。实测大陆访问存在少量首次连接超时、
较高延迟和大文件下载吞吐偏低；重试后恢复，必要时可使用旧直连地址。
对正式商业服务，应根据用户地域和合规要求评估 Cloudflare 中国网络、香港节点或
其他合规入口。

## 8. 回退

旧入口保持可用：

```text
https://115-191-1-188.sslip.io:80/
```

回退时停止 Cloudflare Tunnel：

```bash
sudo systemctl disable --now cloudflared
```

WorkPivot 服务、数据库和文件不受影响。不要删除 Token 文件，除非确认不再使用该 Tunnel。
