#!/bin/bash
# ============================================================================
# Desktop Notification
# ============================================================================
# Sends a desktop notification when Claude Code needs your attention.
# Auto-detects your OS and uses the appropriate notification tool.
# ============================================================================

TITLE="Claude Code"
MESSAGE="Awaiting your input"

# ── Detect OS and send notification ─────────────────────────────────────────
case "$(uname -s)" in
  Darwin)
    # macOS
    osascript -e "display notification \"$MESSAGE\" with title \"$TITLE\"" 2>/dev/null
    ;;
  Linux)
    # Linux with notify-send (most desktop environments)
    if command -v notify-send &> /dev/null; then
      notify-send "$TITLE" "$MESSAGE" 2>/dev/null
    fi
    ;;
  MINGW*|MSYS*|CYGWIN*)
    # Windows (Git Bash / WSL)
    if command -v powershell.exe &> /dev/null; then
      powershell.exe -Command "[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); [System.Windows.Forms.MessageBox]::Show('$MESSAGE','$TITLE')" 2>/dev/null
    fi
    ;;
esac

exit 0
