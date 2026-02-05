# Citation API Reference for Frontend

## Overview

All citation features are accessed through a single flow:
1. **Upload & Detect** - Upload a document to find citations
2. **View Citations** - See all detected citations with parsed components
3. **Validate Style** - Check citations against a style guide (APA, MLA, etc.)
4. **Apply Corrections** - Accept AI suggestions or make manual edits
5. **Generate Reference List** - Create formatted bibliography

**Base URL:** `/api/v1/citation`

---

## Authentication

All endpoints except `/styles` require a Bearer token:
```
Authorization: Bearer <access_token>
```

---

## 1. Citation Detection

### Upload & Detect Citations
```
POST /detect
Content-Type: multipart/form-data
```

**Request:**
| Field | Type | Required | Description |
|-------|------|----------|-------------|
| file | File | Yes | DOCX, PDF, TXT, or EPUB file (max 100MB) |

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "212111c5-3f4d-45f8-9b7f-404479e41596",
    "documentId": "e9837297-14bb-4254-bb46-41a8792db026",
    "citationCount": 12,
    "processingTimeMs": 13201
  }
}
```

**Important:** Store BOTH `jobId` and `documentId` - they're used for different endpoints.

---

## 2. View Detected Citations

### List Citations for a Job
```
GET /job/:jobId?page=1&limit=20
```

**Response:**
```json
{
  "success": true,
  "data": {
    "citations": [
      {
        "id": "cit_abc123",
        "rawText": "(Smith et al., 2023)",
        "citationType": "parenthetical",
        "confidence": 0.95,
        "location": { "paragraph": 3, "sentence": 2 },
        "components": {
          "authors": [
            { "lastName": "Smith", "firstName": null, "isEtAl": true }
          ],
          "year": "2023",
          "pages": null
        }
      }
    ],
    "pagination": {
      "page": 1,
      "limit": 20,
      "total": 12,
      "totalPages": 1
    }
  }
}
```

### Get Citation Statistics
```
GET /document/:documentId/stats
```

**Response:**
```json
{
  "success": true,
  "data": {
    "total": 12,
    "byType": {
      "parenthetical": 8,
      "narrative": 3,
      "numeric": 1
    },
    "byConfidence": {
      "high": 10,
      "medium": 2,
      "low": 0
    }
  }
}
```

---

## 3. Style Validation

### Get Available Styles (Public - No Auth)
```
GET /styles
```

**Response:**
```json
{
  "success": true,
  "data": [
    { "code": "apa7", "name": "APA 7th Edition", "version": "7th" },
    { "code": "mla9", "name": "MLA 9th Edition", "version": "9th" },
    { "code": "chicago17", "name": "Chicago 17th Edition", "version": "17th" },
    { "code": "vancouver", "name": "Vancouver", "version": "ICMJE" },
    { "code": "ieee", "name": "IEEE", "version": "2024" }
  ]
}
```

### Validate Document Citations
```
POST /document/:documentId/validate
Content-Type: application/json
```

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
    "validations": [
      {
        "id": "val_xyz789",
        "citationId": "cit_abc123",
        "styleCode": "apa7",
        "violationType": "punctuation",
        "severity": "error",
        "status": "pending",
        "ruleReference": "APA 8.17",
        "ruleName": "Ampersand in parenthetical citations",
        "explanation": "Use '&' instead of 'and' between author names in parenthetical citations",
        "originalText": "(Smith and Jones, 2023)",
        "suggestedFix": "(Smith & Jones, 2023)"
      }
    ],
    "summary": {
      "total": 5,
      "byStatus": { "pending": 5, "accepted": 0, "rejected": 0 },
      "bySeverity": { "error": 3, "warning": 2, "info": 0 }
    }
  }
}
```

### Get Validation Results
```
GET /document/:documentId/validations?status=pending&severity=error
```

**Query Parameters:**
| Param | Values | Description |
|-------|--------|-------------|
| status | pending, accepted, rejected, edited | Filter by status |
| severity | error, warning, info | Filter by severity |
| violationType | punctuation, capitalization, author_format, date_format, italics | Filter by type |

---

## 4. Apply Corrections

### Accept AI Suggestion
```
POST /validation/:validationId/accept
```

