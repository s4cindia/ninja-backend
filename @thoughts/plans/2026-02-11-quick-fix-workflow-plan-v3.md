# Quick-Fix Workflow Implementation Plan - Version 3

**Date:** 2026-02-11
**Plan Version:** 3 of 5 (iterative refinement)
**Previous Version:** `2026-02-11-quick-fix-workflow-plan-v2.md`
**Changes:** Resolved remaining questions, added component mockups, enhanced error handling, pagination strategy

---

## Resolved Remaining Questions from V2

### 1. Image Similarity Matching for Bulk Operations

**Decision:** Use perceptual hash (pHash) for MVP, ML model for future

**Phase 1 (MVP - Week 3):** File-based matching
- Match by file name pattern (e.g., all `icon-*.png`)
- Match by exact dimensions (width x height)
- Match by file size (within 10% tolerance)

**Phase 2 (Future):** Perceptual hash matching
- Generate pHash for each image during audit
- Store in `context` field: `{ imageHash: string, dimensions: {...} }`
- Match images with Hamming distance < 10
- Library: `imghash` (Node.js perceptual hashing)

**Example Implementation:**
```typescript
// In pdf-audit service (future enhancement)
import imghash from 'imghash';

async function addImageHash(imagePath: string) {
  const hash = await imghash.hash(imagePath, 16);
  return hash;
}

// In bulk-apply matching
function findSimilarImages(sourceHash: string, allTasks: QuickFixTask[]) {
  return allTasks.filter(task => {
    const targetHash = task.context?.imageHash;
    if (!targetHash) return false;
    const distance = hammingDistance(sourceHash, targetHash);
    return distance < 10; // < 10 bits different = similar
  });
}
```

### 2. AI Cost Control

**Decision:** Multi-tier approach

**Free Tier:**
- 10 AI suggestions per day per user
- Reset at midnight UTC
- Tracked in Redis: `ai_suggestions:{userId}:{date}` (expires in 24h)

**Paid Tier (Future):**
- Unlimited suggestions
- Higher quality models
- Batch processing

**Rate Limiting:**
```typescript
// In AI suggestion endpoint
const dailyLimit = user.plan === 'paid' ? Infinity : 10;
const usageKey = `ai_suggestions:${userId}:${today}`;
const currentUsage = await redis.incr(usageKey);

if (currentUsage === 1) {
  await redis.expire(usageKey, 86400); // 24 hours
}

if (currentUsage > dailyLimit) {
  throw AppError.forbidden(
    'Daily AI suggestion limit reached. Upgrade to continue.',
    'AI_LIMIT_EXCEEDED'
  );
}
```

**Cost Optimization:**
- Cache suggestions by image hash (deduplicate similar images)
- Use smaller model for simple cases (icon alt text)
- Batch requests when possible

### 3. Session Cleanup

**Decision:** 30-day retention with grace period

**Policy:**
- Active sessions (IN_PROGRESS, PAUSED): Keep indefinitely
- Completed sessions: Keep for 30 days after completion
- Abandoned sessions (no activity for 7 days): Mark as STALE
- STALE sessions older than 30 days: Delete

**Cleanup Cron Job:**
```typescript
// Run daily at 2 AM
cron.schedule('0 2 * * *', async () => {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

  // Delete old completed sessions
  await prisma.quickFixSession.deleteMany({
    where: {
      status: 'COMPLETED',
      completedAt: { lt: thirtyDaysAgo },
    },
  });

  // Mark abandoned sessions as STALE
  await prisma.quickFixSession.updateMany({
    where: {
      status: { in: ['IN_PROGRESS', 'PAUSED'] },
      lastActiveAt: { lt: sevenDaysAgo },
    },
    data: { status: 'STALE' },
  });

  // Delete old STALE sessions
  await prisma.quickFixSession.deleteMany({
    where: {
      status: 'STALE',
      updatedAt: { lt: thirtyDaysAgo },
    },
  });

  logger.info('[Cleanup] Quick-fix session cleanup complete');
});
```

