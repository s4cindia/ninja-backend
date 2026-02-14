# Quick-Fix Workflow Implementation Plan - Version 2

**Date:** 2026-02-11
**Plan Version:** 2 of 5 (iterative refinement)
**Previous Version:** `2026-02-11-quick-fix-workflow-plan-v1.md`
**Changes:** Resolved open questions, added coordinate mapping strategy, enhanced bulk operations

---

## Resolved Open Questions from V1

### 1. Issue Coordinates: How to map backend issue location to PDF coordinates?

**Solution:** Two-phase approach

**Phase 1 (MVP):** Page-level highlighting
- Backend provides `pageNumber` for each issue
- Frontend highlights entire page or shows banner
- Good enough for alt text (user sees image on page)

**Phase 2 (Advanced):** Element-level highlighting
- Backend enhancement: pdf-audit service returns coordinates
- Add to audit result schema:
  ```typescript
  interface PdfAuditIssue {
    location: {
      pageNumber: number;
      boundingBox?: {
        x: number;
        y: number;
        width: number;
        height: number;
      };
      elementId?: string; // PDF structure element ID
    }
  }
  ```
- Frontend parses coordinates and renders overlay
- **Timeline:** Phase 3 (not blocking MVP)

### 2. Bulk Operations: "Apply to all similar" for alt text?

**Decision:** Yes, implement in Phase 3

**Use Cases:**
- Decorative images: Apply "decorative" to all similar icons
- Repeated logos: Apply same alt text to all instances
- Pattern matching: Similar file names, similar dimensions

**Implementation:**
```typescript
POST /api/v1/pdf/:jobId/quick-fix/session/:sessionId/bulk-apply

Body: {
  taskId: string;          // Source task
  fixData: any;            // Fix to apply
  criteria: {
    issueCode?: string;    // Apply to all with same code
    similarImage?: boolean; // Apply to visually similar images
    fileName?: string;     // Apply to images matching pattern
  }
}
```

### 3. Templates: Should users save reusable fix patterns?

**Decision:** Yes, implement in Phase 3

**Features:**
- Save common alt text templates (e.g., "Logo of [Company]", "Screenshot showing [X]")
- Save table header patterns
- Personal template library per user

**Schema Addition:**
```prisma
model QuickFixTemplate {
  id          String    @id @default(nanoid())
  userId      String
  tenantId    String
  issueType   IssueType
  name        String
  description String?
  template    Json      // Template data with placeholders

  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  user        User      @relation(fields: [userId], references: [id])

  @@index([userId])
  @@index([issueType])
}
```

### 4. Undo: Should users undo submitted fixes?

**Decision:** Yes, implement "Edit Previous" in Phase 2

**Approach:**
- Allow navigation back to completed issues
- Show submitted fix data in form
- Allow editing and resubmitting
- Track edit history in task record

**Schema Change:**
```prisma
model QuickFixTask {
  // ... existing fields
  fixHistory  Json?     // Array of { fixData, submittedAt, editedAt }
}
```

### 5. Collaboration: Can multiple users work on same session?

**Decision:** No, not in initial release

**Reason:**
- Adds complexity (conflict resolution, locking)
- Use case is rare (most PDFs audited by one person)
- **Future Enhancement:** Add session sharing in Phase 5 (post-MVP)

**Current Approach:**
- One session per user per job
- Session ownership enforced (userId check)

---

## Enhanced Database Schema (V2)

### QuickFixSession (Updated)

```prisma
model QuickFixSession {
  id              String          @id @default(nanoid())
  jobId           String
  userId          String
  tenantId        String

  totalIssues     Int
  completedIssues Int             @default(0)
  skippedIssues   Int             @default(0)
  currentIndex    Int             @default(0)

  status          SessionStatus   @default(PENDING)

  // Filtering state (saved with session)
  filters         Json?           // { issueType?, pageNumber?, severity? }

  createdAt       DateTime        @default(now())
  updatedAt       DateTime        @updatedAt
  completedAt     DateTime?
  lastActiveAt    DateTime        @default(now())

  user            User            @relation(fields: [userId], references: [id])
  job             Job             @relation(fields: [jobId], references: [id])
  tasks           QuickFixTask[]

  @@unique([jobId, userId])       // One session per user per job
  @@index([jobId])
  @@index([userId])
  @@index([status])
  @@index([lastActiveAt])         // For cleanup of stale sessions
}
```

### QuickFixTask (Updated)

