# Citation Editor — Frontend Integration Guide

## Overview

Add an editor view to the existing `/editorial/citations/:documentId` page that displays the document source text with highlighted citations and lets users accept or reject fix suggestions.

## API Endpoints Required

### 1. Get Document Full Text (NEW — not yet used by frontend)

```
GET /api/v1/editorial/document/:documentId/text
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "fullText": "Full document text as a single string with newlines..."
  }
}
```

This is the raw document text that should be displayed in the editor panel. It preserves original line breaks and paragraph structure.

### 2. Get Citation Analysis (already used)

```
GET /api/v1/citation/document/:documentId
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "documentId": "uuid",
    "jobId": "uuid",
    "filename": "paper.docx",
    "processingTimeMs": 1234,
    "detectedStyle": {
      "styleCode": "vancouver",
      "styleName": "Vancouver",
      "confidence": 0.85,
      "citationFormat": "numeric-bracket | author-date | footnote | mixed | unknown",
      "evidence": ["Found 15 numeric bracket citations [1]-[15]", "..."]
    },
    "sequenceAnalysis": {
      "isSequential": false,
      "totalNumbers": 15,
      "expectedRange": { "start": 1, "end": 15 },
      "missingNumbers": [3, 7],
      "duplicateNumbers": [5],
      "outOfOrderNumbers": [12],
      "gaps": [{ "after": 2, "before": 4 }, { "after": 6, "before": 8 }],
      "summary": "..."
    },
    "crossReference": {
      "totalBodyCitations": 15,
      "totalReferenceEntries": 13,
      "matched": 11,
      "citationsWithoutReference": [
        { "number": 3, "text": "[3]", "citationId": "uuid" }
      ],
      "referencesWithoutCitation": [
        { "number": 14, "text": "Smith et al. 2020...", "entryIndex": 13 }
      ],
      "summary": "..."
    },
    "referenceList": {
      "totalEntries": 13,
      "entries": [
        {
          "index": 0,
          "number": 1,
          "text": "An R, Men XJ, Ni XH...",
          "matchedCitationIds": ["uuid"],
          "hasMatch": true
        }
      ]
    },
    "citations": {
      "totalCount": 15,
      "inBody": 15,
      "inReferences": 13,
      "items": [
        {
          "id": "uuid",
          "rawText": "[1]",
          "citationType": "NUMERIC",
          "detectedStyle": "VANCOUVER",
          "startOffset": 1234,
          "endOffset": 1237,
          "confidence": 0.95,
          "pageNumber": null,
          "paragraphIndex": 2,
          "primaryComponentId": null,
          "isParsed": false,
          "parseConfidence": null
        }
      ]
    },
    "conversionOptions": ["apa7", "mla9", "chicago17", "ieee"]
  }
}
```

---

## Frontend Implementation Plan

### Step 1: Fetch Document Text

Call both endpoints in parallel when the page loads:

```javascript
const [analysisRes, textRes] = await Promise.all([
  api.get(`/citation/document/${documentId}`),
  api.get(`/editorial/document/${documentId}/text`)
]);
const analysis = analysisRes.data;
const fullText = textRes.data.fullText;
```

### Step 2: Render Editor Panel (Left Side)

Display the document source text with line numbers and highlighted citations.

**Layout structure:**
```
+------------------------------------------+----------------------------+
|  DOCUMENT SOURCE (editor view)           |  ISSUES & FIXES            |
|                                          |                            |
|  1 | Introduction text here...           |  [E] Citation [3] has no   |
|  2 | Some body text with [1] cited       |      matching reference    |
|  3 | and more text with [2] here         |      ○ Add reference entry |
|  4 | then [3] appears without ref        |      ● Flag for review     |
|  5 | continued text...                   |      [Accept Fix] [Dismiss]|
|  6 |                                     |                            |
|  7 | Another paragraph with [5] and      |  [W] 2 missing citation    |
|  8 | some [5] duplicate usage            |      numbers               |
|                                          |      ○ Renumber citations   |
|                                          |      ● Flag for manual rev  |
|                                          |      [Accept Fix] [Dismiss]|
+------------------------------------------+----------------------------+
```

**How to highlight citations in the text:**

