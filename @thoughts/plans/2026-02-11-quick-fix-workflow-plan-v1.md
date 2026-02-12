# Quick-Fix Workflow Implementation Plan - Version 1

**Date:** 2026-02-11
**Plan Version:** 1 of 5 (iterative refinement)
**Research Document:** `@thoughts/research/2026-02-11-quick-fix-workflow.md`

---

## Plan Overview

Implement a guided workflow for users to fix 796 PDF accessibility issues requiring human input (alt text, table headers, form labels, link text). Build upon existing patterns from VerificationQueue, Batch orchestration, and PDF preview components.

---

## Implementation Phases

### Phase 1: MVP - Core Workflow & Alt Text (Week 1)

**Goal:** Working workflow for alt-text issues only

**Backend Tasks:**
1. Database schema additions
2. Session management service
3. API endpoints for session CRUD
4. Alt-text handler integration

**Frontend Tasks:**
1. QuickFixWorkflow container component
2. Navigation (Next/Previous/Skip)
3. Progress bar component
4. AltTextForm component
5. PDF preview integration

**Deliverable:** User can navigate alt-text issues, provide descriptions, track progress, save/resume session

---

### Phase 2: Additional Issue Types (Week 2)

**Goal:** Support all major issue types

**Backend Tasks:**
1. Table header handler
2. Form label handler
3. Link text handler
4. Heading structure handler
5. Issue type router

**Frontend Tasks:**
1. TableHeaderForm component
2. FormLabelForm component
3. LinkTextForm component
4. HeadingForm component
5. Type detection and form routing

**Deliverable:** All major issue types supported

---

### Phase 3: Advanced Features (Week 3)

**Goal:** AI assistance and bulk operations

**Backend Tasks:**
1. Gemini AI integration for suggestions
2. Bulk operations API
3. Template management
4. Enhanced PDF preview (coordinate mapping)

**Frontend Tasks:**
1. AI suggestion UI
2. Bulk edit modal
3. Template library
4. Enhanced zoom/highlight
5. Jump to specific issue

**Deliverable:** Complete workflow with AI assistance

---

### Phase 4: Apply Fixes (Week 4)

**Goal:** Modify PDF with user-provided fixes

**Backend Tasks:**
1. PDF modification engine for quick-fix types
2. Apply fixes transaction
3. Verification and testing
4. Error handling and rollback

**Frontend Tasks:**
1. Apply fixes confirmation
2. Progress indicator during application
3. Download remediated PDF
4. Success/error states

**Deliverable:** End-to-end working system

---

## Multi-Terminal Development Strategy

### Terminal 1: Backend - Session Management
**Phases:** 1, 2
**Tasks:**
- Create Prisma schema for QuickFixSession, QuickFixTask
- Implement QuickFixSessionService
- Create session controller and routes
- Write tests

**Dependencies:** None (can start immediately)

### Terminal 2: Backend - Issue Handlers
**Phases:** 1, 2, 3
**Tasks:**
- Implement alt-text handler (Phase 1)
- Implement table/form/link handlers (Phase 2)
- AI suggestion integration (Phase 3)

**Dependencies:** Needs schema from Terminal 1

### Terminal 3: Frontend - Workflow Container
**Phases:** 1, 2, 3
**Tasks:**
- Create QuickFixWorkflow component
- Navigation logic
- Progress tracking
- Session save/resume
- React Query hooks

**Dependencies:** Needs API from Terminal 1

### Terminal 4: Frontend - Issue Forms
**Phases:** 1, 2, 3
**Tasks:**
- Create AltTextForm (Phase 1)
- Create other form components (Phase 2)
- AI suggestion UI (Phase 3)
- Form validation

**Dependencies:** None (can use mock data initially)

### Terminal 5: Frontend - PDF Integration
**Phases:** 1, 2, 3
**Tasks:**
- Adapt PdfPreviewPanel for quick-fix
- Issue highlighting
- Coordinate parsing
- Zoom/pan controls

