# syntax=docker/dockerfile:1
# One image for both Railway services (Story 2.10, AD-20). The service's start command picks the entry point:
#   api:     node services/api/dist/server.js
#   worker:  node services/worker/dist/main.js
#   migrate: node services/worker/dist/migrate.js   (the worker's preDeployCommand)
# No secrets are baked in: every credential arrives as a Railway variable at runtime.

FROM node:24.21-bookworm-slim AS base
ENV CI=true \
    COREPACK_ENABLE_DOWNLOAD_PROMPT=0 \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable && corepack prepare pnpm@12.6.0 --activate
WORKDIR /app

FROM base AS build
COPY . .
# The api, the worker, their workspace dependencies, and the root toolchain (turbo, typescript).
RUN pnpm install --frozen-lockfile --filter horos --filter "@horos/api..." --filter "@horos/worker..."
RUN pnpm turbo run build --filter="@horos/api..." --filter="@horos/worker..."
# Drop devDependencies (the root toolchain included) now that dist/ is built.
RUN pnpm install --frozen-lockfile --prod --filter "@horos/api..." --filter "@horos/worker..."

FROM node:24.21-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app /app
USER node
EXPOSE 8080
CMD ["node", "services/api/dist/server.js"]
