# dshagent 客服系统 — 主服务镜像
#
# DeepSeek Harness 官方包尚未发布到 npm（dsh-cli 不存在、dsh-base/web-app 仅
# rc 占位），因此镜像基于本仓库源码运行。lib 产物（packages/*/lib）由仓库
# 维护者在本机 `pnpm run build:lib:host && build:lib:client` 生成后随构建
# 上下文带入（见 .dockerignore：lib 不排除）；容器内只做依赖安装与 web
# 前端构建，避免在镜像里跑全量 tsc（慢且脆）。
#
# 运行时布局：
#   /app                    本仓库源码（含 customer-service/ 与预构建 lib）
#   $DSH_HOME=/dsh-home     DSH 运行时数据（settings/credentials/sessions…）
#   /kb                     客服知识库（Obsidian vault，只读挂载）
#   /srv/guest              Guest 前端静态页（nginx 服务）

FROM node:24-bookworm-slim AS base
RUN npm install -g pnpm@11.7.0
WORKDIR /app

# ── 依赖安装层 ──────────────────────────────────────────────────────────────
FROM base AS deps
COPY pnpm-lock.yaml package.json pnpm-workspace.yaml .npmrc* ./
COPY patches ./patches
COPY vendor ./vendor
COPY packages ./packages
COPY apps ./apps
COPY native ./native
COPY scripts ./scripts
COPY website ./website
COPY tsconfig*.json ./
COPY tsdown.config.ts ./
RUN pnpm install --frozen-lockfile --ignore-scripts

# ── web 前端构建层（只需 vite build 产出 dist）──────────────────────────────
FROM deps AS build
RUN pnpm --filter @deepseek-ai/dsh-web-frontend run build

# ── 运行层 ──────────────────────────────────────────────────────────────────
FROM base AS runtime
ENV NODE_ENV=production
ENV DSH_HOME=/dsh-home
# 全仓库源码 + 本机预构建 lib + 刚构建的 web dist
COPY --from=deps /app /app
COPY --from=build /app/apps/web/dist /app/apps/web/dist
# customer-service 模块（preset 组合引用 /app/customer-service/plugins/...）
COPY customer-service /app/customer-service
# Guest 前端静态页由 nginx 服务
COPY customer-service/web/guest /srv/guest
# 客服 preset/profile 模板（entrypoint 装入 DSH_HOME）
COPY customer-service/presets /presets-src
COPY customer-service/deploy/profile /profile-src

EXPOSE 3080
WORKDIR /app
CMD ["bash", "/app/customer-service/deploy/entrypoint.sh"]
