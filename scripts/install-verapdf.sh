#!/usr/bin/env bash
# Install veraPDF CLI to /opt/verapdf via the official IzPack installer.
#
# Used by the Ninja Backend PDF/UA accessibility validator.
# Matterhorn Coverage Plan — Step 4 (veraPDF integration)
#
# Requires:
#   - curl    (already present in the production image)
#   - unzip   (already present in the production image)
#   - java    (default-jre-headless, already present in the production image)
#
# Result: /opt/verapdf/verapdf  (executable shell wrapper around the veraPDF JARs)
#
# Distribution: veraPDF publishes a single rolling installer ZIP at
#   https://software.verapdf.org/rel/verapdf-installer.zip
# There are no per-version binary release assets on GitHub.
# Docker layer caching keeps the version stable between builds; to upgrade
# veraPDF, force a rebuild with --no-cache or bust the cache layer manually.

set -euxo pipefail

VERAPDF_INSTALLER_URL="https://software.verapdf.org/rel/verapdf-installer.zip"
INSTALL_DIR="/opt/verapdf"

echo "==> Downloading veraPDF installer..."
curl -fsSL --retry 3 "${VERAPDF_INSTALLER_URL}" -o /tmp/verapdf-installer.zip

echo "==> Extracting installer..."
unzip -q /tmp/verapdf-installer.zip -d /tmp/verapdf-installer/
rm /tmp/verapdf-installer.zip

# Detect the extracted versioned directory (e.g. verapdf-greenfield-1.28.2)
VERAPDF_DIR=$(ls -d /tmp/verapdf-installer/verapdf-greenfield-*/ | head -1)
VERAPDF_VERSION=$(basename "${VERAPDF_DIR}" | sed 's/verapdf-greenfield-//')
echo "==> Installer version: ${VERAPDF_VERSION}"

echo "==> Writing auto-install.xml..."
# Pack names verified from resources/packs/ entries inside the 1.28.2 installer JAR.
# Selected: GUI (core JARs) + *nix Scripts (shell wrapper) + Validation model (PDF/UA rules).
cat > /tmp/verapdf-auto-install.xml << 'EOF'
<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<AutomatedInstallation langpack="eng">
    <com.izforge.izpack.panels.htmlhello.HTMLHelloPanel id="welcome"/>
    <com.izforge.izpack.panels.target.TargetPanel id="install_dir">
        <installpath>/opt/verapdf</installpath>
    </com.izforge.izpack.panels.target.TargetPanel>
    <com.izforge.izpack.panels.packs.PacksPanel id="sdk_pack_select">
        <pack index="0" name="veraPDF GUI" selected="true"/>
        <pack index="1" name="veraPDF Mac and *nix Scripts" selected="true"/>
        <pack index="2" name="veraPDF Batch files" selected="false"/>
        <pack index="3" name="veraPDF Validation model" selected="true"/>
        <pack index="4" name="veraPDF Documentation" selected="false"/>
        <pack index="5" name="veraPDF Sample Plugins" selected="false"/>
    </com.izforge.izpack.panels.packs.PacksPanel>
    <com.izforge.izpack.panels.install.InstallPanel id="install"/>
    <com.izforge.izpack.panels.finish.FinishPanel id="finish"/>
</AutomatedInstallation>
EOF

echo "==> Running silent install to ${INSTALL_DIR}..."
"${VERAPDF_DIR}/verapdf-install" /tmp/verapdf-auto-install.xml

# Clean up installer artifacts
rm -rf /tmp/verapdf-installer/ /tmp/verapdf-auto-install.xml

echo "==> Smoke test..."
"${INSTALL_DIR}/verapdf" --version

echo "==> veraPDF ${VERAPDF_VERSION} installed at ${INSTALL_DIR}/verapdf"
