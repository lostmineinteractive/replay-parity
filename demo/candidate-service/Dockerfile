# syntax=docker/dockerfile:1
# Built from the repository root so the workspace lockfile is shared:
#   docker build -f demo/candidate-service/Dockerfile .
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json tsconfig.base.json ./
COPY packages ./packages
COPY demo ./demo
COPY scripts ./scripts
RUN pnpm install --frozen-lockfile --ignore-scripts
RUN pnpm exec tsc -b demo/candidate-service
RUN pnpm --filter @replay-parity/demo-candidate deploy --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production
ENV PORT=3000
WORKDIR /app
COPY --from=build /out /app
EXPOSE 3000
USER node
CMD ["node", "dist/src/server.js"]