For numeric-bracket style (Vancouver, IEEE):
- Use regex: `/\[(\d{1,4})\]/g` to find `[1]`, `[2]`, etc.
- Cross-check each number against `crossReference.citationsWithoutReference` 
- Green highlight = citation has a matching reference
- Red highlight = citation is orphaned (no reference match)

For author-date style (APA, Chicago, Harvard):
- Use `citations.items[].startOffset` and `endOffset` to locate citations in the text
- Apply highlights at those character positions

```javascript
function highlightCitations(fullText, analysis) {
  const orphanNumbers = new Set(
    analysis.crossReference.citationsWithoutReference.map(c => c.number)
  );
  
  // Escape HTML first, then highlight
  const escaped = escapeHtml(fullText);
  return escaped.replace(/\[(\d{1,4})\]/g, (match, num) => {
    const n = parseInt(num);
    const isOrphan = orphanNumbers.has(n);
    const cssClass = isOrphan ? 'citation-issue' : 'citation-matched';
    return `<span class="${cssClass}" data-citation="${n}">${match}</span>`;
  });
}
```

**Line numbers:**
- Split text by `\n`
- Render a gutter column with line numbers
- Render content column with highlighted text

### Step 3: Build Issues from Analysis Data

Transform the analysis response into actionable issue cards:

```javascript
function buildIssues(analysis) {
  const issues = [];
  const seq = analysis.sequenceAnalysis;
  const xref = analysis.crossReference;

  // SEQUENCE ISSUES
  if (seq.missingNumbers.length > 0) {
    issues.push({
      id: 'seq-missing',
      severity: 'error',    // red icon
      title: `${seq.missingNumbers.length} missing citation number(s)`,
      detail: `Missing: ${seq.missingNumbers.map(n => '['+n+']').join(', ')}`,
      fixes: [
        { id: 'renumber', label: 'Renumber citations sequentially' },
        { id: 'flag', label: 'Flag for manual review' }
      ]
    });
  }

  if (seq.duplicateNumbers.length > 0) {
    issues.push({
      id: 'seq-dups',
      severity: 'error',
      title: `${seq.duplicateNumbers.length} duplicate citation number(s)`,
      detail: `Duplicated: ${seq.duplicateNumbers.map(n => '['+n+']').join(', ')}`,
      fixes: [
        { id: 'deduplicate', label: 'Assign unique numbers' },
        { id: 'review', label: 'Review manually' }
      ]
    });
  }

  if (seq.outOfOrderNumbers.length > 0) {
    issues.push({
      id: 'seq-order',
      severity: 'warning',  // yellow icon
      title: `${seq.outOfOrderNumbers.length} citation(s) out of order`,
      fixes: [
        { id: 'reorder', label: 'Reorder by first appearance' },
        { id: 'ignore', label: 'Ignore (intentional order)' }
      ]
    });
  }

  seq.gaps.forEach((gap, i) => {
    issues.push({
      id: `seq-gap-${i}`,
      severity: 'warning',
      title: `Gap: [${gap.after}] to [${gap.before}]`,
      detail: `Skips ${gap.before - gap.after - 1} number(s)`,
      fixes: [
        { id: 'renumber', label: 'Renumber to close gap' },
        { id: 'ignore', label: 'Ignore' }
      ]
    });
  });

  // CROSS-REFERENCE ISSUES
  xref.citationsWithoutReference.forEach(cit => {
    issues.push({
      id: `xref-orphan-${cit.number || cit.citationId}`,
      severity: 'error',
      title: `Citation [${cit.number || '?'}] has no matching reference`,
      detail: `"${cit.text}" not found in reference list`,
      fixes: [
        { id: 'add-ref', label: 'Add reference entry' },
        { id: 'remove-cit', label: 'Remove citation' },
        { id: 'flag', label: 'Flag for review' }
      ]
    });
  });

  if (xref.referencesWithoutCitation.length > 0) {
    issues.push({
      id: 'xref-uncited',
      severity: 'warning',
      title: `${xref.referencesWithoutCitation.length} reference(s) not cited in body`,
      fixes: [
        { id: 'remove-uncited', label: 'Remove uncited references' },
        { id: 'keep', label: 'Keep all' },
        { id: 'flag', label: 'Flag for review' }
      ]
    });
  }

  return issues;
}
```

