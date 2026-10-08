FROM node:24-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY package*.json ./
RUN npm ci --omit=dev && npx playwright install --with-deps chromium
COPY src ./src
COPY test ./test
RUN npm test && npm run test:browser
ENV DATA_DIR=/data PORT=3000
CMD ["node", "src/index.js"]
