# EPUB Remediation Visual Comparison - Design Document

**Version:** 1.0
**Date:** January 7, 2026
**Status:** Proposed
**Author:** Claude Code

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Goals & Objectives](#goals--objectives)
3. [Current State Analysis](#current-state-analysis)
4. [Feature Requirements](#feature-requirements)
5. [System Architecture](#system-architecture)
6. [Database Design](#database-design)
7. [API Design](#api-design)
8. [Frontend Design](#frontend-design)
9. [Workflow Integration](#workflow-integration)
10. [ACR Workflow Integration](#acr-workflow-integration)
11. [PDF Export](#pdf-export)
12. [Reject/Undo Changes](#rejectundo-changes)
13. [Implementation Phases](#implementation-phases)
14. [Security Considerations](#security-considerations)
15. [Performance Considerations](#performance-considerations)

---

## Executive Summary

This document outlines the design for a **Visual Comparison Feature** that enables users to review remediation changes side-by-side, stepping through each issue with before/after XML views. The feature integrates with the existing EPUB Remediation workflow and ACR (Accessibility Conformance Review) workflow, includes PDF export for audit trails, and optionally supports rejecting/undoing individual changes.

### Key Capabilities

- Side-by-side visual comparison of XML before and after remediation
- Step-through navigation for each remediated issue
- Syntax-highlighted code diff view
- PDF export for compliance documentation
- Optional: Reject/undo individual changes with re-generation of EPUB
- Integration with EPUB Remediation and ACR workflows

---

## Goals & Objectives

### Primary Goals

1. **Transparency** - Show users exactly what changed during remediation
2. **Quality Assurance** - Enable reviewers to validate fixes are correct
3. **Audit Trail** - Generate exportable reports for compliance documentation
4. **Trust** - Build confidence in automated remediation through visibility

### Success Metrics

- Users can review 100% of remediation changes
- PDF export contains all change details for audit purposes
- Average time to review remediation reduced by visual comparison
- User satisfaction with remediation transparency

---

## Current State Analysis

### Existing Change Tracking

The current remediation engine tracks changes via `ModificationResult`:

```typescript
type ModificationResult = {
  success: boolean;
  filePath: string;
  modificationType: string;
  description: string;
  before?: string;      // Original content snippet
  after?: string;       // Modified content snippet
};
```

### Existing Services

| Service | Purpose | Relevant Methods |
|---------|---------|------------------|
| `epub.controller.ts` | Main remediation logic | `applyQuickFix`, `runAutoRemediation`, `getComparison` |
| `remediation.service.ts` | Remediation plan management | `createRemediationPlan`, `updateTaskStatus` |
| Comparison Service | File-level diff | `getComparison(jobId)` |

### Data Currently Available

- **Job.output** - Contains audit results and auto-remediation summary
- **RemediationTask** - Individual tasks with status tracking
- **ModificationResult** - Per-change tracking with optional before/after
- **Comparison Report** - Generated but not granularly stored

### Gaps Identified

1. **No persistent change log** - Changes not stored in database, only in Job output
2. **Limited before/after** - Only captured for quick fixes, not all auto-fixes
3. **No change attribution** - Who approved/rejected not tracked at change level
4. **No rollback capability** - Cannot undo individual changes

---

## Feature Requirements

### Functional Requirements

#### FR-1: Visual Comparison View
- FR-1.1: Display side-by-side before/after XML for each change
- FR-1.2: Syntax highlighting for XML/XHTML content
- FR-1.3: Inline diff highlighting (red for removed, green for added)
- FR-1.4: Show file path and line number context

#### FR-2: Issue Navigation
- FR-2.1: Step through issues one at a time (Previous/Next)
- FR-2.2: Jump to specific issue by number or type
- FR-2.3: Filter issues by status (fixed, skipped, failed)
- FR-2.4: Filter issues by type (alt-text, heading, language, etc.)
- FR-2.5: Show progress indicator (Issue X of Y)

#### FR-3: Change Details
- FR-3.1: Display WCAG criterion for each issue
- FR-3.2: Show issue severity (Critical, Major, Minor)
- FR-3.3: Display fix description and rationale
- FR-3.4: Show original audit message

#### FR-4: PDF Export
- FR-4.1: Export comparison report as PDF
- FR-4.2: Include all changes with before/after code
- FR-4.3: Include summary statistics
- FR-4.4: Include WCAG mapping and compliance status
- FR-4.5: Add timestamp and user attribution

#### FR-5: Reject/Undo Changes (Optional Scope)
- FR-5.1: Allow rejecting individual changes
- FR-5.2: Regenerate EPUB with rejected changes reverted
- FR-5.3: Track rejection reason and user
- FR-5.4: Allow re-applying previously rejected changes

#### FR-6: Workflow Integration
- FR-6.1: Access comparison from remediation workflow
- FR-6.2: Access comparison from ACR workflow
- FR-6.3: Link to original audit results
- FR-6.4: Support re-audit after manual review

### Non-Functional Requirements

- NFR-1: Comparison view loads within 3 seconds for up to 500 changes
- NFR-2: PDF export completes within 30 seconds
- NFR-3: Support EPUBs up to 100MB
- NFR-4: Accessible UI (WCAG 2.1 AA compliant)

---

## System Architecture

### High-Level Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                           Frontend                                   │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐     │
│  │ ComparisonView  │  │ IssueNavigator  │  │ PDFExporter     │     │
│  │ (Side-by-side)  │  │ (Step-through)  │  │ (Report Gen)    │     │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘     │
│           │                    │                    │               │
│           └────────────────────┼────────────────────┘               │
│                                │                                     │
└────────────────────────────────┼─────────────────────────────────────┘
                                 │ REST API
┌────────────────────────────────┼─────────────────────────────────────┐
│                           Backend                                    │
│  ┌─────────────────┐  ┌────────┴────────┐  ┌─────────────────┐     │
│  │ Comparison      │  │ Change          │  │ PDF             │     │
│  │ Controller      │◄─┤ Service         │  │ Generator       │     │
│  └────────┬────────┘  └────────┬────────┘  └────────┬────────┘     │
│           │                    │                    │               │
│  ┌────────┴────────┐  ┌────────┴────────┐  ┌────────┴────────┐     │
│  │ EPUB            │  │ Change          │  │ Artifact        │     │
│  │ Processor       │  │ Repository      │  │ Storage (S3)    │     │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘     │
│                                │                                     │
└────────────────────────────────┼─────────────────────────────────────┘
                                 │
┌────────────────────────────────┼─────────────────────────────────────┐
│                           Database                                   │
│  ┌─────────────────┐  ┌────────┴────────┐  ┌─────────────────┐     │
│  │ RemediationChange│  │ ChangeReview   │  │ ComparisonReport│     │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘     │
└─────────────────────────────────────────────────────────────────────┘
```

### Component Responsibilities

| Component | Responsibility |
|-----------|---------------|
| ComparisonView | Render side-by-side diff with syntax highlighting |
| IssueNavigator | Handle step-through navigation and filtering |
| PDFExporter | Generate and download PDF reports |
| ChangeService | Manage change records and status |
| ComparisonController | API endpoints for comparison data |
| PDFGenerator | Server-side PDF rendering |

---

## Database Design

### New Models

```prisma
// Individual remediation change record
model RemediationChange {
  id              String   @id @default(uuid())
  jobId           String
  job             Job      @relation(fields: [jobId], references: [id], onDelete: Cascade)
  taskId          String?  // Link to remediation task if applicable

  // Change identification
  changeNumber    Int      // Sequential number within job (1, 2, 3...)
  issueId         String?  // Original audit issue ID
  ruleId          String?  // e.g., "WCAG2AA.Principle1.Guideline1_1.1_1_1"

  // Location
  filePath        String   // e.g., "OEBPS/chapter1.xhtml"
  elementXPath    String?  // XPath to modified element
  lineNumber      Int?     // Line number in source file

  // Change content
  changeType      String   // e.g., "add-alt-text", "fix-heading", "add-lang"
  description     String   // Human-readable description
  beforeContent   String?  @db.Text  // Original XML/content
  afterContent    String?  @db.Text  // Modified XML/content
  contextBefore   String?  @db.Text  // Surrounding context (for display)
  contextAfter    String?  @db.Text  // Surrounding context after change

  // Metadata
  severity        String?  // CRITICAL, MAJOR, MINOR, INFO
  wcagCriteria    String?  // e.g., "1.1.1"
  wcagLevel       String?  // A, AA, AAA

  // Status
  status          ChangeStatus @default(APPLIED)
  appliedAt       DateTime @default(now())
  appliedBy       String?  // System or user ID

  // Review (for reject/undo feature)
  reviews         ChangeReview[]

  @@index([jobId])
  @@index([status])
}

enum ChangeStatus {
  APPLIED     // Change was applied
  REJECTED    // Change was rejected by reviewer
  REVERTED    // Change was undone
  FAILED      // Change failed to apply
  SKIPPED     // Change was skipped (manual intervention needed)
}

// Review/approval record for each change
model ChangeReview {
  id              String   @id @default(uuid())
  changeId        String
  change          RemediationChange @relation(fields: [changeId], references: [id], onDelete: Cascade)

  action          ReviewAction
  reason          String?  @db.Text
  notes           String?  @db.Text

  reviewedBy      String
  reviewer        User     @relation(fields: [reviewedBy], references: [id])
  reviewedAt      DateTime @default(now())

  @@index([changeId])
}

enum ReviewAction {
  APPROVED    // Reviewer approved the change
  REJECTED    // Reviewer rejected the change
  FLAGGED     // Reviewer flagged for further review
  COMMENTED   // Reviewer added a comment only
}

// Generated comparison report
model ComparisonReport {
  id              String   @id @default(uuid())
  jobId           String   @unique
  job             Job      @relation(fields: [jobId], references: [id], onDelete: Cascade)

  // Summary stats
  totalChanges    Int
  appliedCount    Int
  rejectedCount   Int
  skippedCount    Int
  failedCount     Int

  // Report content
  reportData      Json?    // Full report data for quick retrieval
  pdfUrl          String?  // S3 URL for generated PDF

  generatedAt     DateTime @default(now())
  generatedBy     String?

  @@index([jobId])
}

// Update Job model to add relation
model Job {
  // ... existing fields ...
  remediationChanges  RemediationChange[]
  comparisonReport    ComparisonReport?
}

// Update User model to add relation
model User {
  // ... existing fields ...
  changeReviews       ChangeReview[]
}
```

### Migration Strategy

1. Create new tables with no data migration required
2. Update remediation service to populate `RemediationChange` records
3. Backfill historical data from Job.output (optional)

---

## API Design

### Endpoints

#### Comparison Data

```
GET /api/v1/jobs/:jobId/comparison
```

Returns comparison summary with all changes.

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "uuid",
    "fileName": "book.epub",
    "summary": {
      "totalChanges": 45,
      "applied": 42,
      "rejected": 2,
      "skipped": 1,
      "failed": 0
    },
    "byType": {
      "add-alt-text": 20,
      "fix-heading": 10,
      "add-lang": 5,
      "fix-table": 7,
      "other": 3
    },
    "bySeverity": {
      "CRITICAL": 15,
      "MAJOR": 20,
      "MINOR": 10
    },
    "changes": [
      {
        "id": "uuid",
        "changeNumber": 1,
        "filePath": "OEBPS/chapter1.xhtml",
        "changeType": "add-alt-text",
        "description": "Added alt text to image",
        "severity": "CRITICAL",
        "wcagCriteria": "1.1.1",
        "status": "APPLIED",
        "beforeContent": "<img src=\"fig1.png\"/>",
        "afterContent": "<img src=\"fig1.png\" alt=\"Bar chart showing Q1 sales\"/>",
        "reviews": []
      }
      // ... more changes
    ]
  }
}
```

#### Get Single Change

```
GET /api/v1/jobs/:jobId/comparison/changes/:changeId
```

Returns detailed change with full context.

**Response:**
```json
{
  "success": true,
  "data": {
    "id": "uuid",
    "changeNumber": 1,
    "filePath": "OEBPS/chapter1.xhtml",
    "elementXPath": "//img[@id='fig1']",
    "lineNumber": 45,
    "changeType": "add-alt-text",
    "description": "Added alt text to decorative image",
    "severity": "CRITICAL",
    "wcagCriteria": "1.1.1",
    "wcagLevel": "A",
    "ruleId": "WCAG2AA.Principle1.Guideline1_1.1_1_1",
    "status": "APPLIED",
    "beforeContent": "<img src=\"fig1.png\" class=\"figure\"/>",
    "afterContent": "<img src=\"fig1.png\" class=\"figure\" alt=\"Bar chart showing quarterly sales: Q1 $1.2M, Q2 $1.5M, Q3 $1.8M, Q4 $2.1M\"/>",
    "contextBefore": "...<p>The following chart shows our growth:</p>\n<img src=\"fig1.png\" class=\"figure\"/>\n<p>As shown above...</p>...",
    "contextAfter": "...<p>The following chart shows our growth:</p>\n<img src=\"fig1.png\" class=\"figure\" alt=\"Bar chart showing quarterly sales: Q1 $1.2M, Q2 $1.5M, Q3 $1.8M, Q4 $2.1M\"/>\n<p>As shown above...</p>...",
    "reviews": [
      {
        "id": "uuid",
        "action": "APPROVED",
        "reason": null,
        "reviewedBy": "user-uuid",
        "reviewerName": "John Doe",
        "reviewedAt": "2026-01-07T10:30:00Z"
      }
    ],
    "appliedAt": "2026-01-07T09:00:00Z"
  }
}
```

#### Review/Reject Change (Optional Scope)

```
POST /api/v1/jobs/:jobId/comparison/changes/:changeId/review
```

**Request:**
```json
{
  "action": "REJECTED",
  "reason": "Alt text is not descriptive enough",
  "notes": "Please use more specific description of the chart data"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "changeId": "uuid",
    "newStatus": "REJECTED",
    "review": {
      "id": "uuid",
      "action": "REJECTED",
      "reason": "Alt text is not descriptive enough",
      "reviewedAt": "2026-01-07T11:00:00Z"
    }
  }
}
```

#### Apply Rejections (Regenerate EPUB)

```
POST /api/v1/jobs/:jobId/comparison/apply-rejections
```

Regenerates EPUB with rejected changes reverted.

**Response:**
```json
{
  "success": true,
  "data": {
    "newJobId": "uuid",
    "newFileId": "uuid",
    "changesReverted": 2,
    "downloadUrl": "/api/v1/files/uuid/download"
  }
}
```

#### Export PDF Report

```
POST /api/v1/jobs/:jobId/comparison/export-pdf
```

Generates and returns PDF download URL.

**Request:**
```json
{
  "includeRejected": true,
  "includeContext": true,
  "groupBy": "file"  // "file" | "type" | "severity"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "reportId": "uuid",
    "pdfUrl": "https://s3.../comparison-report-uuid.pdf",
    "expiresAt": "2026-01-08T09:00:00Z"
  }
}
```

---

## Frontend Design

### Component Hierarchy

```
ComparisonPage
├── ComparisonHeader
│   ├── FileInfo (name, dates, status)
│   ├── SummaryStats (applied, rejected, etc.)
│   └── ExportButton
├── FilterBar
│   ├── TypeFilter (dropdown)
│   ├── SeverityFilter (dropdown)
│   ├── StatusFilter (dropdown)
│   └── SearchBox
├── IssueNavigator
│   ├── ProgressIndicator ("Issue 3 of 45")
│   ├── PrevButton
│   ├── NextButton
│   └── JumpToDropdown
├── ComparisonPanel
│   ├── IssueHeader
│   │   ├── IssueTitle
│   │   ├── FilePath
│   │   ├── SeverityBadge
│   │   └── WCAGBadge
│   ├── SideBySideView
│   │   ├── BeforePane (with syntax highlighting)
│   │   └── AfterPane (with syntax highlighting)
│   └── DiffToggle (side-by-side vs unified)
├── ReviewPanel (Optional)
│   ├── ApproveButton
│   ├── RejectButton
│   ├── ReasonInput
│   └── ReviewHistory
└── ActionBar
    ├── ApplyRejectionsButton
    ├── ReauditButton
    └── ExportButton
```

### Wireframe: Main Comparison View

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Remediation Comparison: The_King_in_Yellow.epub          [Export PDF ▼] │
├─────────────────────────────────────────────────────────────────────────┤
│ Applied: 42 │ Rejected: 2 │ Skipped: 1 │ Failed: 0 │ Total: 45         │
├─────────────────────────────────────────────────────────────────────────┤
│ Type: [All Types ▼]  Severity: [All ▼]  Status: [All ▼]  [🔍 Search]   │
├─────────────────────────────────────────────────────────────────────────┤
│ ◀ Prev │ Issue 3 of 45 │ Next ▶                         [Jump to... ▼] │
├─────────────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ Missing alt text on image                                           │ │
│ │ OEBPS/chapter1.xhtml:45  │ 🔴 CRITICAL │ WCAG 1.1.1 (A)            │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
├────────────────────────────────┬────────────────────────────────────────┤
│ BEFORE                         │ AFTER                                  │
├────────────────────────────────┼────────────────────────────────────────┤
│                                │                                        │
│  43 │ <p>See the chart:</p>    │  43 │ <p>See the chart:</p>            │
│  44 │                          │  44 │                                  │
│  45 │ <img                     │  45 │ <img                             │
│  46 │   src="fig1.png"         │  46 │   src="fig1.png"                 │
│- 47 │   class="figure"         │+ 47 │   class="figure"                 │
│- 48 │ />                       │+ 48 │   alt="Bar chart showing         │
│     │                          │+ 49 │   quarterly sales growth"        │
│     │                          │+ 50 │ />                               │
│  49 │                          │  51 │                                  │
│  50 │ <p>As shown above...</p> │  52 │ <p>As shown above...</p>         │
│                                │                                        │
├────────────────────────────────┴────────────────────────────────────────┤
│ Status: ✅ APPLIED                                                      │
├─────────────────────────────────────────────────────────────────────────┤
│ [✓ Approve] [✗ Reject] [💬 Comment]                                     │
│                                                                         │
│ Review History:                                                         │
│ • Jan 7, 2026 10:30 - John Doe: Approved                               │
└─────────────────────────────────────────────────────────────────────────┘
```

### Wireframe: Reject Dialog

```
┌─────────────────────────────────────────────────────────┐
│ Reject Change                                        X  │
├─────────────────────────────────────────────────────────┤
│                                                         │
│ Are you sure you want to reject this change?            │
│                                                         │
│ Reason (required):                                      │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ Alt text is not descriptive enough                  │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ Notes (optional):                                       │
│ ┌─────────────────────────────────────────────────────┐ │
│ │ The chart contains specific data points that        │ │
│ │ should be included in the alt text.                 │ │
│ └─────────────────────────────────────────────────────┘ │
│                                                         │
│ ⚠️ Rejecting changes will require regenerating the      │
│    EPUB file. You can apply all rejections at once.     │
│                                                         │
│                    [Cancel]  [Reject Change]            │
└─────────────────────────────────────────────────────────┘
```

### Syntax Highlighting

Use a library like:
- **Prism.js** - Lightweight, supports XML/HTML
- **highlight.js** - Popular, good theme support
- **Monaco Editor** - Full editor with diff support (heavier)

Recommended: **Monaco Editor** for its built-in diff view capabilities.

---

## Workflow Integration

### EPUB Remediation Workflow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      EPUB REMEDIATION WORKFLOW                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. UPLOAD                                                               │
│    User uploads EPUB file                                               │
│    → Creates File record (ORIGINAL)                                     │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. AUDIT                                                                │
│    System runs accessibility audit (ACE + EPUBCheck)                    │
│    → Creates Job with audit results                                     │
│    → Generates RemediationPlan with tasks                               │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. REMEDIATION                                                          │
│    User applies fixes (auto, quick, manual)                             │
│    → Each fix creates RemediationChange record         ◄── NEW          │
│    → Creates remediated File (REMEDIATED)                               │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 4. VISUAL COMPARISON (NEW)                                              │
│    User reviews changes side-by-side                   ◄── NEW          │
│    → Step through each RemediationChange                                │
│    → Approve/reject individual changes                                  │
│    → Export PDF comparison report                                       │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                          ┌─────────┴─────────┐
                          ▼                   ▼
┌────────────────────────────────┐  ┌────────────────────────────────────┐
│ 4a. ALL APPROVED               │  │ 4b. SOME REJECTED                  │
│     Proceed to re-audit        │  │     Regenerate EPUB                │
│                                │  │     → Apply rejections             │
│                                │  │     → Create new File version      │
│                                │  │     → Return to step 4             │
└────────────────────────────────┘  └────────────────────────────────────┘
                          │                   │
                          └─────────┬─────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 5. RE-AUDIT                                                             │
│    System re-audits remediated file                                     │
│    → Compares before/after issue counts                                 │
│    → Shows resolved vs remaining issues                                 │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                          ┌─────────┴─────────┐
                          ▼                   ▼
┌────────────────────────────────┐  ┌────────────────────────────────────┐
│ 5a. ALL RESOLVED               │  │ 5b. ISSUES REMAIN                  │
│     Proceed to export          │  │     Return to step 3               │
│                                │  │     (Additional remediation)       │
└────────────────────────────────┘  └────────────────────────────────────┘
                          │                   │
                          └─────────┬─────────┘
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 6. EXPORT                                                               │
│    User downloads remediated EPUB                                       │
│    → Optional: Include comparison report PDF                            │
│    → Creates Artifact records                                           │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 7. TRANSFER TO ACR (Optional)                                           │
│    Transfer results to ACR workflow                                     │
│    → See ACR Workflow Integration below                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### UI Integration Points

1. **Remediation Page** - Add "Review Changes" button after remediation
2. **Job Details** - Add "View Comparison" action
3. **Export Dialog** - Option to include comparison report
4. **Re-audit Results** - Link to comparison view

---

## ACR Workflow Integration

### ACR Workflow Overview

The Accessibility Conformance Review (ACR) workflow provides structured WCAG verification.

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         ACR WORKFLOW                                    │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. START ACR                                                            │
│    Select audited EPUB file                                             │
│    → Choose WCAG edition (2.0, 2.1, 2.2)                               │
│    → Select conformance level (A, AA, AAA)                              │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. AUTO-POPULATE FROM AUDIT                                             │
│    System populates checklist from audit results                        │
│    → Maps audit issues to WCAG criteria                                 │
│    → Shows confidence scores for auto-detection                         │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. IMPORT REMEDIATION EVIDENCE (NEW)                    ◄── NEW         │
│    Import remediation changes as evidence                               │
│    → Link RemediationChange records to WCAG criteria                    │
│    → Show before/after for each criterion                               │
│    → Include in ACR report                                              │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 4. MANUAL VERIFICATION                                                  │
│    Reviewer verifies each criterion                                     │
│    → Mark as: Supports, Partially Supports, Does Not Support, N/A       │
│    → Add remarks and evidence                                           │
│    → Review AI-detected items flagged for verification                  │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 5. GENERATE ACR REPORT                                                  │
│    Export VPAT-style ACR report                                         │
│    → Include remediation comparison data              ◄── NEW           │
│    → Show before/after evidence for fixes                               │
│    → PDF and/or machine-readable format                                 │
└─────────────────────────────────────────────────────────────────────────┘
```

### ACR Integration Features

#### Evidence Import

When user transfers from EPUB Remediation to ACR:

```json
{
  "wcagCriterion": "1.1.1",
  "criterionName": "Non-text Content",
  "conformanceLevel": "A",
  "status": "SUPPORTS",
  "evidence": {
    "type": "REMEDIATION_CHANGES",
    "changeCount": 20,
    "changes": [
      {
        "changeId": "uuid",
        "description": "Added alt text to image",
        "beforeContent": "<img src=\"fig1.png\"/>",
        "afterContent": "<img src=\"fig1.png\" alt=\"...\"/>",
        "status": "APPLIED"
      }
      // ... more changes for this criterion
    ]
  },
  "remarks": "20 images remediated with descriptive alt text"
}
```

#### ACR Checklist View with Remediation Evidence

```
┌─────────────────────────────────────────────────────────────────────────┐
│ ACR Review: The_King_in_Yellow.epub                                     │
├─────────────────────────────────────────────────────────────────────────┤
│ WCAG 2.1 AA Checklist                                                   │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ 1.1 Text Alternatives                                                   │
│ ├─ 1.1.1 Non-text Content (Level A)                                    │
│ │  Status: [Supports ▼]                                                 │
│ │  Confidence: 🟢 High (AI-verified)                                    │
│ │                                                                       │
│ │  Remediation Evidence:                              ◄── NEW           │
│ │  ┌─────────────────────────────────────────────────────────────────┐ │
│ │  │ 20 changes applied for this criterion                           │ │
│ │  │ [View All Changes] [View in Comparison]                         │ │
│ │  │                                                                 │ │
│ │  │ Sample (1 of 20):                                               │ │
│ │  │ Before: <img src="fig1.png"/>                                   │ │
│ │  │ After:  <img src="fig1.png" alt="Bar chart..."/>                │ │
│ │  └─────────────────────────────────────────────────────────────────┘ │
│ │                                                                       │
│ │  Remarks:                                                             │
│ │  ┌─────────────────────────────────────────────────────────────────┐ │
│ │  │ All 20 images have been provided with descriptive alt text      │ │
│ │  └─────────────────────────────────────────────────────────────────┘ │
│ │                                                                       │
│ ├─ 1.2.1 Audio-only and Video-only (Level A)                           │
│ │  Status: [Not Applicable ▼]                                          │
│ │  Remarks: No audio or video content in publication                    │
│ │                                                                       │
│ └─ ...                                                                  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## PDF Export

### Report Structure

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    ACCESSIBILITY REMEDIATION REPORT                     │
│                                                                         │
│ Publication: The King in Yellow                                         │
│ File: The_King_in_Yellow.epub                                          │
│ Date: January 7, 2026                                                   │
│ Generated by: Ninja Platform                                            │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ EXECUTIVE SUMMARY                                                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ Original Issues:     127                                                │
│ Issues Resolved:     125 (98.4%)                                        │
│ Issues Remaining:      2 (1.6%)                                         │
│                                                                         │
│ Changes Applied:      45                                                │
│ Changes Rejected:      0                                                │
│ Manual Fixes:          3                                                │
│                                                                         │
│ WCAG Conformance:    AA (with exceptions)                               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ CHANGES BY SEVERITY                                                     │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ Critical:  15  ████████████████                                         │
│ Major:     20  █████████████████████                                    │
│ Minor:     10  ██████████                                               │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ WCAG CRITERIA COVERAGE                                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ 1.1.1 Non-text Content (A)      20 changes   ✅ Resolved               │
│ 1.3.1 Info and Relationships (A) 10 changes   ✅ Resolved               │
│ 2.4.2 Page Titled (A)            1 change    ✅ Resolved               │
│ 2.4.6 Headings and Labels (AA)   8 changes   ✅ Resolved               │
│ 3.1.1 Language of Page (A)       1 change    ✅ Resolved               │
│ 3.1.2 Language of Parts (AA)     5 changes   ⚠️ Partial (2 remaining)  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ DETAILED CHANGES                                                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ CHANGE #1                                                               │
│ ─────────────────────────────────────────────────────────────────────── │
│ File:     OEBPS/chapter1.xhtml                                          │
│ Line:     45                                                            │
│ Type:     Add alt text                                                  │
│ Severity: CRITICAL                                                      │
│ WCAG:     1.1.1 Non-text Content (Level A)                             │
│ Status:   APPLIED                                                       │
│                                                                         │
│ BEFORE:                                                                 │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ <img src="images/fig1.png" class="figure"/>                         │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│ AFTER:                                                                  │
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ <img src="images/fig1.png" class="figure"                           │ │
│ │      alt="Bar chart showing quarterly sales: Q1 $1.2M, Q2 $1.5M,    │ │
│ │      Q3 $1.8M, Q4 $2.1M"/>                                          │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
│                                                                         │
│ ─────────────────────────────────────────────────────────────────────── │
│                                                                         │
│ CHANGE #2                                                               │
│ ... (continues for all changes)                                         │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ REMAINING ISSUES                                                        │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ The following issues require manual remediation:                        │
│                                                                         │
│ 1. OEBPS/chapter5.xhtml:123                                            │
│    Complex table missing proper header associations                     │
│    WCAG 1.3.1 (A) - Info and Relationships                             │
│                                                                         │
│ 2. OEBPS/chapter8.xhtml:456                                            │
│    Image contains text that should be marked up                         │
│    WCAG 1.4.5 (AA) - Images of Text                                    │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────┐
│ ATTESTATION                                                             │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│ This report was generated on January 7, 2026 at 10:30 AM UTC           │
│ by the Ninja Platform automated accessibility remediation system.       │
│                                                                         │
│ Reviewed by: John Doe (john.doe@example.com)                           │
│ Review date: January 7, 2026                                            │
│                                                                         │
│ Report ID: rpt-abc123-def456                                           │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

### PDF Generation Technology

**Recommended:** Use **Puppeteer** or **Playwright** for server-side PDF generation:

1. Render HTML report template
2. Convert to PDF with print styles
3. Store in S3 as Artifact
4. Return download URL

Alternative: **pdfkit** or **jsPDF** for lighter weight (less formatting control).

---

## Reject/Undo Changes

### Feature Scope (Optional)

This feature allows users to reject individual remediation changes and regenerate the EPUB with those changes reverted.

### Use Cases

1. **Incorrect alt text** - AI-generated alt text is inaccurate
2. **Over-remediation** - Change modified more than intended
3. **Style conflicts** - Fix introduces layout issues
4. **Manual preference** - User prefers different approach

### Workflow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      REJECT/UNDO WORKFLOW                               │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 1. USER REVIEWS CHANGES                                                 │
│    Step through each change in comparison view                          │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 2. USER REJECTS CHANGE(S)                                               │
│    Click "Reject" on specific changes                                   │
│    → Enter reason (required)                                            │
│    → Change status updated to REJECTED                                  │
│    → ChangeReview record created                                        │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 3. USER APPLIES REJECTIONS                                              │
│    Click "Apply Rejections" button                                      │
│    → Confirmation dialog shows count of rejections                      │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 4. SYSTEM REGENERATES EPUB                                              │
│    Backend processes rejections:                                        │
│    a. Load original EPUB                                                │
│    b. Apply only non-rejected changes                                   │
│    c. Save new remediated file                                          │
│    d. Create new File record (version N+1)                              │
│    e. Update change statuses to REVERTED                                │
└─────────────────────────────────────────────────────────────────────────┘
                                    │
                                    ▼
┌─────────────────────────────────────────────────────────────────────────┐
│ 5. USER CONTINUES REVIEW                                                │
│    New EPUB available for download                                      │
│    → Can re-audit to verify                                             │
│    → Can re-apply rejected changes if needed                            │
└─────────────────────────────────────────────────────────────────────────┘
```

### Technical Considerations

1. **Change atomicity** - Each change must be independently reversible
2. **Order dependency** - Some changes may depend on others
3. **File versioning** - Track which version each change applies to
4. **Conflict detection** - Detect if rejecting causes other issues

### Complexity Assessment

| Aspect | Complexity | Notes |
|--------|------------|-------|
| UI for reject/approve | Low | Simple button + dialog |
| Storing rejections | Low | Database record |
| Regenerating EPUB | High | Must replay changes selectively |
| Handling dependencies | High | Changes may be interdependent |
| Conflict detection | Medium | Need to validate result |

**Recommendation:** Implement as Phase 3 after core comparison view is stable.

---

## Implementation Phases

### Phase 1: Core Comparison View (MVP)

**Scope:**
- Database schema for RemediationChange
- Capture changes during remediation
- Basic comparison API
- Side-by-side view component
- Issue navigation (prev/next)
- Basic filtering

**Effort:** 2-3 weeks

**Deliverables:**
- [ ] RemediationChange model and migration
- [ ] Update remediation service to log changes
- [ ] GET /jobs/:id/comparison endpoint
- [ ] ComparisonView component
- [ ] IssueNavigator component
- [ ] Basic syntax highlighting

### Phase 2: PDF Export & ACR Integration

**Scope:**
- PDF report generation
- Export endpoint
- ACR evidence import
- Enhanced filtering and search

**Effort:** 1-2 weeks

**Deliverables:**
- [ ] PDF generation service (Puppeteer)
- [ ] POST /jobs/:id/comparison/export-pdf endpoint
- [ ] ComparisonReport model
- [ ] ACR evidence import API
- [ ] ACR checklist integration
- [ ] Advanced filters (type, severity, file)

### Phase 3: Reject/Undo Changes (Optional)

**Scope:**
- Review/reject workflow
- EPUB regeneration
- Change versioning
- Conflict handling

**Effort:** 2-3 weeks

**Deliverables:**
- [ ] ChangeReview model
- [ ] Review API endpoints
- [ ] Reject dialog component
- [ ] EPUB regeneration service
- [ ] Version tracking
- [ ] Re-apply rejected changes

### Phase 4: Polish & Optimization

**Scope:**
- Performance optimization
- Monaco Editor integration
- Unified diff view
- Keyboard navigation
- Accessibility improvements

**Effort:** 1 week

**Deliverables:**
- [ ] Monaco diff editor integration
- [ ] Keyboard shortcuts
- [ ] ARIA labels and screen reader support
- [ ] Performance optimization for large change sets

---

## Security Considerations

1. **Authorization** - Users can only view comparison for their own jobs
2. **Data sanitization** - Escape HTML in before/after content display
3. **PDF generation** - Sandbox Puppeteer, limit resource usage
4. **File access** - Validate file ownership before serving content
5. **Audit logging** - Log all review actions for compliance

---

## Performance Considerations

1. **Pagination** - Load changes in batches (50 per page)
2. **Lazy loading** - Load full content only when viewing specific change
3. **Caching** - Cache comparison data, invalidate on changes
4. **PDF generation** - Queue long-running PDF jobs, async response
5. **Database indexing** - Index on jobId, status, changeType

---

## Appendix A: API Response Examples

### Full Comparison Response

```json
{
  "success": true,
  "data": {
    "jobId": "job-123",
    "fileName": "The_King_in_Yellow.epub",
    "originalFileId": "file-001",
    "remediatedFileId": "file-002",
    "auditedAt": "2026-01-07T08:00:00Z",
    "remediatedAt": "2026-01-07T09:00:00Z",
    "summary": {
      "totalChanges": 45,
      "applied": 42,
      "rejected": 2,
      "skipped": 1,
      "failed": 0,
      "issuesBefore": 127,
      "issuesAfter": 2,
      "resolutionRate": 98.4
    },
    "byType": {
      "add-alt-text": { "count": 20, "applied": 19, "rejected": 1 },
      "fix-heading": { "count": 10, "applied": 10, "rejected": 0 },
      "add-lang": { "count": 5, "applied": 5, "rejected": 0 },
      "fix-table": { "count": 7, "applied": 6, "rejected": 1 },
      "other": { "count": 3, "applied": 2, "rejected": 0 }
    },
    "bySeverity": {
      "CRITICAL": { "count": 15, "applied": 15, "rejected": 0 },
      "MAJOR": { "count": 20, "applied": 18, "rejected": 2 },
      "MINOR": { "count": 10, "applied": 9, "rejected": 0 }
    },
    "byWcag": {
      "1.1.1": { "count": 20, "applied": 19, "rejected": 1 },
      "1.3.1": { "count": 10, "applied": 10, "rejected": 0 },
      "2.4.2": { "count": 1, "applied": 1, "rejected": 0 },
      "2.4.6": { "count": 8, "applied": 7, "rejected": 1 },
      "3.1.1": { "count": 1, "applied": 1, "rejected": 0 },
      "3.1.2": { "count": 5, "applied": 4, "rejected": 0 }
    },
    "pagination": {
      "page": 1,
      "limit": 50,
      "total": 45,
      "pages": 1
    },
    "changes": [
      // Array of change objects (paginated)
    ]
  }
}
```

---

## Appendix B: Related Documentation

- [CLAUDE.md](./CLAUDE.md) - Project context
- [WORKFLOW_LINEAGE_DESIGN.md](./WORKFLOW_LINEAGE_DESIGN.md) - Workflow lineage design
- [FEEDBACK_ENHANCEMENT_DESIGN.md](./FEEDBACK_ENHANCEMENT_DESIGN.md) - Feedback enhancements
- [EPUB_AUDIT_REMEDIATION_USER_GUIDE.md](./EPUB_AUDIT_REMEDIATION_USER_GUIDE.md) - User guide

---

## Appendix C: Glossary

| Term | Definition |
|------|------------|
| ACE | Accessibility Checker for EPUB |
| ACR | Accessibility Conformance Review |
| EPUB | Electronic Publication format |
| Remediation | Process of fixing accessibility issues |
| VPAT | Voluntary Product Accessibility Template |
| WCAG | Web Content Accessibility Guidelines |
| XPath | XML Path Language for locating elements |

---

*Document generated by Claude Code on January 7, 2026*
