# macOS 安装包构建

当前工作环境为 Windows / WSL，尚未生成或验证 DMG。已配置 Apple Silicon（arm64）及 Intel（x64）两个版本；DMG 制作依赖 macOS 的 hdiutil，不能把 Windows 安装包或 ZIP 改名代替。

在装有 Node.js 22+ 和 pnpm 的 Mac 上，将工程复制到本机并执行：

```bash
bash releases/deploy/build-macos.sh
```

输出在 `releases/v0.3.0-preview.30/macos/`，包含两种架构的 DMG、ZIP 及 SHA256SUMS.txt。DMG 支持将 WorkPivot 拖入 Applications。

签名与公证需要 Apple Developer 凭据。本工程未配置这些凭据；无签名构建仅适合内部测试，不应视为已经通过 Gatekeeper 或 macOS 真机验收的公开安装包。

客户端首次运行需要配置可访问的后台服务器地址。服务器项目使用后台创建的目录；本机成果同步目录在产物浏览窗口单独选择，过程文件不自动下载。
