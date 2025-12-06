# Replit Teams: Comprehensive Guide for Ninja Platform Development

**Version:** 2.1  
**Last Updated:** December 2025  
**Classification:** Internal Use Only

---

## Executive Summary

This guide provides a complete reference for the S4Carlisle India Development Team using Replit Teams for the Ninja Platform rebuild. It synthesizes best practices from multiple sources, addresses critical gotchas, and provides specific guidance for the Ninja project architecture.

**Key Architectural Decisions:**
- **Current Setup:** ninja-backend and ninja-frontend as separate Repls (Multiplayer mode)
- **Recommended Migration:** Convert to Replit Projects for managed forking and isolation
- **Core Principle:** "A Branch isolates your Code, but a Fork isolates your Computer"

---

## Part 1: Introduction to Replit Teams

### What is Replit Teams?

Replit Teams is an enterprise-grade collaborative development platform enabling teams to build, test, and deploy software together in real-time. Unlike traditional development environments requiring complex local setups, Replit provides instant access to fully-configured development environments accessible from any device with a web browser.

### Core Value Propositions

| Feature | Benefit |
|---------|---------|
| Zero-Setup Development | Start coding immediately without installations |
| Real-Time Collaboration | Live cursors and simultaneous editing (Multiplayer) |
| Built-in Infrastructure | Database (Neon PostgreSQL), storage included |
| AI-Powered Assistance | Integrated AI Agent for code generation |
| Enterprise Security | SOC-2 compliance, SAML SSO (Enterprise tier) |

### Teams vs. Enterprise Plans

| Feature | Teams ($40/user/mo) | Enterprise |
|---------|---------------------|------------|
| Pooled Credits | ✓ | ✓ |
| Private Deployments | ✓ | ✓ |
| Replit Projects | ✓ | ✓ |
| Viewer Seats | Up to 50 | Unlimited |
| Role-Based Access Control | ✓ | ✓ |
| SOC-2 Compliance | - | ✓ |
| SAML SSO | - | ✓ |

**Recommendation for S4Carlisle:** Teams plan is sufficient for current needs.

---

## Part 2: The Core Conflict - Multiplayer vs. Git

### Understanding the Architecture

Replit presents a fundamental tension between two different collaboration technologies:

| Aspect | Multiplayer (Live Layer) | Git (History Layer) |
|--------|--------------------------|---------------------|
| Technology | Operational Transformation (OT) | Snapshot-based |
| Change Speed | Instant | Only when committed |
| Scope | Real-time for all users | Isolated until pushed |
| Risk | Syntax errors crash server for everyone | Changes are private |

### The Critical Risk

In Replit, the "Working Directory" is live. There is no local "staging" area private to you. If you edit a file in a shared Repl, your half-finished code runs immediately for everyone.

### Fork vs. Branch: The Runtime Distinction

**This is the most important concept for Ninja development.**

| Feature | Git Branch (Inside one Repl) | Fork (Copy of Repl) |
|---------|------------------------------|---------------------|
| What it isolates | Code history only | Everything: Code, RAM, CPU, Database, Shell |
| Runtime Status | Shared - crash affects everyone | Isolated - crash only affects your fork |
| URL/Endpoints | Shares same *.replit.app URL | Gets new unique URL |
| Database | Shares same database connection | Can have separate DB |
| Environment Variables | Shares same secrets | Has own secrets copy |
| When to Use | Quick fixes, config changes | Features, experiments, risky changes |

**Core Principle:**
> A Branch isolates your Code. A Fork isolates your Computer.

---

## Part 3: Replit Projects - The Managed Solution

### What Are Replit Projects?

For Teams subscribers, Replit Projects provides automated forking with managed merging - solving the Multiplayer vs. Git conflict elegantly.

### How Projects Work

1. **Master Repl** = The `main` branch equivalent (integration environment)
2. **Development Forks** = Auto-created when developer clicks "Start Working"
3. **Managed Merging** = Visual diff tool for code integration

### Projects Feature Comparison

| Feature | Raw Multiplayer | Manual Forking | Replit Projects |
|---------|-----------------|----------------|-----------------|
| Isolation | None | High | High (automated) |
| Merge Workflow | Live edits (dangerous) | Manual Git | Visual merge tool |
| Setup Friction | Low | High (secrets) | Medium |
| RBAC | Limited | Manual | Built-in |
| Cost | Free | Repl quota | Teams subscription |

### Why Projects Matter for Ninja

