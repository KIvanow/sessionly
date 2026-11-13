# The Sessionly server with the dashboard built in.
#   docker build .               the core server (Apache-2.0)
#   docker build --target ee .   with the Business and Enterprise features (LICENSE-EE)
FROM node:24-slim AS core
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

# Without DATABASE_URL the embedded database goes to /data: mount a volume there to keep it.
RUN mkdir /data && chown node:node /data
ENV HOST=0.0.0.0 PORT=8080 DATABASE_URL=file:/data/pglite
VOLUME /data
EXPOSE 8080
WORKDIR /app/apps/server
USER node
CMD ["node", "src/index.ts"]

# The same server with ee/ plugged in. Without a license it behaves like the core.
FROM core AS ee
USER root
COPY ee /app/ee
RUN cd /app && pnpm install --frozen-lockfile
WORKDIR /app/ee
USER node
CMD ["node", "src/main.ts"]

# A plain `docker build .` builds the core.
FROM core