**Response:**
```json
{
  "success": true,
  "data": {
    "correctedText": "(Smith & Jones, 2023)",
    "changeId": "chg_001"
  }
}
```

### Reject Suggestion
```
POST /validation/:validationId/reject
Content-Type: application/json
```

**Request:**
```json
{
  "reason": "Optional reason for rejection"
}
```

### Apply Manual Edit
```
POST /validation/:validationId/edit
Content-Type: application/json
```

**Request:**
```json
{
  "correctedText": "(Smith & Jones, 2023, p. 45)"
}
```

### Batch Correct by Type
```
POST /document/:documentId/correct/batch
Content-Type: application/json
```

**Request:**
```json
{
  "violationType": "punctuation",
  "applyAll": true
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "correctedCount": 8,
    "skippedCount": 2
  }
}
```

### View Change History
```
GET /document/:documentId/changes
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": "chg_001",
      "citationId": "cit_abc123",
      "beforeText": "(Smith and Jones, 2023)",
      "afterText": "(Smith & Jones, 2023)",
      "changeType": "auto_correction",
      "createdAt": "2026-02-05T10:30:00Z"
    }
  ]
}
```

### Revert a Change
```
POST /change/:changeId/revert
```

---

## 5. Reference List Generation

### Generate Reference List
```
POST /document/:documentId/reference-list/generate
Content-Type: application/json
```

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
    "entries": [
      {
        "id": "ref_001",
        "citationIds": ["cit_abc123"],
        "authors": [
          { "lastName": "Smith", "firstName": "John" },
          { "lastName": "Jones", "firstName": "Mary" }
        ],
        "year": "2023",
        "title": "Understanding AI in Publishing",
        "sourceType": "journal",
        "journal": "Journal of Digital Publishing",
        "volume": "15",
        "issue": "3",
        "pages": "45-67",
        "doi": "10.1234/jdp.2023.001",
        "formattedApa": "Smith, J., & Jones, M. (2023). Understanding AI in publishing. Journal of Digital Publishing, 15(3), 45-67. https://doi.org/10.1234/jdp.2023.001",
        "isEdited": false,
        "crossrefEnriched": true,
        "confidence": 0.95
      }
    ],
    "stats": {
      "total": 12,
      "enrichedWithDoi": 8,
      "needsReview": 2
    }
  }
}
```

### Update Reference Entry
```
PATCH /reference-list/:entryId
Content-Type: application/json
```

**Request:**
```json
{
  "title": "Updated Title",
  "year": "2024",
  "authors": [
    { "lastName": "Smith", "firstName": "John A." }
  ]
}
```

### Finalize Reference List
```
POST /document/:documentId/reference-list/finalize
Content-Type: application/json
```

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
    "formattedList": "Smith, J., & Jones, M. (2023). Understanding AI in publishing...\n\nDoe, J. (2022). Another reference...",
    "status": "finalized"
  }
}
```

---

## Frontend UI Structure

### Recommended Page Layout

```
/jobs                          → Jobs List Page
    ↓ click "View" on citation job
/citations/:documentId         → Citations Page (single page with tabs)
    ├── Tab: Detected (default)
    │   └── List of all citations with parsed components
    ├── Tab: Style Validation
    │   ├── Style dropdown (populated from GET /styles)
    │   ├── "Validate All" button
    │   └── Violations list with Accept/Reject/Edit actions
    └── Tab: Reference List
        ├── Style dropdown
        ├── "Generate" button
        ├── Editable reference entries
        └── "Finalize" button
```

### Data to Store After Detection

```javascript
// After POST /detect completes:
const citationSession = {
  jobId: response.data.jobId,        // For: GET /job/:jobId (list citations)
  documentId: response.data.documentId  // For: All validation & reference endpoints
};

// Pass documentId in URL: /citations/e9837297-14bb-4254-bb46-41a8792db026
```

---

## Error Responses

All errors follow this format:
```json
{
  "success": false,
  "error": {
    "message": "Document not found",
    "code": "NOT_FOUND",
    "requestId": "req_abc123"
  }
}
```

| HTTP Status | Meaning |
|-------------|---------|
| 400 | Bad request (missing/invalid parameters) |
| 401 | Authentication required or token expired |
| 404 | Resource not found |
| 500 | Server error |
