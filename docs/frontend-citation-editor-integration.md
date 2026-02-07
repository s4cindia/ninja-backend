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

### Step 1: Fetch Document Content + Analysis

Call both endpoints in parallel when the page loads:

```javascript
const [analysisRes, textRes] = await Promise.all([
  api.get(`/citation/document/${documentId}`),
  api.get(`/editorial/document/${documentId}/text`)
]);
const analysis = analysisRes.data;
const { fullHtml, fullText } = textRes.data;
```

**Important:** Prefer `fullHtml` over `fullText`. The HTML preserves the original Word document formatting (headings, bold, italic, tables, lists, etc.). Only fall back to `fullText` if `fullHtml` is `null` (older documents uploaded before HTML support). In that case, prompt the user to re-upload the DOCX via the regenerate-html endpoint (see Section 1b above).

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
```

---

## Summary of Changes Needed

| Area | What to Do |
|------|-----------|
| **New API call** | Fetch `GET /api/v1/editorial/document/:documentId/text` — returns both `fullHtml` and `fullText` |
| **Left panel** | Render `fullHtml` as styled document (like Word). Fall back to `fullText` with line numbers only if `fullHtml` is null |
| **Citation highlights** | Use DOM TreeWalker to inject highlight spans into HTML text nodes without breaking markup |
| **Backfill** | If `fullHtml` is null, prompt user to re-upload DOCX via `POST .../regenerate-html` |
| **Right panel** | Expanded issue cards with fix options built from citation analysis data |
| **Issue cards** | Severity icon, title, detail, radio-button fix options, Accept/Dismiss buttons |
| **Bulk actions** | "Accept All" and "Dismiss All" buttons at top of issues list |
| **Interactions** | Click citation in editor → scroll to issue; click issue → scroll to citation |
| **Allowed HTML tags** | h1-h6, p, br, hr, strong, b, em, i, u, s, del, ins, sup, sub, span, ul, ol, li, table/thead/tbody/tfoot/tr/th/td/caption, blockquote, pre, code, a, img, figure, figcaption |
| **Embedded images** | `img` tags may use `data:` URIs for images embedded in the DOCX — render them inline |
