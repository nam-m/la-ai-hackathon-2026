FROM node:22-slim

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY src ./src
COPY scripts ./scripts
COPY tsconfig.json ./

# Run as the image's non-root "node" user; the store lives on the /data volume.
RUN mkdir -p /data && chown node:node /data
ENV NODE_ENV=production DATA_FILE=/data/store.json
USER node
VOLUME /data

EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://localhost:' + (process.env.PORT || 8080) + '/health').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
# node directly (not npx) so docker stop's SIGTERM reaches the server, which saves the store and exits.
CMD ["node", "--import", "tsx", "src/index.ts"]
