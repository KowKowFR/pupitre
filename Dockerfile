# syntax=docker/dockerfile:1.7
#
# ONE single image, two commands at runtime:
#   docker run <image> web       → Next.js panel (applies the migrations at startup)
#   docker run <image> worker    → BullMQ consumer
#
ARG NODE_VERSION=24-alpine

# ─── base ─────────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS base
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

# ─── manifests (cache layer) ──────────────────────────────────────────────────
FROM base AS manifests
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json ./apps/web/
COPY apps/worker/package.json ./apps/worker/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/

# ─── full dependencies (build) ────────────────────────────────────────────────
FROM manifests AS deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile

# ─── production dependencies only (runtime) ───────────────────────────────────
FROM manifests AS prod-deps
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --prod

# ─── build ────────────────────────────────────────────────────────────────────
FROM deps AS builder
COPY tsconfig.base.json ./
COPY packages ./packages
COPY apps ./apps
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build:packages \
 && pnpm --filter @pupitre/worker build \
 && pnpm --filter @pupitre/web build

# ─── runtime ──────────────────────────────────────────────────────────────────
FROM node:${NODE_VERSION} AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME=0.0.0.0

# postgresql16-client: pg_dump / pg_restore for the panel's backup — same major
# as the server (PostgreSQL 16), so that an export always reads back.
RUN addgroup -g 1001 -S nodejs \
 && adduser -u 1001 -S nodejs -G nodejs \
 && apk add --no-cache openssh-client postgresql16-client

# "monorepo" tree: serves the worker and the migration script.
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/apps/worker/node_modules ./apps/worker/node_modules
COPY --from=prod-deps /app/packages/core/node_modules ./packages/core/node_modules
COPY --from=prod-deps /app/packages/db/node_modules ./packages/db/node_modules
COPY package.json ./
COPY apps/worker/package.json ./apps/worker/
COPY packages/core/package.json ./packages/core/
COPY packages/db/package.json ./packages/db/
COPY --from=builder /app/apps/worker/dist ./apps/worker/dist
COPY --from=builder /app/packages/core/dist ./packages/core/dist
COPY --from=builder /app/packages/db/dist ./packages/db/dist
COPY packages/db/migrations ./packages/db/migrations

# "standalone" tree: autonomous Next server, dependencies already traced.
COPY --from=builder /app/apps/web/.next/standalone ./web/
COPY --from=builder /app/apps/web/.next/static ./web/apps/web/.next/static

COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# `/backups` exists in the image and belongs to `nodejs`: a new named volume
# inherits that at its first mount — otherwise it would be born as root, and the
# worker would write nothing in it.
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && chown -R nodejs:nodejs /app \
  && mkdir -p /backups && chown nodejs:nodejs /backups

USER nodejs
EXPOSE 3000
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["web"]
