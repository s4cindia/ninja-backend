# Ninja Platform Documentation

Welcome to the Ninja Platform documentation. This folder contains developer guides, setup instructions, and reference materials for the S4Carlisle India Development Team.

---

## 📚 Documentation Index

### Getting Started (Read in Order)

| # | Document | Description | Time |
|---|----------|-------------|------|
| 1 | [Ninja Replit Setup Guide](./ninja-replit-setup-guide.md) | Step-by-step environment setup for backend and frontend | 30 min |
| 2 | [Replit Teams Guide v2](./replit-teams-guide-v2.md) | Comprehensive collaboration reference (Multiplayer, Forks, Projects) | 45 min |
| 3 | [Developer Training Guide](./ninja-developer-training-guide.md) | Complete workflow training including AI safety and debugging | 4 hours |

### Quick Reference

| Document | Description |
|----------|-------------|
| [Git & GitHub Training](./git-github-training-course.md) | Version control fundamentals and team workflow |
| [Sprint Replit Prompts](./sprint-prompts/) | Approved AI prompts by sprint (MANDATORY for feature development) |

---

## 🚀 Quick Start

### New Developer Checklist

- [ ] Complete [Ninja Replit Setup Guide](./ninja-replit-setup-guide.md)
- [ ] Read [Replit Teams Guide v2](./replit-teams-guide-v2.md) (Parts 1-5 minimum)
- [ ] Complete [Developer Training Guide](./ninja-developer-training-guide.md)
- [ ] Set up [Bitwarden](https://vault.bitwarden.com) access (request from team lead)
- [ ] Join `#ninja-development` Teams channel
- [ ] Review sprint prompts for your assigned sprint

### Daily Development

```bash
# 1. Sync with main
git checkout main
git pull origin main

# 2. Create feature branch
git checkout -b feat/NINJA-XXX-description

# 3. Use ONLY approved sprint prompts for feature development
# See: docs/sprint-prompts/Sprint-X-Replit-Prompts.md

# 4. Commit and push
git add .
git commit -m "feat(scope): description"
git push -u origin feat/NINJA-XXX-description

# 5. Create PR on GitHub
```

---

## ⚠️ Critical Rules

### AI Agent Safety

| Scenario | Rule |
|----------|------|
| **Feature Development** | ✅ Use ONLY approved sprint prompts |
| **Debugging** | ✅ Use Claude Code with approved workflow |
| **Experimentation** | ⚠️ Only in isolated forks |
| **Production Repl** | ❌ NEVER use AI Agent |

### Forbidden Actions

- ❌ DROP TABLE or DROP DATABASE commands
- ❌ Schema modifications without approval
- ❌ Committing secrets to Git
- ❌ Installing unapproved packages

---

## 📁 Folder Structure

```
docs/
├── README.md                           ← You are here
├── ninja-replit-setup-guide.md         ← Environment setup
├── replit-teams-guide-v2.md            ← Collaboration reference
├── ninja-developer-training-guide.md   ← Complete training
├── git-github-training-course.md       ← Git fundamentals
└── sprint-prompts/                     ← Approved AI prompts
    ├── Sprint-1-Replit-Prompts.md
    ├── Sprint-2-Replit-Prompts.md
    ├── Sprint-3-Replit-Prompts.md
    ├── Sprint-4-Replit-Prompts.md
    ├── Sprint-5-Replit-Prompts.md
    ├── Sprint-6-Replit-Prompts.md
    └── Sprint-7-Replit-Prompts.md
```

---

## 🔗 Related Resources

### SharePoint (Official Documentation)
- **Location:** `07 - Knowledge Base → Developer Onboarding`
- Contains Word document versions of all guides

### Teams Channels
- `#ninja-development` - Technical discussions
- `#Knowledge-Learning` - Training and best practices
- `#Code-Reviews` - PR reviews and architecture

### External Links
- [GitHub Organization](https://github.com/s4cindia)
- [Replit Team](https://replit.com/t/s4carlisle-publishing-servic)
- [Bitwarden Vault](https://vault.bitwarden.com)
- [Anthropic Console](https://console.anthropic.com) (Claude Code API keys)

---

## 📝 Document Versions

| Document | Version | Last Updated |
|----------|---------|--------------|
| Ninja Replit Setup Guide | 2.1 | December 2025 |
| Replit Teams Guide | 2.1 | December 2025 |
| Developer Training Guide | 2.0 | December 2025 |

---

## 🆘 Getting Help

| Issue | Contact |
|-------|---------|
| Access problems | Team Lead |
| Technical blockers | `#ninja-development` Teams channel |
| Bitwarden access | Admin (request via team lead) |
| Blocked > 30 minutes | Tag team lead in Teams |

---

*This documentation is maintained by the S4Carlisle India Development Team.*  
*For updates, submit a PR or contact the Project Manager.*
