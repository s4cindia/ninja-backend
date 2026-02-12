# Build stage - compile TypeScript
  FROM node:20-alpine AS builder
  WORKDIR /app
  COPY package*.json ./
  COPY tsconfig.json ./
  RUN npm ci
  COPY src ./src
  COPY src/data ./src/data
  COPY prisma ./prisma
  RUN npx prisma generate
  RUN npm run build

  # Production stage - use Debian-based image for Prisma/OpenSSL compatibility
  FROM node:20-slim
  WORKDIR /app

  # Install system dependencies for EPUB processing and sharp
  RUN apt-get update && apt-get install -y --no-install-recommends \
      curl \
      wget \
      unzip \
      pandoc \
      poppler-utils \
      ghostscript \
      imagemagick \
      default-jre-headless \
      git \
      jq \
      postgresql-client \
      openssl \
      ca-certificates \
      python3 \
      build-essential \
      && rm -rf /var/lib/apt/lists/* \
      && groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs nodejs

  # Copy compiled code and dependencies
  COPY --from=builder /app/dist ./dist
  COPY --from=builder /app/src/data ./dist/data
  COPY --from=builder /app/node_modules ./node_modules
  COPY --from=builder /app/prisma ./prisma
  COPY --from=builder /app/package*.json ./

  # Rebuild native modules for Debian (sharp, prisma)
  RUN npm rebuild sharp --platform=linux --arch=x64
  RUN npx prisma generate

  # Download EPUBCheck
  RUN mkdir -p /app/lib/epubcheck && \
      wget -q https://github.com/w3c/epubcheck/releases/download/v5.1.0/epubcheck-5.1.0.zip -O /tmp/epubcheck.zip && \
      unzip -q /tmp/epubcheck.zip -d /app/lib/epubcheck && \
      rm /tmp/epubcheck.zip && \
      chown -R nodejs:nodejs /app/lib /app/node_modules/.prisma

  ENV EPUBCHECK_PATH=/app/lib/epubcheck/epubcheck-5.1.0/epubcheck.jar

  USER nodejs
  EXPOSE 3000
  ENV NODE_ENV=production
  ENV PORT=3000
  HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:3000/health || exit 1
  CMD ["node", "dist/index.js"]
