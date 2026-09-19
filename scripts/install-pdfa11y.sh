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
# exact version's real JSON output. To upgrade, bump PDFA11Y_VERSION AND
# both SHA-256 checksums below (re-download and `sha256sum` the new
# release's tarballs) AND re-validate every mapping entry against the new
# version's real output before merging.
#
# CodeRabbit findings on PR #577, both confirmed real and fixed here:
#   - only the amd64 asset was downloaded, unconditionally, matching
#     neither the Dockerfile's own existing multi-arch Pandoc install
#     step nor pdfa11y's own published arm64 release asset
#   - the archive was extracted and executed with no integrity check
#     (CWE-494) -- pinned SHA-256 checksums added, verified before tar runs

set -euxo pipefail

PDFA11Y_VERSION="v0.0.11"
INSTALL_DIR="/opt/pdfa11y"

ARCH="$(dpkg --print-architecture)"
if [ "${ARCH}" = "amd64" ]; then
  PDFA11Y_ASSET="pdfa11y-linux-amd64.tar.gz"
  PDFA11Y_SHA256="6fa5add80366170d7ea01cf5e26128d8a849900acba15a84f01e6da39e779747"
elif [ "${ARCH}" = "arm64" ]; then
  PDFA11Y_ASSET="pdfa11y-linux-arm64.tar.gz"
  PDFA11Y_SHA256="afd7df73c3da1b4819d98615f1047d4168ed41a0dbcef57fea165d2a573b4ae2"
else
  echo "Unsupported architecture: ${ARCH}" >&2
  exit 1
fi
PDFA11Y_URL="https://github.com/speedata/pdfa11y/releases/download/${PDFA11Y_VERSION}/${PDFA11Y_ASSET}"

echo "==> Downloading pdfa11y ${PDFA11Y_VERSION} (${ARCH})..."
mkdir -p "${INSTALL_DIR}"
curl -fsSL --retry 3 "${PDFA11Y_URL}" -o /tmp/pdfa11y.tar.gz

echo "==> Verifying checksum..."
echo "${PDFA11Y_SHA256}  /tmp/pdfa11y.tar.gz" | sha256sum -c -

echo "==> Extracting..."
tar -xzf /tmp/pdfa11y.tar.gz -C /tmp
rm /tmp/pdfa11y.tar.gz

# The tarball extracts to a versioned directory containing the binary.
PDFA11Y_BIN=$(find /tmp -maxdepth 2 -type f -name 'pdfa11y' | head -1)
if [ -z "${PDFA11Y_BIN}" ]; then
  echo "ERROR: pdfa11y binary not found after extracting release tarball" >&2
  exit 1
fi
PDFA11Y_EXTRACT_DIR=$(dirname "${PDFA11Y_BIN}")
mv "${PDFA11Y_BIN}" "${INSTALL_DIR}/pdfa11y"
chmod +x "${INSTALL_DIR}/pdfa11y"
rm -rf "${PDFA11Y_EXTRACT_DIR}"

echo "==> Smoke test..."
"${INSTALL_DIR}/pdfa11y" --version

echo "==> pdfa11y ${PDFA11Y_VERSION} (${ARCH}) installed at ${INSTALL_DIR}/pdfa11y"
