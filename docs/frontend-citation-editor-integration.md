# Citation Editor — Frontend Integration Guide

## Overview

Add an editor view to the existing `/editorial/citations/:documentId` page that displays the document source text with highlighted citations and lets users accept or reject fix suggestions.

## API Endpoints Required

### 1. Get Document Content — Text + HTML (updated)

```
GET /api/v1/editorial/document/:documentId/text
Authorization: Bearer <token>
```

The `:documentId` parameter accepts **either a document ID or a job ID** (the backend resolves both).

**Response:**
```json
{
  "success": true,
  "data": {
    "documentId": "4f8893df-8cfe-4c73-821d-b8f0fefa1c70",
    "fullText": "Plain text extracted from document...",
    "fullHtml": "<h1>Title</h1><p>Paragraph with <strong>bold</strong> and <em>italic</em>...</p>"
  }
}
```

- **`fullHtml`** — Styled HTML converted from the original Word document using mammoth.js. Preserves headings (h1-h4), bold, italic, underline, strikethrough, lists, tables, and superscripts/subscripts. **Use this for the editor panel** to show the document like a Word file.
- **`fullText`** — Plain text fallback (no formatting). Only use if `fullHtml` is null.
- **`fullHtml` will be `null` for documents uploaded before this feature.** Use the regenerate endpoint below to backfill.

### 1b. Regenerate HTML for Existing Documents

For documents uploaded before HTML support was added, re-upload the DOCX file to generate HTML:

```
POST /api/v1/editorial/document/:documentId/regenerate-html
Authorization: Bearer <token>
Content-Type: multipart/form-data

Body: file=<DOCX file>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "documentId": "4f8893df-...",
    "htmlLength": 28450,
    "warnings": 2
  }
}
```

After calling this, the `GET .../text` endpoint will return `fullHtml` for that document.

### 2. Run Citation Validation (NEW)

Checks for duplicate in-text citations, missing citation numbers, orphaned citations (no matching reference), and uncited references. Also returns a **reference lookup map** for hover tooltips.

```
GET /api/v1/editorial/document/:documentId/validate-citations
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "documentId": "uuid",
    "totalIssues": 5,
    "errors": 3,
    "warnings": 2,
    "issues": [
      {
        "id": "seq-duplicates",
        "severity": "error",
        "type": "DUPLICATE_CITATION",
        "title": "2 duplicate in-text citation number(s)",
        "detail": "Duplicated: [5], [8]",
        "citationNumbers": [5, 8]
      },
      {
        "id": "xref-orphan-3",
        "severity": "error",
        "type": "CITATION_WITHOUT_REFERENCE",
        "title": "Citation [3] has no matching reference",
        "detail": "In-text citation \"[3]\" not found in the reference list at the bottom",
        "citationNumbers": [3]
      },
      {
        "id": "xref-uncited-14",
        "severity": "warning",
        "type": "REFERENCE_WITHOUT_CITATION",
        "title": "Reference [14] not cited in text",
        "detail": "\"Smith et al. 2020...\" appears in the reference list but is not cited in the document body",
        "citationNumbers": [14]
      }
    ],
    "referenceLookup": {
      "1": "An R, Men XJ, Ni XH, et al. Full reference text...",
      "2": "Baker SM, Jones KL. Another reference...",
      "3": null
    },
    "summary": {
      "totalBodyCitations": 15,
      "totalReferences": 13,
      "matched": 11,
      "duplicates": 2,
      "missingInSequence": 1,
      "orphanedCitations": 2,
      "uncitedReferences": 1
    }
  }
}
```

**Issue types:**
| Type | Severity | Meaning |
|------|----------|---------|
| `DUPLICATE_CITATION` | error | Same citation number appears multiple times in body |
| `MISSING_CITATION_NUMBER` | error | Gap in numbered sequence (e.g., [1], [2], [4] — missing [3]) |
| `CITATION_WITHOUT_REFERENCE` | error | In-text citation has no matching entry in reference list |
| `REFERENCE_WITHOUT_CITATION` | warning | Reference list entry is never cited in the body |
| `OUT_OF_ORDER` | warning | Citations don't appear in numerical order |
| `SEQUENCE_GAP` | warning | Large gap between consecutive citation numbers |

### 3. Reference Lookup for Hover Tooltips (NEW)

Returns a map of citation numbers to their full reference text. Use this to show hover tooltips when the user hovers over a citation like `[1]` in the document.

```
GET /api/v1/editorial/document/:documentId/reference-lookup
Authorization: Bearer <token>
```

