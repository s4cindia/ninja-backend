# Citation Validation, Correction & Reference List Generation

## Design Document

> **User Stories**: US-5.1, US-6.1, US-6.3
> **Created**: February 2026
> **Status**: Design Phase

---

## Table of Contents

1. [Overview](#overview)
2. [User Stories & Acceptance Criteria](#user-stories--acceptance-criteria)
3. [System Architecture](#system-architecture)
4. [Database Schema](#database-schema)
5. [API Design](#api-design)
6. [AI Prompts & Integration](#ai-prompts--integration)
7. [Frontend Components](#frontend-components)
8. [User Flows](#user-flows)
9. [Technical Implementation](#technical-implementation)
10. [Testing Strategy](#testing-strategy)

---

## 1. Overview

### Purpose

Build AI-powered citation validation, correction, and reference list generation capabilities that:

1. **Validate** citations against style guides (APA, MLA, Chicago, etc.)
2. **Correct** formatting errors with one-click fixes
3. **Generate** complete reference lists from in-text citations

### Dependencies

- **Prerequisite**: US-4.1 (Citation Detection) and US-4.2 (Citation Parsing) must be complete
- **AI**: Google Gemini for validation, correction, and generation
- **External APIs**: CrossRef, PubMed for metadata enrichment

### Workflow

```
┌─────────────────────────────────────────────────────────────────────┐
│                         CITATION WORKFLOW                            │
├─────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  ┌──────────┐    ┌──────────┐    ┌──────────┐    ┌──────────┐      │
│  │  US-4.1  │───▶│  US-4.2  │───▶│  US-5.1  │───▶│  US-6.1  │      │
│  │ Detect   │    │  Parse   │    │ Validate │    │ Correct  │      │
│  └──────────┘    └──────────┘    └──────────┘    └──────────┘      │
│                                         │                            │
│                                         ▼                            │
│                                  ┌──────────┐                       │
│                                  │  US-6.3  │                       │
│                                  │ Generate │                       │
│                                  │ Ref List │                       │
│                                  └──────────┘                       │
│                                                                      │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. User Stories & Acceptance Criteria

### US-5.1: AI Citation Format Validation

**As a** copyeditor
**I want** AI to validate citations against the specified style guide
**So that** I can ensure consistency throughout the manuscript

| AC | Criteria | Priority |
|----|----------|----------|
| AC-27 | Validates against APA 7th, MLA 9th, Chicago 17th, or custom style | Must |
| AC-28 | Checks: punctuation, capitalization, italics, author format, date format | Must |
| AC-29 | AI understands context (e.g., 'n.d.' acceptable when date unavailable) | Must |
| AC-30 | Reports each violation with specific rule reference | Must |
| AC-31 | Suggests corrected format for each violation | Must |

### US-6.1: AI Citation Format Correction

**As a** copyeditor
**I want** AI to automatically correct citation formatting errors
**So that** I can fix issues with one click rather than manual editing

| AC | Criteria | Priority |
|----|----------|----------|
| AC-32 | AI generates corrected citation in target format | Must |
| AC-33 | Preview shows before/after comparison | Must |
| AC-34 | One-click accept or manual edit option | Must |
| AC-35 | Batch correction for similar issues throughout document | Should |
| AC-36 | Maintains tracked changes for editor review | Should |

### US-6.3: AI Reference List Generation

**As an** author
**I want** AI to generate a complete reference list from my in-text citations
**So that** I don't have to manually compile the bibliography

| AC | Criteria | Priority |
|----|----------|----------|
| AC-37 | AI extracts all unique citations from manuscript | Must |
| AC-38 | CrossRef/PubMed lookup enriches citation metadata | Must |
| AC-39 | AI generates formatted reference list in specified style | Must |
| AC-40 | Handles sources not in databases with best-effort formatting | Must |
| AC-41 | Alphabetizes (APA/MLA) or numbers (Vancouver) as appropriate | Must |
| AC-42 | User can edit individual entries before final generation | Must |

---

## 3. System Architecture

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                           FRONTEND                                   │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │ ValidationPanel │  │ CorrectionPanel │  │ ReferenceListGen│     │
│  │                 │  │                 │  │                 │     │
│  │ - Style select  │  │ - Before/After  │  │ - Preview list  │     │
│  │ - Violations    │  │ - Accept/Edit   │  │ - Edit entries  │     │
│  │ - Rule refs     │  │ - Batch correct │  │ - Style format  │     │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘     │
│           │                    │                    │               │
└───────────┼────────────────────┼────────────────────┼───────────────┘
            │                    │                    │
            ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                          API LAYER                                   │
├─────────────────────────────────────────────────────────────────────┤
│  POST /citation/validate                                            │
│  POST /citation/correct                                             │
│  POST /citation/correct/batch                                       │
│  POST /citation/reference-list/generate                             │
│  POST /citation/reference-list/enrich                               │
│  PATCH /citation/reference-list/:id                                 │
└─────────────────────────────────────────────────────────────────────┘
            │                    │                    │
            ▼                    ▼                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        SERVICE LAYER                                 │
├─────────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │ ValidationSvc   │  │ CorrectionSvc   │  │ ReferenceListSvc│     │
│  │                 │  │                 │  │                 │     │
│  │ - validateStyle │  │ - correctSingle │  │ - extractUnique │     │
│  │ - checkRules    │  │ - correctBatch  │  │ - enrichMetadata│     │
│  │ - getViolations │  │ - trackChanges  │  │ - formatList    │     │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘     │
│           │                    │                    │               │
│           └────────────────────┼────────────────────┘               │
│                                ▼                                    │
│                    ┌─────────────────────┐                         │
│                    │   StyleRuleEngine   │                         │
│                    │                     │                         │
│                    │ - APA 7th rules     │                         │
│                    │ - MLA 9th rules     │                         │
│                    │ - Chicago 17th      │                         │
│                    │ - Custom styles     │                         │
│                    └─────────────────────┘                         │
└─────────────────────────────────────────────────────────────────────┘
            │                    │
            ▼                    ▼
┌─────────────────────┐  ┌─────────────────────┐
│    Gemini AI        │  │   External APIs     │
│                     │  │                     │
│ - Validate format   │  │ - CrossRef (DOI)    │
│ - Generate correct  │  │ - PubMed (PMID)     │
│ - Format references │  │ - Open Library      │
└─────────────────────┘  └─────────────────────┘
```

---

## 4. Database Schema

### New Models

```prisma
// Citation style guide definitions
model CitationStyle {
  id            String   @id @default(uuid())
  code          String   @unique  // "apa7", "mla9", "chicago17"
  name          String            // "APA 7th Edition"
  version       String?           // "7th"

  // Rule definitions (JSON)
  inTextRules   Json     // Rules for in-text citations
  referenceRules Json    // Rules for reference entries

  // Formatting options
  sortOrder     String   @default("alphabetical") // "alphabetical", "numbered", "appearance"
  hangingIndent Boolean  @default(true)
  doubleSpacing Boolean  @default(true)

  isSystem      Boolean  @default(true)  // System vs custom
  tenantId      String?  // null = system-wide

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([tenantId])
}

// Validation results for a document
model CitationValidation {
  id            String   @id @default(uuid())
  documentId    String
  document      EditorialDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)

  citationId    String
  citation      Citation @relation(fields: [citationId], references: [id], onDelete: Cascade)

  styleCode     String   // Which style was validated against

  // Violation details
  violationType String   // "punctuation", "capitalization", "author_format", "date_format", "italics", "order"
  ruleReference String   // "APA 7.01", "MLA 3.2"
  ruleName      String   // "Author names should be inverted"

  originalText  String   // The problematic text
  suggestedFix  String   // AI-suggested correction
  explanation   String?  // Why this is wrong

  severity      String   @default("warning") // "error", "warning", "info"

  // Resolution
  status        String   @default("pending") // "pending", "accepted", "rejected", "edited"
  resolvedText  String?  // Final corrected text
  resolvedBy    String?
  resolvedAt    DateTime?

  createdAt     DateTime @default(now())

  @@index([documentId])
  @@index([citationId])
  @@index([status])
}

// Generated reference list entries
model ReferenceListEntry {
  id              String   @id @default(uuid())
  documentId      String
  document        EditorialDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)

  // Link to source citation(s)
  citationIds     String[] // Multiple in-text citations may refer to same reference

  // Enriched metadata
  authors         Json     // Array of {firstName, lastName, suffix}
  year            String?
  title           String
  sourceType      String   // "journal", "book", "chapter", "website", "conference"

  // Journal article fields
  journalName     String?
  volume          String?
  issue           String?
  pages           String?

  // Book fields
  publisher       String?
  publisherLocation String?
  edition         String?
  editors         Json?    // For edited books

  // Digital fields
  doi             String?
  url             String?
  accessDate      DateTime?

  // Identifiers (for enrichment)
  pmid            String?  // PubMed ID
  isbn            String?

  // Enrichment status
  enrichmentSource String?  // "crossref", "pubmed", "manual", "ai"
  enrichmentConfidence Float?

  // Formatted output (cached)
  formattedApa    String?
  formattedMla    String?
  formattedChicago String?

  // Order in list
  sortKey         String?  // For alphabetical sorting
  orderNumber     Int?     // For numbered styles

  // User edits
  isEdited        Boolean  @default(false)
  editedBy        String?
  editedAt        DateTime?

  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  @@index([documentId])
  @@unique([documentId, doi])
}

// Track changes for corrections
model CitationChange {
  id            String   @id @default(uuid())
  documentId    String
  document      EditorialDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)

  citationId    String?
  referenceId   String?

  changeType    String   // "correction", "insertion", "deletion", "reorder"

  beforeText    String
  afterText     String

  appliedBy     String?
  appliedAt     DateTime @default(now())

  // For undo/redo
  isReverted    Boolean  @default(false)
  revertedAt    DateTime?

  @@index([documentId])
}
```

### Update Existing Models

```prisma
// Add to Citation model
model Citation {
  // ... existing fields ...

  // Add relation to validations
  validations   CitationValidation[]

  // Add validation status
  validationStatus String? // "valid", "has_errors", "has_warnings", "not_validated"
  lastValidatedAt  DateTime?
  lastValidatedStyle String?
}

// Add to EditorialDocument model
model EditorialDocument {
  // ... existing fields ...

  // Add relations
  validations       CitationValidation[]
  referenceEntries  ReferenceListEntry[]
  citationChanges   CitationChange[]

  // Reference list status
  referenceListStatus String? // "not_generated", "draft", "finalized"
  referenceListStyle  String? // Style code used
  referenceListGeneratedAt DateTime?
}
```

---

## 5. API Design

### Validation Endpoints (US-5.1)

#### POST `/api/v1/citation/document/:documentId/validate`

Validate all citations in a document against a style guide.

**Request:**
```json
{
  "styleCode": "apa7",
  "options": {
    "checkPunctuation": true,
    "checkCapitalization": true,
    "checkItalics": true,
    "checkAuthorFormat": true,
    "checkDateFormat": true,
    "checkOrder": true
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "documentId": "doc-123",
    "styleCode": "apa7",
    "styleName": "APA 7th Edition",
    "summary": {
      "totalCitations": 45,
      "validCitations": 38,
      "citationsWithErrors": 5,
      "citationsWithWarnings": 2,
      "errorCount": 7,
      "warningCount": 3
    },
    "violations": [
      {
        "id": "val-001",
        "citationId": "cite-123",
        "citationText": "(Smith and Jones, 2020)",
        "violationType": "author_format",
        "severity": "error",
        "ruleReference": "APA 8.17",
        "ruleName": "Use ampersand in parenthetical citations",
        "explanation": "In parenthetical citations, use '&' instead of 'and' between author names.",
        "originalText": "Smith and Jones",
        "suggestedFix": "Smith & Jones",
        "correctedCitation": "(Smith & Jones, 2020)"
      },
      {
        "id": "val-002",
        "citationId": "cite-124",
        "citationText": "(johnson, 2019)",
        "violationType": "capitalization",
        "severity": "error",
        "ruleReference": "APA 6.14",
        "ruleName": "Capitalize author surnames",
        "explanation": "Author surnames should be capitalized.",
        "originalText": "johnson",
        "suggestedFix": "Johnson",
        "correctedCitation": "(Johnson, 2019)"
      }
    ]
  }
}
```

#### GET `/api/v1/citation/document/:documentId/validations`

Get all validation results for a document.

**Query Parameters:**
- `status`: Filter by status (pending, accepted, rejected)
- `severity`: Filter by severity (error, warning, info)
- `type`: Filter by violation type

#### GET `/api/v1/citation/styles`

List available citation styles.

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "code": "apa7",
      "name": "APA 7th Edition",
      "description": "American Psychological Association",
      "isDefault": true
    },
    {
      "code": "mla9",
      "name": "MLA 9th Edition",
      "description": "Modern Language Association"
    },
    {
      "code": "chicago17",
      "name": "Chicago 17th Edition",
      "description": "Chicago Manual of Style (Notes-Bibliography)"
    },
    {
      "code": "ieee",
      "name": "IEEE",
      "description": "Institute of Electrical and Electronics Engineers"
    },
    {
      "code": "vancouver",
      "name": "Vancouver",
      "description": "ICMJE/Vancouver style for medical journals"
    }
  ]
}
```

---

### Correction Endpoints (US-6.1)

#### POST `/api/v1/citation/validation/:validationId/accept`

Accept a suggested correction.

**Response:**
```json
{
  "success": true,
  "data": {
    "validationId": "val-001",
    "status": "accepted",
    "originalText": "(Smith and Jones, 2020)",
    "correctedText": "(Smith & Jones, 2020)",
    "change": {
      "id": "change-001",
      "changeType": "correction",
      "beforeText": "(Smith and Jones, 2020)",
      "afterText": "(Smith & Jones, 2020)"
    }
  }
}
```

#### POST `/api/v1/citation/validation/:validationId/edit`

Apply a manual edit instead of the suggestion.

**Request:**
```json
{
  "correctedText": "(Smith & Jones, 2020, p. 45)"
}
```

#### POST `/api/v1/citation/validation/:validationId/reject`

Reject the validation (mark as intentional).

**Request:**
```json
{
  "reason": "Author preference to use 'and' throughout"
}
```

#### POST `/api/v1/citation/document/:documentId/correct/batch`

Batch correct similar issues.

**Request:**
```json
{
  "validationIds": ["val-001", "val-003", "val-007"],
  "applyAll": false
}
```

Or apply all of a specific type:

```json
{
  "violationType": "author_format",
  "applyAll": true
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "correctedCount": 12,
    "skippedCount": 0,
    "changes": [
      {
        "id": "change-001",
        "citationId": "cite-123",
        "beforeText": "(Smith and Jones, 2020)",
        "afterText": "(Smith & Jones, 2020)"
      }
      // ... more changes
    ]
  }
}
```

#### GET `/api/v1/citation/document/:documentId/changes`

Get all tracked changes for a document.

**Response:**
```json
{
  "success": true,
  "data": {
    "changes": [
      {
        "id": "change-001",
        "changeType": "correction",
        "citationId": "cite-123",
        "beforeText": "(Smith and Jones, 2020)",
        "afterText": "(Smith & Jones, 2020)",
        "appliedBy": "user-123",
        "appliedAt": "2026-02-05T10:30:00Z",
        "isReverted": false
      }
    ],
    "totalChanges": 15,
    "canUndo": true
  }
}
```

#### POST `/api/v1/citation/change/:changeId/revert`

Undo a specific change.

---

### Reference List Endpoints (US-6.3)

#### POST `/api/v1/citation/document/:documentId/reference-list/generate`

Generate reference list from in-text citations.

**Request:**
```json
{
  "styleCode": "apa7",
  "options": {
    "enrichFromCrossRef": true,
    "enrichFromPubMed": true,
    "includeAccessDates": true
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "documentId": "doc-123",
    "styleCode": "apa7",
    "status": "draft",
    "summary": {
      "totalEntries": 25,
      "enrichedFromCrossRef": 18,
      "enrichedFromPubMed": 3,
      "manualEntries": 4,
      "needsReview": 2
    },
    "entries": [
      {
        "id": "ref-001",
        "citationIds": ["cite-005", "cite-012"],
        "sourceType": "journal",
        "authors": [
          {"lastName": "Smith", "firstName": "John", "suffix": null},
          {"lastName": "Jones", "firstName": "Mary", "suffix": "Jr."}
        ],
        "year": "2020",
        "title": "The impact of climate change on biodiversity",
        "journalName": "Nature",
        "volume": "580",
        "issue": "7802",
        "pages": "252-259",
        "doi": "10.1038/s41586-020-2175-0",
        "formatted": "Smith, J., & Jones, M., Jr. (2020). The impact of climate change on biodiversity. *Nature*, *580*(7802), 252-259. https://doi.org/10.1038/s41586-020-2175-0",
        "enrichmentSource": "crossref",
        "enrichmentConfidence": 0.95,
        "needsReview": false
      },
      {
        "id": "ref-002",
        "citationIds": ["cite-008"],
        "sourceType": "book",
        "authors": [
          {"lastName": "Williams", "firstName": "Sarah", "suffix": null}
        ],
        "year": "2019",
        "title": "Introduction to data science",
        "publisher": "O'Reilly Media",
        "publisherLocation": "Sebastopol, CA",
        "isbn": "978-1-491-95289-0",
        "formatted": "Williams, S. (2019). *Introduction to data science*. O'Reilly Media.",
        "enrichmentSource": "manual",
        "enrichmentConfidence": 0.7,
        "needsReview": true,
        "reviewReason": "Publisher location not verified"
      }
    ]
  }
}
```

#### POST `/api/v1/citation/document/:documentId/reference-list/enrich`

Re-run enrichment for specific entries.

**Request:**
```json
{
  "entryIds": ["ref-002", "ref-005"],
  "sources": ["crossref", "pubmed"]
}
```

#### PATCH `/api/v1/citation/reference-list/:entryId`

Edit a reference list entry.

**Request:**
```json
{
  "authors": [
    {"lastName": "Williams", "firstName": "Sarah A.", "suffix": null}
  ],
  "publisherLocation": "Sebastopol, CA"
}
```

#### POST `/api/v1/citation/document/:documentId/reference-list/finalize`

Finalize the reference list (mark as complete).

**Request:**
```json
{
  "styleCode": "apa7"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "status": "finalized",
    "formattedList": "References\n\nSmith, J., & Jones, M., Jr. (2020). The impact of...\n\nWilliams, S. A. (2019). Introduction to data science...",
    "entryCount": 25,
    "wordCount": 1250
  }
}
```

#### GET `/api/v1/citation/document/:documentId/reference-list/export`

Export reference list in various formats.

**Query Parameters:**
- `format`: "text", "html", "docx", "bibtex"

---

## 6. AI Prompts & Integration

### Validation Prompt (US-5.1)

```typescript
// src/services/citation/citation-validation.service.ts

const VALIDATION_PROMPT = `You are an expert citation style guide validator. Analyze the following citation against ${styleName} rules.

CITATION:
"${citationText}"

CITATION TYPE: ${citationType} (${isInText ? 'in-text' : 'reference entry'})

PARSED COMPONENTS:
${JSON.stringify(parsedComponents, null, 2)}

CONTEXT: ${sectionContext}

STYLE GUIDE: ${styleName}

Check for violations in these categories:
1. PUNCTUATION: Commas, periods, colons, semicolons, parentheses
2. CAPITALIZATION: Author names, titles, proper nouns
3. AUTHOR FORMAT: Name order, initials, "et al." usage, ampersand vs "and"
4. DATE FORMAT: Year placement, "n.d." for missing dates, date ranges
5. ITALICS: Journal names, book titles, volume numbers
6. ORDER: Multiple authors, multiple citations in same parentheses

For each violation found, provide:
- violationType: category from above
- ruleReference: specific rule number (e.g., "APA 8.17")
- ruleName: brief rule description
- explanation: why this is incorrect
- originalText: the problematic portion
- suggestedFix: corrected text
- severity: "error" (must fix) or "warning" (recommendation)

IMPORTANT CONTEXT RULES:
- "n.d." is acceptable when publication date is unavailable
- "et al." is acceptable for 3+ authors after first citation
- Some style variations are acceptable (check ${styleName} specifically)

Return a JSON object:
{
  "isValid": boolean,
  "violations": [array of violations],
  "correctedCitation": "full corrected citation if violations exist"
}

Return {"isValid": true, "violations": [], "correctedCitation": null} if no violations found.`;
```

### Correction Prompt (US-6.1)

```typescript
// src/services/citation/citation-correction.service.ts

const CORRECTION_PROMPT = `You are an expert citation formatter. Convert the following citation to ${targetStyle} format.

ORIGINAL CITATION:
"${originalText}"

PARSED COMPONENTS:
${JSON.stringify(parsedComponents, null, 2)}

CITATION TYPE: ${citationType}

TARGET STYLE: ${targetStyle}

${targetStyle} RULES FOR THIS CITATION TYPE:
${relevantRules}

Generate the correctly formatted citation. Ensure:
1. All components are in the correct order for ${targetStyle}
2. Punctuation follows ${targetStyle} rules exactly
3. Capitalization is correct (title case vs sentence case)
4. Italics are applied correctly (mark with *asterisks*)
5. Author names are formatted correctly (initials, order, et al.)

Return a JSON object:
{
  "correctedCitation": "the fully corrected citation",
  "changes": [
    {
      "original": "what was changed",
      "corrected": "what it changed to",
      "rule": "rule reference"
    }
  ],
  "confidence": 0.0-1.0
}`;
```

### Reference List Generation Prompt (US-6.3)

```typescript
// src/services/citation/reference-list.service.ts

const REFERENCE_FORMAT_PROMPT = `Format the following reference entry in ${styleName} style.

SOURCE TYPE: ${sourceType}

METADATA:
${JSON.stringify(metadata, null, 2)}

${styleName} FORMAT RULES FOR ${sourceType.toUpperCase()}:
${styleRulesForType}

Format the complete reference entry. Include:
- All available metadata in correct order
- Proper punctuation and spacing
- Italics marked with *asterisks*
- DOI as URL if available (https://doi.org/...)
- Hanging indent formatting (indicate with "  " two spaces for continuation lines)

Return a JSON object:
{
  "formatted": "the formatted reference entry",
  "sortKey": "key for alphabetical sorting (usually author last name + year)",
  "missingFields": ["list of recommended but missing fields"],
  "confidence": 0.0-1.0
}`;
```

### CrossRef Enrichment

```typescript
// src/services/citation/crossref.service.ts

async function enrichFromCrossRef(doi: string): Promise<EnrichedMetadata> {
  const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
    headers: {
      'User-Agent': 'Ninja-Citation-Tool/1.0 (mailto:support@ninja.com)'
    }
  });

  if (!response.ok) {
    throw new Error(`CrossRef lookup failed: ${response.status}`);
  }

  const data = await response.json();
  const work = data.message;

  return {
    authors: work.author?.map(a => ({
      firstName: a.given,
      lastName: a.family,
      suffix: a.suffix
    })) || [],
    title: work.title?.[0] || '',
    year: work.published?.['date-parts']?.[0]?.[0]?.toString(),
    journalName: work['container-title']?.[0],
    volume: work.volume,
    issue: work.issue,
    pages: work.page,
    doi: work.DOI,
    url: work.URL,
    publisher: work.publisher,
    type: mapCrossRefType(work.type),
    source: 'crossref',
    confidence: 0.95
  };
}
```

---

## 7. Frontend Components

### Component Tree

```
src/components/citation/
├── validation/
│   ├── ValidationPanel.tsx        # Main validation UI
│   ├── StyleSelector.tsx          # Style guide dropdown
│   ├── ViolationList.tsx          # List of violations
│   ├── ViolationCard.tsx          # Single violation with actions
│   ├── RuleReference.tsx          # Expandable rule explanation
│   ├── ValidationSummary.tsx      # Stats overview
│   └── BatchCorrectionModal.tsx   # Batch fix dialog
├── correction/
│   ├── CorrectionPreview.tsx      # Before/after comparison
│   ├── InlineEditor.tsx           # Edit corrected text
│   ├── AcceptRejectButtons.tsx    # Action buttons
│   └── ChangeHistory.tsx          # List of applied changes
├── reference-list/
│   ├── ReferenceListGenerator.tsx # Main generation UI
│   ├── ReferenceEntryCard.tsx     # Single entry with edit
│   ├── EntryEditor.tsx            # Edit entry metadata
│   ├── EnrichmentStatus.tsx       # CrossRef/PubMed status
│   ├── ReferenceListPreview.tsx   # Formatted preview
│   └── ExportOptions.tsx          # Export format selection
└── shared/
    ├── CitationHighlight.tsx      # Highlight errors in text
    ├── StyleBadge.tsx             # Style indicator
    └── ConfidenceIndicator.tsx    # Confidence score display
```

### Key Component Designs

#### ValidationPanel.tsx

```tsx
interface ValidationPanelProps {
  documentId: string;
  citations: Citation[];
}

export function ValidationPanel({ documentId, citations }: ValidationPanelProps) {
  const [selectedStyle, setSelectedStyle] = useState<string>('apa7');
  const { data: styles } = useCitationStyles();
  const validateMutation = useValidateCitations();
  const { data: validations, isLoading } = useValidations(documentId);

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Citation Validation</h2>
        <div className="flex items-center gap-3">
          <StyleSelector
            styles={styles}
            selected={selectedStyle}
            onChange={setSelectedStyle}
          />
          <Button
            onClick={() => validateMutation.mutate({ documentId, styleCode: selectedStyle })}
            loading={validateMutation.isPending}
          >
            Validate All
          </Button>
        </div>
      </div>

      {/* Summary */}
      {validations && <ValidationSummary data={validations.summary} />}

      {/* Violations List */}
      <ViolationList
        violations={validations?.violations || []}
        isLoading={isLoading}
        onAccept={handleAccept}
        onReject={handleReject}
        onEdit={handleEdit}
      />

      {/* Batch Correction */}
      {validations?.violations.length > 0 && (
        <BatchCorrectionModal
          violations={validations.violations}
          onApplyBatch={handleBatchCorrect}
        />
      )}
    </div>
  );
}
```

#### ViolationCard.tsx

```tsx
interface ViolationCardProps {
  violation: CitationValidation;
  onAccept: () => void;
  onReject: () => void;
  onEdit: (text: string) => void;
}

export function ViolationCard({ violation, onAccept, onReject, onEdit }: ViolationCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editText, setEditText] = useState(violation.suggestedFix);

  return (
    <Card className={cn(
      'p-4 border-l-4',
      violation.severity === 'error' ? 'border-l-red-500' : 'border-l-yellow-500'
    )}>
      {/* Citation text with error highlighted */}
      <div className="mb-3">
        <CitationHighlight
          text={violation.citationText}
          errorText={violation.originalText}
        />
      </div>

      {/* Rule reference */}
      <RuleReference
        reference={violation.ruleReference}
        name={violation.ruleName}
        explanation={violation.explanation}
      />

      {/* Before/After comparison */}
      <CorrectionPreview
        before={violation.originalText}
        after={violation.suggestedFix}
      />

      {/* Actions */}
      <div className="flex items-center gap-2 mt-4">
        <Button variant="success" size="sm" onClick={onAccept}>
          <Check className="h-4 w-4 mr-1" />
          Accept
        </Button>
        <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
          <Edit className="h-4 w-4 mr-1" />
          Edit
        </Button>
        <Button variant="ghost" size="sm" onClick={onReject}>
          <X className="h-4 w-4 mr-1" />
          Ignore
        </Button>
      </div>

      {/* Inline editor */}
      {isEditing && (
        <InlineEditor
          value={editText}
          onChange={setEditText}
          onSave={() => {
            onEdit(editText);
            setIsEditing(false);
          }}
          onCancel={() => setIsEditing(false)}
        />
      )}
    </Card>
  );
}
```

#### ReferenceListGenerator.tsx

```tsx
interface ReferenceListGeneratorProps {
  documentId: string;
}

export function ReferenceListGenerator({ documentId }: ReferenceListGeneratorProps) {
  const [selectedStyle, setSelectedStyle] = useState<string>('apa7');
  const generateMutation = useGenerateReferenceList();
  const { data: referenceList, isLoading } = useReferenceList(documentId);
  const finalizeMutation = useFinalizeReferenceList();

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">Reference List</h2>
        <div className="flex items-center gap-3">
          <StyleSelector
            selected={selectedStyle}
            onChange={setSelectedStyle}
          />
          <Button
            onClick={() => generateMutation.mutate({ documentId, styleCode: selectedStyle })}
            loading={generateMutation.isPending}
          >
            Generate
          </Button>
        </div>
      </div>

      {/* Generation status */}
      {referenceList && (
        <EnrichmentStatus
          enrichedCount={referenceList.summary.enrichedFromCrossRef}
          totalCount={referenceList.summary.totalEntries}
          needsReviewCount={referenceList.summary.needsReview}
        />
      )}

      {/* Entries list */}
      <div className="space-y-3">
        {referenceList?.entries.map(entry => (
          <ReferenceEntryCard
            key={entry.id}
            entry={entry}
            onEdit={handleEdit}
            onReEnrich={handleReEnrich}
          />
        ))}
      </div>

      {/* Preview */}
      {referenceList && (
        <ReferenceListPreview
          entries={referenceList.entries}
          styleCode={selectedStyle}
        />
      )}

      {/* Actions */}
      <div className="flex items-center justify-between pt-4 border-t">
        <ExportOptions documentId={documentId} />
        <Button
          onClick={() => finalizeMutation.mutate({ documentId, styleCode: selectedStyle })}
          disabled={referenceList?.summary.needsReview > 0}
        >
          Finalize Reference List
        </Button>
      </div>
    </div>
  );
}
```

---

## 8. User Flows

### Flow 1: Validate Citations

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. User uploads document or navigates to citation analysis      │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. User selects citation style (APA 7th, MLA 9th, etc.)        │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. User clicks "Validate All"                                   │
│    - System runs AI validation against style rules              │
│    - Each citation checked for violations                       │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. System displays validation summary                           │
│    - Total citations: 45                                        │
│    - Valid: 38                                                  │
│    - Errors: 5                                                  │
│    - Warnings: 2                                                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. User reviews each violation:                                 │
│    - Sees original text highlighted                             │
│    - Sees rule reference (e.g., "APA 8.17")                    │
│    - Sees suggested correction                                  │
│    - Chooses: Accept / Edit / Ignore                           │
└─────────────────────────────────────────────────────────────────┘
```

