# syntax=docker/dockerfile:1.4

# Base images are pinned to the ECR Public Gallery's mirror of the
# official Docker Hub images, by exact digest. GitHub-hosted runners
# share IP ranges across huge numbers of unrelated orgs, so Docker Hub's
# anonymous-pull rate limit (shared per-IP, not per-repo) gets exhausted
# by OTHER tenants' traffic -- this has twice failed a real deploy with
# "429 Too Many Requests" resolving docker.io/library/node. ECR Public
# Gallery (https://gallery.ecr.aws/docker/library/node) is AWS's verified,
# bit-identical mirror of the same images, specifically to route around
# this; it isn't subject to Docker Hub's shared-IP throttling. Pinning to
# a digest (not just switching registries) additionally lets BuildKit
# skip the remote manifest-resolution round-trip entirely once the layer
# cache is warm -- a floating tag forces a "check for updates" network
# call on every build even with a warm cache, which is what let the
# Docker Hub outage affect an otherwise-cached build in the first place.
#
# To bump the Node version: `docker buildx imagetools inspect
# public.ecr.aws/docker/library/node:<new-tag>` and copy the top-level
# multi-arch index Digest (not a single-platform manifest digest).

# EPUBCheck download stage (cacheable - rarely changes)
FROM public.ecr.aws/docker/library/node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS epubcheck
RUN apk add --no-cache wget unzip \
    && wget -q https://github.com/w3c/epubcheck/releases/download/v5.1.0/epubcheck-5.1.0.zip -O /tmp/epubcheck.zip \
    && unzip -q /tmp/epubcheck.zip -d /epubcheck \
    && rm /tmp/epubcheck.zip

# Build stage - compile TypeScript
FROM public.ecr.aws/docker/library/node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293 AS builder
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
FROM public.ecr.aws/docker/library/node:20-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS production
WORKDIR /app

# Install system dependencies (single layer, sorted for cache efficiency)
# Pandoc is installed from GitHub releases to pin version 3.1.3 (matching local dev)
# instead of the Debian apt package which ships an older 2.17.x version.
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    default-jre-headless \
    ghostscript \
    imagemagick \
    openssl \
    poppler-utils \
    postgresql-client \
    unzip \
    wget \
    && PANDOC_ARCH="$(dpkg --print-architecture)" \
    && wget -qO /tmp/pandoc.deb "https://github.com/jgm/pandoc/releases/download/3.1.3/pandoc-3.1.3-1-${PANDOC_ARCH}.deb" \
    && if [ "$PANDOC_ARCH" = "amd64" ]; then \
         echo "caa7e0410f9e2cb1da2eb8db13cc97b5548fe455985e2c944e3929d22f99bcdc  /tmp/pandoc.deb" | sha256sum -c -; \
       elif [ "$PANDOC_ARCH" = "arm64" ]; then \
         echo "b93cc370f2bf5e360aa2aa72019eda8aaf374dfff125bebf950470b22f7ac7e4  /tmp/pandoc.deb" | sha256sum -c -; \
       else echo "Unsupported architecture: $PANDOC_ARCH" && exit 1; fi \
    && dpkg -i /tmp/pandoc.deb \
    && rm /tmp/pandoc.deb \
    && apt-get purge -y wget && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd -g 1001 nodejs && useradd -u 1001 -g nodejs nodejs

# Install veraPDF CLI (PDF/UA validator — Matterhorn coverage Step 4)
# Note: default-jre-headless is already installed in the apt-get layer above.
# Installs GUI + *nix Scripts + Validation model packs (~18 MB of JARs and scripts).
COPY scripts/install-verapdf.sh /tmp/install-verapdf.sh
RUN bash /tmp/install-verapdf.sh && rm /tmp/install-verapdf.sh

# Install pdfa11y CLI (second free/open PDF/UA validator — Matterhorn coverage Step 6)
# A single static Go binary, no JVM/installer needed.
COPY scripts/install-pdfa11y.sh /tmp/install-pdfa11y.sh
RUN bash /tmp/install-pdfa11y.sh && rm /tmp/install-pdfa11y.sh

# Copy EPUBCheck from download stage (cached)
COPY --from=epubcheck /epubcheck/epubcheck-5.1.0 /app/lib/epubcheck/epubcheck-5.1.0

# Copy compiled code and dependencies
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/src/data ./dist/data
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package*.json ./

# Copy operational scripts (spot-check, backfills, etc.)
COPY scripts/spot-check-ecs.js ./scripts/
COPY scripts/backfill-empty-pages.js ./scripts/
COPY scripts/export-pikepdf-spike-bundle.js ./scripts/

# Rebuild native modules for Debian (sharp, prisma) and set permissions
RUN npm rebuild sharp --platform=linux --arch=x64 \
    && npx prisma generate \
    && chown -R nodejs:nodejs /app/lib /app/node_modules/.prisma

ARG COMMIT_SHA=unknown
ENV EPUBCHECK_PATH=/app/lib/epubcheck/epubcheck-5.1.0/epubcheck.jar
ENV VERAPDF_PATH=/opt/verapdf/verapdf
ENV PDFA11Y_PATH=/opt/pdfa11y/pdfa11y
ENV NODE_ENV=production
ENV PORT=3000
ENV COMMIT_SHA=$COMMIT_SHA

USER nodejs
EXPOSE 3000

# Health checks with generous start period to avoid premature unhealthy status
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

CMD ["node", "dist/index.js"]
