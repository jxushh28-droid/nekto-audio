FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package*.json ./
# Install deps + REAL Google Chrome (not just bundled Chromium) so the browser
# is genuine Chrome — real codecs/Widevine/brands, nothing for nekto to flag as
# Chromium. Keep chromium as a fallback. Xvfb lets Chrome run *headful* inside a
# virtual framebuffer (no "HeadlessChrome" tells).
RUN npm ci --omit=dev \
 && npx playwright install --with-deps chromium chrome \
 && apt-get update && apt-get install -y --no-install-recommends \
      xvfb speech-dispatcher espeak-ng libnss3 \
 && rm -rf /var/lib/apt/lists/*
COPY src ./src
COPY docker-entrypoint.sh ./docker-entrypoint.sh
RUN chmod +x docker-entrypoint.sh
ENV DATA_DIR=/data PORT=3000 DISPLAY=:99 NEKTO_BROWSER_CHANNEL=chrome
CMD ["./docker-entrypoint.sh"]
