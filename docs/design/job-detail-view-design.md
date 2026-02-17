# Job Detail View - Replace Raw JSON with User-Friendly UI

## Related Issue
Linked to #50 (Complete Dashboard Stats & Jobs Page Implementation)

---

## Problem Statement

When clicking "View" on a job in the Jobs page, the job detail view displays **raw JSON output** which:
- Is not user-friendly for EPUB remediation operators
- Provides no actionable insights
- Buries important data (compliance score, issue counts) in code format
- Has no visual hierarchy or scannability

### Current Behavior
The job detail page shows:
- Job Information card (Status, Type, Job ID) ✅
- Timestamps card ✅
- **Output section with raw JSON** ❌

---

## Design Specification

### Wireframe Layout

```
┌─────────────────────────────────────────────────────────────────────────┐
│  ← Back                                                                 │
│  10-pages.epub                                                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────────────────────┐  ┌─────────────────────────────────┐  │
│  │ Job Information             │  │ Timestamps                      │  │
│  │                             │  │                                 │  │
│  │ Status    ✅ COMPLETED      │  │ Created    6/1/2026, 8:53:04 pm │  │
│  │ Type      EPUB Accessibility│  │ Started    6/1/2026, 8:53:04 pm │  │
│  │ Job ID    419590f4-7c9e...  │  │ Completed  6/1/2026, 8:53:07 pm │  │
│  └─────────────────────────────┘  │ Duration   3s                   │  │
│                                   └─────────────────────────────────┘  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌─────────────┐  ┌───────────┐ ┌───────────┐ ┌───────────┐ ┌────────┐ │
│  │             │  │  Critical │ │  Serious  │ │ Moderate  │ │ Minor  │ │
│  │     66      │  │     🔴    │ │    🟠     │ │    🟡     │ │   🔵   │ │
│  │    ████     │  │     0     │ │    3      │ │    2      │ │   2    │ │
│  │   Score     │  └───────────┘ └───────────┘ └───────────┘ └────────┘ │
│  │             │                                                       │
│  │ ⚠️ NOT      │  Accessibility Status                                 │
│  │ ACCESSIBLE  │  ❌ isValid: false    ❌ isAccessible: false          │
│  └─────────────┘                                                       │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Issues (7 total)                                      [Filter ▼]      │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ Severity   │ Description              │ Location     │ Auto-Fix │   │
│  ├────────────┼──────────────────────────┼──────────────┼──────────┤   │
│  │ 🟠 Serious │ Missing alt text         │ ch1.xhtml    │ ✅ Yes   │   │
│  │ 🟠 Serious │ Missing alt text         │ ch2.xhtml    │ ✅ Yes   │   │
│  │ 🟠 Serious │ Missing table headers    │ ch3.xhtml    │ ✅ Yes   │   │
│  │ 🟡 Moderate│ Missing lang attribute   │ content.opf  │ ✅ Yes   │   │
│  │ 🟡 Moderate│ Empty link text          │ nav.xhtml    │ ✅ Yes   │   │
│  │ 🔵 Minor   │ Missing accessibility    │ package.opf  │ ✅ Yes   │   │
│  │            │ summary                  │              │          │   │
│  │ 🔵 Minor   │ Heading hierarchy skip   │ ch1.xhtml    │ ❌ No    │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐      │
│  │ Start Remediation│  │ Download Report  │  │    Re-Audit      │      │
│  └──────────────────┘  └──────────────────┘  └──────────────────┘      │
│                                                                         │
├─────────────────────────────────────────────────────────────────────────┤
│  ▶ Show Raw Data (collapsed by default)                                 │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │ {                                                               │   │
│  │   "jobId": "419590f4-7c9e-4946-9e61-3a79a93ad5b8",             │   │
│  │   "score": 66,                                                  │   │
│  │   ...                                                           │   │
│  │ }                                                               │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## Color Specifications

### Compliance Score Colors
| Score Range | Color | Tailwind Class | Hex |
|-------------|-------|----------------|-----|
| 90-100 | Green | `text-green-500` | #22c55e |
| 70-89 | Yellow | `text-yellow-500` | #eab308 |
| 0-69 | Red | `text-red-500` | #ef4444 |

### Severity Colors
| Severity | Background | Text | Border |
|----------|------------|------|--------|
| Critical | `bg-red-50` | `text-red-700` | `border-red-200` |
| Serious | `bg-orange-50` | `text-orange-700` | `border-orange-200` |
| Moderate | `bg-yellow-50` | `text-yellow-700` | `border-yellow-200` |
| Minor | `bg-blue-50` | `text-blue-700` | `border-blue-200` |

---

## Data Structure

### Input JSON (from API)
```json
{
  "jobId": "419590f4-7c9e-4946-9e61-3a79a93ad5b8",
  "score": 66,
  "isValid": false,
  "isAccessible": false,
  "summary": {
    "minor": 2,
    "total": 7,
    "serious": 3,
    "critical": 0,
    "moderate": 2
  },
  "fileName": "10-pages.epub",
  "aceResult": null,
  "auditedAt": "2026-01-06T15:23:05.427Z",
  "epubVersion": "unknown",
  "combinedIssues": [
    {
      "id": "issue-1",
      "code": "EPUB-IMG-001",
      "severity": "serious",
      "description": "Image missing alt text",
      "location": "OEBPS/chapter1.xhtml",
      "element": "<img src=\"image1.jpg\">",
      "autoFixable": true,
      "fixCode": "ADD_ALT_TEXT",
      "wcagCriteria": "1.1.1",
      "suggestion": "Add descriptive alt text to the image"
    }
  ]
}
```

### TypeScript Interfaces
```typescript
interface JobOutput {
  jobId: string;
  score: number;
  isValid: boolean;
  isAccessible: boolean;
  fileName: string;
  epubVersion: string;
  auditedAt: string;
  summary: IssueSummary;
  combinedIssues: AccessibilityIssue[];
}

