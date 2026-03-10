# syntax=docker/dockerfile:1.4

# EPUBCheck download stage (cacheable - rarely changes)
FROM node:20-alpine AS epubcheck
RUN apk add --no-cache wget unzip \
    && wget -q https://github.com/w3c/epubcheck/releases/download/v5.1.0/epubcheck-5.1.0.zip -O /tmp/epubcheck.zip \
    && unzip -q /tmp/epubcheck.zip -d /epubcheck \
    && rm /tmp/epubcheck.zip

# Build stage - compile TypeScript
FROM node:20-alpine AS builder
WORKDIR /app

# Copy package files first (better layer caching)
COPY package*.json ./
COPY tsconfig.json ./

# Install dependencies (cached if package.json unchanged)
RUN npm ci --ignore-scripts

# Copy source and build
COPY prisma ./prisma
RUN npx prisma generate

COPY src ./src
RUN npm run build

# Production stage - use Debian-based image for Prisma/OpenSSL compatibility
FROM node:20-slim AS production
WORKDIR /app

# Install system dependencies (single layer, sorted for cache efficiency)
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    default-jre-headless \
    ghostscript \
    imagemagick \
    openssl \
    pandoc \
    poppler-utils \
    postgresql-client \
    unzip \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs nodejs

# Install veraPDF CLI (PDF/UA validator — Matterhorn coverage Step 4)
# Note: default-jre-headless is already installed in the apt-get layer above.
# Installs GUI + *nix Scripts + Validation model packs (~18 MB of JARs and scripts).
COPY scripts/install-verapdf.sh /tmp/install-verapdf.sh
RUN bash /tmp/install-verapdf.sh && rm /tmp/install-verapdf.sh

# Copy EPUBCheck from download stage (cached)
COPY --from=epubcheck /epubcheck/epubcheck-5.1.0 /app/lib/epubcheck/epubcheck-5.1.0

# Copy compiled code and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/data ./dist/data
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package*.json ./

# Rebuild native modules for Debian (sharp, prisma) and set permissions
RUN npm rebuild sharp --platform=linux --arch=x64 \
    && npx prisma generate \
    && chown -R nodejs:nodejs /app/lib /app/node_modules/.prisma

ARG COMMIT_SHA=unknown
ENV EPUBCHECK_PATH=/app/lib/epubcheck/epubcheck-5.1.0/epubcheck.jar
ENV VERAPDF_PATH=/opt/verapdf/verapdf
ENV NODE_ENV=production
ENV PORT=3000
ENV COMMIT_SHA=$COMMIT_SHA

USER nodejs
EXPOSE 3000

# Health checks with generous start period to avoid premature unhealthy status
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