### 4. Large Sessions (1000+ issues)

**Decision:** Cursor-based pagination with virtual scrolling

**Backend Pagination:**
```typescript
GET /api/v1/pdf/:jobId/quick-fix/session/:sessionId/tasks?cursor=<taskId>&limit=50

Response: {
  tasks: QuickFixTask[];
  nextCursor: string | null;
  hasMore: boolean;
  total: number;
}
```

**Frontend Virtual Scrolling:**
- Use `react-window` for task list rendering
- Render only visible 20 items
- Load next page when scrolling near end
- Cache loaded pages in React Query

**Current Issue Navigation:**
- Always load: current issue + previous 5 + next 5
- Prefetch next 10 in background
- Use optimistic updates for submissions

**Example:**
```typescript
// Load tasks around current index
const startIndex = Math.max(0, currentIndex - 5);
const endIndex = currentIndex + 15;

const { data: tasks } = useQuery({
  queryKey: ['quick-fix-tasks', sessionId, startIndex, endIndex],
  queryFn: () => quickFixService.getTasksRange(sessionId, startIndex, endIndex),
  staleTime: 1000 * 60 * 5, // 5 minutes
});
```

---

## Detailed Component Mockups

### QuickFixWorkflowPage Layout

```
┌────────────────────────────────────────────────────────────────────────────┐
│ Quick-Fix Workflow - document.pdf                           [X] Save & Exit │
├────────────────────────────────────────────────────────────────────────────┤
│ ▓▓▓▓▓▓▓▓▓▓▓░░░░░░░░░░░░░░░░░░░░░░░░░░░░ 45 of 796 (5%)                    │
│ ⏱ 23 minutes elapsed  •  📊 45 fixed  •  ⏭ 5 skipped                        │
├─────────────────┬──────────────────────────────────┬──────────────────────┤
│                 │                                  │                      │
│  Filters        │         PDF Preview              │   Issue #46 of 796   │
│  ─────────      │                                  │   ────────────────   │
│                 │    ┌──────────────────────┐      │                      │
│  □ Alt Text     │    │                      │      │  🔴 Critical         │
│  □ Table        │    │    Page 23           │      │  📄 Page 23          │
│  □ Form         │    │                      │      │                      │
│  □ Link         │    │    [PDF content      │      │  Image Missing Alt   │
│  □ Heading      │    │     with highlighted │      │  Text                │
│                 │    │     issue area]      │      │                      │
│  Pages          │    │                      │      │  This image appears  │
│  ──────         │    │    🔍 Current issue  │      │  to be a chart...    │
│                 │    │       highlighted    │      │                      │
│  □ 1-10 (12)    │    └──────────────────────┘      │  ┌─────────────────┐ │
│  ✓ 11-20 (8)    │                                  │  │ Alt text:       │ │
│  □ 21-30 (15)   │    [−] [+] [Fit] 100%            │  │                 │ │
│                 │                                  │  │ [______________ │ │
│  Severity       │    ◄ Prev  Page 23/756  Next ►   │  │  ______________ │ │
│  ────────       │                                  │  │  ______________]│ │
│                 │                                  │  │                 │ │
│  □ Critical     │                                  │  │ ☐ Decorative    │ │
│  □ Serious      │                                  │  └─────────────────┘ │
│  □ Moderate     │                                  │                      │
│  □ Minor        │                                  │  [✨ AI Suggest]     │
│                 │                                  │  [📋 Templates ▼]    │
│  [Reset]        │                                  │                      │
│                 │                                  │  Tips:               │
│                 │                                  │  • Describe what's   │
│                 │                                  │    shown, not "image"│
│                 │                                  │  • Be concise (<150) │
│                 │                                  │                      │
│                 │                                  │  [⬅ Previous] [Skip] │
│                 │                                  │  [Submit] [Next ➡]   │
│                 │                                  │                      │
└─────────────────┴──────────────────────────────────┴──────────────────────┘
```

### AI Suggestion Card

