# PDF Auto-Fix Handler Audit

**Date:** February 13, 2026
**Purpose:** Identify gaps between issue classification and registered handlers

---

## Analysis

### AUTO_FIXABLE Codes vs Registered Handlers

| Issue Code | Classified As | Handler Registered | Status | Notes |
|------------|---------------|-------------------|--------|-------|
| **PDF-NO-LANGUAGE** | AUTO_FIXABLE ✅ | ✅ Yes | ✅ OK | handleAddLanguage |
| **MATTERHORN-11-001** | AUTO_FIXABLE ✅ | ✅ Yes | ✅ OK | Alias for language |
| **PDF-NO-TITLE** | AUTO_FIXABLE ✅ | ✅ Yes | ✅ OK | handleAddTitle |
| **WCAG-2.4.2** | AUTO_FIXABLE ✅ | ✅ Yes (FIXED) | ✅ OK | handleAddTitle (PR #175) |
| **MATTERHORN-01-003** | AUTO_FIXABLE ✅ | ✅ Yes | ⚠️ CONFLICT | Handler exists BUT code is also in MANUAL_CODES! |
| **PDF-NO-CREATOR** | AUTO_FIXABLE ✅ | ✅ Yes | ✅ OK | handleAddCreator |
| **PDF-EMPTY-HEADING** | AUTO_FIXABLE ✅ | ❌ NO | ❌ MISSING | No handler implemented |
| **PDF-REDUNDANT-TAG** | AUTO_FIXABLE ✅ | ❌ NO | ❌ MISSING | No handler implemented |

### Additional Handlers (Not in AUTO_FIXABLE)

| Issue Code | Classified As | Handler Registered | Status | Notes |
|------------|---------------|-------------------|--------|-------|
| **PDF-NO-METADATA** | MANUAL ❌ | ✅ Yes | ⚠️ CONFLICT | handleAddMetadata exists but classified as MANUAL |
| **MATTERHORN-01-001** | Not in AUTO_FIXABLE | ✅ Yes | ⚠️ ORPHAN | handleSetMarkedFlag - not in classification lists |
| **MATTERHORN-01-002** | Not in AUTO_FIXABLE | ✅ Yes | ⚠️ ORPHAN | handleSetDisplayDocTitle - not in classification lists |
| **MATTERHORN-01-005** | Not in AUTO_FIXABLE | ✅ Yes | ⚠️ ORPHAN | handleSetSuspectsFlag - not in classification lists |

---

## Issues Found

### 1. Missing Handlers (Code exists, no handler)

**PDF-EMPTY-HEADING**
- Classification: AUTO_FIXABLE
- Handler: ❌ Missing
- Impact: Will be skipped during auto-fix
- Fix needed: Implement handler or reclassify as MANUAL

**PDF-REDUNDANT-TAG**
- Classification: AUTO_FIXABLE
- Handler: ❌ Missing
- Impact: Will be skipped during auto-fix
- Fix needed: Implement handler or reclassify as MANUAL

### 2. Classification Conflicts

**MATTERHORN-01-003** (PDF not tagged)
- Classification: Both AUTO_FIXABLE AND MANUAL (conflict!)
- Handler: ✅ Registered as handleAddTitle
- Issue: Code appears in both AUTO_FIXABLE_CODES (line 58) and MANUAL_CODES (line 58)
- Fix needed: Remove from one list

**PDF-NO-METADATA**
- Classification: MANUAL (requires StructTreeRoot creation per comment)
- Handler: ✅ handleAddMetadata exists
- Issue: Handler might not actually create proper tag tree
- Fix needed: Verify handler implementation or remove handler

### 3. Orphaned Handlers (Handler exists, not in classification)

These handlers are registered but their codes don't appear in AUTO_FIXABLE_CODES:
- **MATTERHORN-01-001** (handleSetMarkedFlag)
- **MATTERHORN-01-002** (handleSetDisplayDocTitle)
- **MATTERHORN-01-005** (handleSetSuspectsFlag)

**Status:** These might work but won't be categorized as AUTO_FIXABLE in the UI

---

## Recommended Actions

### Immediate (Before Phase 3)

1. **Add MATTERHORN codes to AUTO_FIXABLE_CODES:**
   ```typescript
   export const AUTO_FIXABLE_CODES = new Set([
     // ... existing codes ...
     'MATTERHORN-01-001',      // PDF not marked for accessibility
     'MATTERHORN-01-002',      // DisplayDocTitle not set
     'MATTERHORN-01-005',      // Suspects flag not set
   ]);
   ```

2. **Remove MATTERHORN-01-003 from MANUAL_CODES:**
   - It's already in AUTO_FIXABLE_CODES (line 23 shows it's actually for title, not tagging)
   - Wait, there's confusion here - need to verify what this code actually means

3. **Decide on PDF-EMPTY-HEADING and PDF-REDUNDANT-TAG:**
   - Option A: Implement handlers
   - Option B: Move to MANUAL_CODES

### Long-term (Phase 3+)

1. **Audit all Matterhorn codes** against actual PAC validation output
2. **Create integration tests** to catch classification/handler mismatches
3. **Add validation** to ensure every AUTO_FIXABLE code has a handler

---

## Test Case

To verify this issue doesn't happen again:

```typescript
// tests/unit/pdf-classification-handler-sync.test.ts
import { AUTO_FIXABLE_CODES } from '../constants/pdf-fix-classification';
import { pdfAutoRemediationService } from '../services/pdf/pdf-auto-remediation.service';

describe('PDF Classification and Handler Sync', () => {
  it('should have handlers for all AUTO_FIXABLE codes', () => {
    const handlers = pdfAutoRemediationService.getRegisteredHandlers();

    for (const code of AUTO_FIXABLE_CODES) {
      expect(handlers.has(code)).toBe(true);
    }
  });
});
```

---

**Summary:** Found 2 missing handlers, 2 classification conflicts, and 3 orphaned handlers that need to be added to classification.