### Flow 2: Batch Correction

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. After validation, user sees multiple similar violations      │
│    (e.g., 12 instances of "and" instead of "&")                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. User clicks "Fix All Similar Issues"                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. System shows batch correction preview:                       │
│    ┌─────────────────────────────────────────────────────────┐ │
│    │ Fix 12 instances of "Use ampersand in citations"        │ │
│    │                                                          │ │
│    │ ☑ (Smith and Jones, 2020) → (Smith & Jones, 2020)      │ │
│    │ ☑ (Davis and Lee, 2019) → (Davis & Lee, 2019)          │ │
│    │ ☑ (Brown and White, 2021) → (Brown & White, 2021)      │ │
│    │ ... and 9 more                                          │ │
│    │                                                          │ │
│    │ [Cancel]                    [Apply All Selected]        │ │
│    └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. User confirms, system applies all corrections                │
│    - Changes tracked for undo/review                            │
└─────────────────────────────────────────────────────────────────┘
```

### Flow 3: Generate Reference List

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. User clicks "Generate Reference List"                        │
│    - Selects target style (APA 7th)                            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. System extracts unique citations from document               │
│    - Groups multiple in-text citations to same source          │
│    - Identifies: 25 unique references                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. System enriches metadata from external sources               │
│    - CrossRef: 18 found (DOI lookup)                           │
│    - PubMed: 3 found (medical journals)                        │
│    - Manual/AI: 4 (no external match)                          │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. System shows draft reference list                            │
│    - Each entry formatted in target style                       │
│    - Entries needing review flagged                            │
│    - Confidence scores shown                                    │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. User reviews and edits entries:                              │
│    - Edit metadata (author names, titles)                      │
│    - Re-run enrichment for specific entries                    │
│    - Reorder if needed                                         │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. User finalizes and exports:                                  │
│    - Preview formatted list                                     │
│    - Export as text, HTML, or Word                             │
│    - Copy to clipboard                                          │
└─────────────────────────────────────────────────────────────────┘
```

