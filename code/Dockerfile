# WorkPivot 企业服务端镜像（J02 拓扑二：服务端集中部署，浏览器 zero-install 访问）
# 构建：docker build -t workpivot-server:0.2.0 .
# 运行：见仓库根 docker-compose.yml 与 releases/deploy/部署说明.md
FROM node:22-alpine

# pnpm（与 pnpm-lock.yaml 版本对齐由 corepack 读取 packageManager/package.json）
RUN corepack enable

WORKDIR /app

# 依赖清单先行（利用层缓存）
COPY pnpm-workspace.yaml pnpm-lock.yaml ./
COPY package.json ./
COPY packages/server/package.json packages/server/
COPY packages/core/package.json packages/core/
COPY packages/shared/package.json packages/shared/
COPY apps/web/package.json apps/web/
COPY apps/desktop/package.json apps/desktop/

RUN pnpm install --frozen-lockfile

# 源码（服务层直接以 tsx 运行 TS 源，无需构建步骤）
COPY . .

# 前端构建产物（Express 静态托管）
RUN pnpm --filter @workpivot/web build

ENV NODE_ENV=production \
    WORKPIVOT_HOST=0.0.0.0 \
    WORKPIVOT_PORT=39800 \
    WORKPIVOT_HOME=/data/workpivot \
    WORKPIVOT_WORKSPACE=/data/workspace

EXPOSE 39800

VOLUME ["/data/workpivot", "/data/workspace"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:39800/api/health || exit 1

CMD ["npx", "tsx", "packages/server/src/index.ts"]
