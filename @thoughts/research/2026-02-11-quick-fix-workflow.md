# Quick-Fix Workflow Implementation - Research Document

**Date:** 2026-02-11
**Purpose:** Research existing codebase patterns to inform Quick-Fix workflow implementation
**Scope:** Backend and Frontend patterns for session management, forms, PDF preview, and API design

---

## Executive Summary

This research document consolidates findings from exploring the ninja-workspace codebase to identify reusable patterns for implementing the Quick-Fix workflow. The workflow will enable users to provide input for 796 accessibility issues requiring human decisions (alt text, table headers, form labels, etc.).

**Key Findings:**
- ✅ Mature session management exists (Job/Batch/AcrJob models with progress tracking)
- ✅ Comprehensive form patterns (simple useState, multi-step, verification queue)
- ✅ PDF preview infrastructure ready (react-pdf with zoom, pan, highlighting)
- ✅ Standardized API patterns (transactions, validation, error handling)

---

## 1. Session Management Patterns

### Database Models (Prisma Schema)

**Primary Models for Session Tracking:**

1. **Job Model** (`schema.prisma` lines 90-125)
   - Central tracking for all processing sessions
   - Fields: `id`, `tenantId`, `userId`, `type`, `status`, `progress`, `input`, `output`
   - Statuses: `QUEUED`, `PROCESSING`, `COMPLETED`, `FAILED`, `CANCELLED`
   - Job types include: `PDF_ACCESSIBILITY`, `EPUB_ACCESSIBILITY`, `ACR_WORKFLOW`, `BATCH_VALIDATION`
   - **Recommendation:** Create new job type `PDF_QUICK_FIX` for quick-fix sessions

2. **Batch Model** (`schema.prisma` lines 535-578)
   - Multi-file processing with progress counters
   - Fields: `filesUploaded`, `filesAudited`, `filesPlanned`, `filesRemediated`, `filesFailed`
   - **Pattern to Adopt:** Progress tracking with multiple counters (totalIssues, completedIssues, skippedIssues)

3. **AcrJob Model** (`schema.prisma` lines 475-499)
   - Session-based workflow with criteria review
   - Status: `in_progress`, tracking completion
   - Relations to individual criterion reviews (AcrCriterionReview)
   - **Pattern to Adopt:** Session → Individual Items structure

### Backend Services

**Queue Service** (`services/queue.service.ts`)
- Creates job records with `status: 'QUEUED'`
- Enqueues to BullMQ for async processing
- Pattern: Create DB record → Enqueue → Process → Update status
- **Recommendation:** Quick-fix doesn't need queue (synchronous session management)

**Batch Orchestrator** (`services/batch/batch-orchestrator.service.ts`)
- Creates batch in `DRAFT` status
- Transitions: `DRAFT` → `QUEUED` → `PROCESSING` → `COMPLETED`
- Async orchestration with file-by-file processing
- **Pattern to Adopt:** Session lifecycle management with state transitions

**Verification Service** (`services/acr/human-verification.service.ts`)
- **In-memory storage** using Maps (TODO: migrate to DB)
- Data structures:
  ```typescript
  VerificationQueue: { jobId, totalItems, pendingItems, items[] }
  VerificationQueueItem: { id, criterionId, status, verificationHistory[] }
  ```
- Methods: `initializeQueue()`, `submitVerification()`
- **Critical Finding:** Current implementation uses in-memory storage but notes need for DB persistence
- **Recommendation:** Learn from this—use DB from start for quick-fix sessions

### Frontend State Management

**React Query Hooks** (`hooks/useJobs.ts`, `hooks/useBatch.ts`)
- Pattern: Query for data, mutations for updates, auto-invalidation
- Smart polling: 5s interval when `PROCESSING`, 30s when idle
- Example:
  ```typescript
  const { data: job } = useJob(jobId);
  const updateMutation = useUpdateTaskStatus();
  await updateMutation.mutateAsync({ status: 'COMPLETED' });
  ```

**Zustand Store** (`stores/auth.store.ts`)
- Global state with persistence middleware (localStorage)
- Pattern: `create()` + `persist()` middleware
- **Recommendation:** Consider for quick-fix session state (currentIndex, filters, etc.)

### Real-Time Updates

**SSE Service** (`sse/sse.service.ts`)
- Server-sent events for progress updates
- Pattern: Client subscribes → Server broadcasts on channel → Client invalidates queries
- Events used in batch: `file_auditing`, `file_audited`, `batch_completed`
- **Recommendation:** Use for quick-fix progress (e.g., `issue_fixed`, `session_saved`)

