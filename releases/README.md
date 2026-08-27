# 发行版本

面向**私有化部署**交付的版本管理目录。

## 版本命名

采用[语义化版本](https://semver.org/lang/zh-CN/)，目录名 `v{主版本}.{次版本}.{修订号}`：

- `v0.x.x`：研发期版本（MVP 阶段）
- `v1.0.0` 起：对外正式交付版本
- 预发布版本加后缀，如 `v1.0.0-rc.1`

## 每个版本目录的标准结构

发布时创建 `vX.Y.Z/`，须包含：

```
releases/vX.Y.Z/
├── RELEASE-NOTES.md       # 本版发布说明（必含：新特性/修复/升级注意事项/回滚方案）
├── installers/            # 桌面端等客户端安装包
├── deploy/                # 私有化部署包（docker-compose/k8s manifests/helm chart + 离线镜像清单）
├── upgrade/               # 从上一版本升级的脚本与说明
└── artifacts/             # 其他大体积二进制产物（已在 .gitignore 排除，不入 git）
```

## 大文件管理约定

- 安装包、容器镜像等大体积二进制**不提交到 git**（`artifacts/` 已被 `.gitignore` 排除）
- 实际产物存放于制品库 / 内网文件服务器，并在 `RELEASE-NOTES.md` 中记录下载地址与校验和（SHA-256）
- git 中只保留：发布说明、部署编排配置、升级脚本

## 发布流程

1. 代码达到发布条件（测试通过、CHANGELOG 已更新）
2. 打版本 tag（`git tag vX.Y.Z`），构建产物并生成校验和
3. 创建 `vX.Y.Z/` 目录，写入 RELEASE-NOTES.md 与部署配置
4. 在私有化目标环境完成一次完整安装验证后，方可对外交付
5. 更新 [CHANGELOG.md](CHANGELOG.md)
