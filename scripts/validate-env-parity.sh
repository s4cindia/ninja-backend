#!/bin/bash
# Environment Parity Validation Script
# Ensures Replit (replit.nix) and Docker (Dockerfile) environments match
#
# This script verifies that packages in the Replit development environment
# match those in the Docker production environment to prevent "works on my
# machine" issues.

set -e

echo "=========================================="
echo "Environment Parity Validation"
echo "=========================================="
echo ""

# Define expected package mappings
# Format: ["nix_package"]="docker_package"
declare -A PARITY_MAP=(
    ["nodejs_20"]="node:20"
    ["postgresql_15"]="postgresql-client"
    ["poppler_utils"]="poppler-utils"
    ["ghostscript"]="ghostscript"
    ["imagemagick"]="imagemagick"
    ["openjdk17"]="openjdk-17"
    ["pandoc"]="pandoc"
)

ERRORS=0
WARNINGS=0

# Check if required files exist
echo "Checking required files..."
echo "------------------------------------------"

if [ ! -f "replit.nix" ]; then
    echo "❌ ERROR: replit.nix not found"
    exit 1
else
    echo "✅ replit.nix found"
fi

if [ ! -f "Dockerfile" ]; then
    echo "❌ ERROR: Dockerfile not found"
    exit 1
else
    echo "✅ Dockerfile found"
fi

echo ""
echo "Checking package parity..."
echo "------------------------------------------"

for nix_pkg in "${!PARITY_MAP[@]}"; do
    docker_pkg="${PARITY_MAP[$nix_pkg]}"

    # Check if package exists in replit.nix
    if grep -q "$nix_pkg" replit.nix; then
        NIX_FOUND="✓"
    else
        NIX_FOUND="✗"
    fi

    # Check if package exists in Dockerfile
    if grep -q "$docker_pkg" Dockerfile; then
        DOCKER_FOUND="✓"
    else
        DOCKER_FOUND="✗"
    fi

    # Report status
    if [ "$NIX_FOUND" = "✓" ] && [ "$DOCKER_FOUND" = "✓" ]; then
        echo "✅ $nix_pkg ↔ $docker_pkg: MATCHED"
    elif [ "$NIX_FOUND" = "✓" ] && [ "$DOCKER_FOUND" = "✗" ]; then
        echo "❌ $nix_pkg found in replit.nix but $docker_pkg MISSING in Dockerfile"
        ((ERRORS++))
    elif [ "$NIX_FOUND" = "✗" ] && [ "$DOCKER_FOUND" = "✓" ]; then
        echo "⚠️  $docker_pkg found in Dockerfile but $nix_pkg missing in replit.nix"
        ((WARNINGS++))
    else
        echo "⚪ $nix_pkg / $docker_pkg: Not used in either environment"
    fi
done

# Check Node.js version consistency
echo ""
echo "Checking Node.js version consistency..."
echo "------------------------------------------"

NIX_NODE_VERSION=$(grep -oP 'nodejs_\K[0-9]+' replit.nix 2>/dev/null | head -1 || echo "")
DOCKER_NODE_VERSION=$(grep -oP 'node:\K[0-9]+' Dockerfile 2>/dev/null | head -1 || echo "")

if [ -n "$NIX_NODE_VERSION" ] && [ -n "$DOCKER_NODE_VERSION" ]; then
    if [ "$NIX_NODE_VERSION" = "$DOCKER_NODE_VERSION" ]; then
        echo "✅ Node.js version: v$NIX_NODE_VERSION (matched)"
    else
        echo "❌ Node.js version mismatch: replit.nix=v$NIX_NODE_VERSION, Dockerfile=v$DOCKER_NODE_VERSION"
        ((ERRORS++))
    fi
else
    echo "⚠️  Could not determine Node.js versions"
    ((WARNINGS++))
fi

# Check Java version consistency
echo ""
echo "Checking Java version consistency..."
echo "------------------------------------------"

NIX_JAVA_VERSION=$(grep -oP 'openjdk\K[0-9]+' replit.nix 2>/dev/null | head -1 || echo "")
DOCKER_JAVA_VERSION=$(grep -oP 'openjdk-\K[0-9]+' Dockerfile 2>/dev/null | head -1 || echo "")

if [ -n "$NIX_JAVA_VERSION" ] && [ -n "$DOCKER_JAVA_VERSION" ]; then
    if [ "$NIX_JAVA_VERSION" = "$DOCKER_JAVA_VERSION" ]; then
        echo "✅ Java version: v$NIX_JAVA_VERSION (matched)"
    else
        echo "❌ Java version mismatch: replit.nix=v$NIX_JAVA_VERSION, Dockerfile=v$DOCKER_JAVA_VERSION"
        ((ERRORS++))
    fi
elif [ -z "$NIX_JAVA_VERSION" ] && [ -z "$DOCKER_JAVA_VERSION" ]; then
    echo "⚪ Java not configured in either environment"
else
    echo "⚠️  Java configured in only one environment"
    ((WARNINGS++))
fi

# Summary
echo ""
echo "=========================================="
echo "SUMMARY"
echo "=========================================="
echo "Errors:   $ERRORS"
echo "Warnings: $WARNINGS"
echo ""

if [ $ERRORS -gt 0 ]; then
    echo "❌ VALIDATION FAILED"
    echo ""
    echo "How to fix:"
    echo "1. Add missing packages to the appropriate file"
    echo "2. Ensure version numbers match between replit.nix and Dockerfile"
    echo "3. Re-run this validation"
    exit 1
else
    if [ $WARNINGS -gt 0 ]; then
        echo "⚠️  VALIDATION PASSED WITH WARNINGS"
        echo "Review warnings above to ensure they are intentional."
    else
        echo "✅ VALIDATION PASSED"
        echo "Replit and Docker environments are in sync."
    fi
    exit 0
fi