**Response:**
```json
{
  "success": true,
  "data": {
    "documentId": "uuid",
    "totalReferences": 13,
    "lookupMap": {
      "1": "An R, Men XJ, Ni XH, Yu HL, Xie J, Peng SE. Breast angiosarcoma: a systematic review. Eur J Surg Oncol. 2024;50:106–15.",
      "2": "Baker SM, Jones KL. Clinical features of primary angiosarcoma. J Oncol. 2023;41:234–9.",
      "3": "Chen D, Liu F. Radiation-associated angiosarcoma: a review. Ann Surg Oncol. 2022;29:4567–78."
    },
    "crossReference": { "...same structure as citation analysis..." },
    "sequenceAnalysis": { "...same structure as citation analysis..." }
  }
}
```

**Frontend usage for hover tooltips:**
```javascript
// Fetch once when page loads
const lookupRes = await api.get(`/editorial/document/${documentId}/reference-lookup`);
const lookupMap = lookupRes.data.lookupMap;

// When hovering over a citation span
document.querySelectorAll('[data-citation]').forEach(el => {
  el.addEventListener('mouseenter', (e) => {
    const num = e.target.dataset.citation;
    const refText = lookupMap[num];
    if (refText) {
      showTooltip(e.target, refText);
    } else {
      showTooltip(e.target, 'No matching reference found');
    }
  });
});
```

### 4. Get Citation Analysis (existing)

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

### Step 1: Fetch Document Content + Validation Data

Call all three endpoints in parallel when the page loads:

```javascript
const [textRes, validationRes, lookupRes] = await Promise.all([
  api.get(`/editorial/document/${documentId}/text`),
  api.get(`/editorial/document/${documentId}/validate-citations`),
  api.get(`/editorial/document/${documentId}/reference-lookup`)
]);
const { fullHtml, fullText } = textRes.data;
const validation = validationRes.data;    // issues, referenceLookup, summary
const lookupMap = lookupRes.data.lookupMap; // { "1": "full reference text...", ... }
```

**Important:**
- Prefer `fullHtml` over `fullText`. The HTML preserves the original Word document formatting (headings, bold, italic, tables, lists, superscripts, subscripts, etc.). Only fall back to `fullText` if `fullHtml` is `null` (older documents uploaded before HTML support). In that case, prompt the user to re-upload the DOCX via the regenerate-html endpoint (see Section 1b above).
- The `validate-citations` endpoint returns pre-built issue objects ready for the right panel, plus a `referenceLookup` map.
- The `reference-lookup` endpoint returns the same lookup map (use either one — `validate-citations` includes it for convenience).

### Step 2: Render Editor Panel (Left Side)

Display the document as styled HTML with highlighted citations. The document should look like the original Word file.

**Layout structure:**
```
+------------------------------------------+----------------------------+
|  DOCUMENT SOURCE (styled HTML view)      |  ISSUES & FIXES            |
|                                          |                            |
|  Title Heading (h1, styled)              |  [E] Citation [3] has no   |
|                                          |      matching reference    |
|  Introduction paragraph with [1] cited   |      ○ Add reference entry |
|  and more **bold text** with [2] here    |      ● Flag for review     |
|  then [3] appears without ref            |      [Accept Fix] [Dismiss]|
|                                          |                            |
|  Subheading (h2)                         |  [W] 2 missing citation    |
|                                          |      numbers               |
|  Another paragraph with [5] and          |      ○ Renumber citations   |
|  some [5] duplicate usage                |      ● Flag for manual rev  |
|                                          |      [Accept Fix] [Dismiss]|
+------------------------------------------+----------------------------+
```

**Rendering the HTML content:**

The `fullHtml` is server-sanitized and safe to render directly via `innerHTML` or `dangerouslySetInnerHTML` (React). It contains standard HTML tags: `h1`-`h4`, `p`, `strong`, `em`, `u`, `s`, `table`, `ul`, `ol`, `li`, `img` (with embedded data URIs for images), `sup`, `sub`, `blockquote`, `pre`, `code`.

Style the container with document-like CSS (serif font, readable line height, appropriate heading sizes) to make it look like the original Word document rather than a code editor.

**How to highlight citations in the HTML:**

Since `fullHtml` already contains HTML tags, you need to highlight citations within the text content without breaking the existing markup. Use a DOM-based approach:

```javascript
function highlightCitationsInHtml(htmlString, analysis) {
  const orphanNumbers = new Set(
    analysis.crossReference.citationsWithoutReference.map(c => c.number)
  );

  const parser = new DOMParser();
  const doc = parser.parseFromString(htmlString, 'text/html');

  const walker = document.createTreeWalker(
    doc.body,
    NodeFilter.SHOW_TEXT,
    null
  );

  const textNodes = [];
  while (walker.nextNode()) {
    textNodes.push(walker.currentNode);
  }

  textNodes.forEach(node => {
    const text = node.textContent;
    if (!/\[\d{1,4}\]/.test(text)) return;

    const fragment = document.createDocumentFragment();
    let lastIndex = 0;
    const regex = /\[(\d{1,4})\]/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(
          document.createTextNode(text.slice(lastIndex, match.index))
        );
      }
      const n = parseInt(match[1]);
      const span = document.createElement('span');
      span.className = orphanNumbers.has(n) ? 'citation-issue' : 'citation-matched';
      span.dataset.citation = String(n);
      span.textContent = match[0];
      fragment.appendChild(span);
      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      fragment.appendChild(document.createTextNode(text.slice(lastIndex)));
    }

    node.parentNode.replaceChild(fragment, node);
  });

  return doc.body.innerHTML;
}
```

For author-date style (APA, Chicago, Harvard):
- Use `citations.items[].startOffset` and `endOffset` to locate citations
- These offsets refer to the plain-text version (`fullText`), so map them to the HTML DOM positions using the TreeWalker approach above

**Fallback for plain text (when fullHtml is null):**

If `fullHtml` is not available, fall back to the plain-text approach with line numbers:
```javascript
function highlightCitationsPlainText(fullText, analysis) {
  const orphanNumbers = new Set(
    analysis.crossReference.citationsWithoutReference.map(c => c.number)
  );
  const escaped = escapeHtml(fullText);
  return escaped.replace(/\[(\d{1,4})\]/g, (match, num) => {
    const n = parseInt(num);
    const cssClass = orphanNumbers.has(n) ? 'citation-issue' : 'citation-matched';
    return `<span class="${cssClass}" data-citation="${n}">${match}</span>`;
  });
}
```
For plain text: split by `\n`, render a gutter column with line numbers + content column.

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

### Step 6: Hover Tooltips — Show Reference on Citation Hover

When the user hovers over a highlighted citation (e.g., `[1]`), display a tooltip showing the full reference text from the bottom of the document.

**Implementation:**
```javascript
// Use the referenceLookup from the validate-citations response
const lookupMap = validation.referenceLookup;

function setupHoverTooltips(containerEl) {
  containerEl.querySelectorAll('[data-citation]').forEach(el => {
    el.addEventListener('mouseenter', (e) => {
      const num = e.target.dataset.citation;
      const refText = lookupMap[num];
      showTooltip(e.target, refText || 'No matching reference found');
    });
    el.addEventListener('mouseleave', () => {
      hideTooltip();
    });
  });
}

function showTooltip(anchorEl, text) {
  let tooltip = document.getElementById('citation-tooltip');
  if (!tooltip) {
    tooltip = document.createElement('div');
    tooltip.id = 'citation-tooltip';
    tooltip.className = 'citation-tooltip';
    document.body.appendChild(tooltip);
  }
  tooltip.textContent = text;
  tooltip.style.display = 'block';
  const rect = anchorEl.getBoundingClientRect();
  tooltip.style.left = `${rect.left}px`;
  tooltip.style.top = `${rect.bottom + 6}px`;
}

function hideTooltip() {
  const tooltip = document.getElementById('citation-tooltip');
  if (tooltip) tooltip.style.display = 'none';
}
```

### Step 7: "Run Validation" Button

Add a button in the toolbar/header area that triggers citation validation on demand:

```javascript
async function handleRunValidation(documentId) {
  setLoading(true);
  const res = await api.get(`/editorial/document/${documentId}/validate-citations`);
  const validation = res.data;

  // Update issue cards
  renderIssueCards(validation.issues);

  // Update citation highlights based on new validation data
  const orphanNumbers = new Set(
    validation.issues
      .filter(i => i.type === 'CITATION_WITHOUT_REFERENCE')
      .flatMap(i => i.citationNumbers)
  );
  updateCitationHighlights(orphanNumbers);

  // Update hover tooltips
  lookupMap = validation.referenceLookup;

  // Show summary
  showValidationSummary(validation.summary);
  setLoading(false);
}
```

**Summary bar** above the issues panel:
```
Matched: 11/15 | Duplicates: 2 | Orphaned: 2 | Uncited refs: 1
```

### Step 8: Citation Click Interaction

When user clicks a highlighted citation in the editor:
- Scroll the issues panel to the corresponding issue card
- Highlight the issue card briefly

When user clicks an issue card:
- Scroll the editor to the line containing that citation
- Flash-highlight the citation in the editor

---

## CSS Suggestions