---

## 9. Technical Implementation

### Service Structure

```
src/services/citation/
├── citation-validation.service.ts    # US-5.1 validation logic
├── citation-correction.service.ts    # US-6.1 correction logic
├── reference-list.service.ts         # US-6.3 generation logic
├── style-rules.service.ts            # Style guide rules engine
├── crossref.service.ts               # CrossRef API integration
├── pubmed.service.ts                 # PubMed API integration
└── change-tracking.service.ts        # Track all changes
```

### Style Rules Engine

```typescript
// src/services/citation/style-rules.service.ts

interface StyleRule {
  id: string;
  reference: string;      // "APA 8.17"
  name: string;           // "Use ampersand in parenthetical citations"
  category: string;       // "author_format"
  pattern: RegExp;        // Pattern to detect violation
  replacement: string;    // Replacement pattern
  context?: string[];     // When this rule applies
  severity: 'error' | 'warning';
}

const APA7_RULES: StyleRule[] = [
  {
    id: 'apa7-ampersand',
    reference: 'APA 8.17',
    name: 'Use ampersand in parenthetical citations',
    category: 'author_format',
    pattern: /\(([^)]+)\s+and\s+([^)]+),\s*(\d{4})\)/gi,
    replacement: '($1 & $2, $3)',
    context: ['parenthetical'],
    severity: 'error'
  },
  {
    id: 'apa7-etal',
    reference: 'APA 8.17',
    name: 'Use et al. for 3+ authors',
    category: 'author_format',
    pattern: /\(([^,]+),\s*([^,]+),\s*([^,]+),.*?,\s*(\d{4})\)/gi,
    replacement: '($1 et al., $4)',
    context: ['parenthetical', 'subsequent'],
    severity: 'error'
  },
  {
    id: 'apa7-comma-before-year',
    reference: 'APA 8.11',
    name: 'Comma before year in parenthetical citations',
    category: 'punctuation',
    pattern: /\(([^,)]+)\s+(\d{4})\)/gi,
    replacement: '($1, $2)',
    context: ['parenthetical'],
    severity: 'error'
  },
  // ... more rules
];

export class StyleRulesService {
  private rules: Map<string, StyleRule[]> = new Map();

  constructor() {
    this.rules.set('apa7', APA7_RULES);
    this.rules.set('mla9', MLA9_RULES);
    this.rules.set('chicago17', CHICAGO17_RULES);
  }

  getRulesForStyle(styleCode: string): StyleRule[] {
    return this.rules.get(styleCode) || [];
  }

  validateCitation(
    citation: ParsedCitation,
    styleCode: string,
    context: string
  ): ValidationResult[] {
    const rules = this.getRulesForStyle(styleCode);
    const violations: ValidationResult[] = [];

    for (const rule of rules) {
      if (rule.context && !rule.context.includes(context)) {
        continue;
      }

      if (rule.pattern.test(citation.text)) {
        violations.push({
          ruleReference: rule.reference,
          ruleName: rule.name,
          violationType: rule.category,
          originalText: citation.text.match(rule.pattern)?.[0] || '',
          suggestedFix: citation.text.replace(rule.pattern, rule.replacement),
          severity: rule.severity
        });
      }
    }

    return violations;
  }
}
```

