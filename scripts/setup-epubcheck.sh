#!/bin/bash
# Setup EPUBCheck for EPUB validation

# Enable strict error handling
set -e

EPUBCHECK_VERSION="5.1.0"
INSTALL_DIR="lib/epubcheck"

echo "Setting up EPUBCheck ${EPUBCHECK_VERSION}..."

if ! command -v java &> /dev/null; then
    echo "ERROR: Java is required but not installed." >&2
    exit 1
fi

mkdir -p "${INSTALL_DIR}"

# Validate cd command success
if ! cd "${INSTALL_DIR}"; then
    echo "ERROR: Failed to change directory to ${INSTALL_DIR}" >&2
    exit 1
fi

if [ ! -f "epubcheck-${EPUBCHECK_VERSION}/epubcheck.jar" ]; then
    echo "Downloading EPUBCheck..."

    # Download with --fail flag to force HTTP error exits
    if ! curl -fL "https://github.com/w3c/epubcheck/releases/download/v${EPUBCHECK_VERSION}/epubcheck-${EPUBCHECK_VERSION}.zip" -o epubcheck.zip; then
        echo "ERROR: Failed to download EPUBCheck from GitHub" >&2
        exit 1
    fi

    # Extract and check exit status
    if ! unzip -o epubcheck.zip; then
        echo "ERROR: Failed to extract epubcheck.zip" >&2
        rm -f epubcheck.zip
        exit 1
    fi

    rm epubcheck.zip
    echo "EPUBCheck installed successfully!"
else
    echo "EPUBCheck already installed."
fi

java -jar "epubcheck-${EPUBCHECK_VERSION}/epubcheck.jar" --version

echo ""
echo "Add to your .env:"
echo "EPUBCHECK_PATH=$(pwd)/epubcheck-${EPUBCHECK_VERSION}/epubcheck.jar"
