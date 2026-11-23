FROM node:22-alpine

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8787 \
    DATA_DIR=/data \
    LX_DNS_OVER_HTTPS=true

WORKDIR /app
COPY package.json package-lock.json ./
RUN apk add --no-cache ffmpeg unzip
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY src ./src
COPY public ./public
COPY vendor ./vendor
COPY LICENSE ./LICENSE
RUN mkdir -p /data && chown node:node /data /app

USER node
EXPOSE 8787
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "--experimental-strip-types", "src/update/launcher.ts"]
