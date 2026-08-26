FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/core/package.json packages/core/
COPY packages/cli/package.json packages/cli/
RUN npm ci --workspace @luo-5/core --workspace @luo-5/cli
COPY packages/core/ packages/core/
COPY packages/cli/ packages/cli/
RUN cd packages/core && npm install --save-dev @types/node@24
RUN npm run build --workspace @luo-5/core
RUN npm run build --workspace @luo-5/cli

FROM node:24-alpine
WORKDIR /app
RUN apk add --no-cache samba-server
COPY --from=builder /app/package.json ./
COPY --from=builder /app/packages/core/dist/ packages/core/dist/
COPY --from=builder /app/packages/core/package.json packages/core/
COPY --from=builder /app/packages/cli/dist/ packages/cli/dist/
COPY --from=builder /app/packages/cli/package.json packages/cli/
COPY packages/cli/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY packages/cli/smb-sidecar.sh /usr/local/bin/smb-sidecar.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/smb-sidecar.sh
RUN npm install --omit=dev --workspace @luo-5/cli
VOLUME ["/data"]
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["--help"]
