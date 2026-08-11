# ---------------------------------------------------------------------------
# WhatsApp Campaign Studio — web edition
# Single-stage image with Chromium for whatsapp-web.js (puppeteer).
# Works on Railway, Render, Fly, or any Docker host.
# ---------------------------------------------------------------------------
FROM node:20-slim

# Puppeteer/whatsapp-web.js needs a real Chromium + its shared libraries.
# We install the distro Chromium and point puppeteer at it instead of letting
# it download its own (smaller image, reliable on ARM/AMD).
ENV PUPPETEER_SKIP_DOWNLOAD=true \
    PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true \
    PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium \
    NODE_ENV=production \
    DATA_DIR=/data

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    ca-certificates \
    fonts-liberation \
    fonts-noto-color-emoji \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
    libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
    libpango-1.0-0 libcairo2 libatspi2.0-0 \
    dumb-init \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Install deps first for better layer caching.
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

# App source.
COPY . .

# Persistent state (DB, WhatsApp session, uploads) lives here — mount a volume.
RUN mkdir -p /data
VOLUME ["/data"]

EXPOSE 3000

# dumb-init reaps zombie Chromium processes cleanly.
ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "src/server.js"]
