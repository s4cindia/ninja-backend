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

# veraPDF — installed from the same official tarball the main backend
# image uses (matches /opt/verapdf/verapdf layout). The argument-style
# installer needs xvfb/headless awareness, so use the package's own
# installer-with-script payload.
RUN mkdir -p /opt/verapdf \
    && curl -fsSL "https://software.verapdf.org/rel/1.26/verapdf-greenfield-1.26.2-installer.zip" -o /tmp/verapdf.zip \
    && unzip -q /tmp/verapdf.zip -d /tmp/verapdf-installer \
    && INSTALLER_JAR=$(find /tmp/verapdf-installer -name 'verapdf-installer.jar' | head -1) \
    && cat > /tmp/auto-install.xml <<'EOF'
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<AutomatedInstallation langpack="eng">
    <com.izforge.izpack.panels.target.TargetPanel id="install.dir">
        <installpath>/opt/verapdf</installpath>
    </com.izforge.izpack.panels.target.TargetPanel>
    <com.izforge.izpack.panels.packs.PacksPanel id="sdk.pack.select">
        <pack index="0" name="veraPDF GUI" selected="true"/>
        <pack index="1" name="veraPDF Mac and *nix Scripts" selected="true"/>
        <pack index="2" name="veraPDF Validation model" selected="true"/>
        <pack index="3" name="veraPDF Documentation" selected="false"/>
        <pack index="4" name="veraPDF Sample Plugins" selected="false"/>
    </com.izforge.izpack.panels.packs.PacksPanel>
    <com.izforge.izpack.panels.install.InstallPanel id="install"/>
    <com.izforge.izpack.panels.finish.FinishPanel id="finish"/>
</AutomatedInstallation>
EOF
    && java -jar "$INSTALLER_JAR" /tmp/auto-install.xml \
    && rm -rf /tmp/verapdf-installer /tmp/verapdf.zip /tmp/auto-install.xml

ENV VERAPDF_PATH=/opt/verapdf/verapdf

# Copy the JAR from the build stage.
COPY --from=builder /build/target/pdfbox-write-spike.jar /app/pdfbox-write-spike.jar

# Entrypoint: download bundle from S3 if BUNDLE_S3_URI is set; run the
# spike; optionally upload the report back to S3 if RESULTS_S3_URI is set.
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

WORKDIR /work
ENTRYPOINT ["/app/entrypoint.sh"]