```
┌─────────────────────────────────────────────────────────────┐
│  ✨ AI Suggestion  (Confidence: 87%)                         │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  "Bar chart showing quarterly revenue growth from 2020 to  │
│   2023, with values ranging from $2M to $8M"               │
│                                                             │
│  [✓ Use This]  [✎ Edit & Use]  [✗ Dismiss]                │
│                                                             │
│  💡 This suggestion was generated by AI. Please review and  │
│     adjust if needed.                                       │
└─────────────────────────────────────────────────────────────┘
```

### Table Header Form

```
┌─────────────────────────────────────────────────────────────┐
│  Table Header Configuration                                 │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Table Preview:                                             │
│  ┌─────────────────────────────────────────────────────┐   │
│  │     │ Q1   │ Q2   │ Q3   │ Q4   │                    │   │
│  ├─────┼──────┼──────┼──────┼──────┤                    │   │
│  │ 2020│ $2M  │ $3M  │ $4M  │ $5M  │                    │   │
│  │ 2021│ $3M  │ $4M  │ $5M  │ $6M  │                    │   │
│  │ 2022│ $4M  │ $5M  │ $6M  │ $7M  │                    │   │
│  │ 2023│ $5M  │ $6M  │ $7M  │ $8M  │                    │   │
│  └─────────────────────────────────────────────────────┘   │
│                                                             │
│  Click cells to mark as headers:                            │
│  🔵 Row Header  🟢 Column Header  🟣 Both                   │
│                                                             │
│  First Row:  [✓] Column headers                            │
│  First Col:  [✓] Row headers                               │
│                                                             │
│  Advanced:                                                  │
│  [ ] Table has caption                                      │
│  [ ] Complex table (merged cells)                           │
│                                                             │
│  [Reset] [Submit]                                           │
└─────────────────────────────────────────────────────────────┘
```

### Bulk Apply Modal

```
┌─────────────────────────────────────────────────────────────┐
│  Apply Fix to Similar Issues                          [✗]  │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  Source Issue:                                              │
│  Image on page 12: "Company logo"                          │
│                                                             │
│  Fix to apply:                                              │
│  Alt text: "Acme Inc. company logo"                        │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  Find similar issues by:                                    │
│  [✓] Same file name pattern (logo-*.png)      [8 found]   │
│  [✓] Same dimensions (200x50px)               [12 found]  │
│  [ ] Visually similar (perceptual hash)       [N/A]        │
│                                                             │
│  ─────────────────────────────────────────────────────────  │
│                                                             │
│  Preview:                                                   │
│  ┌───────────────────────────────────────────────────────┐ │
│  │ ✓ Page 12: logo-header.png                           │ │
│  │ ✓ Page 15: logo-footer.png                           │ │
│  │ ✓ Page 18: logo-sidebar.png                          │ │
│  │ ✓ Page 23: logo-watermark.png                        │ │
│  │ ... 4 more                           [Show All ▼]    │ │
│  └───────────────────────────────────────────────────────┘ │
│                                                             │
│  [Cancel] [Apply to 8 Issues]                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Enhanced Error Handling (V3)

### Error Boundary Component

```typescript
class QuickFixErrorBoundary extends React.Component {
  state = { hasError: false, error: null };

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    logger.error('Quick-fix workflow error', { error, errorInfo });

