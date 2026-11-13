# The Sessionly server with the dashboard built in.
FROM node:24-slim
WORKDIR /app
RUN corepack enable

# Dependencies first, so they are cached until a package.json changes.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/schema/package.json packages/schema/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

COPY schema schema
COPY packages packages
COPY apps apps
RUN pnpm build

ENV HOST=0.0.0.0 PORT=8080
EXPOSE 8080
WORKDIR /app/apps/server
USER node
CMD ["node", "src/index.ts"]