### Change Tracking

```typescript
// src/services/citation/change-tracking.service.ts

export class ChangeTrackingService {
  async trackChange(
    documentId: string,
    change: {
      citationId?: string;
      referenceId?: string;
      changeType: 'correction' | 'insertion' | 'deletion' | 'reorder';
      beforeText: string;
      afterText: string;
      userId: string;
    }
  ): Promise<CitationChange> {
    return prisma.citationChange.create({
      data: {
        documentId,
        citationId: change.citationId,
        referenceId: change.referenceId,
        changeType: change.changeType,
        beforeText: change.beforeText,
        afterText: change.afterText,
        appliedBy: change.userId,
      }
    });
  }

  async revertChange(changeId: string, userId: string): Promise<void> {
    const change = await prisma.citationChange.findUnique({
      where: { id: changeId }
    });

    if (!change || change.isReverted) {
      throw new Error('Change not found or already reverted');
    }

    // Apply reverse change
    if (change.citationId) {
      await prisma.citation.update({
        where: { id: change.citationId },
        data: { rawText: change.beforeText }
      });
    }

    // Mark as reverted
    await prisma.citationChange.update({
      where: { id: changeId },
      data: {
        isReverted: true,
        revertedAt: new Date()
      }
    });
  }

  async getChangesForDocument(documentId: string): Promise<CitationChange[]> {
    return prisma.citationChange.findMany({
      where: { documentId },
      orderBy: { appliedAt: 'desc' }
    });
  }
}
```

