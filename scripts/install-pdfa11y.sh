#!/usr/bin/env bash
# Install pdfa11y CLI to /opt/pdfa11y from its GitHub release tarball.
#
# Used by the Ninja Backend PDF/UA accessibility validator as a second,
# free/open validator alongside veraPDF (see install-verapdf.sh).
# Matterhorn Coverage Plan — Step 6 (pdfa11y integration)
#
# Unlike veraPDF, pdfa11y ships as a single static Go binary with no JVM
# and no installer — just download, extract, chmod +x.
#
# Result: /opt/pdfa11y/pdfa11y (executable binary)
#
# Pinned to a specific release (not "latest") so a Docker rebuild never
# silently picks up a new, unvalidated version — the mapping table in
# src/data/pdfa11y-matterhorn.map.ts was built and tested against this
# exact version's real JSON output. To upgrade, bump PDFA11Y_VERSION here
# AND re-validate every mapping entry against the new version's real
# output before merging.

set -euxo pipefail

PDFA11Y_VERSION="v0.0.11"
PDFA11Y_URL="https://github.com/speedata/pdfa11y/releases/download/${PDFA11Y_VERSION}/pdfa11y-linux-amd64.tar.gz"
INSTALL_DIR="/opt/pdfa11y"

echo "==> Downloading pdfa11y ${PDFA11Y_VERSION}..."
mkdir -p "${INSTALL_DIR}"
curl -fsSL --retry 3 "${PDFA11Y_URL}" -o /tmp/pdfa11y.tar.gz

echo "==> Extracting..."
tar -xzf /tmp/pdfa11y.tar.gz -C /tmp
rm /tmp/pdfa11y.tar.gz

# The tarball extracts to a versioned directory containing the binary.
PDFA11Y_BIN=$(find /tmp -maxdepth 2 -type f -name 'pdfa11y' | head -1)
if [ -z "${PDFA11Y_BIN}" ]; then
  echo "ERROR: pdfa11y binary not found after extracting release tarball" >&2
  exit 1
fi
mv "${PDFA11Y_BIN}" "${INSTALL_DIR}/pdfa11y"
chmod +x "${INSTALL_DIR}/pdfa11y"
rm -rf /tmp/pdfa11y-linux-amd64

echo "==> Smoke test..."
"${INSTALL_DIR}/pdfa11y" --version

echo "==> pdfa11y ${PDFA11Y_VERSION} installed at ${INSTALL_DIR}/pdfa11y"