```css
/* Two-panel layout */
.citation-editor { display: flex; height: 100vh; }
.document-panel { flex: 1; overflow-y: auto; padding: 32px 40px; background: #fff; }
.issues-panel { width: 380px; overflow-y: auto; padding: 16px; background: #fafafa; border-left: 1px solid #e0e0e0; }

/* Document-style rendering (styled HTML from fullHtml) */
.document-panel h1 { font-size: 24px; font-weight: 700; margin: 24px 0 12px; font-family: 'Georgia', serif; }
.document-panel h2 { font-size: 20px; font-weight: 600; margin: 20px 0 10px; font-family: 'Georgia', serif; }
.document-panel h3 { font-size: 17px; font-weight: 600; margin: 16px 0 8px; font-family: 'Georgia', serif; }
.document-panel p { font-size: 14px; line-height: 1.7; margin: 0 0 12px; font-family: 'Georgia', serif; }
.document-panel table { border-collapse: collapse; width: 100%; margin: 16px 0; }
.document-panel th, .document-panel td { border: 1px solid #ccc; padding: 8px 12px; font-size: 13px; }
.document-panel th { background: #f5f5f5; font-weight: 600; }
.document-panel ul, .document-panel ol { margin: 8px 0 12px 24px; }
.document-panel li { font-size: 14px; line-height: 1.6; }
.document-panel img { max-width: 100%; height: auto; margin: 12px 0; }
.document-panel blockquote { border-left: 3px solid #ccc; padding-left: 16px; color: #555; margin: 12px 0; }

/* Plain-text fallback (when fullHtml is null) */
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

/* Hover tooltip for citations */
.citation-tooltip {
  position: fixed;
  z-index: 1000;
  max-width: 450px;
  padding: 10px 14px;
  background: #1a1a2e;
  color: #fff;
  border-radius: 6px;
  font-size: 12px;
  line-height: 1.5;
  box-shadow: 0 4px 12px rgba(0,0,0,0.15);
  pointer-events: none;
  display: none;
}

/* Citation hover cursor */
.citation-matched, .citation-issue { cursor: pointer; }
.citation-matched:hover { background: rgba(61, 214, 140, 0.3); }
.citation-issue:hover { background: rgba(255, 107, 107, 0.3); }

/* Validation summary bar */
.validation-summary {
  display: flex;
  gap: 16px;
  padding: 8px 16px;
  background: #f0f4ff;
  border-radius: 6px;
  font-size: 13px;
  margin-bottom: 12px;
}
.validation-summary .stat { font-weight: 600; }
.validation-summary .stat.error { color: #e53e3e; }
.validation-summary .stat.success { color: #38a169; }

/* Run Validation button */
.btn-validate {
  padding: 8px 16px;
  background: #4a7aff;
  color: #fff;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  font-size: 13px;
}
.btn-validate:hover { background: #3b6ae0; }
```

---

## Summary of Changes Needed

| Area | What to Do |
|------|-----------|
| **Text endpoint** | `GET /api/v1/editorial/document/:documentId/text` — returns `fullHtml` (styled) and `fullText` (plain) |
| **Validate endpoint (NEW)** | `GET /api/v1/editorial/document/:documentId/validate-citations` — returns issues, referenceLookup map, and summary counts |
| **Reference lookup (NEW)** | `GET /api/v1/editorial/document/:documentId/reference-lookup` — returns citation-number-to-reference-text map for hover tooltips |
| **Left panel** | Render `fullHtml` as styled document (like Word) with h1/h2/bold/italic preserved. Fall back to `fullText` only if null |
| **Citation highlights** | DOM TreeWalker to inject highlight spans into HTML text nodes. Green = matched, Red = orphaned |
| **Hover tooltips** | On citation hover, show full reference text from `referenceLookup` map in a tooltip |
| **Run Validation button** | Triggers `validate-citations` endpoint, updates issue cards and highlights |
| **Right panel** | Issue cards from `validate-citations` response (pre-built with type, severity, citationNumbers) |
| **Issue cards** | Severity icon, title, detail, radio-button fix options, Accept/Dismiss buttons |
| **Bulk actions** | "Accept All" and "Dismiss All" buttons at top of issues list |
| **Interactions** | Click citation → scroll to issue; click issue → scroll to citation |
| **Allowed HTML tags** | h1-h6, p, br, hr, strong, b, em, i, u, s, del, ins, sup, sub, span, ul, ol, li, table/thead/tbody/tfoot/tr/th/td/caption, blockquote, pre, code, a, img, figure, figcaption |
| **Embedded images** | `img` tags may use `data:` URIs for images embedded in the DOCX — render them inline |
