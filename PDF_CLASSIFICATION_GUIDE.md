# PDF Issue Classification Guide

## Overview

PDF accessibility issues are classified into three categories based on remediation complexity and required user input.

## Classification Categories

### AUTO_FIXABLE
**Criteria:** Can be fixed automatically with deterministic values (no user input needed)

**Examples:**
- `MATTERHORN-01-001` - PDF not marked for accessibility
  - Fix: Set `/Marked true` in catalog
- `MATTERHORN-01-002` - DisplayDocTitle not set
  - Fix: Set `/DisplayDocTitle true` in ViewerPreferences
- `MATTERHORN-01-005` - Suspects flag not set correctly
  - Fix: Set `/Suspects false` in MarkInfo

**Characteristics:**
- ✅ Always the same fix value
- ✅ No ambiguity about what to set
- ✅ No user knowledge required
- ✅ Fully automated workflow

---

### QUICK_FIX
**Criteria:** Requires user input but can be fixed through simple guided workflow

**Examples:**
- `MATTERHORN-11-001` / `PDF-NO-LANGUAGE` - Document language not specified
  - User provides: Language code (e.g., "en-US", "es", "fr")
- `WCAG-2.4.2` / `MATTERHORN-01-003` / `PDF-NO-TITLE` - Document title missing
  - User provides: Meaningful document title
- `PDF-NO-CREATOR` - Creator/Author metadata missing
  - User provides: Author name

**Characteristics:**
- ✅ Simple metadata values
- ✅ User knows the correct value
- ✅ Quick modal workflow (~5 seconds)
- ✅ Results in quality, meaningful metadata
- ❌ Requires user interaction

**Why not AUTO_FIXABLE?**
- Language should match document content (not hardcoded "en-US")
- Title should be meaningful (not generic "Document" or filename)
- Compliance standards require accurate metadata

---

### MANUAL
**Criteria:** Complex issues requiring PDF editor or extensive content work

**Examples:**
- Missing alt text for images
  - Requires understanding image content
- Reading order problems
  - Requires analyzing document structure
- Table structure issues
  - Requires understanding table layout
- Missing heading hierarchy
  - Requires content expertise

**Characteristics:**
- ❌ Cannot be automated
- ❌ Requires PDF editor (Adobe Acrobat Pro)
- ❌ Needs content/accessibility expertise
- ❌ Time-consuming fixes

---

## Adding New Issue Classifications

When adding a new PDF issue type, use this decision tree:

```
Can it be fixed with a known value?
├─ YES, always the same value
│  └─ AUTO_FIXABLE
└─ NO, requires input
   ├─ Simple metadata/value from user?
   │  └─ QUICK_FIX
   └─ Complex content/structure work?
      └─ MANUAL
```

## Code Location

Classification logic: `src/constants/pdf-fix-classification.ts`

## Testing Classification

When testing new classifications:
1. Temporarily move issue to QUICK_FIX
2. Create test PDF with that issue
3. Verify modal workflow makes sense
4. If yes, keep in QUICK_FIX; if no, move to MANUAL

---

**Last Updated:** February 15, 2026
**Decision:** Language/Title/Creator kept in QUICK_FIX for quality metadata