    // Send to error tracking service
    errorTracker.captureException(error, {
      context: {
        component: 'QuickFixWorkflow',
        sessionId: this.props.sessionId,
      },
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="error-fallback">
          <h2>Something went wrong</h2>
          <p>Your progress has been saved. Please refresh to continue.</p>
          <button onClick={() => window.location.reload()}>
            Refresh Page
          </button>
          <button onClick={() => this.props.onExit()}>
            Exit Workflow
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
```

### Retry Logic for Failed Requests

```typescript
const retryConfig = {
  retries: 3,
  retryDelay: (attemptNumber) => Math.min(1000 * 2 ** attemptNumber, 10000),
  retryCondition: (error) => {
    // Retry on network errors and 5xx
    return (
      !error.response ||
      error.response.status >= 500 ||
      error.code === 'NETWORK_ERROR'
    );
  },
};

const apiClient = axios.create({
  baseURL: '/api/v1',
  timeout: 30000,
});

axiosRetry(apiClient, retryConfig);
```

### Validation Error Display

```typescript
const ValidationError = ({ errors }: { errors: FieldError[] }) => (
  <div className="validation-errors">
    <div className="error-header">
      <AlertCircle className="icon" />
      <span>Please fix the following issues:</span>
    </div>
    <ul>
      {errors.map((err, i) => (
        <li key={i}>
          <strong>{err.field}:</strong> {err.message}
        </li>
      ))}
    </ul>
  </div>
);
```

---

## State Management Architecture

### Session State (Zustand Store)

```typescript
interface QuickFixState {
  sessionId: string | null;
  currentIndex: number;
  totalIssues: number;
  completedIssues: number;
  skippedIssues: number;
  filters: QuickFixFilters;
  currentIssue: QuickFixIssue | null;

  // Actions
  setSession: (session: QuickFixSession) => void;
  setCurrentIssue: (issue: QuickFixIssue) => void;
  incrementCompleted: () => void;
  incrementSkipped: () => void;
  setFilters: (filters: QuickFixFilters) => void;
  reset: () => void;
}

const useQuickFixStore = create<QuickFixState>()(
  persist(
    (set) => ({
      sessionId: null,
      currentIndex: 0,
      totalIssues: 0,
      completedIssues: 0,
      skippedIssues: 0,
      filters: {},
      currentIssue: null,

      setSession: (session) => set({
        sessionId: session.id,
        totalIssues: session.totalIssues,
        completedIssues: session.completedIssues,
        skippedIssues: session.skippedIssues,
        currentIndex: session.currentIndex,
      }),

      setCurrentIssue: (issue) => set({ currentIssue: issue }),

      incrementCompleted: () => set((state) => ({
        completedIssues: state.completedIssues + 1,
        currentIndex: state.currentIndex + 1,
      })),

      incrementSkipped: () => set((state) => ({
        skippedIssues: state.skippedIssues + 1,
        currentIndex: state.currentIndex + 1,
      })),

      setFilters: (filters) => set({ filters }),

      reset: () => set({
        sessionId: null,
        currentIndex: 0,
        totalIssues: 0,
        completedIssues: 0,
        skippedIssues: 0,
        filters: {},
        currentIssue: null,
      }),
    }),
    {
      name: 'quick-fix-session',
      partialize: (state) => ({
        sessionId: state.sessionId,
        filters: state.filters,
      }),
    }
  )
);
```

### Server State (React Query)

```typescript
// Prefetch strategy
const prefetchNextIssue = async (sessionId: string, currentIndex: number) => {
  await queryClient.prefetchQuery({
    queryKey: ['quick-fix-issue', sessionId, currentIndex + 1],
    queryFn: () => quickFixService.getIssueByIndex(sessionId, currentIndex + 1),
  });
};

// Optimistic updates
const submitMutation = useMutation({
  mutationFn: (data: SubmitFixData) => quickFixService.submitFix(sessionId, data),
  onMutate: async (data) => {
    // Cancel outgoing refetches
    await queryClient.cancelQueries({ queryKey: ['quick-fix-session', sessionId] });

    // Snapshot previous value
    const previousSession = queryClient.getQueryData(['quick-fix-session', sessionId]);

    // Optimistically update
    queryClient.setQueryData(['quick-fix-session', sessionId], (old: any) => ({
      ...old,
      completedIssues: old.completedIssues + 1,
      currentIndex: old.currentIndex + 1,
    }));

    return { previousSession };
  },
  onError: (err, variables, context) => {
    // Rollback on error
    queryClient.setQueryData(
      ['quick-fix-session', sessionId],
      context.previousSession
    );
  },
  onSettled: () => {
    // Refetch to sync with server
    queryClient.invalidateQueries({ queryKey: ['quick-fix-session', sessionId] });
  },
});
```

---

## Testing Strategy (Enhanced)

### Unit Tests

**Backend Services:**
```typescript
describe('QuickFixSessionService', () => {
  describe('createSession', () => {
    it('should create session with tasks from remediation plan', async () => {
      const session = await service.createSession(jobId, userId, tenantId);
      expect(session.totalIssues).toBe(796);
      expect(session.tasks).toHaveLength(796);
    });

    it('should resume existing session', async () => {
      await service.createSession(jobId, userId, tenantId);
      const resumed = await service.createSession(jobId, userId, tenantId);
      expect(resumed.status).toBe('IN_PROGRESS');
    });

    it('should filter only quick-fix tasks', async () => {
      const session = await service.createSession(jobId, userId, tenantId);
      const allQuickFix = session.tasks.every(t => t.issueType in ['ALT_TEXT', 'TABLE_HEADER', ...]);
      expect(allQuickFix).toBe(true);
    });
  });

  describe('submitFix', () => {
    it('should update task status and increment completed count', async () => {
      const result = await service.submitFix(sessionId, taskId, { altText: 'Test' });
      expect(result.task.status).toBe('COMPLETED');
      expect(result.session.completedIssues).toBe(1);
    });

    it('should append to fix history when editing', async () => {
      await service.submitFix(sessionId, taskId, { altText: 'First' });
      await service.submitFix(sessionId, taskId, { altText: 'Second' });
      const task = await service.getTask(taskId);
      expect(task.fixHistory).toHaveLength(2);
    });
  });
});
```

**Frontend Components:**
```typescript
describe('AltTextForm', () => {
  it('should validate required field', async () => {
    render(<AltTextForm onSubmit={jest.fn()} />);
    fireEvent.click(screen.getByText('Submit'));
    expect(await screen.findByText('Alt text is required')).toBeInTheDocument();
  });

  it('should warn about redundant phrases', async () => {
    render(<AltTextForm onSubmit={jest.fn()} />);
    fireEvent.change(screen.getByLabelText('Alt text'), {
      target: { value: 'Image of a chart' },
    });
    expect(await screen.findByText(/Avoid starting with "image of"/)).toBeInTheDocument();
  });

  it('should call onSubmit with trimmed value', async () => {
    const onSubmit = jest.fn();
    render(<AltTextForm onSubmit={onSubmit} />);
    fireEvent.change(screen.getByLabelText('Alt text'), {
      target: { value: '  Chart showing data  ' },
    });
    fireEvent.click(screen.getByText('Submit'));
    expect(onSubmit).toHaveBeenCalledWith({ altText: 'Chart showing data' });
  });
});
```

### Integration Tests

```typescript
describe('Quick-Fix Workflow Integration', () => {
  it('should complete full workflow', async () => {
    // Start session
    const session = await quickFixService.startSession(jobId);
    expect(session.totalIssues).toBe(796);

    // Submit first issue
    const firstIssue = session.currentIssue;
    const result1 = await quickFixService.submitFix(session.id, firstIssue.taskId, {
      altText: 'Test alt text',
    });
    expect(result1.session.completedIssues).toBe(1);

    // Skip second issue
    const result2 = await quickFixService.skipIssue(session.id, result1.nextIssue.taskId);
    expect(result2.session.skippedIssues).toBe(1);

    // Save session
    await quickFixService.saveSession(session.id);
    const saved = await quickFixService.getSession(session.id);
    expect(saved.status).toBe('PAUSED');

    // Resume session
    const resumed = await quickFixService.startSession(jobId);
    expect(resumed.id).toBe(session.id);
    expect(resumed.currentIndex).toBe(2);
  });
});
```

### E2E Tests (Playwright)

```typescript
test('quick-fix workflow e2e', async ({ page }) => {
  // Navigate to remediation plan
  await page.goto(`/pdf/${jobId}/remediation`);

  // Start quick-fix
  await page.click('text=Start Quick Fix');
  await expect(page).toHaveURL(`/quick-fix/${sessionId}`);

  // Fill alt text
  await page.fill('textarea[name="altText"]', 'Chart showing revenue');
  await page.click('text=Submit');

  // Verify progress updated
  await expect(page.locator('text=1 of 796')).toBeVisible();

  // Skip issue
  await page.click('text=Skip');
  await expect(page.locator('text=2 of 796')).toBeVisible();

  // Save and exit
  await page.click('text=Save & Exit');
  await expect(page).toHaveURL(`/pdf/${jobId}/remediation`);

  // Resume
  await page.click('text=Resume Quick Fix');
  await expect(page).toHaveURL(`/quick-fix/${sessionId}`);
  await expect(page.locator('text=2 of 796')).toBeVisible();
});
```

---

## Performance Benchmarks

### Target Metrics

| Operation | Target | Measurement |
|-----------|--------|-------------|
| Session creation | < 2s | Time from API call to first render |
| Issue navigation | < 200ms | Time from click to next issue display |
| Form submission | < 500ms | Time from submit to success toast |
| PDF page load | < 1s | Time to render PDF page |
| AI suggestion | < 5s | Time from request to suggestion display |
| Apply fixes | < 30s | Time to modify PDF and generate download |

### Load Testing Scenarios

1. **Concurrent Sessions:**
   - 100 users starting sessions simultaneously
   - Should handle without degradation

2. **Large Session:**
   - 2000 issues in single session
   - Should paginate and load smoothly

3. **Rapid Submissions:**
   - User submits 50 fixes in 1 minute
   - Should queue and process without errors

---

## Accessibility Compliance (A11Y)

### WCAG 2.1 Level AA Requirements

**Keyboard Navigation:**
- All interactive elements focusable via Tab
- Skip links to main content
- Focus visible indicator (outline)
- Logical tab order

**Screen Reader Support:**
- Semantic HTML (`<nav>`, `<main>`, `<form>`)
- ARIA labels for icon buttons
- ARIA live regions for progress updates
- Descriptive form labels

**Visual Design:**
- Color contrast ratio ≥ 4.5:1 for normal text
- Color contrast ratio ≥ 3:1 for large text
- No reliance on color alone (use icons + text)
- Text resizable to 200% without loss of functionality

**Implementation Example:**
```tsx
<button
  onClick={handleNext}
  aria-label="Next issue (Right arrow)"
  className="btn-primary"
>
  Next <ArrowRight aria-hidden="true" />
</button>

<div role="status" aria-live="polite" aria-atomic="true">
  {completedIssues} of {totalIssues} issues fixed
</div>
```

---

## Security Audit Checklist

- [ ] All endpoints require authentication
- [ ] Session ownership validated (userId, tenantId)
- [ ] Task IDs validated before updates
- [ ] Input sanitization (XSS prevention)
- [ ] SQL injection prevented (Prisma)
- [ ] Rate limiting on AI suggestions
- [ ] File path validation (prevent traversal)
- [ ] CORS configured correctly
- [ ] CSP headers set
- [ ] Sensitive data not logged
- [ ] Error messages don't leak info
- [ ] Session tokens stored securely (httpOnly cookies or secure storage)

---

## Changes from V2

### New Features
- Perceptual hash matching for images (future)
- AI usage tracking with Redis
- Session cleanup cron job
- Cursor-based pagination
- Virtual scrolling for large lists
- Prefetching next issue

### Enhanced Details
- Complete component mockups
- State management architecture (Zustand + React Query)
- Comprehensive testing strategy
- Performance benchmarks
- Accessibility requirements
- Security audit checklist

---

## Next Steps for V4

1. Add deployment strategy (Docker, CI/CD)
2. Database migration scripts
3. Monitoring and alerting setup
4. User documentation
5. Admin tools for session management

---

**Plan Version 3 Complete**
**Next:** Create V4 with deployment and operations focus
