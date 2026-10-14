FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package*.json ./
# Install deps + the bundled Chromium, then Xvfb so Chrome can run *headful*
# inside a virtual framebuffer (no "HeadlessChrome" tells for nekto to read).
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium \
 && apt-get update && apt-get install -y --no-install-recommends xvfb \
 && rm -rf /var/lib/apt/lists/*
COPY src ./src
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh
ENV DATA_DIR=/data PORT=3000 DISPLAY=:99 NEKTO_BROWSER_CHANNEL=chromium
CMD ["./docker-entrypoint.sh"]
