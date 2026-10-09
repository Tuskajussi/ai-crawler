FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production \
    CRAWLSPACE_HOST=0.0.0.0 \
    CRAWLSPACE_PORT=3001 \
    CRAWLSPACE_DATA_DIR=/data \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev \
    && ./node_modules/.bin/playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && npm cache clean --force \
    && mkdir -p /data \
    && chown node:node /data
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
USER node
EXPOSE 3001
VOLUME ["/data"]
CMD ["node", "dist-server/index.js"]