```prisma
model QuickFixTask {
  id              String          @id @default(nanoid())
  sessionId       String
  taskId          String          // From RemediationTask
  orderIndex      Int             // Deterministic ordering

  issueCode       String
  issueType       IssueType
  description     String
  pageNumber      Int?
  elementPath     String?
  context         Json?           // Image data, table structure, etc.

  status          TaskStatus      @default(PENDING)
  fixData         Json?           // Current fix
  fixHistory      Json?           // Edit history: [{ fixData, timestamp, action }]
  aiSuggestion    Json?           // Cached AI suggestion

  submittedAt     DateTime?
  skippedAt       DateTime?
  skippedReason   String?

  session         QuickFixSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)

  @@unique([sessionId, taskId])
  @@index([sessionId])
  @@index([sessionId, orderIndex]) // For ordered retrieval
  @@index([status])
}
```

### QuickFixTemplate (New)

```prisma
model QuickFixTemplate {
  id          String    @id @default(nanoid())
  userId      String
  tenantId    String
  issueType   IssueType
  name        String
  description String?
  template    Json      // { altText?: string, headers?: [...], ... }
  usageCount  Int       @default(0)

  createdAt   DateTime  @default(now())
  updatedAt   DateTime  @updatedAt

  user        User      @relation(fields: [userId], references: [id])

  @@index([userId])
  @@index([issueType])
  @@index([tenantId])
}
```

---

## Enhanced API Specification (V2)

### New Endpoints for V2 Features

**GET /api/v1/pdf/:jobId/quick-fix/session/:sessionId/issue/:taskId/edit**
- Get completed task for editing
- Returns task with fixData populated

**POST /api/v1/pdf/:jobId/quick-fix/session/:sessionId/issue/:taskId/update**
- Update previously submitted fix
- Appends to fixHistory

**GET /api/v1/quick-fix/templates**
- List user's templates
- Query params: `issueType?`, `page`, `limit`

**POST /api/v1/quick-fix/templates**
- Create new template
- Body: `{ name, description, issueType, template }`

**POST /api/v1/pdf/:jobId/quick-fix/session/:sessionId/bulk-apply**
- Apply fix to multiple similar issues
- Body: `{ taskId, fixData, criteria }`

---

## Enhanced Component Architecture (V2)

### New Components for V2

**QuickFixTemplateSelector**
- Dropdown of user's templates
- Apply template to current issue
- "Save as template" button

**QuickFixBulkApplyModal**
- Show matching issues preview
- Confirm bulk application
- Progress indicator

**QuickFixEditHistory**
- Show edit history for task
- Revert to previous version
- Diff view

**QuickFixFilterPanel**
- Filter by issue type, page, severity
- Save filter state to session
- Quick filter chips

---

## Detailed Implementation Timeline

### Week 1: Phase 1 - MVP

**Day 1-2: Backend Foundation**
- Terminal 1:
  - [ ] Create Prisma migration for QuickFixSession, QuickFixTask
  - [ ] Implement QuickFixSessionService (CRUD methods)
  - [ ] Write unit tests for service
- Terminal 2:
  - [ ] Create quick-fix controller
  - [ ] Implement session endpoints (start, get, save)
  - [ ] Add authentication and validation middleware

**Day 3-4: Frontend Foundation**
- Terminal 3:
  - [ ] Create QuickFixWorkflowPage component
  - [ ] Implement QuickFixProgress component
  - [ ] Create React Query hooks (useQuickFixSession, useStartQuickFix)
- Terminal 4:
  - [ ] Create AltTextForm component
  - [ ] Implement form validation
  - [ ] Add loading/error states

**Day 5: Integration**
- Terminal 3:
  - [ ] Integrate PDF preview with workflow
  - [ ] Connect forms to API
  - [ ] Test navigation flow
- Terminal 5:
  - [ ] Adapt PdfPreviewPanel for quick-fix
  - [ ] Add page-level highlighting
  - [ ] Test zoom/pan

**Day 6-7: Testing & Polish**
- All terminals:
  - [ ] E2E testing (start → fix → save → resume)
  - [ ] Bug fixes
  - [ ] Documentation
  - [ ] User testing with alt-text issues

---

### Week 2: Phase 2 - Additional Issue Types

**Day 1-2: Backend Handlers**
- Terminal 2:
  - [ ] Implement TableHeaderForm handler
  - [ ] Implement FormLabelForm handler
  - [ ] Implement LinkTextForm handler
  - [ ] Implement HeadingForm handler
  - [ ] Write tests

**Day 3-4: Frontend Forms**
- Terminal 4:
  - [ ] Create TableHeaderForm component
  - [ ] Create FormLabelForm component
  - [ ] Create LinkTextForm component
  - [ ] Create HeadingForm component
  - [ ] Implement type-based routing

**Day 5: Edit Feature**
- Terminal 1:
  - [ ] Add fixHistory to QuickFixTask
  - [ ] Implement edit endpoint
- Terminal 3:
  - [ ] Add "Edit Previous" navigation
  - [ ] Show edit history in UI

**Day 6-7: Testing**
- All terminals:
  - [ ] Test all issue types
  - [ ] Test edit functionality
  - [ ] Bug fixes

---