**Dependencies:** None (reuses existing components)

### Terminal 6: Backend - PDF Application
**Phases:** 4
**Tasks:**
- PDF modification engine
- Apply fixes service
- Verification tests
- Rollback logic

**Dependencies:** All previous phases

---

## Database Schema Design

### QuickFixSession Table

```prisma
model QuickFixSession {
  id              String    @id @default(nanoid())
  jobId           String    // Link to PDF audit job
  userId          String
  tenantId        String

  totalIssues     Int
  completedIssues Int       @default(0)
  skippedIssues   Int       @default(0)
  currentIndex    Int       @default(0)

  status          SessionStatus @default(PENDING)

  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  completedAt     DateTime?

  user            User      @relation(fields: [userId], references: [id])
  job             Job       @relation(fields: [jobId], references: [id])
  tasks           QuickFixTask[]

  @@index([jobId])
  @@index([userId])
  @@index([status])
}

enum SessionStatus {
  PENDING
  IN_PROGRESS
  PAUSED
  COMPLETED
  CANCELLED
}
```

### QuickFixTask Table

```prisma
model QuickFixTask {
  id              String    @id @default(nanoid())
  sessionId       String
  taskId          String    // From RemediationTask

  issueCode       String
  issueType       IssueType
  description     String
  pageNumber      Int?
  elementPath     String?

  status          TaskStatus @default(PENDING)
  fixData         Json?     // User-provided fix (alt text, table headers, etc.)
  aiSuggestion    Json?     // AI-generated suggestion

  submittedAt     DateTime?

  session         QuickFixSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@index([sessionId])
  @@index([taskId])
  @@index([status])
}

enum IssueType {
  ALT_TEXT
  TABLE_HEADER
  FORM_LABEL
  LINK_TEXT
  HEADING
  LIST_STRUCTURE
}

enum TaskStatus {
  PENDING
  COMPLETED
  SKIPPED
}
```

---

## API Endpoints Specification

### Session Management

**POST /api/v1/pdf/:jobId/quick-fix/start**
- Create new session or resume existing
- Initialize tasks from remediation plan
- Response:
  ```typescript
  {
    success: true,
    data: {
      sessionId: string;
      totalIssues: number;
      completed: number;
      currentIssue: QuickFixIssue;
    }
  }
  ```

**GET /api/v1/pdf/:jobId/quick-fix/session/:sessionId**
- Get session details
- Response includes current issue, progress, all tasks

**POST /api/v1/pdf/:jobId/quick-fix/session/:sessionId/save**
- Save current progress
- Update session status to PAUSED

**DELETE /api/v1/pdf/:jobId/quick-fix/session/:sessionId**
- Cancel session

### Navigation

**GET /api/v1/pdf/:jobId/quick-fix/session/:sessionId/next**
- Get next issue
- Increment currentIndex

**GET /api/v1/pdf/:jobId/quick-fix/session/:sessionId/previous**
- Get previous issue
- Decrement currentIndex

**GET /api/v1/pdf/:jobId/quick-fix/session/:sessionId/issue/:taskId**
- Jump to specific issue

### Issue Actions

**POST /api/v1/pdf/:jobId/quick-fix/session/:sessionId/submit**
- Submit fix for current issue
- Body:
  ```typescript
  {
    taskId: string;
    fixData: {
      altText?: string;
      headers?: { row: number; col: number; type: 'row' | 'col' | 'both' }[];
      label?: string;
      linkText?: string;
    }
  }
  ```

**POST /api/v1/pdf/:jobId/quick-fix/session/:sessionId/skip**
- Skip current issue
- Body: `{ taskId: string; reason?: string }`

**POST /api/v1/pdf/:jobId/quick-fix/session/:sessionId/bulk-submit**
- Submit fixes for multiple issues
- Body:
  ```typescript
  {
    fixes: Array<{ taskId: string; fixData: Record<string, any> }>;
  }
  ```