---

## 10. Testing Strategy

### Unit Tests

```typescript
// src/services/citation/__tests__/citation-validation.service.test.ts

describe('CitationValidationService', () => {
  describe('validateCitation', () => {
    it('should detect ampersand violation in APA', async () => {
      const citation = {
        text: '(Smith and Jones, 2020)',
        type: 'parenthetical'
      };

      const violations = await service.validateCitation(citation, 'apa7');

      expect(violations).toHaveLength(1);
      expect(violations[0].ruleReference).toBe('APA 8.17');
      expect(violations[0].suggestedFix).toBe('(Smith & Jones, 2020)');
    });

    it('should accept n.d. for missing date', async () => {
      const citation = {
        text: '(Smith, n.d.)',
        type: 'parenthetical'
      };

      const violations = await service.validateCitation(citation, 'apa7');

      expect(violations).toHaveLength(0);
    });

    it('should detect missing comma before year', async () => {
      const citation = {
        text: '(Smith 2020)',
        type: 'parenthetical'
      };

      const violations = await service.validateCitation(citation, 'apa7');

      expect(violations).toContainEqual(
        expect.objectContaining({
          violationType: 'punctuation',
          suggestedFix: '(Smith, 2020)'
        })
      );
    });
  });
});
```

### Integration Tests

