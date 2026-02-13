# Context Status Script - Developer Guide

## Overview

The Context Status Script is an on-demand diagnostic tool that helps you quickly understand your current development context when working with Claude Code. Instead of manually running multiple commands to check your environment, you get a comprehensive status report with a single command.

## What It Does

The status script provides instant visibility into:

### Repository Context
- Current branch and last commit
- Number of uncommitted changes
- Sprint detection (automatically identifies `feature/sprint-X` branches)

### Infrastructure Status
- **Backend:** PostgreSQL and Redis container status
- **Backend:** Pending Prisma migrations
- **Frontend:** Dev server status (port 5173)
- **Frontend:** Backend API reachability

### Smart Work Context Detection
Analyzes your recently changed files and automatically suggests relevant documentation:

**Backend Examples:**
```bash
💡 Database work detected
   📄 docs/DATABASE.md
   ⚠️  Review migration SQL before deploying!

💡 API development context
   📄 docs/API-PATTERNS.md

💡 Testing context
   📄 docs/TESTING.md
```

**Frontend Examples:**
```bash
💡 PDF UI context
   📄 docs/COMPONENTS.md (reuse strategy)
   📄 Reference: src/components/epub/

💡 Data fetching context
   📄 docs/DATA-FETCHING.md
```

## How to Use

### Primary Method: npm Script

```bash
# Backend
cd ninja-backend
npm run status

# Frontend
cd ninja-frontend
npm run status
```

### Alternative: Direct Execution

```bash
# Backend
bash .claude/bin/ninja-status.sh

# Frontend
bash .claude/bin/ninja-status.sh
```

### Optional: Git Alias (Per Developer)

Add to your `~/.gitconfig`:

```ini
[alias]
    ninja-status = "!bash .claude/bin/ninja-status.sh"
```

Then run from any repo:
```bash
git ninja-status
```

## Output Examples

### Backend Output
```
🥷 Ninja Backend Status
────────────────────────
📦 Repo: ninja-backend
📍 Branch: feature/sprint-3
   Last: 9954b86 fix: propagate quality check hook failures
✅ PostgreSQL: Running
✅ Redis: Running

💡 Database work detected
   📄 docs/DATABASE.md
   ⚠️  Review migration SQL before deploying!

🏃 Active sprint branch: sprint-3
📝 Uncommitted changes: 5 file(s)
────────────────────────
```

### Frontend Output
```
🥷 Ninja Frontend Status
────────────────────────
📦 Repo: ninja-frontend
📍 Branch: feature/visual-comparison
   Last: 1f9c81c fix: add comparison components
✅ Dev server: Running (port 5173)
✅ Backend API: Connected (http://localhost:3000)

💡 Visual comparison context
   📄 docs/COMPONENTS.md

📝 Uncommitted changes: 12 file(s)
────────────────────────
```

## Optional: Automatic Status on Session Start

A lightweight hook can display one-line status when you start a Claude Code session. **This is opt-in and disabled by default.**

### Understanding the Session-Start Hook

#### What "Session Start" Means

Every time you launch Claude Code (open the CLI and start a conversation), the **SessionStart hook** runs automatically BEFORE Claude responds to you.

**Example:**
```bash
# You open your terminal and type:
$ claude code

# If SessionStart hook is enabled, it runs first:
🥷 ninja-backend | 📍 feature/sprint-3 | 📝 5 uncommitted | Full status: npm run status

# Then Claude responds:
Claude: Hello! How can I help you today?
```

#### Two-Layer Opt-In Design

**Why Two Layers?**

The hook uses a two-layer design to balance team consistency with individual preference:

**Layer 1: Repository Configuration (Team-Wide)**
- Hook script exists in `.claude/hooks/session-start.sh` (committed to git)
- Hook configuration in `.claude/settings.json` (committed to git)
- Available for all team members

**Layer 2: Personal Opt-In File (Individual Choice)**
- Hook script checks for `.claude/.enable-status` file
- If file doesn't exist → hook exits silently (no output)
- If file exists → hook displays one-line status
- **File is NOT committed to git** (in `.gitignore`)

