FROM node:24-alpine AS builder
WORKDIR /app

# Keep build logs free of npm's self-update and funding notices.
ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false
COPY package*.json ./
RUN npm ci --no-audit --loglevel=error
COPY . .
RUN npm run build

FROM node:24-alpine
WORKDIR /app

ENV NPM_CONFIG_UPDATE_NOTIFIER=false NPM_CONFIG_FUND=false

# su-exec is a small (~30 KB) replacement for gosu used to drop privileges
# from root to the unprivileged "node" user after the entrypoint has fixed
# bind-mount ownership.
RUN apk add --no-cache su-exec

COPY --from=builder /app/package*.json ./
RUN npm ci --omit=dev --no-audit --loglevel=error
COPY --from=builder /app/server ./server
COPY --from=builder /app/mcp ./mcp
COPY --from=builder /app/dist ./dist
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# /app/data is the canonical data path; the bind mount or named volume is
# attached here at runtime.
RUN mkdir -p /app/data

ENV PORT=6767
ENV NODE_ENV=production
# Override these at runtime (docker-compose `environment:`) to make the
# container run as your host user. Defaults to the alpine "node" user (1000).
ENV PUID=1000
ENV PGID=1000

EXPOSE 6767
VOLUME ["/app/data"]

# Healthy once the API answers; /api/setup/status needs no sign-in and touches the database.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||6767)+'/api/setup/status').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["node", "server/server.js"]