### Week 3: Phase 3 - Advanced Features

**Day 1-2: AI Integration**
- Terminal 2:
  - [ ] Integrate Gemini API for suggestions
  - [ ] Implement suggestion caching
  - [ ] Add rate limiting
- Terminal 4:
  - [ ] Create AISuggestionCard component
  - [ ] Add "Get Suggestion" button
  - [ ] Show confidence scores

**Day 3-4: Bulk Operations**
- Terminal 1:
  - [ ] Implement bulk-apply endpoint
  - [ ] Write matching logic (similar images, patterns)
- Terminal 3:
  - [ ] Create QuickFixBulkApplyModal
  - [ ] Show preview of matching issues
  - [ ] Confirm and apply

**Day 5-6: Templates**
- Terminal 1:
  - [ ] Create QuickFixTemplate table migration
  - [ ] Implement template CRUD endpoints
- Terminal 4:
  - [ ] Create QuickFixTemplateSelector
  - [ ] Add "Save as Template" button
  - [ ] Template management UI

**Day 7: Testing**
- All terminals:
  - [ ] Test AI suggestions
  - [ ] Test bulk operations
  - [ ] Test templates

---

### Week 4: Phase 4 - Apply Fixes

**Day 1-3: PDF Modification**
- Terminal 6:
  - [ ] Enhance pdf-modifier service for quick-fix types
  - [ ] Implement alt-text application to PDF
  - [ ] Implement table header application
  - [ ] Write verification tests

**Day 4-5: Apply Transaction**
- Terminal 6:
  - [ ] Create apply-fixes service
  - [ ] Implement transaction (update PDF, create remediated file)
  - [ ] Add rollback logic
  - [ ] Emit SSE events

**Day 6: Frontend Application**
- Terminal 3:
  - [ ] Create "Apply Fixes" button
  - [ ] Show confirmation modal
  - [ ] Progress indicator during application
  - [ ] Success state with download link

**Day 7: Final Testing**
- All terminals:
  - [ ] E2E test: start → fix all issues → apply → download
  - [ ] Verify remediated PDF
  - [ ] Bug fixes
  - [ ] Documentation

---

## SSE Events Specification

```typescript
// Session events
interface QuickFixSessionStartedEvent {
  type: 'quick_fix_session_started';
  sessionId: string;
  jobId: string;
  totalIssues: number;
}

interface QuickFixIssueFixedEvent {
  type: 'quick_fix_issue_fixed';
  sessionId: string;
  taskId: string;
  issueType: IssueType;
  completedCount: number;
  totalCount: number;
}

interface QuickFixIssueSkippedEvent {
  type: 'quick_fix_issue_skipped';
  sessionId: string;
  taskId: string;
  reason?: string;
}

interface QuickFixSessionSavedEvent {
  type: 'quick_fix_session_saved';
  sessionId: string;
  completedCount: number;
}

interface QuickFixSessionCompletedEvent {
  type: 'quick_fix_session_completed';
  sessionId: string;
  completedCount: number;
  skippedCount: number;
}

// Application events
interface QuickFixApplyStartedEvent {
  type: 'quick_fix_apply_started';
  sessionId: string;
  totalFixes: number;
}

interface QuickFixApplyProgressEvent {
  type: 'quick_fix_apply_progress';
  sessionId: string;
  appliedCount: number;
  totalCount: number;
}

interface QuickFixApplyCompletedEvent {
  type: 'quick_fix_apply_completed';
  sessionId: string;
  appliedCount: number;
  remediatedFileUrl: string;
}

interface QuickFixApplyFailedEvent {
  type: 'quick_fix_apply_failed';
  sessionId: string;
  error: string;
}
```

---

## Navigation Enhancements

### Keyboard Shortcuts

```typescript
const shortcuts = {
  'ArrowRight': 'Next issue',
  'ArrowLeft': 'Previous issue',
  'Enter': 'Submit current fix',
  'Shift+Enter': 'Submit and next',
  'Escape': 'Skip issue',
  'Ctrl+S': 'Save session',
  '1-5': 'Jump to issue type filter',
  '/': 'Focus search',
};
```

### Smart Navigation

**Auto-advance after submit:**
- By default, advance to next issue after successful submit
- User preference: Stay on current issue (for review)

**Jump to page:**
- Input field to jump to specific page
- Shows issues on that page

**Filter and navigate:**
- Filter by issue type
- Navigate only through filtered issues
- Breadcrumb: "Alt Text Issues: 5 of 45"

---

## Error Recovery Strategies

### Network Interruption

**Problem:** User loses connection mid-session

**Solution:**
- Optimistic UI updates (immediate feedback)
- Queue failed submissions in localStorage
- Retry on reconnection
- Show "Offline" banner