### AI Suggestions

**GET /api/v1/pdf/:jobId/quick-fix/session/:sessionId/issue/:taskId/suggest**
- Get AI-generated suggestion
- Response:
  ```typescript
  {
    success: true,
    data: {
      suggestions: string[];
      confidence: number;
    }
  }
  ```

### Apply Fixes

**POST /api/v1/pdf/:jobId/quick-fix/session/:sessionId/apply**
- Apply all fixes to PDF
- Response:
  ```typescript
  {
    success: true,
    data: {
      appliedCount: number;
      remediatedFileUrl: string;
      verificationReport: VerificationResult;
    }
  }
  ```

---

## Component Architecture

### Frontend Component Hierarchy

```
QuickFixWorkflowPage
├── QuickFixProgress
│   ├── ProgressBar
│   ├── Statistics (X of Y completed)
│   └── SaveExitButton
│
├── PdfPreviewPanel (adapted)
│   ├── PdfDocument
│   ├── IssueHighlight (current issue)
│   └── ZoomControls
│
└── QuickFixIssuePanel
    ├── IssueHeader (title, severity, page)
    ├── IssueContext (description, location)
    ├── DynamicForm (based on issue type)
    │   ├── AltTextForm
    │   ├── TableHeaderForm
    │   ├── FormLabelForm
    │   └── LinkTextForm
    │
    ├── AISuggestions (optional)
    └── ActionButtons
        ├── SkipButton
        ├── PreviousButton
        ├── SubmitButton
        └── NextButton
```

---

## Data Flow

### Session Start Flow

```
User clicks "Start Quick Fix" on Remediation Plan page
  ↓
Frontend: POST /quick-fix/start
  ↓
Backend: Check for existing session
  ├─ Exists → Resume (status: IN_PROGRESS)
  └─ Not exists → Create new session
  ↓
Backend: Initialize tasks from RemediationPlan.tasks
  ↓
Backend: Filter quick-fix tasks (type === 'QUICK_FIX')
  ↓
Backend: Create QuickFixTask records
  ↓
Backend: Return session + first issue
  ↓
Frontend: Navigate to /quick-fix/:sessionId
  ↓
Frontend: Load PDF, display issue, show form
```

### Submit Fix Flow

```
User fills form and clicks Submit
  ↓
Frontend: Validate form data
  ↓
Frontend: POST /session/:sessionId/submit
  ↓
Backend: Validate taskId and sessionId
  ↓
Backend: Transaction:
  ├─ Update QuickFixTask (status: COMPLETED, fixData)
  ├─ Increment session.completedIssues
  └─ Emit SSE event: quick_fix_issue_fixed
  ↓
Backend: Return next issue
  ↓
Frontend: Invalidate queries, show next issue
  ↓
Frontend: Show success toast
```

### Save & Exit Flow

```
User clicks "Save & Exit"
  ↓
Frontend: POST /session/:sessionId/save
  ↓
Backend: Update session (status: PAUSED, currentIndex)
  ↓
Backend: Emit SSE event: quick_fix_saved
  ↓
Frontend: Navigate back to Remediation Plan page
  ↓
Frontend: Show "Resume Quick Fix" button
```

---

## React Query Hooks

```typescript
// Session management
export function useQuickFixSession(jobId: string) {
  return useQuery({
    queryKey: ['quick-fix-session', jobId],
    queryFn: () => quickFixService.getSession(jobId),
  });
}

export function useStartQuickFix(jobId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => quickFixService.startSession(jobId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quick-fix-session', jobId] });
    },
  });
}

// Issue submission
export function useSubmitFix(sessionId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { taskId: string; fixData: any }) =>
      quickFixService.submitFix(sessionId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['quick-fix-session'] });
    },
  });
}

// Navigation
export function useNextIssue(sessionId: string) {
  return useMutation({
    mutationFn: () => quickFixService.getNextIssue(sessionId),
  });
}

// AI Suggestions
export function useGetSuggestion(sessionId: string, taskId: string) {
  return useQuery({
    queryKey: ['ai-suggestion', sessionId, taskId],
    queryFn: () => quickFixService.getSuggestion(sessionId, taskId),
    enabled: false, // Only fetch on user request
  });
}
```

