#!/bin/bash
# ============================================================================
# Command Audit Log
# ============================================================================
# Logs every bash command Claude executes to .claude/audit-log.jsonl
# Useful for debugging, compliance, and understanding what Claude did.
#
# Each entry is a JSON line with timestamp, command, and description.
# ============================================================================

INPUT=$(cat)

COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')
DESCRIPTION=$(echo "$INPUT" | jq -r '.tool_input.description // "No description"')
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"')
TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")

# Skip if no command
if [ -z "$COMMAND" ] || [ "$COMMAND" = "null" ]; then
  exit 0
fi

# Ensure log directory exists
mkdir -p .claude

# Append as JSON line (JSONL format for easy parsing)
jq -n \
  --arg ts "$TIMESTAMP" \
  --arg cmd "$COMMAND" \
  --arg desc "$DESCRIPTION" \
  --arg sid "$SESSION_ID" \
  '{timestamp: $ts, session_id: $sid, command: $cmd, description: $desc}' \
  >> .claude/audit-log.jsonl

exit 0
