#!/usr/bin/env bash
# Install veraPDF CLI to /opt/verapdf
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
# To update veraPDF: change VERAPDF_VERSION below and rebuild the image.
# Verify the release exists at:
#   https://github.com/veraPDF/veraPDF-apps/releases/tag/v${VERAPDF_VERSION}

set -euxo pipefail

VERAPDF_VERSION="1.26.2"
VERAPDF_ZIP_URL="https://github.com/veraPDF/veraPDF-apps/releases/download/v${VERAPDF_VERSION}/verapdf-${VERAPDF_VERSION}-bin.zip"
INSTALL_DIR="/opt/verapdf"

echo "==> Downloading veraPDF ${VERAPDF_VERSION}..."
curl -fsSL --retry 3 "${VERAPDF_ZIP_URL}" -o /tmp/verapdf.zip

echo "==> Extracting to ${INSTALL_DIR}..."
# The ZIP extracts a top-level 'verapdf/' directory directly to the target
unzip -q /tmp/verapdf.zip -d /opt/
# unzip creates /opt/verapdf/ containing the verapdf shell script
rm /tmp/verapdf.zip

chmod +x "${INSTALL_DIR}/verapdf"

echo "==> Smoke test..."
"${INSTALL_DIR}/verapdf" --version

echo "==> veraPDF ${VERAPDF_VERSION} installed at ${INSTALL_DIR}/verapdf"
