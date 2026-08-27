# 源代码

> ⚠️ 本目录为**占位**：后端技术栈与整体架构待 `docs/01-research/tech/` 调研定案
>（并落 ADR 于 `docs/02-design/decisions/`）后，再按结论建立实际工程目录。

## 已确定的技术约束（截至 2026-08-27）

- **交付模式**：私有化部署（架构须支持内网环境、离线安装交付）
- **客户端**：桌面端必有（框架 Electron vs Tauri 待调研）；Web 端、IM 接入待定
- **后端技术栈**：待定（候选：Java/Spring Boot、Python/FastAPI、Node.js/NestJS 或混合架构）

## 建议的 monorepo 布局（定案后参考，非最终结论）

```
code/
├── apps/                  # 客户端应用
│   ├── desktop/           #   桌面端（必有）
│   ├── web/               #   Web 端（管理台/工作台，待定）
│   └── im-bot/            #   IM 机器人接入（企业微信/钉钉/飞书，待定）
├── services/              # 后端服务（按域拆分，技术栈待定）
│   ├── gateway/           #   API 网关 / BFF
│   ├── auth/              #   认证与租户管理
│   ├── agent/             #   Agent 编排与任务执行
│   ├── knowledge/         #   知识库 / RAG
│   └── model-gateway/     #   多模型接入网关
├── packages/              # 跨端共享库（类型定义、SDK、UI 组件）
└── deploy/                # 部署编排（docker-compose / k8s / helm，私有化交付的核心）
```

## 建库时的注意事项

1. 技术栈定案后，首个动作是落 ADR，然后按本文件建议布局建立工程并更新本 README
2. 私有化交付要求所有依赖可离线获取（镜像、包仓库需可镜像化）
3. `deploy/` 与 `releases/` 的关系：deploy 存编排源文件（入库），releases 存发布产物（大文件不入库）
