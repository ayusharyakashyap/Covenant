# Production image: small, non-root, health-checked, data on a mounted volume.
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build && npm run typecheck

FROM node:22-alpine
ENV NODE_ENV=production PORT=8787 DATA_DIR=/data TRUST_PROXY=1 LOG_FORMAT=json
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/public ./public
RUN addgroup -S app && adduser -S app -G app && mkdir -p /data && chown app:app /data
USER app
VOLUME /data
EXPOSE 8787
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s CMD wget -qO- http://127.0.0.1:8787/readyz || exit 1
# SIGTERM is forwarded to node, which drains requests and jobs before exiting.
CMD ["node", "--import", "tsx", "server/index.ts"]