---

## 2. Form Handling Patterns

### Simple Forms (useState-based)

**FeedbackForm** (`components/feedback/FeedbackForm.tsx`)
- Individual field state: `useState` per field
- Client-side validation (trim checks)
- Status states: `idle`, `success`, `error`
- Pattern:
  ```typescript
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitStatus, setSubmitStatus] = useState<'idle' | 'success' | 'error'>('idle');

  const handleSubmit = async (e) => {
    if (!message.trim()) return;
    setIsSubmitting(true);
    try {
      await api.post('/feedback', { message });
      setSubmitStatus('success');
    } catch (error) {
      setSubmitStatus('error');
    } finally {
      setIsSubmitting(false);
    }
  };
  ```
- **Recommendation:** Use for simple issue types (alt text input)

### Multi-Field Forms

**BatchQuickFixModal** (`components/batch/BatchQuickFixModal.tsx`)
- Multiple state variables for different field types
- Cross-field validation logic
- Conditional required fields
- Pattern:
  ```typescript
  const [accessMode, setAccessMode] = useState<string[]>([]);
  const [accessibilitySummary, setAccessibilitySummary] = useState('');

  const isValid =
    (hasAccessMode ? accessMode.length > 0 : true) &&
    (hasAccessibilitySummary ? accessibilitySummary.trim().length >= 20 : true);
  ```
- **Recommendation:** Use for complex issue types (table headers with row/column specification)

### Multi-Step Workflow

**VerificationQueue** (`components/acr/VerificationQueue.tsx`)
- **Most relevant pattern for quick-fix workflow**
- Features:
  - Global filter state (severity, confidence, status)
  - Bulk selection (`Set<string>`)
  - Individual item expansion
  - Progress tracking
  - Memoized filtering for performance
- Pattern:
  ```typescript
  const [filters, setFilters] = useState<VerificationFilters>({});
  const [selectedItems, setSelectedItems] = useState<Set<string>>(new Set());

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (filters.severity?.length && !filters.severity.includes(item.severity)) return false;
      return true;
    });
  }, [items, filters]);
  ```
- **Recommendation:** Primary pattern to adopt for quick-fix workflow

### Individual Item Forms

**VerificationItem** (`components/acr/VerificationItem.tsx`)
- Expandable form sections
- Conditional validation (notes required for certain statuses)
- Optimistic success feedback
- History tracking with sync via `useEffect`
- Pattern:
  ```typescript
  const [isExpanded, setIsExpanded] = useState(false);
  const [formStatus, setFormStatus] = useState<VerificationStatus>('verified_pass');
  const [formNotes, setFormNotes] = useState('');

  const requiresNotes = formStatus === 'verified_fail';
  const canSubmit = !requiresNotes || formNotes.trim().length > 0;
  ```
- **Recommendation:** Use for each quick-fix issue card

### Custom UI Components

**Input** (`components/ui/Input.tsx`)
- Auto-generated IDs from labels
- Error/helper text variants
- Focus ring styling
- Uses `forwardRef` for DOM access
- **Recommendation:** Use for all text inputs

**Button** (`components/ui/Button.tsx`)
- 5 variants: primary, secondary, outline, ghost, danger
- Loading state with spinner
- Icon support (left/right)
- Auto-disable during loading
- **Recommendation:** Use for all actions

### Form Validation

**No form libraries used** (no React Hook Form, Formik)
- Everything is custom `useState`-based
- Validation patterns:
  1. Client-side: trim checks, length requirements
  2. Conditional validation: based on field values
  3. Cross-field validation: field A affects field B
- **Recommendation:** Continue this pattern for consistency

### Selector Components

**AccessModeSelector** (`components/batch/AccessModeSelector.tsx`)
- Controlled component (value + onChange)
- Array state management with immutability
- Toggle logic: `value.includes(x) ? filter : [...value, x]`
- **Recommendation:** Use for multi-select fields (table header selection)

---

## 3. PDF Preview Components

### PDF Viewer Library

**Library:** `react-pdf` (v7.5.1) + `pdfjs-dist` (v3.11.174)
- Worker configuration using local file (not CDN)
- Configured in `PdfPreviewPanel.tsx`:
  ```typescript
  pdfjs.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.js',
    import.meta.url
  ).toString();
  ```

### Page Navigation