interface IssueSummary {
  total: number;
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
}

interface AccessibilityIssue {
  id: string;
  code: string;
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  description: string;
  location: string;
  element?: string;
  autoFixable: boolean;
  fixCode?: string;
  wcagCriteria?: string;
  suggestion?: string;
}
```

---

## Components to Create

### 1. ComplianceScoreDisplay
- Reuse/adapt `ComplianceScoreCircle` from Dashboard
- Add accessibility status badges

### 2. SeveritySummaryCards
- 4-column grid of severity count cards
- Responsive: 2x2 on mobile, 1x4 on desktop

### 3. IssuesTable
- Sortable by severity
- Filterable by severity
- Expandable rows for details
- Auto-fix indicator

### 4. JobActionButtons
- Start Remediation
- Download Report
- Re-Audit
- Show/Hide Raw Data toggle

---

## Acceptance Criteria

- [ ] Compliance score displayed as visual gauge (0-100)
- [ ] Score color changes based on value (green/yellow/red)
- [ ] Issue counts shown in 4 severity cards
- [ ] Issues listed in readable, sortable table
- [ ] Each issue shows: severity badge, description, location, auto-fix status
- [ ] "Start Remediation" button navigates to `/remediation/{jobId}`
- [ ] "Download Report" button exports PDF/DOCX
- [ ] Raw JSON hidden by default, expandable via toggle
- [ ] Mobile responsive design
- [ ] WCAG 2.1 AA compliant
- [ ] Keyboard navigable

---

## Files to Create/Modify

1. `src/pages/JobDetail.tsx` - Main refactor
2. `src/components/jobs/ComplianceScore.tsx` - Score display
3. `src/components/jobs/SeveritySummary.tsx` - Severity cards
4. `src/components/jobs/IssuesTable.tsx` - Issues list
5. `src/components/jobs/JobActions.tsx` - Action buttons

---

# Implementation Prompts

## Frontend Prompt (ninja-frontend)

```
## Task: Implement User-Friendly Job Detail View

Replace the raw JSON output in the Job Detail page with a proper UI for EPUB remediation operators.

### Current State
- File: `src/pages/Jobs.tsx` or `src/pages/JobDetail.tsx`
- Currently shows raw JSON in the "Output" section
- JSON contains: score, isValid, isAccessible, summary (severity counts), combinedIssues array

### Requirements

