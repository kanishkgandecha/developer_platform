# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS pruner
RUN npm install -g turbo@2.3.3
COPY . .
RUN turbo prune @developer-platform/worker --docker

# ---- Install dependencies, then build --------------------------------------
FROM base AS installer
# Phase 3: apps/worker now depends on @developer-platform/database (Prisma),
# whose query engine needs libssl at runtime on Debian slim — same fix as
# docker/api.Dockerfile.
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm exec turbo run build --filter=@developer-platform/worker
RUN pnpm prune --prod

FROM base AS runner
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 workeruser
ENV NODE_ENV=production
WORKDIR /app
COPY --from=installer --chown=workeruser:nodejs /app .
# INGESTION_WORKSPACE_DIR defaults to ./workspaces, resolved against this
# WORKDIR — /app itself is still root-owned (created by WORKDIR while the
# base stage was still root), so workeruser can't mkdir inside it at runtime
# without this directory existing with the right ownership up front.
RUN mkdir -p /app/workspaces && chown workeruser:nodejs /app/workspaces
USER workeruser
CMD ["node", "apps/worker/dist/index.js"]
