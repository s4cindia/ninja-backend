#!/bin/bash
# Setup EPUBCheck for EPUB validation

EPUBCHECK_VERSION="5.1.0"
INSTALL_DIR="lib/epubcheck"

echo "Setting up EPUBCheck ${EPUBCHECK_VERSION}..."

if ! command -v java &> /dev/null; then
    echo "ERROR: Java is required but not installed."
    exit 1
fi

mkdir -p "${INSTALL_DIR}"
cd "${INSTALL_DIR}"

if [ ! -f "epubcheck-${EPUBCHECK_VERSION}/epubcheck.jar" ]; then
    echo "Downloading EPUBCheck..."
    curl -L "https://github.com/w3c/epubcheck/releases/download/v${EPUBCHECK_VERSION}/epubcheck-${EPUBCHECK_VERSION}.zip" -o epubcheck.zip
    unzip -o epubcheck.zip
    rm epubcheck.zip
    echo "EPUBCheck installed successfully!"
else
    echo "EPUBCheck already installed."
fi

java -jar "epubcheck-${EPUBCHECK_VERSION}/epubcheck.jar" --version

echo ""
echo "Add to your .env:"
echo "EPUBCHECK_PATH=$(pwd)/epubcheck-${EPUBCHECK_VERSION}/epubcheck.jar"