**Current State:** ninja-backend and ninja-frontend are set up as raw Repls with Multiplayer enabled. This means:
- Any developer's syntax error crashes the server for all
- No isolation between feature work
- Database shared by all developers simultaneously
- Risk of overwriting each other's uncommitted work

**Recommended State:** Convert to Replit Projects to gain:
- Automatic fork creation for each developer
- Runtime isolation (your crash doesn't affect others)
- Built-in merge conflict resolution
- Clear integration workflow

---

## Part 4: Configuration Management

### The Configuration Trinity

Three files control Replit environment behavior:

| File | Purpose | Visibility |
|------|---------|------------|
| `replit.nix` | System-level packages (Nix) | Hidden by default |
| `.replit` | Process orchestration (run commands, ports) | Hidden by default |
| `replit.md` | AI Agent context instructions | Visible |

**First action in any Repl:** Toggle "Show hidden files" in file tree.

### Synchronizing replit.nix with Dockerfile

**Critical for Ninja:** Development happens in Replit, but production deploys to AWS ECS (Docker). Environment parity requires synchronization.

#### The Parity Matrix

| Package | replit.nix | Dockerfile |
|---------|------------|------------|
| Node.js | `pkgs.nodejs_20` | `node:20-bookworm` |
| PostgreSQL client | `pkgs.postgresql_15` | `postgresql-client` |
| poppler (PDF) | `pkgs.poppler_utils` | `poppler-utils` |
| Ghostscript | `pkgs.ghostscript` | `ghostscript` |
| ImageMagick | `pkgs.imagemagick` | `imagemagick` |
| Java (EPUBCheck) | `pkgs.openjdk17` | `openjdk-17-jre-headless` |
| pandoc | `pkgs.pandoc` | `pandoc` |

**Recommendation:** Use the validation script in Appendix A to verify environment parity in CI.

### replit.md: The AI Agent Context File

The `replit.md` file serves as a "system prompt" for the Replit AI Agent. It stabilizes context and prevents the Agent from:
- Forgetting the tech stack
- Making incompatible code changes
- "Hallucinating" solutions that break existing patterns

**Required for Ninja:** Create a `replit.md` in project root with:
- Project overview and tech stack
- Architectural constraints
- Forbidden actions (DROP TABLE, schema changes)
- Recovery commands

---

## Part 5: AI Agent Management

### The "Junior Developer" Mental Model

The Replit Agent is a talented but inexperienced developer. It excels at:
- Generating boilerplate code
- Setting up standard frameworks
- Writing tests from examples

It struggles with:
- Understanding system-wide implications
- Managing "blast radius" of changes
- Respecting architectural boundaries

### The Rogue AI and Data Deletion

**Real Risk:** There are documented cases where the Replit Agent:
1. Accessed the production database
2. Decided a schema mismatch was the problem
3. Executed DROP TABLE to "fix" it
4. Destroyed customer data

### Agent Isolation Protocol

| Scenario | In Multiplayer | In Fork |
|----------|----------------|---------|
| Agent runs DROP TABLE | Production data deleted | Only test data affected |
| Agent installs wrong package | Breaks server for team | Only your fork affected |
| Agent rewrites auth | Team can't log in | Your fork is isolated |

**Rules:**
1. NEVER invoke Agent in Production Repl
2. ALWAYS fork before Agent interaction
3. Configure fork with test database (or no DB credentials)
4. Review ALL Agent changes before committing

### Agent vs. Assistant

| Feature | Agent | Assistant |
|---------|-------|-----------|
| Capability | Multi-file, terminal access | Single-file, contextual |
| Best For | Scaffolding, new features | Debugging, optimization |
| Risk Level | High (can modify anything) | Low (limited scope) |
| Usage | 0→1 tasks | Iteration, refinement |

**Recommended Workflow:**
1. Use AGENT for initial scaffolding (in a fork)
2. Switch to ASSISTANT for refinement
3. NEVER use AGENT for minor tweaks

---

## Part 6: Database Strategy

### Replit PostgreSQL (Neon) Architecture

Replit's integrated database uses Neon's serverless PostgreSQL.

| Feature | Behavior |
|---------|----------|
| Scale to Zero | DB sleeps when unused |
| Cold Start | First query after sleep: 3-5 seconds |
| Branching | Copy-on-write database copies |
| History | Retains WAL logs for point-in-time recovery |

### The Neon Snapshot Pricing Gotcha

**⚠️ CRITICAL WARNING ⚠️**

Neon charges not just for active data, but for **retained history**:
- Every INSERT, UPDATE, DELETE creates WAL entries
- Snapshots are retained based on your retention policy
- Default retention may be 7 days or more

**The Trap:**
```
Scenario: AI Agent runs a script that:
1. Inserts 10,000 test records
2. Deletes them to "clean up"
3. Repeats this 100 times testing edge cases

Result: 
- Final database size: 1 MB
- History/snapshot size: 10 GB
- Monthly bill: $1,500+ (actual reported cases)
```

**Mitigation:**
- Set history_retention_period to 6 hours for dev environments
- Monitor storage in Neon console weekly
- Use transactions to batch operations

### Ninja Database Strategy

| Environment | Database | Retention |
|-------------|----------|-----------|
| Replit Dev | Neon PostgreSQL | 6 hours |
| AWS Staging | RDS PostgreSQL | 7 days |
| AWS Production | RDS Multi-AZ | 30 days |

---

## Part 7: Deployment Architecture

### Deployment Type Comparison

| Type | Cold Start | Cost | Best For |
|------|------------|------|----------|
| Autoscale | 3-5 seconds | Pay per request | Webhooks, async tasks |
| Reserved VM | None | $20+/month fixed | User-facing apps |
| Static | None | Bandwidth only | Frontend SPAs |

### The Autoscale Trap

Autoscale deployments "scale to zero" when idle. First request after idle wakes the container (3-5 seconds). For user-facing apps like Ninja, this creates poor UX.

**Recommendation:** Use Reserved VM for production hosting on Replit, OR (preferred) deploy to AWS ECS for production.

### Ninja Deployment Strategy

```
Development Phase (Replit):
├── Real-time collaboration
├── Instant deployment for testing
├── Neon PostgreSQL for dev database
└── URL: ninja-dev.replit.app
          │
          │ git push → GitHub
          │ CI/CD (GitHub Actions)
          ▼
AWS Staging:
├── ECS Fargate (Docker containers)
├── RDS PostgreSQL Multi-AZ
├── ElastiCache Redis
├── S3 for file storage
└── URL: staging.ninja.s4carlisle.com
          │
          │ Manual approval
          ▼
AWS Production:
├── ECS Fargate with auto-scaling
├── RDS Multi-AZ
├── CloudFront CDN
├── WAF protection
└── URL: ninja.s4carlisle.com
```

---

## Part 8: Security and Secrets Management

### Secrets Architecture

| Location | Encryption | Injection |
|----------|------------|-----------|
| Sidebar → Secrets (🔒) | AES-256 at rest | Environment variables at runtime |

### The Frontend Leak Gotcha

**Critical Security Issue:**
```javascript
// ❌ DANGEROUS - This exposes the key to browsers!
const response = await fetch('https://api.gemini.com', {
  headers: { 'Authorization': `Bearer ${process.env.GEMINI_API_KEY}` }
});
```

Frontend code gets bundled into JavaScript sent to browsers. Anyone can view-source and steal the key.

**Correct Pattern:**
```javascript
// ✅ SAFE - Key stays on server
// Frontend calls your backend
const response = await fetch('/api/analyze-document', { method: 'POST', body: formData });

// Backend uses the key (never exposed to browser)
const geminiResponse = await gemini.analyze(doc, {
  apiKey: process.env.GEMINI_API_KEY  // Only exists on server
});
```

### Secrets in Fork: The Firewall Feature

When forking, secrets are **intentionally NOT copied**. This is a security feature preventing accidental credential leaks.

**Implication:** Each developer fork requires manual secret configuration.

---

## Part 9: Team Collaboration Workflows

### Workflow Decision Matrix

| Team Size | Subscription | Recommended Workflow |
|-----------|--------------|---------------------|
| Solo | Any | Git branching in single Repl |
| 2-3 | Core | Manual forking + GitHub PRs |
| 4+ | Teams | **Replit Projects** |
| Enterprise | Teams | Projects + RBAC + Audit |

### Workflow for Ninja (Recommended)

**Using Replit Projects:**
1. Project Owner Creates Project linking to GitHub repo
2. Developer Clicks "Start Working" → automatic fork created
3. Developer Works in Isolated Fork → full runtime isolation
4. Developer Clicks "Request Review" → visual merge UI
5. Reviewer Approves → changes merge to Master Repl

### Multiplayer Protocol (When to Use)

| Use Case | Protocol |
|----------|----------|
| Pair Programming | Driver/Navigator: ONE person types |
| Live Code Review | Reviewer observes, author makes changes |
| Debugging Sessions | Shared shell for log analysis |
| Teaching/Onboarding | Mentor demonstrates, trainee observes |

**Multiplayer DON'Ts:**
- ❌ Two people editing same file
- ❌ Running npm install while others work
- ❌ Switching branches while others edit
- ❌ Using Agent in shared session

---

## Part 10: GitHub Integration

### Connecting GitHub to Replit

1. Navigate to Account Settings → Connected Services
2. Click "Connect" next to GitHub
3. Authorize Replit to access your repositories
4. Import repository via "+ Create Repl" → "Import from GitHub"

### Git Workflow for Ninja

```bash
# Daily Development Workflow
git checkout main
git pull origin main
git checkout -b feat/NINJA-123-description

# Work on code...
git add .
git commit -m "feat(validation): add PDF/UA structure check"
git push -u origin feat/NINJA-123-description

# Create PR via GitHub UI
```

### Critical Git Gotchas in Replit

| Gotcha | Symptom | Solution |
|--------|---------|----------|
| Re-running `git init` | Broken history | Never run `git init` in existing repo |
| Committing secrets | Secrets in history | Use Replit Secrets, `.gitignore` |
| Merge conflicts in Multiplayer | Data loss | Use forks for isolation |
| Large files | Push rejected | `.gitignore` binaries, use S3 |

---

## Part 11: Claude and AI Assistant Integration

### Using Anthropic's Claude API in Replit

**Step 1: Store API Key**
1. Go to console.anthropic.com and create an API key
2. In Replit, open Secrets tool
3. Add secret: Key: `ANTHROPIC_API_KEY`, Value: your key

**Step 2: Install Dependencies**
```bash
pip install anthropic
```

**Step 3: Implement Claude Integration**
```python
import anthropic
import os

client = anthropic.Anthropic(api_key=os.environ.get("ANTHROPIC_API_KEY"))

def get_claude_response(prompt):
    message = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=1024,
        messages=[{"role": "user", "content": prompt}]
    )
    return message.content[0].text
```

### Claude Code Integration Workflows

**Code Review:**
```python
def review_code(code_snippet):
    prompt = f"""Review this code for:
    - Security vulnerabilities
    - Performance issues
    - Best practice violations
    Code: {code_snippet}"""
    return get_claude_response(prompt)
```

**Test Generation:**
```python
def generate_tests(function_code):
    prompt = f"""Generate pytest test cases for this function:
    - Happy path scenarios
    - Edge cases
    - Error handling
    {function_code}"""
    return get_claude_response(prompt)
```

---

## Part 12: Best Practices Summary

### Team Collaboration

| Practice | Description |
|----------|-------------|
| Use Replit Projects | Automatic fork management and merging |
| Define Roles Clearly | Admin, Editor, Viewer based on responsibilities |
| Establish Coding Standards | Agree on style guides and conventions |
| Document Everything | Maintain up-to-date README and replit.md |

### Security

| Practice | Description |
|----------|-------------|
| Use Secrets Tool | Never hardcode credentials |
| Fork for Agent Work | Isolate AI experiments |
| Rotate API Keys | Update credentials regularly |
| Monitor Neon Costs | Check snapshot storage weekly |

### Development Workflow

| Practice | Description |
|----------|-------------|
| Fork for Features | Never edit shared Repl directly |
| Commit Often | Small, focused commits with clear messages |
| Review Code | Use Projects or GitHub PRs for peer review |
| Use AI Thoughtfully | Review all AI-generated code before committing |

---

## Part 13: Troubleshooting Common Issues

### GitHub Integration Issues

**Problem:** Cannot push to GitHub  
**Solution:**
1. Verify GitHub connection in Account Settings
2. Check repository permissions
3. Try disconnecting and reconnecting GitHub
4. Use Shell for manual git commands if Git Pane fails

### Deployment Failures

**Problem:** Deployment errors  
**Solution:**
1. Check deployment logs for error messages
2. Verify all environment variables are set
3. Ensure build commands are correct in `.replit`
4. Check for missing dependencies

### Secret Access Issues

**Problem:** Environment variable returns undefined  
**Solution:**
1. Verify secret key name matches exactly (case-sensitive)
2. For account-level secrets, ensure they're linked to the app
3. Restart the Repl after adding new secrets
4. Check that secrets aren't restricted to certain deployments

### Database Connection Issues

**Problem:** Cannot connect to Neon PostgreSQL  
**Solution:**
1. Verify DATABASE_URL is set in Secrets
2. Check Neon dashboard for connection limits
3. Ensure SSL mode is enabled (`?sslmode=require`)
4. Check for cold start delays (wait 3-5 seconds)

---

## Appendix A: Environment Parity Validation

### CI Validation Script

This script verifies that Replit development environment and Docker production environment have matching package versions. Add this to your GitHub Actions workflow.

**File: `.github/workflows/validate-env-parity.yml`**

```yaml
name: Validate Environment Parity

on:
  push:
    paths:
      - 'replit.nix'
      - 'Dockerfile'
      - '.github/workflows/validate-env-parity.yml'
  pull_request:
    paths:
      - 'replit.nix'
      - 'Dockerfile'

jobs:
  validate-parity:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Validate Environment Parity
        run: |
          chmod +x ./scripts/validate-env-parity.sh
          ./scripts/validate-env-parity.sh
```

**File: `scripts/validate-env-parity.sh`**

```bash
#!/bin/bash
# Environment Parity Validation Script
# Ensures Replit (replit.nix) and Docker (Dockerfile) environments match

set -e

echo "=========================================="
echo "Environment Parity Validation"
echo "=========================================="

# Define expected package mappings
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
if [ ! -f "replit.nix" ]; then
    echo "❌ ERROR: replit.nix not found"
    exit 1
fi

if [ ! -f "Dockerfile" ]; then
    echo "❌ ERROR: Dockerfile not found"
    exit 1
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

echo ""
echo "------------------------------------------"

# Check Node.js version consistency
echo ""
echo "Checking Node.js version consistency..."

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

NIX_JAVA_VERSION=$(grep -oP 'openjdk\K[0-9]+' replit.nix 2>/dev/null | head -1 || echo "")
DOCKER_JAVA_VERSION=$(grep -oP 'openjdk-\K[0-9]+' Dockerfile 2>/dev/null | head -1 || echo "")

if [ -n "$NIX_JAVA_VERSION" ] && [ -n "$DOCKER_JAVA_VERSION" ]; then
    if [ "$NIX_JAVA_VERSION" = "$DOCKER_JAVA_VERSION" ]; then
        echo "✅ Java version: v$NIX_JAVA_VERSION (matched)"
    else
        echo "❌ Java version mismatch: replit.nix=v$NIX_JAVA_VERSION, Dockerfile=v$DOCKER_JAVA_VERSION"
        ((ERRORS++))
    fi
else
    echo "⚪ Java not configured in both environments"
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
    echo "Please fix the environment parity issues above."
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
```

### Usage Instructions

1. **Add the workflow file** to `.github/workflows/validate-env-parity.yml`
2. **Add the script** to `scripts/validate-env-parity.sh`
3. **Make script executable**: `chmod +x scripts/validate-env-parity.sh`
4. **Commit both files** to your repository

The validation will run automatically on any PR that modifies `replit.nix` or `Dockerfile`.

### Extending the Parity Map

To add new packages to the validation, update the `PARITY_MAP` in the script:

```bash
declare -A PARITY_MAP=(
    # ... existing entries ...
    ["your_nix_package"]="your-docker-package"
)
```

---

## Appendix B: Ninja-Specific Configuration Files

### replit.nix for Ninja Backend

```nix
{ pkgs }: {
  deps = [
    pkgs.nodejs_20
    pkgs.nodePackages.npm
    pkgs.nodePackages.typescript
    pkgs.postgresql_15
    pkgs.poppler_utils
    pkgs.ghostscript
    pkgs.imagemagick
    pkgs.openjdk17
    pkgs.pandoc
    pkgs.git
    pkgs.curl
    pkgs.jq
  ];

  env = {
    JAVA_HOME = "${pkgs.openjdk17}";
    NODE_OPTIONS = "--max-old-space-size=4096";
  };
}
```

### .replit for Ninja Backend

```toml
run = "npm run dev"
entrypoint = "src/index.ts"
modules = ["nodejs-20:v8-20230920-bd784b9"]
hidden = [".config", "package-lock.json", ".git"]

[nix]
channel = "stable-23_11"

[[ports]]
localPort = 3000
externalPort = 80

[env]
NODE_OPTIONS = "--max-old-space-size=4096"
```

---

## Appendix C: Resources

### Official Documentation
- [Replit Docs](https://docs.replit.com)
- [Replit Teams Guide](https://docs.replit.com/category/teams)
- [Secrets Documentation](https://docs.replit.com/replit-workspace/workspace-features/secrets)

### AI Integration
- [Anthropic API Documentation](https://docs.anthropic.com)
- [Replit Agent Guide](https://docs.replit.com/replitai/agents-and-automations)

---

*Version: 2.1 | Last Updated: December 2025*  
*Document synthesized from: Replit Teams Guide, Ninja Replit Development Guide, Cloud-Native Software Delivery patterns*
