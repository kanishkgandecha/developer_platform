# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim AS base
RUN corepack enable
WORKDIR /app

FROM base AS pruner
RUN npm install -g turbo@2.3.3
COPY . .
RUN turbo prune @developer-platform/web --docker

FROM base AS installer
COPY --from=pruner /app/out/json/ .
COPY --from=pruner /app/out/pnpm-lock.yaml ./pnpm-lock.yaml
RUN pnpm install --frozen-lockfile
COPY --from=pruner /app/out/full/ .
RUN pnpm exec turbo run build --filter=@developer-platform/web
RUN pnpm prune --prod

# ---- Runtime ----------------------------------------------------------------
# `next start` against the full pruned node_modules, not `output: "standalone"`
# — see the comment in apps/web/next.config.ts for why.
FROM base AS runner
RUN addgroup --system --gid 1001 nodejs \
    && adduser --system --uid 1001 webuser
ENV NODE_ENV=production
WORKDIR /app
COPY --from=installer --chown=webuser:nodejs /app .
USER webuser
WORKDIR /app/apps/web
ENV PORT=3000
EXPOSE 3000
# Invoke Next's bin directly rather than `pnpm start` / `next start` through
# a package-manager shim — corepack tries to write a version cache to $HOME
# on first run, which the non-root, homeless `webuser` can't do.
CMD ["node", "node_modules/next/dist/bin/next", "start"]