---

## Testing Strategy

### Backend Tests

**Unit Tests:**
- QuickFixSessionService methods
- Issue type handlers
- Validation logic

**Integration Tests:**
- Session creation from remediation plan
- Submit fix transaction
- Skip issue updates
- Save/resume session

**E2E Tests:**
- Complete workflow (start → fix issues → apply → download)

### Frontend Tests

**Component Tests:**
- Form validation (required fields, character limits)
- Navigation logic (next/previous/skip)
- Progress calculation
- AI suggestion display

**Integration Tests:**
- Session creation flow
- Issue submission flow
- Save/resume flow

---

## Security Considerations

1. **Authentication:** All endpoints require `authenticate` middleware
2. **Authorization:**
   - User must own the session (userId === req.user.id)
   - Session must belong to user's tenant (tenantId === req.user.tenantId)
3. **Validation:**
   - Zod schemas for all inputs
   - taskId must belong to session
   - fixData structure validated per issue type
4. **Rate Limiting:**
   - AI suggestion endpoint: 10 requests/minute per user
   - Submit endpoint: 100 requests/minute per user

---

## Performance Considerations

1. **Lazy Loading:**
   - Load issues on-demand (not all 796 at once)
   - Paginate task list (current + next 5)

2. **Caching:**
   - Cache PDF pages in browser
   - Cache AI suggestions (deduplicate similar images)

3. **SSE Events:**
   - Use for progress updates
   - Reduce polling frequency

4. **Database Indexes:**
   - Index on sessionId, userId, status
   - Optimize queries with proper includes

---

## Error Handling

### Backend Errors

- `QUICK_FIX_SESSION_NOT_FOUND` (404)
- `QUICK_FIX_TASK_NOT_FOUND` (404)
- `QUICK_FIX_INVALID_FIX_DATA` (400)
- `QUICK_FIX_SESSION_ALREADY_COMPLETED` (409)
- `QUICK_FIX_AI_SERVICE_UNAVAILABLE` (503)

### Frontend Error States

- Session load failure → Show retry button
- Submit failure → Keep form data, show error toast
- Network error → Queue submission for retry
- PDF load failure → Show error message, allow continue without preview

---

## Accessibility Requirements

1. **Keyboard Navigation:**
   - Tab through all form fields
   - Enter/Space to submit
   - Escape to cancel/skip

2. **Screen Reader Support:**
   - Announce progress changes
   - Label all form fields
   - Describe issue context

3. **Focus Management:**
   - Focus on form field when issue loads
   - Return focus after submission
   - Trap focus in modal dialogs

---

## Open Questions (to resolve in next iteration)

1. **Issue Coordinates:** How to map backend issue location to PDF coordinates for highlighting?
2. **Bulk Operations:** Should we allow "apply to all similar" for alt text?
3. **Templates:** Should users be able to save reusable fix patterns?
4. **Undo:** Should users be able to undo submitted fixes?
5. **Collaboration:** Can multiple users work on same session?

---

## Changes from Design Document

- Added SessionStatus enum (PAUSED state)
- Added TaskStatus enum (removed IN_PROGRESS, FAILED)
- Simplified fixData storage (single JSON field)
- Added AI suggestion storage in task record
- Removed separate VerificationResult integration (handled by pdf-verification service)

---

**Plan Version 1 Complete**
**Next Steps:**
1. Review and refine plan (iterations 2-5)
2. Resolve open questions
3. Validate for errors and gaps
4. Get user approval
5. Begin implementation