```typescript
// src/services/citation/__tests__/reference-list.integration.test.ts

describe('ReferenceListService Integration', () => {
  it('should enrich citation from CrossRef by DOI', async () => {
    const doi = '10.1038/s41586-020-2175-0';

    const enriched = await service.enrichFromDoi(doi);

    expect(enriched.authors).toContainEqual(
      expect.objectContaining({ lastName: expect.any(String) })
    );
    expect(enriched.journalName).toBeDefined();
    expect(enriched.year).toBeDefined();
  });

  it('should generate formatted reference list', async () => {
    const documentId = 'test-doc';
    await seedTestCitations(documentId);

    const result = await service.generateReferenceList(documentId, 'apa7');

    expect(result.entries).toHaveLength(5);
    expect(result.entries[0].formatted).toMatch(/\(\d{4}\)/); // Year in parens
  });
});
```

### E2E Tests

```typescript
// e2e/citation-validation.spec.ts

describe('Citation Validation Flow', () => {
  it('should validate and correct citations', async () => {
    // Upload document
    await page.goto('/citation/upload');
    await page.setInputFiles('input[type="file"]', 'fixtures/test-doc.docx');

    // Select style and validate
    await page.selectOption('[data-testid="style-selector"]', 'apa7');
    await page.click('[data-testid="validate-button"]');

    // Wait for results
    await expect(page.locator('[data-testid="validation-summary"]')).toBeVisible();

    // Check violation count
    const errorCount = await page.locator('[data-testid="error-count"]').textContent();
    expect(parseInt(errorCount)).toBeGreaterThan(0);

    // Accept first correction
    await page.click('[data-testid="violation-card"]:first-child [data-testid="accept-button"]');

    // Verify change applied
    await expect(page.locator('[data-testid="change-history"]')).toContainText('Correction applied');
  });
});
```