**PdfPageNavigator** (`components/pdf/PdfPageNavigator.tsx`)
- Features:
  - Previous/Next buttons
  - Jump to page input
  - Keyboard shortcuts (Arrow keys, Home, End)
  - Page filtering (all pages, pages with issues, critical only)
  - Issue summary per page
  - Optional thumbnail display
- Props:
  ```typescript
  interface PdfPageNavigatorProps {
    pageCount: number;
    currentPage: number;
    issuesByPage: Map<number, PdfAuditIssue[]>;
    onPageChange: (page: number) => void;
    thumbnails?: string[];
  }
  ```
- **Recommendation:** Reuse for quick-fix navigation

### PDF Preview with Highlighting

**PdfPreviewPanel** (`components/pdf/PdfPreviewPanel.tsx`)
- **Issue Overlay System:**
  - Absolute positioned overlays on PDF page
  - Color-coded by severity (red, orange, yellow, blue)
  - Click to select issue
  - Keyboard accessible
  - Pulse animation on selection
- **Coordinate Parsing Placeholder:**
  - `parseIssueLocation()` reserves space for backend coordinates
  - Currently returns null (awaiting implementation)
  - Designed to parse element path or location field
- **Show/Hide Toggle:** Eye icon to toggle issue highlights

### Zoom Controls

- Zoom levels: 50%, 75%, 100%, 125%, 150%, 200%
- Controls: Zoom In, Zoom Out, dropdown selector, Fit to Page
- Scale application:
  ```typescript
  <Page
    pageNumber={currentPage}
    scale={zoomLevel / 100}
    renderTextLayer={true}
    renderAnnotationLayer={true}
  />
  ```

### Loading and Error Handling

- Loading state: Spinner with "Loading PDF..." text
- Error state: Alert with error message
- Authentication: Automatic JWT token from localStorage
- Handlers:
  ```typescript
  handleDocumentLoadSuccess = ({ numPages }) => {
    setNumPages(numPages);
    setIsLoading(false);
  }

  handleDocumentLoadError = (error) => {
    setError(error.message);
    setIsLoading(false);
  }
  ```

### Three-Column Layout

**PdfAuditResultsPage** (`pages/PdfAuditResultsPage.tsx`)
- Left (W-64): PdfPageNavigator
- Center (Flex-1): PdfPreviewPanel
- Right (W-96): Issues list with filtering
- **Recommendation:** Use similar layout for quick-fix (Left: Progress/Navigation, Center: PDF Preview, Right: Issue Form)

---

## 4. API Endpoint Patterns

### Controller Organization

**Pattern:** Feature-based controllers with singleton pattern
```typescript
export class FileController {
  async uploadFile(req, res, next) { ... }
  async downloadFile(req, res, next) { ... }
}
export const fileController = new FileController();
```

**Middleware Stack:**
1. Global: CORS, Helmet, body parsing, compression, logging
2. Route-level: authenticate, authorize, validate, file uploads

### Request/Response Types

**Authentication Extension:**
```typescript
declare global {
  namespace Express {
    interface Request {
      user?: { id: string; email: string; tenantId: string; role: string; };
    }
  }
}
```

**Response Structure:**
```typescript
// Success (200/201)
{
  success: true,
  data: <resource>,
  message?: string
}

// Error (4xx/5xx)
{
  success: false,
  error: {
    message: string,
    code?: string,
    details?: unknown
  }
}
```

### Validation (Zod)

**Schema Pattern:**
```typescript
export const createJobSchema = {
  body: z.object({
    type: jobTypeEnum,
    fileId: z.string().uuid().optional(),
    options: z.record(z.string(), z.unknown()).optional()
  })
};

// Usage
router.post('/jobs', validate(createJobSchema), controller.create);
```

**Validation Middleware:**
- Parses and transforms request data
- Returns 400 with field-level errors on validation failure
- Structure:
  ```typescript
  {
    error: {
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: [
        { field: 'email', message: 'Invalid email format', code: 'invalid_string' }
      ]
    }
  }
  ```

### Error Handling

**Custom Error Class:**
```typescript
export class AppError extends Error {
  constructor(message: string, statusCode: number, code?: string) { ... }

  static badRequest(message: string, code?: string): AppError
  static notFound(message?: string, code?: string): AppError
  static unauthorized(message?: string, code?: string): AppError
}
```

