# syntax=docker/dockerfile:1.4

# ─── Stage 1: build the uber-jar with Maven + JDK 17 ───────────────────
FROM maven:3.9-eclipse-temurin-17 AS builder
WORKDIR /build

# Cache deps first (pom.xml-only layer changes rarely).
COPY pom.xml .
RUN mvn -B -q dependency:go-offline

# Compile + package.
COPY src ./src
RUN mvn -B -q -DskipTests package
# Output JAR ends up at /build/target/pdfbox-write-spike.jar.

# ─── Stage 2: runtime image (JRE + veraPDF + the JAR) ──────────────────
FROM eclipse-temurin:17-jre-jammy AS runtime
WORKDIR /app

# Install minimal runtime utilities + AWS CLI (used by entrypoint.sh
# when running as an ECS one-shot that ships results back to S3).
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        unzip \
        zip \
        python3 \
    && curl -fsSL "https://awscli.amazonaws.com/awscli-exe-linux-x86_64.zip" -o /tmp/aws.zip \
    && unzip -q /tmp/aws.zip -d /tmp \
    && /tmp/aws/install \
    && rm -rf /tmp/aws /tmp/aws.zip \
    && rm -rf /var/lib/apt/lists/*

# veraPDF — aligned with scripts/install-verapdf.sh in the main backend
# image: use the rolling installer URL and the bundled verapdf-install
# shell wrapper (rather than calling the IzPack jar directly), so panel
# IDs and pack indices stay in sync with the installer's own assumptions.
COPY verapdf-auto-install.xml /tmp/verapdf-auto-install.xml
RUN set -eux \
    && curl -fsSL --retry 3 "https://software.verapdf.org/rel/verapdf-installer.zip" -o /tmp/verapdf.zip \
    && unzip -q /tmp/verapdf.zip -d /tmp/verapdf-installer \
    && VERAPDF_DIR=$(ls -d /tmp/verapdf-installer/verapdf-greenfield-*/ | head -1) \
    && test -n "$VERAPDF_DIR" || { echo "verapdf-greenfield-* dir not found in installer zip"; find /tmp/verapdf-installer -maxdepth 2 -type d; exit 1; } \
    && "$VERAPDF_DIR/verapdf-install" /tmp/verapdf-auto-install.xml \
    && /opt/verapdf/verapdf --version \
    && rm -rf /tmp/verapdf-installer /tmp/verapdf.zip /tmp/verapdf-auto-install.xml

ENV VERAPDF_PATH=/opt/verapdf/verapdf

# Copy the JAR from the build stage.
COPY --from=builder /build/target/pdfbox-write-spike.jar /app/pdfbox-write-spike.jar

# Entrypoint: download bundle from S3 if BUNDLE_S3_URI is set; run the
# spike; optionally upload the report back to S3 if RESULTS_S3_URI is set.
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

WORKDIR /work
ENTRYPOINT ["/app/entrypoint.sh"]