**Implementation:**
```typescript
const useOfflineQueue = () => {
  const [queue, setQueue] = useState<QueuedSubmission[]>([]);

  useEffect(() => {
    const handleOnline = async () => {
      for (const submission of queue) {
        await retrySubmission(submission);
      }
      setQueue([]);
    };

    window.addEventListener('online', handleOnline);
    return () => window.removeEventListener('online', handleOnline);
  }, [queue]);

  return { addToQueue, queue };
};
```

### Session Timeout

**Problem:** User leaves session open for hours

**Solution:**
- Auto-save every 5 minutes
- Update `lastActiveAt` on every action
- Cleanup stale sessions after 24 hours
- Show "Session expired" with resume option

### Concurrent Edits

**Problem:** User opens two tabs with same session

**Solution:**
- Detect concurrent access via session lock
- Show warning: "Session open in another tab"
- Offer to take control or open in read-only mode

---

## Performance Optimizations

### Database Query Optimization

**Indexed Queries:**
```typescript
// Get session with tasks
await prisma.quickFixSession.findUnique({
  where: { id: sessionId },
  include: {
    tasks: {
      where: { status: 'PENDING' },
      orderBy: { orderIndex: 'asc' },
      take: 10, // Load next 10 issues only
    },
  },
});
```

### Frontend Optimizations

**Virtual Scrolling:**
- Use `react-window` for large task lists
- Render only visible items

**Image Lazy Loading:**
- Load PDF pages on-demand
- Cache rendered pages
- Preload next page

**Debounced Auto-Save:**
```typescript
const debouncedSave = useMemo(
  () => debounce((sessionId) => saveSession(sessionId), 5000),
  []
);
```

---

## Validation Rules by Issue Type

### Alt Text Validation

```typescript
const validateAltText = (altText: string, context: ImageContext): ValidationResult => {
  const errors: string[] = [];

  // Length check
  if (altText.length > 150) {
    errors.push('Alt text should be concise (under 150 characters)');
  }

  // Redundant words
  if (/(image|picture|photo|graphic) of/i.test(altText)) {
    errors.push('Avoid starting with "image of" - screen readers announce it as an image');
  }

  // File name check
  if (/\.(jpg|png|gif|svg)$/i.test(altText)) {
    errors.push('Alt text should not be a file name');
  }

  // Decorative check
  if (context.isDecorative && altText !== '') {
    errors.push('Decorative images should have empty alt text');
  }

  return { valid: errors.length === 0, errors };
};
```

### Table Header Validation

```typescript
const validateTableHeaders = (headers: TableHeader[]): ValidationResult => {
  const errors: string[] = [];

  if (headers.length === 0) {
    errors.push('At least one header must be marked');
  }

  // Check for row header in first column
  const hasRowHeader = headers.some(h => h.type === 'row' || h.type === 'both');
  if (!hasRowHeader) {
    errors.push('Consider marking row headers for better navigation');
  }

  return { valid: errors.length === 0, errors };
};
```

---

## Migration Plan from Existing Remediation

### Data Migration

**Existing:** RemediationPlan with tasks stored in Job.output (JSON)

**New:** QuickFixSession with tasks in dedicated table

**Migration Steps:**
1. Check if remediation plan exists for job
2. Filter tasks with `type === 'QUICK_FIX'`
3. Create QuickFixSession record
4. Create QuickFixTask records with `orderIndex`
5. Link to original RemediationTask via `taskId`

**Backward Compatibility:**
- Keep RemediationPlan intact (read-only reference)
- QuickFixTask updates don't modify RemediationPlan
- On "Apply Fixes", update RemediationPlan task statuses

---

## Changes from V1

### Schema Changes
- Added `filters` field to QuickFixSession (save filter state)
- Added `fixHistory` to QuickFixTask (edit tracking)
- Added `orderIndex` to QuickFixTask (deterministic ordering)
- Added `skippedReason` to QuickFixTask
- Added `lastActiveAt` to QuickFixSession (cleanup stale sessions)
- Added `QuickFixTemplate` table

### API Changes
- Added edit endpoints
- Added bulk-apply endpoint
- Added template endpoints
- Enhanced validation rules

### Features Added
- Edit previous fixes
- Bulk apply operations
- Template library
- Keyboard shortcuts
- Offline queue
- Auto-save

---

## Remaining Questions for V3

1. **Image Similarity Matching:** How to compare images for bulk operations? (Perceptual hash, ML model?)
2. **AI Cost Control:** How to limit AI suggestion usage per user? (Daily quota, paid feature?)
3. **Session Cleanup:** When to delete old sessions? (30 days, after job completes?)
4. **Large Sessions:** How to handle 1000+ issues? (Pagination strategy, lazy loading?)

---

**Plan Version 2 Complete**
**Next Steps:**
1. Create V3 to address remaining questions
2. Add detailed component mockups
3. Refine error handling
4. Prepare for validation phase
