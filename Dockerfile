# ---- 构建阶段 ----
# node:24+：node:sqlite（DatabaseSync）需 Node 22.5+ 且 24 起标记为稳定
FROM node:24-alpine AS builder
WORKDIR /app

COPY package.json package-lock.json* ./
# 国内网络加速：npmmirror 镜像源（仅构建期生效，产物与官方源完全一致）
RUN npm ci --no-audit --no-fund --registry=https://registry.npmmirror.com

COPY . .
ENV DOCKER_BUILD=1
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build

# ---- 运行阶段 ----
FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=8080
ENV HOSTNAME=0.0.0.0

# 非 root 用户
RUN addgroup -S nodejs && adduser -S nextjs -G nodejs

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

# SQLite 数据目录（源检测结果 / 黑名单 / 我的片单）：挂卷持久化
ENV LIBRETV_DATA_DIR=/app/data
RUN mkdir -p /app/data && chown -R nextjs:nodejs /app/data
VOLUME ["/app/data"]

USER nextjs

EXPOSE 8080
CMD ["node", "server.js"]