---

## Appendix: Style Guide Quick Reference

### APA 7th Edition Key Rules

| Rule | Reference | Description |
|------|-----------|-------------|
| Ampersand | 8.17 | Use & in parenthetical, "and" in narrative |
| Et al. | 8.17 | 3+ authors: first author et al. |
| Comma before year | 8.11 | (Author, year) |
| Multiple citations | 8.12 | Alphabetical, semicolon separated |
| No date | 8.14 | Use (n.d.) |
| Title italics | 9.19 | Italicize book/journal titles |

### MLA 9th Edition Key Rules

| Rule | Reference | Description |
|------|-----------|-------------|
| Author name | 2.1 | Last, First Middle. |
| No year in text | Core | Year at end of entry only |
| Quotation marks | 2.2 | Article titles in quotes |
| Italics | 2.3 | Book/journal titles |
| Container | 3.1 | Source within larger source |

### Chicago 17th Key Rules (Notes-Bibliography)

| Rule | Reference | Description |
|------|-----------|-------------|
| Footnote format | 14.19 | First: full citation; subsequent: short |
| Ibid | 14.34 | Same source as previous note |
| Author name | 14.21 | First Last in notes, Last, First in bib |
| Comma vs period | 14.23 | Commas in notes, periods in bib |

---

**Document Version**: 1.0
**Last Updated**: February 2026
**Author**: Development Team
