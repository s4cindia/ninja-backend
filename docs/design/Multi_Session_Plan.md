# Multi-Session Claude Code Implementation Plan
## Visual Comparison Feature - Ninja Platform

**Version:** 1.0  
**Date:** January 8, 2026  
**Estimated Duration:** 2-3 weeks (Phase 1 MVP)

---

## Table of Contents

1. [CLAUDE.md Review & Improvements](#1-claudemd-review--improvements)
2. [Multi-Session Strategy Overview](#2-multi-session-strategy-overview)
3. [Pre-Implementation Setup](#3-pre-implementation-setup)
4. [Session Architecture](#4-session-architecture)
5. [Detailed Session Plans](#5-detailed-session-plans)
6. [Handover Procedures](#6-handover-procedures)
7. [Verification Checkpoints](#7-verification-checkpoints)
8. [Notification Configuration](#8-notification-configuration)
9. [Risk Mitigation](#9-risk-mitigation)

---

## 1. CLAUDE.md Review & Improvements

### Current Strengths ✅

The existing CLAUDE.md provides excellent coverage of:
- Project architecture and tech stack
- Repository structure and key directories
- Development workflow and git conventions
- Database commands and infrastructure details
- Common issues and solutions

### Recommended Improvements

#### 1.1 Add Visual Comparison Context Section

```markdown
## Visual Comparison Feature (Active Development)

### Feature Overview
Side-by-side visual comparison of remediation changes with:
- XML diff view with syntax highlighting
- Issue navigation (prev/next)
- Filtering by type, severity, status
- PDF export for compliance documentation

### New Models
- `RemediationChange` - Individual change records
- `ComparisonReport` - Generated reports with PDF URLs
- `ChangeReview` - Review/approval records (Phase 3)

### New Files
**Backend:**
- `src/services/comparison/comparison.service.ts`
- `src/controllers/comparison.controller.ts`
- `src/routes/comparison.routes.ts`
- `src/types/comparison.types.ts`

**Frontend:**
- `src/pages/ComparisonPage.tsx`
- `src/components/comparison/*`
- `src/services/comparison.service.ts`
- `src/hooks/useComparison.ts`

### API Endpoints
- `GET /api/v1/jobs/:jobId/comparison` - Get comparison data
- `GET /api/v1/jobs/:jobId/comparison/changes/:changeId` - Single change
- `GET /api/v1/jobs/:jobId/comparison/filter` - Filtered results
- `POST /api/v1/jobs/:jobId/comparison/export-pdf` - Export PDF (Phase 2)
```

#### 1.2 Add Session Continuity Section

```markdown
## Claude Code Session Context

### Active Feature Branches
- `feature/visual-comparison` (Backend)
- `feature/visual-comparison` (Frontend)

### Current Sprint Focus
- Phase 1: Core Comparison View (MVP)
- Target: Week of January 13, 2026

### Multi-Session Workflow
When resuming work:
1. Pull latest changes: `git pull origin feature/visual-comparison`
2. Check for pending CodeRabbit comments
3. Review test results from last CI run
4. Continue from checkpoint documented below

### Last Session Checkpoint
[Update after each session]
- **Date:** [Date]
- **Completed:** [What was done]
- **Next:** [What to do next]
- **Blockers:** [Any issues]
```

#### 1.3 Add Testing Patterns Section

```markdown
## Testing Patterns

### Backend (Jest)
```typescript
// Service test pattern
describe('ServiceName', () => {
  let prisma: DeepMockProxy<PrismaClient>;
  let service: ServiceClass;

  beforeEach(() => {
    prisma = mockDeep<PrismaClient>();
    service = new ServiceClass(prisma as unknown as PrismaClient);
  });
});
```

### Frontend (Vitest + React Testing Library)
```typescript
// Component test pattern
describe('ComponentName', () => {
  const mockData = {...};

  beforeEach(() => {
    server.use(
      rest.get('/api/endpoint', (req, res, ctx) => 
        res(ctx.json(mockData))
      )
    );
  });
});
```

### Running Tests
- Backend: `npm test -- --watch`
- Frontend: `npm test -- --watch`
- E2E: `npx playwright test`
```

---

## 2. Multi-Session Strategy Overview

### Parallel Workstreams

```
┌─────────────────────────────────────────────────────────────────┐
│                    MULTI-SESSION ARCHITECTURE                    │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────┐         ┌──────────────────┐             │
│  │   TERMINAL 1     │         │   TERMINAL 2     │             │
│  │   Backend Repl   │         │   Frontend Repl  │             │
│  │   ninja-backend  │         │   ninja-frontend │             │
│  └────────┬─────────┘         └────────┬─────────┘             │
│           │                            │                        │
│           │                            │                        │
│  ┌────────▼─────────┐         ┌────────▼─────────┐             │
│  │ Session B1       │         │ Session F1       │             │
│  │ DB Schema        │         │ Types & Service  │             │
│  │ (30 min)         │         │ (30 min)         │             │
│  └────────┬─────────┘         └────────┬─────────┘             │
│           │                            │                        │
│  ┌────────▼─────────┐         ┌────────▼─────────┐             │
│  │ Session B2       │         │ Session F2       │             │
│  │ Service Layer    │◄───────►│ React Query      │             │
│  │ (45 min)         │  sync   │ Hooks (20 min)   │             │
│  └────────┬─────────┘         └────────┬─────────┘             │
│           │                            │                        │
│  ┌────────▼─────────┐         ┌────────▼─────────┐             │
│  │ Session B3       │         │ Session F3       │             │
│  │ Controller &     │◄───────►│ Components       │             │
│  │ Routes (45 min)  │  test   │ (60 min)         │             │
│  └────────┬─────────┘         └────────┬─────────┘             │
│           │                            │                        │
│  ┌────────▼─────────┐         ┌────────▼─────────┐             │
│  │ Session B4       │         │ Session F4       │             │
│  │ Integration &    │◄───────►│ Page & Route     │             │
│  │ Remediation Svc  │  e2e    │ Integration      │             │
│  │ Update (45 min)  │         │ (30 min)         │             │
│  └────────┬─────────┘         └────────┬─────────┘             │
│           │                            │                        │
│           └────────────┬───────────────┘                        │
│                        │                                        │
│               ┌────────▼─────────┐                             │
│               │ Session JOINT    │                             │
│               │ E2E Testing &    │                             │
│               │ PR Creation      │                             │
│               └──────────────────┘                             │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Session Dependencies

| Session | Depends On | Enables |
|---------|------------|---------|
| B1 (Schema) | None | B2, F1 |
| B2 (Service) | B1 | B3 |
| B3 (Controller) | B2 | B4 |
| B4 (Integration) | B3 | JOINT |
| F1 (Types/Service) | B1 (schema aware) | F2 |
| F2 (Hooks) | F1 | F3 |
| F3 (Components) | F2 | F4 |
| F4 (Page) | F3 | JOINT |
| JOINT (E2E) | B4, F4 | PR |

---

## 3. Pre-Implementation Setup

### 3.1 Git Setup (Both Repls)

**Terminal 1 - Backend:**
```bash
cd ninja-backend
git checkout main && git pull origin main
git checkout -b feature/visual-comparison
```

**Terminal 2 - Frontend:**
```bash
cd ninja-frontend
git checkout main && git pull origin main
git checkout -b feature/visual-comparison
```

### 3.2 Update CLAUDE.md Files

**Backend CLAUDE.md Addition:**
```markdown
## Current Feature: Visual Comparison (Phase 1)

### Implementation Status
- [ ] B1: Database schema
- [ ] B2: Comparison service
- [ ] B3: Controller & routes
- [ ] B4: Remediation service integration

### Session Checkpoint
Updated: [timestamp]
Last completed: [step]
Next step: [step]
Blockers: [none/description]
```

**Frontend CLAUDE.md Addition:**
```markdown
## Current Feature: Visual Comparison (Phase 1)

### Implementation Status
- [ ] F1: Types & API service
- [ ] F2: React Query hooks
- [ ] F3: UI components
- [ ] F4: Page & route integration

### Session Checkpoint
Updated: [timestamp]
Last completed: [step]
Next step: [step]
Blockers: [none/description]
```

### 3.3 Notification Setup

Add to `~/.claude/settings.json` on your local machine:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "osascript -e 'display notification \"Ninja session completed\" with title \"Claude Code\" sound name \"Glass\"'",
            "timeout": 10
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt|idle_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "osascript -e 'display notification \"Claude needs input\" with title \"Ninja Development\" sound name \"Ping\"'"
          }
        ]
      }
    ]
  }
}
```

---

## 4. Session Architecture

### 4.1 Recommended Approach: Sequential with Checkpoints

For the Ninja Platform implementation, I recommend a **sequential approach with clear checkpoints** rather than fully parallel sessions, because:

1. **Two separate Repls** - Backend and frontend are in different environments
2. **API dependency** - Frontend needs backend API to be functional for integration testing
3. **Replit constraints** - Replit AI Agent works best with focused, sequential tasks

### 4.2 Session Execution Strategy

**Option A: Single Developer (Recommended for Initial Implementation)**
```
Day 1 Morning:   B1 → B2 (Backend database + service)
Day 1 Afternoon: B3 → B4 (Backend controller + integration)
Day 2 Morning:   F1 → F2 (Frontend types + hooks)
Day 2 Afternoon: F3 → F4 (Frontend components + page)
Day 3:           JOINT (E2E testing, PR creation, CodeRabbit fixes)
```

**Option B: Two Developers (Parallel)**
```
Developer 1 (Backend):  B1 → B2 → B3 → B4
Developer 2 (Frontend): [wait for B1] → F1 → F2 → F3 → F4
Sync Points: After B1, After B4
```

### 4.3 Context Sharing Between Sessions

Each session should:
1. **Start** by reading CLAUDE.md and checking last checkpoint
2. **During** work, periodically update checkpoint in CLAUDE.md
3. **End** with a commit that includes updated checkpoint

---

## 5. Detailed Session Plans

### Session B1: Database Schema (Backend)
**Duration:** 30-45 minutes  
**Repl:** ninja-backend

#### Objective
Create Prisma models for Visual Comparison feature

#### Pre-Prompt Context
```
Reference documents:
- VISUAL_COMPARISON_DESIGN.md (Database Design section)
- VISUAL_COMPARISON_IMPLEMENTATION_PROMPTS.md (Step 1)
```

#### Replit Prompt
```
Add the following models to prisma/schema.prisma for the Visual Comparison feature:

1. RemediationChange model:
   - id: String (UUID primary key)
   - jobId: String (foreign key to Job)
   - taskId: String? (optional foreign key)
   - changeNumber: Int (sequential number within job)
   - issueId: String? (original audit issue ID)
   - ruleId: String? (e.g., "WCAG2AA.Principle1.Guideline1_1.1_1_1")
   - filePath: String (e.g., "OEBPS/chapter1.xhtml")
   - elementXPath: String? (XPath to modified element)
   - lineNumber: Int?
   - changeType: String (e.g., "add-alt-text", "fix-heading")
   - description: String
   - beforeContent: String? @db.Text
   - afterContent: String? @db.Text
   - contextBefore: String? @db.Text
   - contextAfter: String? @db.Text
   - severity: String? (CRITICAL, MAJOR, MINOR, INFO)
   - wcagCriteria: String?
   - wcagLevel: String?
   - status: ChangeStatus @default(APPLIED)
   - appliedAt: DateTime @default(now())
   - appliedBy: String?
   - Add indexes on: jobId, status
   - Add relation to Job model

2. ChangeStatus enum: APPLIED, REJECTED, REVERTED, FAILED, SKIPPED

3. ComparisonReport model:
   - id: String (UUID primary key)
   - jobId: String @unique
   - totalChanges: Int
   - appliedCount: Int
   - rejectedCount: Int
   - skippedCount: Int
   - failedCount: Int
   - reportData: Json?
   - pdfUrl: String?
   - generatedAt: DateTime @default(now())
   - generatedBy: String?
   - Add relation to Job model

4. Update Job model to add: remediationChanges RemediationChange[]

After adding:
1. npx prisma generate
2. npx prisma migrate dev --name add_visual_comparison_models
```

#### Verification
- [ ] Schema compiles without errors
- [ ] Migration created successfully
- [ ] `npx prisma studio` shows new tables

#### Checkpoint Update
```markdown
### Session Checkpoint
Updated: [DATE TIME]
Last completed: B1 - Database schema
Next step: B2 - Comparison service
Blockers: None
```

---

### Session B2: Comparison Service (Backend)
**Duration:** 45-60 minutes  
**Repl:** ninja-backend

#### Pre-Prompt Context
```
B1 is complete. RemediationChange and ComparisonReport models exist.
Reference: VISUAL_COMPARISON_IMPLEMENTATION_PROMPTS.md (Steps 2-3)
```

#### Replit Prompt
```
Create the comparison service layer for Visual Comparison feature:

1. Create src/types/comparison.types.ts with interfaces:
   - ComparisonSummary (totalChanges, applied, rejected, skipped, failed, etc.)
   - ChangeSummaryByCategory (count, applied, rejected)
   - ComparisonData (jobId, fileName, summary, byType, bySeverity, byWcag, pagination, changes)
   - PaginationInfo (page, limit, total, pages)
   - ComparisonFilters (changeType?, severity?, status?, wcagCriteria?, page?, limit?)
   - CreateChangeData (all fields for creating a change)

2. Create src/services/comparison/comparison.service.ts with methods:

   a. getComparison(jobId: string, userId?: string, pagination?: {page, limit})
      - Fetch all RemediationChange records for jobId
      - Calculate summary statistics
      - Group by type, severity, WCAG criteria
      - Include Job details (fileName, dates)
      - Support pagination (default 50 per page)
      - Return ComparisonData

   b. getChangeById(jobId: string, changeId: string, userId?: string)
      - Fetch single change with full context
      - Throw error if not found

   c. getChangesByFilter(jobId: string, filters: ComparisonFilters, userId?: string)
      - Filter by changeType, severity, status, wcagCriteria
      - Support search by filePath, description
      - Return paginated results

   d. logChange(data: CreateChangeData): Promise<RemediationChange>
      - Create new RemediationChange record
      - Auto-increment changeNumber within job
      - Return created change

   e. updateChangeStatus(changeId: string, status: ChangeStatus, userId?: string)
      - Update change status
      - Return updated change

Follow the service pattern from feedback.service.ts.
Use proper error handling with try-catch blocks.
Export the service class.
```

#### Verification
- [ ] TypeScript compiles without errors
- [ ] Service methods follow existing patterns
- [ ] Types are properly exported

---

### Session B3: Controller & Routes (Backend)
**Duration:** 45-60 minutes  
**Repl:** ninja-backend

#### Pre-Prompt Context
```
B1, B2 complete. Service layer exists.
Reference: VISUAL_COMPARISON_IMPLEMENTATION_PROMPTS.md (Steps 4-5)
```

#### Replit Prompt
```
Create the comparison controller and routes:

1. Create src/controllers/comparison.controller.ts with methods:

   a. getComparison(req, res, next)
      - Extract jobId from req.params
      - Extract userId from req.user
      - Extract page, limit from query params
      - Call comparisonService.getComparison()
      - Return success response

   b. getChangeById(req, res, next)
      - Extract jobId, changeId from params
      - Call comparisonService.getChangeById()
      - Return success response

   c. getChangesByFilter(req, res, next)
      - Extract filters from query params
      - Call comparisonService.getChangesByFilter()
      - Return success response

2. Create src/routes/comparison.routes.ts:

   Routes (all require authentication):
   - GET / - getComparison
   - GET /changes/:changeId - getChangeById  
   - GET /filter - getChangesByFilter

3. Update src/routes/index.ts or job routes to mount:
   router.use('/jobs/:jobId/comparison', comparisonRoutes)

Follow the controller pattern from other controllers.
Add Zod validation schemas for query parameters.
Use authenticate middleware on all routes.
```

#### Verification
- [ ] Routes registered correctly
- [ ] API responds to test requests
- [ ] Authentication works

---

### Session B4: Remediation Service Integration (Backend)
**Duration:** 45-60 minutes  
**Repl:** ninja-backend

#### Pre-Prompt Context
```
B1-B3 complete. API endpoints working.
Now integrate change logging into remediation service.
```

#### Replit Prompt
```
Integrate change logging into the remediation service:

1. Update src/services/epub.controller.ts (or wherever remediation logic is):

   In the applyQuickFix method:
   - After successful fix, call comparisonService.logChange() with:
     - jobId, taskId (if applicable)
     - filePath, changeType, description
     - beforeContent, afterContent
     - severity, wcagCriteria from the issue
     - status: 'APPLIED'

   In the runAutoRemediation method:
   - For each ModificationResult, call comparisonService.logChange()
   - Map modificationType to changeType
   - Include before/after content
   - Track line numbers if available

2. Import and instantiate ComparisonService in the controller/service

3. Ensure changes are logged in a transaction with the main operation

4. Add error handling - don't fail remediation if change logging fails,
   but log the error

Test by:
1. Running a remediation on a test EPUB
2. Calling GET /api/v1/jobs/:jobId/comparison
3. Verifying changes appear in response
```

#### Verification
- [ ] Remediation logs changes to database
- [ ] Comparison API returns logged changes
- [ ] No performance degradation in remediation

---

### Session F1: Types & API Service (Frontend)
**Duration:** 30-45 minutes  
**Repl:** ninja-frontend

#### Pre-Prompt Context
```
Backend B1 complete (schema defined).
Reference: VISUAL_COMPARISON_IMPLEMENTATION_PROMPTS.md (Step 6)
```

#### Replit Prompt
```
Create frontend types and API service for Visual Comparison:

1. Create src/types/comparison.ts with interfaces:
   - RemediationChange (match backend model)
   - ChangeStatus enum
   - ComparisonSummary
   - ChangeSummaryByCategory  
   - ComparisonData
   - PaginationInfo
   - ComparisonFilters

2. Create src/services/comparison.service.ts:

   a. getComparison(jobId: string, params?: {page?, limit?})
      - GET /api/v1/jobs/${jobId}/comparison
      - Return ComparisonData

   b. getChangeById(jobId: string, changeId: string)
      - GET /api/v1/jobs/${jobId}/comparison/changes/${changeId}
      - Return RemediationChange

   c. getChangesByFilter(jobId: string, filters: ComparisonFilters)
      - GET /api/v1/jobs/${jobId}/comparison/filter
      - Pass filters as query params
      - Return ComparisonData

Use the existing API client pattern (check how other services make API calls).
Handle errors consistently with other services.
```

#### Verification
- [ ] Types match backend responses
- [ ] API service methods compile
- [ ] Follows existing patterns

---

### Session F2: React Query Hooks (Frontend)
**Duration:** 20-30 minutes  
**Repl:** ninja-frontend

#### Pre-Prompt Context
```
F1 complete. Types and service exist.
Reference: VISUAL_COMPARISON_IMPLEMENTATION_PROMPTS.md (Step 7)
```

#### Replit Prompt
```
Create React Query hooks for comparison data:

Create src/hooks/useComparison.ts:

1. useComparison(jobId: string, options?: {page?, limit?})
   - Use useQuery with queryKey: ['comparison', jobId, page, limit]
   - Call comparisonService.getComparison()
   - Return query result with data, isLoading, error

2. useComparisonChange(jobId: string, changeId: string)
   - Use useQuery with queryKey: ['comparison', jobId, 'change', changeId]
   - Call comparisonService.getChangeById()
   - Enabled only when changeId is provided

3. useFilteredComparison(jobId: string, filters: ComparisonFilters)
   - Use useQuery with queryKey: ['comparison', jobId, 'filtered', filters]
   - Call comparisonService.getChangesByFilter()
   - Refetch when filters change

Follow the hook patterns from other hooks (e.g., useFiles.ts).
Export all hooks.
```

#### Verification
- [ ] Hooks follow existing patterns
- [ ] TypeScript compiles without errors
- [ ] Query keys are consistent

---

### Session F3: UI Components (Frontend)
**Duration:** 60-90 minutes  
**Repl:** ninja-frontend

#### Pre-Prompt Context
```
F1, F2 complete. Types, service, hooks exist.
Reference: VISUAL_COMPARISON_IMPLEMENTATION_PROMPTS.md (Step 8)
This is the largest frontend session.
```

#### Replit Prompt
```
Create UI components for the Visual Comparison feature.

First, install react-syntax-highlighter:
npm install react-syntax-highlighter @types/react-syntax-highlighter

Create the following components in src/components/comparison/:

1. ComparisonHeader.tsx
   Props: summary: ComparisonSummary, fileName: string
   Display:
   - File name
   - Summary stats: Total Changes, Applied, Rejected, Skipped
   - Progress bar or pie chart showing resolution
   Use TailwindCSS for styling

2. FilterBar.tsx
   Props: 
     filters: ComparisonFilters
     onFilterChange: (filters) => void
     changeTypes: string[] (available types)

   Controls:
   - Dropdown for changeType (All, add-alt-text, fix-heading, etc.)
   - Dropdown for severity (All, CRITICAL, MAJOR, MINOR)
   - Dropdown for status (All, APPLIED, REJECTED, SKIPPED)
   - Reset filters button

3. IssueNavigator.tsx
   Props:
     currentIndex: number
     totalCount: number
     onPrevious: () => void
     onNext: () => void
     onJumpTo: (index: number) => void

   Display:
   - "Change X of Y" indicator
   - Previous/Next buttons
   - Optional: Jump to dropdown

4. ComparisonPanel.tsx
   Props: change: RemediationChange
   Display:
   - Change header: description, file path, line number
   - Severity badge (colored: red=critical, orange=major, yellow=minor)
   - WCAG badge (e.g., "WCAG 1.1.1 (A)")
   - Status badge
   - Side-by-side diff:
     - Left: BEFORE (beforeContent or contextBefore)
     - Right: AFTER (afterContent or contextAfter)
     - Use react-syntax-highlighter for XML syntax highlighting:
       import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
       import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';
   - If no content, show "No preview available"

Use TailwindCSS for responsive layout (grid for side-by-side, stack on mobile).
```

#### Verification
- [ ] Components render without errors
- [ ] Syntax highlighting works
- [ ] Responsive layout functions

---

### Session F4: Page & Route Integration (Frontend)
**Duration:** 30-45 minutes  
**Repl:** ninja-frontend

#### Pre-Prompt Context
```
F1-F3 complete. All components exist.
Reference: VISUAL_COMPARISON_IMPLEMENTATION_PROMPTS.md (Steps 9-10)
```

#### Replit Prompt
```
Create the ComparisonPage and integrate with routing:

1. Create src/pages/ComparisonPage.tsx:

   - Use useParams to get jobId from URL
   - Use useComparison hook to fetch data
   - Manage state for:
     - currentIndex (which change is being viewed)
     - filters (ComparisonFilters)

   Layout:
   - ComparisonHeader at top
   - FilterBar below header
   - IssueNavigator in middle
   - ComparisonPanel showing current change

   Logic:
   - Filter changes based on filters state
   - Navigate through filtered changes with prev/next
   - Show loading spinner while fetching
   - Show error message if fetch fails
   - Show "No changes found" if empty

2. Add route in src/App.tsx (or routes file):
   <Route path="/jobs/:jobId/comparison" element={<ComparisonPage />} />

   Place with other job routes, ensure authentication wrapper if needed.

3. Add navigation link from Job details/Remediation page:
   Find the appropriate page and add:
   <Link to={`/jobs/${jobId}/comparison`} className="btn btn-primary">
     Review Changes
   </Link>

   Only show if job has completed remediation.
```

#### Verification
- [ ] Page loads at /jobs/:jobId/comparison
- [ ] Navigation from job details works
- [ ] Filtering and navigation function

---

### Session JOINT: E2E Testing & PR Creation
**Duration:** 60-90 minutes  
**Both Repls + Local**

#### Objectives
1. End-to-end testing
2. Create and submit PRs
3. Address CodeRabbit feedback

#### Replit Prompt (Backend)
```
Test and prepare backend PR:

1. Write basic integration test:
   Create src/services/comparison/__tests__/comparison.service.test.ts
   - Test getComparison returns correct summary
   - Test filtering works
   - Test pagination works
   (Reference: VISUAL_COMPARISON_TESTS.md)

2. Run tests: npm test

3. Create commit:
   git add .
   git commit -m "feat: Visual Comparison backend (Phase 1 MVP)

   - Add RemediationChange and ComparisonReport models
   - Create ComparisonService with filtering and pagination
   - Add comparison API endpoints
   - Integrate change logging into remediation service

   Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"

4. Push: git push -u origin feature/visual-comparison

5. Create PR via GitHub CLI or web
```

#### Replit Prompt (Frontend)
```
Test and prepare frontend PR:

1. Test manually:
   - Navigate to a job with remediation
   - Click "Review Changes"
   - Verify summary displays
   - Test prev/next navigation
   - Test filtering
   - Check mobile responsiveness

2. Create commit:
   git add .
   git commit -m "feat: Visual Comparison frontend (Phase 1 MVP)

   - Add comparison types and API service
   - Create React Query hooks for comparison data
   - Build ComparisonPage with filtering and navigation
   - Add side-by-side diff view with syntax highlighting

   Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"

3. Push: git push -u origin feature/visual-comparison

4. Create PR
```

---

## 6. Handover Procedures

### Between Sessions (Same Day)

1. **Save checkpoint in CLAUDE.md:**
   ```markdown
   ### Session Checkpoint
   Updated: 2026-01-08 14:30 IST
   Last completed: B2 - Comparison service
   Next step: B3 - Controller & routes
   Files modified: src/services/comparison/*, src/types/*
   Blockers: None
   ```

2. **Commit work-in-progress:**
   ```bash
   git add .
   git commit -m "wip: comparison service layer"
   git push origin feature/visual-comparison
   ```

### Between Days

1. **Update CLAUDE.md with detailed status:**
   ```markdown
   ### End of Day Status - January 8, 2026

   **Completed:**
   - B1: Database schema ✅
   - B2: Comparison service ✅

   **In Progress:**
   - B3: Controller (routes defined, controller 50% complete)

   **Tomorrow:**
   - Complete B3
   - Start B4

   **Notes:**
   - Zod validation needed for query params
   - Consider caching for large change sets
   ```

2. **Resume prompt for next session:**
   ```
   Resume Visual Comparison implementation.

   Status: B2 complete, B3 in progress.

   Continue with comparison.controller.ts:
   - getChangesByFilter method not implemented yet
   - Need to add Zod validation schemas

   Then proceed to comparison.routes.ts.
   ```

### Terminal ↔ Web Handover

If moving from Replit web to Claude Code CLI:

1. **Export session state:**
   - Note current file being edited
   - Copy any uncommitted code snippets
   - Document exact position in implementation

2. **In Claude Code CLI:**
   ```bash
   cd ninja-backend  # or ninja-frontend
   git pull origin feature/visual-comparison
   claude -c  # Continue most recent session
   ```

3. **Resume prompt:**
   ```
   Continuing Visual Comparison implementation from Replit session.

   Last state:
   - Working on: src/controllers/comparison.controller.ts
   - Completed: getComparison, getChangeById methods
   - Next: getChangesByFilter method

   Please read the current file and continue implementation.
   ```

---

## 7. Verification Checkpoints

### After B1 (Schema)
```bash
# Verify migration
npx prisma studio  # Check tables exist

# Check schema
npx prisma validate
```

### After B2 (Service)
```bash
# Compile check
npm run build

# Type check
npx tsc --noEmit
```

### After B3 (Routes)
```bash
# Start server
npm run dev

# Test endpoint (replace with actual jobId)
curl http://localhost:3000/api/v1/jobs/test-job/comparison \
  -H "Authorization: Bearer <token>"
```

### After B4 (Integration)
```bash
# Run a remediation, then check:
curl http://localhost:3000/api/v1/jobs/<jobId>/comparison \
  -H "Authorization: Bearer <token>"

# Verify changes array is populated
```

### After F4 (Frontend Complete)
```bash
# Start frontend
npm run dev

# Manual tests:
# 1. Navigate to /jobs/<jobId>/comparison
# 2. Verify summary loads
# 3. Test prev/next navigation
# 4. Test filtering
# 5. Check mobile view
```

### E2E Verification
```bash
# Full workflow test:
# 1. Upload EPUB
# 2. Run audit
# 3. Apply auto-remediation
# 4. Navigate to comparison page
# 5. Review all changes
# 6. Verify counts match
```

---

## 8. Notification Configuration

### macOS Desktop Notifications

**File:** `~/.claude/settings.json`

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "osascript -e 'display notification \"Ninja task completed\" with title \"Claude Code\" sound name \"Glass\"'",
            "timeout": 10
          }
        ]
      }
    ],
    "Notification": [
      {
        "matcher": "permission_prompt|idle_prompt",
        "hooks": [
          {
            "type": "command",
            "command": "osascript -e 'display notification \"Claude needs attention\" with title \"Ninja Dev\" sound name \"Ping\"'"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Bash|Edit|Write",
        "hooks": [
          {
            "type": "command",
            "command": "echo \"$(date): Tool completed\" >> ~/.claude/ninja-session.log"
          }
        ]
      }
    ]
  }
}
```

### Mobile Notifications (ntfy.sh)

1. Install ntfy app on phone
2. Subscribe to topic: `ninja-claude-alerts-[random]`
3. Add hook:

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "curl -d 'Ninja session completed' ntfy.sh/ninja-claude-alerts-abc123"
          }
        ]
      }
    ]
  }
}
```

---

## 9. Risk Mitigation

### Risk: API Incompatibility
**Symptom:** Frontend fails to parse API response  
**Mitigation:** 
- Define types before implementation
- Test API responses match type definitions
- Use Zod for runtime validation

### Risk: Large Change Sets Performance
**Symptom:** Slow loading for 500+ changes  
**Mitigation:**
- Implement pagination from start (50 per page)
- Lazy load full content on demand
- Add loading indicators

### Risk: Merge Conflicts
**Symptom:** Conflicts when merging feature branch  
**Mitigation:**
- Frequent commits and pushes
- Rebase on main daily: `git rebase origin/main`
- Coordinate if multiple developers

### Risk: CodeRabbit Feedback Overload
**Symptom:** Many review comments to address  
**Mitigation:**
- Follow existing code patterns exactly
- Add proper error handling from start
- Include TypeScript types for everything

### Risk: Session Context Loss
**Symptom:** New session doesn't know previous state  
**Mitigation:**
- Update CLAUDE.md checkpoint after each session
- Commit work-in-progress frequently
- Use descriptive commit messages

---

## Appendix A: Quick Reference Commands

### Git Commands
```bash
# Start feature branch
git checkout main && git pull && git checkout -b feature/visual-comparison

# Save progress
git add . && git commit -m "wip: description" && git push

# Create PR
gh pr create --title "feat: Visual Comparison" --body "Description"

# Rebase on main
git fetch origin && git rebase origin/main

# View changes
git diff --stat origin/main
```

### Prisma Commands
```bash
# Generate client
npx prisma generate

# Create migration
npx prisma migrate dev --name migration_name

# View database
npx prisma studio

# Reset database (caution!)
npx prisma migrate reset
```

### Development Commands
```bash
# Backend
npm run dev          # Start server
npm test            # Run tests
npm run build       # Build for production

# Frontend
npm run dev          # Start dev server
npm test            # Run tests
npm run build       # Build for production
```

---

## Appendix B: Estimated Timeline

### Phase 1 MVP - 8-10 Sessions

| Session | Duration | Day |
|---------|----------|-----|
| B1: Schema | 30-45 min | Day 1 |
| B2: Service | 45-60 min | Day 1 |
| B3: Controller | 45-60 min | Day 1 |
| B4: Integration | 45-60 min | Day 2 |
| F1: Types | 30-45 min | Day 2 |
| F2: Hooks | 20-30 min | Day 2 |
| F3: Components | 60-90 min | Day 3 |
| F4: Page | 30-45 min | Day 3 |
| JOINT: E2E + PR | 60-90 min | Day 3 |

**Total Estimated Time:** 6-8 hours over 3 days

---

*Document generated: January 8, 2026*
*For Ninja Platform Visual Comparison Feature Implementation*
