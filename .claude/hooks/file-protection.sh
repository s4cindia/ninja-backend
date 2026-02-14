#!/bin/bash
# ============================================================================
# Sensitive File Protection
# ============================================================================
# Blocks Claude from modifying files that should not be touched:
#   - .env files (secrets)
#   - Lock files (package-lock.json, yarn.lock)
#   - .git/ internals
#   - CI/CD configs (optional — remove if Claude should edit these)
#
# Add or remove patterns in PROTECTED_PATTERNS to customize.
# ============================================================================

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // empty')

if [ -z "$FILE_PATH" ] || [ "$FILE_PATH" = "null" ]; then
  exit 0
fi

# ── Protected file patterns ─────────────────────────────────────────────────
# Add patterns here. Each is checked as a substring match.
PROTECTED_PATTERNS=(
  ".env"
  ".env.local"
  ".env.production"
  ".env.development"
  "package-lock.json"
  "yarn.lock"
  "pnpm-lock.yaml"
  ".git/"
  ".github/workflows/"
)

for pattern in "${PROTECTED_PATTERNS[@]}"; do
  if echo "$FILE_PATH" | grep -qF "$pattern"; then
    echo "🔒 Protected file: '$FILE_PATH' matches pattern '$pattern'" >&2
    echo "" >&2
    echo "This file is protected from automated edits." >&2
    echo "If you need to modify it, please do so manually." >&2
    exit 2
  fi
done

exit 0
