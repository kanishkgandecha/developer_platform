# syntax=docker/dockerfile:1
# Multi-stage build for apps/api. Uses `turbo prune` to build a minimal
# workspace subset (only the packages @developer-platform/api actually
# depends on) so unrelated app source doesn't bust the Docker layer cache.

FROM node:20-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

# ---- Prune the workspace down to what apps/api needs ----------------------
FROM base AS pruner
RUN npm install -g turbo@2.3.3
COPY . .
RUN turbo prune @developer-platform/api --docker

# ---- Install dependencies, then build --------------------------------------
FROM base AS installer
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm exec turbo run build --filter=@developer-platform/api
RUN pnpm prune --prod

# ---- Slim runtime image -----------------------------------------------------
FROM base AS runner
RUN apt-get update && apt-get install -y --no-install-recommends openssl \
    && rm -rf /var/lib/apt/lists/* \
    && addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 apiuser
ENV NODE_ENV=production
WORKDIR /app
COPY --from=installer --chown=apiuser:nodejs /app .
USER apiuser
EXPOSE 4000
CMD ["node", "apps/api/dist/index.js"]