**Error Codes Registry:**
- `AUTH_INVALID_CREDENTIALS`
- `USER_NOT_FOUND`
- `JOB_NOT_FOUND`
- `FILE_NOT_FOUND`
- `VALIDATION_ERROR`
- **Recommendation:** Add `QUICK_FIX_SESSION_NOT_FOUND`, `QUICK_FIX_TASK_NOT_FOUND`

**Prisma Error Mapping:**
- `P2002` → 409 Conflict (unique constraint)
- `P2003` → 400 Bad Request (foreign key constraint)
- `P2025` → 404 Not Found (record not found)

### Transaction Pattern

**Atomic Operations:**
```typescript
const result = await prisma.$transaction(async (tx) => {
  // Step 1: Create record
  const job = await tx.job.create({ data: { ... } });

  // Step 2: Update related record
  await tx.file.update({
    where: { id: fileId },
    data: { latestJobId: job.id }
  });

  return job;
});

// Async work runs AFTER transaction
runAsyncWork(result.id);
```
- **Recommendation:** Use for quick-fix session creation + task initialization

### File Upload Patterns

**Disk Storage (for permanent files):**
```typescript
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(uploadConfig.uploadDir, req.user.tenantId);
    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueId = uuidv4();
    cb(null, `${uniqueId}${path.extname(file.originalname)}`);
  }
});
```

**Memory Storage (for processing):**
```typescript
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.originalname.toLowerCase().endsWith('.pdf')) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files allowed'));
    }
  }
});
```

**File Download (Streaming):**
```typescript
async downloadFile(req, res) {
  const file = await fileService.getFileById(req.params.id);

  res.setHeader('Content-Disposition', `attachment; filename="${file.originalName}"`);
  res.setHeader('Content-Type', file.mimeType);
  res.setHeader('Content-Length', file.size);

  const fileStream = fs.createReadStream(file.path);
  fileStream.pipe(res);
}
```

---

## 5. Key Patterns for Quick-Fix Workflow

### Session Lifecycle (from AcrJob and Batch)

```
1. Create session (status: PENDING)
   ↓
2. Initialize tasks (load issues from remediation plan)
   ↓
3. Start session (status: IN_PROGRESS)
   ↓
4. User navigates and fixes issues
   ↓
5. Save session (persist progress)
   ↓
6. Resume session (load from DB)
   ↓
7. Complete session (status: COMPLETED)
   ↓
8. Apply fixes to PDF
```

### Progress Tracking (from Batch)

**Multiple Counters:**
- `totalIssues`
- `completedIssues`
- `skippedIssues`
- `currentIndex`

**Percentage Calculation:**
```typescript
const completionPercentage = Math.round(
  ((completedIssues + skippedIssues) / totalIssues) * 100
);
```

### Session State Management (from VerificationQueue)

**In-Memory vs DB:**
- Current verification queue uses in-memory storage
- TODO comment indicates need for DB persistence
- **Recommendation:** Use DB from start for quick-fix sessions

**State Structure:**
```typescript
interface QuickFixSession {
  id: string;
  jobId: string;
  userId: string;
  totalIssues: number;
  completedIssues: number;
  skippedIssues: number;
  currentIndex: number;
  fixes: QuickFixData[];
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED';
  createdAt: Date;
  updatedAt: Date;
}
```

### Real-Time Updates (from SSE)

**Events to Emit:**
- `quick_fix_started` - Session started
- `quick_fix_issue_fixed` - Issue completed
- `quick_fix_issue_skipped` - Issue skipped
- `quick_fix_saved` - Session saved
- `quick_fix_completed` - All issues processed
- `quick_fix_applied` - Fixes applied to PDF

### API Endpoints (following existing patterns)

```typescript
// Session Management
POST   /api/v1/pdf/:jobId/quick-fix/start
GET    /api/v1/pdf/:jobId/quick-fix/session/:sessionId
POST   /api/v1/pdf/:jobId/quick-fix/session/:sessionId/save

// Issue Navigation
GET    /api/v1/pdf/:jobId/quick-fix/session/:sessionId/next
GET    /api/v1/pdf/:jobId/quick-fix/session/:sessionId/previous
GET    /api/v1/pdf/:jobId/quick-fix/session/:sessionId/issue/:taskId

// Issue Actions
POST   /api/v1/pdf/:jobId/quick-fix/session/:sessionId/submit
POST   /api/v1/pdf/:jobId/quick-fix/session/:sessionId/skip
POST   /api/v1/pdf/:jobId/quick-fix/session/:sessionId/bulk-submit

// Apply Fixes
POST   /api/v1/pdf/:jobId/quick-fix/session/:sessionId/apply
```