#### 1. Compliance Score Section
- Reuse or adapt `ComplianceScoreCircle` component from Dashboard
- Display score as large circular gauge (0-100)
- Colors: Green (#22c55e) for 90+, Yellow (#eab308) for 70-89, Red (#ef4444) for <70
- Show "ACCESSIBLE" or "NOT ACCESSIBLE" badge based on `isAccessible` field

#### 2. Issues Summary Cards (4-column grid)
Create severity cards showing:
- Critical (red): count from `summary.critical`
- Serious (orange): count from `summary.serious`
- Moderate (yellow): count from `summary.moderate`
- Minor (blue): count from `summary.minor`

Each card should have:
- Icon indicator
- Severity label
- Count number
- Appropriate background color

#### 3. Issues Table
Parse `combinedIssues` array and display as table:
- Columns: Severity, Description, Location, Auto-Fix Available
- Severity badges with colors
- Sortable by severity
- Show "No issues found" if empty

#### 4. Action Buttons
- "Start Remediation" → `navigate(`/remediation/${jobId}`)`
- "Download Report" → Call export API (placeholder for now)
- "Re-Audit" → Trigger new audit job
- "Show Raw Data" → Collapsible section with formatted JSON

#### 5. Layout Structure
```
┌──────────────────────────────────────────────────┐
│ [Job Info Card]          [Timestamps Card]       │
├──────────────────────────────────────────────────┤
│ [Score Circle]  [Critical][Serious][Moderate][Minor] │
├──────────────────────────────────────────────────┤
│ Issues (7 total)                    [Filter ▼]   │
│ ┌────────────────────────────────────────────┐   │
│ │ Severity │ Description │ Location │ Fix    │   │
│ ├──────────┼─────────────┼──────────┼────────┤   │
│ │ 🟠 Serious│ Missing alt │ ch1.xhtml│ ✅     │   │
│ └────────────────────────────────────────────┘   │
├──────────────────────────────────────────────────┤
│ [Start Remediation] [Download Report] [Re-Audit] │
├──────────────────────────────────────────────────┤
│ ▶ Show Raw Data (collapsed by default)           │
└──────────────────────────────────────────────────┘
```

### Technical Notes
- Use Tailwind CSS only (no inline styles)
- Make it responsive (mobile-first)
- Ensure WCAG 2.1 AA compliance
- Use existing UI components from `src/components/ui/`
- TypeScript strict mode

### Sample Data Structure
```typescript
interface JobOutput {
  jobId: string;
  score: number;
  isValid: boolean;
  isAccessible: boolean;
  fileName: string;
  summary: {
    total: number;
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
  };
  combinedIssues: Array<{
    id: string;
    severity: 'critical' | 'serious' | 'moderate' | 'minor';
    description: string;
    location: string;
    autoFixable: boolean;
    wcagCriteria?: string;
  }>;
}
```

### Color Reference
- Critical: bg-red-50, text-red-700, border-red-200
- Serious: bg-orange-50, text-orange-700, border-orange-200
- Moderate: bg-yellow-50, text-yellow-700, border-yellow-200
- Minor: bg-blue-50, text-blue-700, border-blue-200
- Score Green (90+): #22c55e
- Score Yellow (70-89): #eab308
- Score Red (<70): #ef4444
```

---

## Backend Prompt (ninja-backend)

```
## Task: Ensure Job Results API Returns Structured Data

Verify and enhance the GET /api/v1/jobs/:id/results endpoint to return properly structured data for the frontend.

### Requirements

1. **Endpoint:** GET /api/v1/jobs/:id/results

2. **Response Structure:**
```typescript
{
  jobId: string;
  type: JobType;
  status: JobStatus;
  output: {
    score: number;
    isValid: boolean;
    isAccessible: boolean;
    fileName: string;
    summary: {
      total: number;
      critical: number;
      serious: number;
      moderate: number;
      minor: number;
    };
    combinedIssues: Array<{
      id: string;
      code: string;
      severity: 'critical' | 'serious' | 'moderate' | 'minor';
      description: string;
      location: string;
      element?: string;
      autoFixable: boolean;
      fixCode?: string;
      wcagCriteria?: string;
      suggestion?: string;
    }>;
  };
  completedAt: string;
}
```

3. **Ensure:**
- `combinedIssues` array is always present (empty array if no issues)
- `summary` object has all severity counts (default 0)
- `autoFixable` boolean is set correctly based on fix handlers
- `location` includes file path within EPUB

4. **Files to Check:**
- `src/controllers/job.controller.ts` - getResults method
- `src/services/queue.service.ts` - job output structure
- Audit service that generates the output

5. **Validation:**
- Add Zod schema for job results response
- Ensure consistent typing
```

---

## GitHub Issue Template

**Title:** Job Detail View - Replace Raw JSON with User-Friendly UI

**Labels:** enhancement, frontend, UX, accessibility

**Body:**
```
## Related Issue
Linked to #50 (Complete Dashboard Stats & Jobs Page Implementation)

## Problem
When clicking "View" on a job in the Jobs page, the job detail view displays **raw JSON output** which:
- Is not user-friendly for EPUB remediation operators
- Provides no actionable insights
- Buries important data (compliance score, issue counts) in code format
- Has no visual hierarchy or scannability

## Expected Behavior
Transform the JSON data into a user-friendly interface with:
1. Compliance Score Circle (color-coded gauge)
2. Severity Summary Cards (Critical, Serious, Moderate, Minor counts)
3. Issues Table (sortable, filterable list)
4. Action Buttons (Start Remediation, Download Report, Re-Audit)
5. Collapsible Raw Data section for advanced users

## Acceptance Criteria
- [ ] Compliance score displayed as visual gauge
- [ ] Issue counts shown in severity cards with colors
- [ ] Issues listed in readable table format
- [ ] "Start Remediation" button navigates to remediation workflow
- [ ] Raw JSON hidden by default, available via toggle
- [ ] Mobile responsive
- [ ] WCAG 2.1 AA compliant

## Priority
High - Directly impacts operator usability
```

---

*Created: January 2026*
*Author: Claude Code*
*Project: Ninja Platform - Accessibility Validation SaaS*