This means:
- ✅ Script is in the repo (everyone has access)
- ✅ Each developer chooses whether to enable it
- ✅ No merge conflicts over preferences
- ✅ No forced behavior on the team

### Enable (Per Developer, Per Repo)

Each developer can enable the hook independently:

```bash
# In the repo where you want automatic status:
cd ninja-backend
touch .claude/.enable-status
```

When enabled, you'll see:
```
🥷 ninja-backend | 📍 feature/sprint-3 | 📝 5 uncommitted | Full status: npm run status
```

**Performance:**
- Cached for 1 hour (won't run repeatedly in the same session)
- ~200ms execution time
- Non-blocking (runs in background)

### Disable

```bash
rm .claude/.enable-status
```

### Personal Preference Examples

#### Developer Alice: Wants auto-status in backend only

```bash
cd ninja-backend
touch .claude/.enable-status     # ✅ Enabled here

cd ../ninja-frontend
# No .enable-status file         # ❌ Disabled here
```

**Alice's backend sessions:**
```bash
$ claude code
🥷 ninja-backend | 📍 main | 📝 2 uncommitted | Full status: npm run status
Claude: Hello!
```

**Alice's frontend sessions:**
```bash
$ claude code
Claude: Hello!
```

#### Developer Bob: Doesn't want auto-status anywhere

```bash
# Bob simply never creates .claude/.enable-status
# All his sessions start immediately without status
```

**Bob's sessions (all repos):**
```bash
$ claude code
Claude: Hello!
```

#### Developer Carol: Wants it everywhere

```bash
cd ninja-backend
touch .claude/.enable-status

cd ../ninja-frontend
touch .claude/.enable-status
```

**Carol's sessions (all repos):**
```bash
$ claude code
🥷 ninja-backend | 📍 main | Full status: npm run status
Claude: Hello!
```

### Comparison: Manual vs Automatic

#### Full Status (Manual - Always Available)

```bash
$ npm run status

🥷 Ninja Backend Status
────────────────────────
📦 Repo: ninja-backend
📍 Branch: feature/sprint-3
   Last: 9954b86 fix: propagate quality check hook failures
✅ PostgreSQL: Running
✅ Redis: Running

💡 Database work detected
   📄 docs/DATABASE.md
   ⚠️  Review migration SQL before deploying!

🏃 Active sprint branch: sprint-3
📝 Uncommitted changes: 5 file(s)
────────────────────────
```

**When to use:** When you want comprehensive details about your environment

#### Session-Start Hook (Automatic - Opt-In)

```bash
$ claude code

🥷 ninja-backend | 📍 feature/sprint-3 | 📝 5 uncommitted | Full status: npm run status

Claude: Hello! How can I help?
```

**When to use:** Quick context reminder at session start without running a command

**Key difference:** Session-start shows a one-line summary and reminds you that `npm run status` is available for full details.

### Recommendation for New Users

1. **Try the full status first:**
   ```bash
   npm run status
   ```

2. **If you like it, try the auto-status:**
   ```bash
   touch .claude/.enable-status
   claude code  # See if you like the automatic reminder
   ```

3. **Keep or disable based on preference:**
   ```bash
   # Like it? Keep the file
   # Don't like it? Remove it:
   rm .claude/.enable-status
   ```

4. **No pressure either way** - Both approaches give you access to context, just different UX

## Developer Benefits

### 1. **Faster Context Switching**
When resuming work after a break or switching between repos:
```bash
npm run status  # Instant orientation
```

Instead of:
```bash
git status
git log -1
docker ps
git branch
git diff --name-only HEAD
# ... etc
```

### 2. **Reduced Errors**
- **Catches forgotten migrations** before you start coding
- **Detects infrastructure issues** (DB not running) immediately
- **Shows uncommitted work** so you don't accidentally start on dirty state

### 3. **Better Claude Code Sessions**
- **Context-aware documentation hints** guide Claude to the right docs
- **Sprint detection** helps Claude understand your current work phase
- **Change detection** helps Claude see what you're actively working on

### 4. **Onboarding Aid**
New developers or rotating team members can run `npm run status` to understand:
- Which repo they're in
- What infrastructure needs to be running
- Where to find relevant documentation
- What work is in progress

### 5. **Multi-Repo Workflow Support**
When working across `ninja-backend` and `ninja-frontend`:
```bash
# Quick sanity check before context switching
cd ../ninja-backend && npm run status
cd ../ninja-frontend && npm run status
```

## Technical Details

### File Locations
```
ninja-backend/
├── .claude/
│   ├── bin/
│   │   └── ninja-status.sh       # Full status script
│   └── hooks/
│       └── session-start.sh      # Optional lightweight hook
└── package.json                   # "status" script

ninja-frontend/
└── (same structure)
```

### Context Detection Logic

The script uses **cascading git diff fallback** to detect changed files:

1. `git diff --name-only HEAD` (uncommitted changes)
2. `git diff --cached --name-only` (staged changes)
3. `git diff --name-only HEAD~1` (last commit)
4. `git ls-files -m` (modified files)
5. Empty string (no changes detected)

This ensures the script works in various scenarios:
- New repos with no commits
- Detached HEAD state
- Shallow clones
- Clean working tree

### Cross-Platform Compatibility

**Tested on:**
- ✅ Windows MSYS bash (Git Bash)
- ✅ macOS (BSD utilities)
- ✅ Linux (GNU utilities)

**POSIX-compliant:**
- Uses `grep -o` instead of `grep -P` (Perl regex)
- Supports both GNU `stat -c%Y` and BSD `stat -f%m`
- Gracefully handles missing commands (`lsof` on Windows)

### Performance

| Operation | Time |
|-----------|------|
| Full status script | ~800ms |
| Session-start hook (cached) | ~50ms |
| Session-start hook (first run) | ~200ms |

## Privacy & Security

- ✅ **No data sent to external services**
- ✅ **No secrets logged or displayed**
- ✅ **Runs entirely locally**
- ✅ **Opt-in for automatic hook**
- ✅ **`.claude/.enable-status` not committed to git** (personal preference)

## Troubleshooting

### "PostgreSQL: Not running"
```bash
cd ninja-backend
docker-compose up -d
```

### "Backend API: Not reachable"
```bash
cd ninja-backend
npm run dev
```

### "Prisma: X pending migrations"
```bash
cd ninja-backend
npx prisma migrate dev
```

### Script not found
```bash
# Ensure scripts are executable
chmod +x .claude/bin/ninja-status.sh
chmod +x .claude/hooks/session-start.sh
```

### Session hook not running
```bash
# Check if opt-in file exists
ls -la .claude/.enable-status

# If exists, check cache age
ls -lt /tmp/claude-ninja-*
```

## Comparison with Other Approaches

### Before: Manual Context Gathering
```bash
# ~60 seconds, 8+ commands
pwd
git status
git branch
git log -1
docker ps
npx prisma migrate status
git diff --name-only HEAD
# ... then find relevant docs manually
```

### After: Automated Context
```bash
# ~1 second, 1 command
npm run status
```

**Time saved:** ~59 seconds per context check
**Typical daily context checks:** 10-15 times
**Daily time saved:** ~10-15 minutes

## Future Enhancements

Potential additions based on developer feedback:

- [ ] Test suite status (last run, pass/fail count)
- [ ] npm/node version mismatch detection
- [ ] Branch staleness warnings (behind main by X commits)
- [ ] Uncommitted changes age (how long since last commit)
- [ ] Claude Code session history (last 3 interactions)

## Feedback

Have suggestions for improving the status script?
- Open an issue: `gh issue create`
- Submit a PR: Update `.claude/bin/ninja-status.sh`
- Discuss with team: Slack #ninja-dev channel

---

**Version:** 1.0.0
**Last updated:** February 14, 2026
**Maintainer:** Development Team