---

## 6. Multi-Terminal Development Opportunities

Based on the research, here are opportunities for parallel development:

### Terminal 1: Backend Session Management
- Create QuickFixSession model in Prisma schema
- Implement session controller and routes
- Write session service (CRUD operations)
- Migration for new tables

### Terminal 2: Backend Quick-Fix Handlers
- Implement issue-specific handlers (alt text, table headers, etc.)
- Integrate with pdf-modifier service
- Write tests for handlers

### Terminal 3: Frontend Workflow Container
- Create QuickFixWorkflow component
- Implement navigation logic
- Progress tracking UI
- React Query hooks for session

### Terminal 4: Frontend Issue Forms
- Create type-specific form components (AltTextForm, TableHeaderForm, etc.)
- Implement validation
- AI suggestion integration

### Terminal 5: Frontend PDF Preview Integration
- Adapt PdfPreviewPanel for quick-fix
- Issue highlighting for current item
- Zoom/pan controls

**Dependencies:**
- Terminal 1 must complete schema before Terminal 2 can test handlers
- Terminal 3 depends on Terminal 1 API being available
- Terminal 4 can work independently with mock data
- Terminal 5 can work independently (reuses existing components)

---

## 7. Recommendations

### Adopt These Patterns

1. **Session Management:** Use Job/Batch pattern with DB persistence (not in-memory)
2. **Form Handling:** VerificationQueue + VerificationItem pattern (multi-step workflow)
3. **PDF Preview:** Reuse PdfPreviewPanel with modifications for issue context
4. **API Design:** Follow existing transaction, validation, error handling patterns
5. **Real-Time Updates:** Use SSE for progress events
6. **State Management:** React Query for server state, Zustand for UI state

### Avoid These Pitfalls

1. **Don't use in-memory storage** - Verification queue pattern has TODO to migrate to DB
2. **Don't skip transactions** - Atomic operations prevent inconsistent state
3. **Don't forget authentication** - All endpoints need `authenticate` middleware
4. **Don't skip validation** - Use Zod schemas for all inputs
5. **Don't forget tenant isolation** - Always filter by `tenantId`

### New Patterns to Create

1. **Issue Type Router:** Dynamically load form component based on issue type
2. **Bulk Operations:** Apply same fix to multiple similar issues
3. **Templates:** Save common fix patterns for reuse
4. **AI Suggestions:** Integrate Gemini for alt text, link text suggestions

---

## 8. Files to Reference During Implementation

### Backend
- `prisma/schema.prisma` - Add QuickFixSession, QuickFixTask models
- `src/services/batch/batch-orchestrator.service.ts` - Session lifecycle pattern
- `src/services/acr/human-verification.service.ts` - Queue management (but use DB not in-memory)
- `src/controllers/job.controller.ts` - Standard controller pattern
- `src/middleware/auth.middleware.ts` - Authentication
- `src/middleware/validate.middleware.ts` - Validation
- `src/utils/app-error.ts` - Error handling

### Frontend
- `src/components/acr/VerificationQueue.tsx` - Multi-step workflow pattern
- `src/components/acr/VerificationItem.tsx` - Individual item form
- `src/components/pdf/PdfPreviewPanel.tsx` - PDF rendering
- `src/components/pdf/PdfPageNavigator.tsx` - Page navigation
- `src/hooks/useJobs.ts` - React Query pattern
- `src/hooks/useBatch.ts` - Mutation hooks
- `src/components/ui/Input.tsx` - Input component
- `src/components/ui/Button.tsx` - Button component

---

## 9. Next Steps

1. **Plan Phase:** Create detailed implementation plan with:
   - Database schema changes
   - API endpoint specifications
   - Component hierarchy
   - Data flow diagrams
   - Test strategy

2. **Validate Phase:** Review plan for:
   - Missing edge cases
   - Security vulnerabilities
   - Performance bottlenecks
   - Accessibility concerns

3. **Implement Phase:** Execute in phases:
   - Phase 1: MVP (alt text only)
   - Phase 2: Additional issue types
   - Phase 3: Advanced features (AI, bulk ops)
   - Phase 4: Apply fixes to PDF

---

**Research Complete:** 2026-02-11
**Researcher:** Claude Sonnet 4.5
**Next Document:** `@thoughts/plans/2026-02-11-quick-fix-workflow-plan-v1.md`