### Step 4: Render Issue Cards (Right Side)

Each issue card should be **expanded by default** showing:
1. Severity icon (red E for error, yellow W for warning)
2. Title and detail text
3. Fix options as selectable radio buttons (first option pre-selected)
4. **Accept Fix** button (green) and **Dismiss** button (outline)

```html
<!-- Example issue card structure -->
<div class="issue-card">
  <div class="issue-header">
    <span class="severity-icon error">E</span>
    <div>
      <div class="issue-title">Citation [3] has no matching reference</div>
      <div class="issue-detail">"[3]" not found in reference list</div>
    </div>
  </div>
  <div class="issue-body">
    <div class="fix-options">
      <label class="fix-option selected">
        <input type="radio" name="fix-xref-orphan-3" value="add-ref" checked>
        Add reference entry
      </label>
      <label class="fix-option">
        <input type="radio" name="fix-xref-orphan-3" value="remove-cit">
        Remove citation
      </label>
      <label class="fix-option">
        <input type="radio" name="fix-xref-orphan-3" value="flag">
        Flag for review
      </label>
    </div>
    <div class="issue-actions">
      <button class="btn-accept">Accept Fix</button>
      <button class="btn-dismiss">Dismiss</button>
    </div>
  </div>
</div>
```

### Step 5: Handle Accept/Dismiss Actions

When user clicks **Accept Fix**:
- Record the selected fix option
- Visually mark the card as accepted (fade it, show green "Accepted" badge)
- Optionally highlight the affected citation in the editor panel

When user clicks **Dismiss**:
- Mark the card as dismissed (fade it, show "Dismissed" badge)

**Bulk actions** at the top:
- "Accept All Fixes" — accepts first fix option for all pending issues
- "Dismiss All" — dismisses all pending issues

### Step 6: Optional — Citation Click Interaction

When user clicks a highlighted citation in the editor:
- Scroll the issues panel to the corresponding issue card
- Highlight the issue card briefly

When user clicks an issue card:
- Scroll the editor to the line containing that citation
- Flash-highlight the citation in the editor

---

## CSS Suggestions

```css
/* Editor gutter + content layout */
.editor-wrapper { display: flex; height: 100%; overflow: auto; }
.editor-gutter { min-width: 44px; background: #f5f5f5; border-right: 1px solid #ddd; }
.editor-gutter .line-num { text-align: right; padding: 0 8px; font-size: 11px; color: #999; line-height: 1.8; }
.editor-content { flex: 1; padding: 12px 16px; font-family: monospace; font-size: 13px; line-height: 1.8; }
.editor-line { padding: 0 4px; border-left: 2px solid transparent; }
.editor-line:hover { background: #f0f4ff; border-left-color: #4a7aff; }

/* Citation highlights */
.citation-matched { background: rgba(61, 214, 140, 0.15); border-bottom: 2px solid #3dd68c; padding: 1px 2px; }
.citation-issue { background: rgba(255, 107, 107, 0.15); border-bottom: 2px solid #ff6b6b; padding: 1px 2px; }

/* Issue card — always expanded */
.issue-card { border: 1px solid #ddd; border-radius: 8px; margin-bottom: 8px; }
.issue-card.accepted { border-color: #3dd68c; opacity: 0.7; }
.issue-card.dismissed { border-color: #ccc; opacity: 0.5; }

/* Fix option radio buttons */
.fix-option { padding: 8px 12px; border: 1px solid #ddd; border-radius: 6px; margin-bottom: 4px; cursor: pointer; }
.fix-option.selected { border-color: #3dd68c; background: rgba(61, 214, 140, 0.1); }
```

---

## Summary of Changes Needed

| Area | What to Do |
|------|-----------|
| **New API call** | Fetch `GET /api/v1/editorial/document/:documentId/text` for document source |
| **Left panel** | Add editor view with line numbers + highlighted citations from `fullText` |
| **Right panel** | Replace current accordion sections with expanded issue cards with fix options |
| **Issue cards** | Show severity icon, title, detail, radio-button fix options, Accept/Dismiss buttons |
| **Bulk actions** | Add "Accept All" and "Dismiss All" buttons at top of issues list |
| **Interactions** | Click citation in editor → scroll to issue; click issue → scroll to citation |
