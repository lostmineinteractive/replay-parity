# syntax=docker/dockerfile:1
# The rp image. Built from the repository root so the workspace lockfile is shared:
#   docker build -t replay-parity-rp:dev .
#   docker run --rm replay-parity-rp:dev --version
# The build stage installs the workspace with the lockfile, compiles the cli and
# the packages it depends on, and lays out the cli with its production
# dependencies in /out the way the demo images do. The final stage is distroless:
# no shell, no package manager, and a non root user.
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY demo ./demo
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm exec tsc -b packages/cli
RUN pnpm --filter @replay-parity/cli deploy --prod --legacy /out

FROM gcr.io/distroless/nodejs22-debian12:nonroot
LABEL org.opencontainers.image.source="https://github.com/seesharp15/replay-parity"
LABEL org.opencontainers.image.description="rp: capture, replay, diff, and latency gating for a candidate system against a reference"
LABEL org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out /app
ENTRYPOINT ["/nodejs/bin/node", "/app/dist/src/main.js"]
