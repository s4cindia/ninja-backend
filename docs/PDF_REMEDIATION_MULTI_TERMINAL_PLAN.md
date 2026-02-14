# PDF Remediation - Multi-Terminal Implementation Plan

**Version:** 1.0
**Date:** February 9, 2026
**Approach:** 4-Terminal Parallel Development using Git Worktrees
**Timeline:** 8-12 weeks (6 phases)
**Status:** Ready for implementation

---

## Table of Contents

1. [Overview](#overview)
2. [Terminal Structure](#terminal-structure)
3. [Git Worktree Setup](#git-worktree-setup)
4. [Phase Breakdown](#phase-breakdown)
5. [File Ownership Matrix](#file-ownership-matrix)
6. [Parallel Work Streams](#parallel-work-streams)
7. [Dependencies & Sequencing](#dependencies--sequencing)
8. [Merge Strategy](#merge-strategy)
9. [Testing Strategy](#testing-strategy)
10. [Success Criteria](#success-criteria)

---

## Overview

### Goal
Implement complete PDF remediation workflow to achieve feature parity with EPUB, using **4 parallel Claude Code terminals** to maximize development velocity.

### Team Structure
- **4 Claude Code instances** working simultaneously
- **2 Backend terminals** (BE-T1, BE-T2)
- **2 Frontend terminals** (FE-T1, FE-T2)
- Work designed to **minimize file conflicts**

### Why Multi-Terminal?
- ✅ **4x faster development** - parallel execution
- ✅ **Reduced conflicts** - clear file ownership
- ✅ **Independent testing** - each terminal validates its work
- ✅ **Easier rollback** - isolated branches
- ✅ **Better focus** - each terminal has specific scope

### Timeline Summary
```
Phase 1: Core Remediation Service (1-2 weeks)
Phase 2: PDF Modifier + Priority Handlers (2-3 weeks)
Phase 3: Auto-Remediation Engine (1-2 weeks)
Phase 4: ACR Integration (1 week)
Phase 5: Batch Processing (1 week)
Phase 6: Advanced Handlers (2-3 weeks)

Total: 8-12 weeks with parallel execution
```

---

## Terminal Structure

### Backend Terminal 1 (BE-T1): Services & Business Logic
**Primary Responsibility:** Core services, PDF modification, auto-remediation logic

**Branch:** `feature/pdf-remediation-backend-1`

**Key Files:**
- `src/services/pdf/pdf-remediation.service.ts` (NEW - 500-800 lines)
- `src/services/pdf/pdf-modifier.service.ts` (NEW - 400-600 lines)
- `src/services/pdf/pdf-auto-remediation.service.ts` (NEW - 300-400 lines)
- `src/services/pdf/handlers/*.ts` (NEW - 10+ handler files)
- `src/utils/pdf-helpers.ts` (NEW)

**Focus:** "Make the PDF files actually change"

---

### Backend Terminal 2 (BE-T2): API, Routes, Controllers, Types
**Primary Responsibility:** HTTP layer, request/response handling, validation schemas

**Branch:** `feature/pdf-remediation-backend-2`

**Key Files:**
- `src/controllers/pdf-remediation.controller.ts` (NEW - 200-300 lines)
- `src/routes/pdf-remediation.routes.ts` (NEW - 100-150 lines)
- `src/schemas/pdf-remediation.schemas.ts` (NEW - 150-200 lines)
- `src/types/pdf-remediation.types.ts` (NEW - 100-150 lines)
- `src/constants/pdf-fix-classification.ts` (NEW - 50-100 lines)

**Focus:** "Make the API endpoints work correctly"

---

### Frontend Terminal 1 (FE-T1): Remediation Plan UI
**Primary Responsibility:** Remediation plan page, task list, status tracking

**Branch:** `feature/pdf-remediation-frontend-1`

**Key Files:**
- `src/pages/PdfRemediationPlanPage.tsx` (NEW)
- `src/components/pdf/RemediationPlanView.tsx` (NEW)
- `src/components/pdf/RemediationTaskCard.tsx` (NEW)
- `src/components/pdf/AutoFixProgress.tsx` (NEW)
- `src/components/pdf/ReauditButton.tsx` (NEW)
- `src/hooks/usePdfRemediation.ts` (NEW)
- `src/api/pdf-remediation.api.ts` (NEW)

**Focus:** "Show the remediation plan and progress"

---

### Frontend Terminal 2 (FE-T2): ACR Integration & Batch UI
**Primary Responsibility:** ACR workflow integration, batch processing UI

**Branch:** `feature/pdf-remediation-frontend-2`

**Key Files:**
- `src/components/pdf/TransferToAcrButton.tsx` (NEW)
- `src/components/pdf/BatchRemediationView.tsx` (NEW)
- `src/components/pdf/QuickFixModal.tsx` (NEW)
- `src/components/pdf/RemediationComparison.tsx` (NEW)
- `src/hooks/useBatchRemediation.ts` (NEW)
- `src/api/pdf-batch.api.ts` (NEW)

**Focus:** "Connect to ACR and batch workflows"

---

## Git Worktree Setup

### Prerequisites
```bash
cd C:\Users\avrve\projects\ninja-workspace\ninja-backend
git fetch origin
git checkout main
git pull
```

### Create Backend Worktrees
```bash
# Terminal 1: BE-T1 (Services)
git worktree add ../ninja-backend-be-t1 -b feature/pdf-remediation-backend-1

# Terminal 2: BE-T2 (API)
git worktree add ../ninja-backend-be-t2 -b feature/pdf-remediation-backend-2
```

### Create Frontend Worktrees
```bash
cd C:\Users\avrve\projects\ninja-workspace\ninja-frontend
git fetch origin
git checkout main
git pull

# Terminal 3: FE-T1 (Remediation UI)
git worktree add ../ninja-frontend-fe-t1 -b feature/pdf-remediation-frontend-1

# Terminal 4: FE-T2 (ACR & Batch)
git worktree add ../ninja-frontend-fe-t2 -b feature/pdf-remediation-frontend-2
```

### Launch Claude Code Sessions
```bash
# Terminal 1 (BE-T1)
cd C:\Users\avrve\projects\ninja-workspace\ninja-backend-be-t1
claude-code .

# Terminal 2 (BE-T2)
cd C:\Users\avrve\projects\ninja-workspace\ninja-backend-be-t2
claude-code .

# Terminal 3 (FE-T1)
cd C:\Users\avrve\projects\ninja-workspace\ninja-frontend-fe-t1
claude-code .

# Terminal 4 (FE-T2)
cd C:\Users\avrve\projects\ninja-workspace\ninja-frontend-fe-t2
claude-code .
```

---

## Phase Breakdown

### Phase 1: Core Remediation Service (Weeks 1-2)

**Goal:** Create remediation plan from audit results

#### BE-T1: Remediation Service Foundation
```typescript
// Create: src/services/pdf/pdf-remediation.service.ts
class PdfRemediationService {
  async createRemediationPlan(jobId: string): Promise<RemediationPlan>
  async getRemediationPlan(jobId: string): Promise<RemediationPlan>
  async classifyIssues(issues: Issue[]): Promise<ClassifiedIssues>
  async updateTaskStatus(jobId, taskId, status): Promise<void>
}
```

**Deliverables:**
- ✅ Service file created with core methods
- ✅ Issue classification logic (auto/quick-fix/manual)
- ✅ Database queries for plan creation
- ✅ Unit tests (80%+ coverage)

**Testing:**
```bash
npm test -- pdf-remediation.service.test.ts
```

---

#### BE-T2: API Layer
```typescript
// Create: src/controllers/pdf-remediation.controller.ts
// Create: src/routes/pdf-remediation.routes.ts
// Create: src/schemas/pdf-remediation.schemas.ts
// Create: src/types/pdf-remediation.types.ts
// Create: src/constants/pdf-fix-classification.ts

// Endpoints:
POST /api/v1/pdf/:jobId/remediation/plan
GET /api/v1/pdf/:jobId/remediation/plan
PATCH /api/v1/pdf/:jobId/remediation/tasks/:taskId
```

**Deliverables:**
- ✅ Controller with 3 endpoints
- ✅ Routes registered
- ✅ Zod schemas for validation
- ✅ TypeScript types exported
- ✅ Fix classification constants
- ✅ Integration tests

**Testing:**
```bash
npm test -- pdf-remediation.controller.test.ts
curl -X POST http://localhost:3000/api/v1/pdf/{jobId}/remediation/plan
```

---

#### FE-T1: Remediation Plan Page
```tsx
// Create: src/pages/PdfRemediationPlanPage.tsx
// Create: src/components/pdf/RemediationPlanView.tsx
// Create: src/components/pdf/RemediationTaskCard.tsx
// Create: src/hooks/usePdfRemediation.ts
// Create: src/api/pdf-remediation.api.ts

// Route: /pdf/:jobId/remediation
```

**Deliverables:**
- ✅ Page component with routing
- ✅ Plan view displaying tasks grouped by type
- ✅ Task cards with status indicators
- ✅ React Query hook for data fetching
- ✅ API service methods
- ✅ Loading/error states

**Testing:**
```bash
npm run dev
# Navigate to /pdf/{jobId}/remediation
```

---

#### FE-T2: Navigation Integration
```tsx
// Modify: src/pages/PdfAuditResultsPage.tsx
// Add: "Create Remediation Plan" button
// Add: Link to remediation page after plan created
```

**Deliverables:**
- ✅ Button in audit results page
- ✅ Navigation after plan creation
- ✅ Success toast notifications
- ✅ Error handling

**Testing:**
```bash
# End-to-end flow:
# 1. Upload PDF → 2. Run Audit → 3. View Results → 4. Click "Create Plan" → 5. See plan
```

---

### Phase 2: PDF Modifier + Priority Handlers (Weeks 3-5)

**Goal:** Implement PDF file modification with 4 priority metadata handlers

#### BE-T1: PDF Modifier Service + Handlers
```typescript
// Create: src/services/pdf/pdf-modifier.service.ts
class PdfModifierService {
  async loadPDF(buffer: Buffer): Promise<PDFDocument>
  async savePDF(doc: PDFDocument): Promise<Buffer>
  async addLanguage(doc: PDFDocument, lang?: string): Promise<ModificationResult>
  async addTitle(doc: PDFDocument, title: string): Promise<ModificationResult>
  async addMetadata(doc: PDFDocument, metadata: XMPMetadata): Promise<ModificationResult>
  async addCreator(doc: PDFDocument, creator?: string): Promise<ModificationResult>
}

// Create: src/services/pdf/handlers/language.handler.ts
// Create: src/services/pdf/handlers/title.handler.ts
// Create: src/services/pdf/handlers/metadata.handler.ts
// Create: src/services/pdf/handlers/creator.handler.ts
```

**Deliverables:**
- ✅ PDF modifier service using pdf-lib
- ✅ 4 handler implementations
- ✅ Before/after content tracking
- ✅ Error handling & rollback
- ✅ Unit tests for each handler

**Testing:**
```bash
npm test -- pdf-modifier.service.test.ts
npm test -- handlers/*.handler.test.ts
```

---

#### BE-T2: Quick-Fix Endpoints
```typescript
// Add to controller:
POST /api/v1/pdf/:jobId/remediation/quick-fix/:issueId
GET /api/v1/pdf/:jobId/remediation/preview/:issueId

// Add schemas:
QuickFixRequestSchema
QuickFixPreviewSchema
```

**Deliverables:**
- ✅ Quick-fix endpoint for user-provided values
- ✅ Preview endpoint (shows what will change)
- ✅ Validation schemas
- ✅ Integration tests

**Testing:**
```bash
curl -X POST http://localhost:3000/api/v1/pdf/{jobId}/remediation/quick-fix/{issueId} \
  -d '{"title": "Accessible Document"}'
```

---

#### FE-T1: Auto-Fix Progress UI
```tsx
// Create: src/components/pdf/AutoFixProgress.tsx
// Create: src/components/pdf/TaskStatusBadge.tsx
// Update: src/hooks/usePdfRemediation.ts (add polling)
```

**Deliverables:**
- ✅ Progress bar component
- ✅ Status badges (pending/in-progress/completed/failed)
- ✅ Polling logic (5s interval)
- ✅ Real-time updates

**Testing:**
```bash
# Start auto-fix and watch progress update live
```

---

#### FE-T2: Quick-Fix Modal
```tsx
// Create: src/components/pdf/QuickFixModal.tsx
// Create: src/hooks/useQuickFix.ts
```

**Deliverables:**
- ✅ Modal for user input (title, metadata, etc.)
- ✅ Form validation
- ✅ Preview before applying
- ✅ Success/error feedback

**Testing:**
```bash
# Click "Quick Fix" button → Modal opens → Enter values → Preview → Apply
```

---

### Phase 3: Auto-Remediation Engine (Weeks 6-7)

**Goal:** Execute auto-fixes automatically and track results

#### BE-T1: Auto-Remediation Service
```typescript
// Create: src/services/pdf/pdf-auto-remediation.service.ts
class PdfAutoRemediationService {
  async runAutoRemediation(jobId: string): Promise<AutoRemediationResult>
  async executeHandler(issue: Issue): Promise<HandlerResult>
  async saveRemediatedPdf(jobId: string, buffer: Buffer): Promise<string>
  async rollbackChanges(jobId: string): Promise<void>
}
```

**Deliverables:**
- ✅ Auto-remediation orchestration
- ✅ Sequential handler execution
- ✅ Progress tracking via DB updates
- ✅ Error handling & rollback
- ✅ S3 file management (backup + remediated)

**Testing:**
```bash
npm test -- pdf-auto-remediation.service.test.ts
```

---

#### BE-T2: Auto-Remediation Endpoints
```typescript
// Add to controller:
POST /api/v1/pdf/:jobId/remediation/auto-fix/start
GET /api/v1/pdf/:jobId/remediation/auto-fix/status
POST /api/v1/pdf/:jobId/remediation/auto-fix/cancel
```

**Deliverables:**
- ✅ Start auto-fix endpoint
- ✅ Status polling endpoint
- ✅ Cancel/rollback endpoint
- ✅ Integration tests

**Testing:**
```bash
curl -X POST http://localhost:3000/api/v1/pdf/{jobId}/remediation/auto-fix/start
```

---

#### FE-T1: Auto-Fix Execution UI
```tsx
// Create: src/components/pdf/AutoFixButton.tsx
// Update: src/components/pdf/AutoFixProgress.tsx (full implementation)
// Update: src/hooks/usePdfRemediation.ts (add mutations)
```

**Deliverables:**
- ✅ "Start Auto-Fix" button
- ✅ Progress display with live updates
- ✅ Cancel button
- ✅ Download remediated file button

**Testing:**
```bash
# Full auto-fix flow with progress tracking
```

---

#### FE-T2: Re-Audit Integration
```tsx
// Create: src/components/pdf/ReauditButton.tsx
// Update: src/api/pdf-remediation.api.ts (add reaudit)
```

**Deliverables:**
- ✅ "Re-Audit" button after auto-fix
- ✅ Upload remediated file
- ✅ Trigger new audit
- ✅ Compare results

**Testing:**
```bash
# Auto-fix → Re-audit → See issues resolved
```

---

### Phase 4: ACR Integration (Week 8)

**Goal:** Transfer remediation results to ACR workflow

#### BE-T1: ACR Transfer Service
```typescript
// Update: src/services/pdf/pdf-remediation.service.ts
async transferToAcr(jobId: string, options?: AcrTransferOptions): Promise<AcrTransferResult> {
  // Create AcrJob
  // Map fixed issues to supported criteria
  // Update confidence scores
  // Create initial criterion reviews with 'SUPPORTS' status
}
```

**Deliverables:**
- ✅ Transfer logic implementation
- ✅ Issue → WCAG mapping
- ✅ Confidence calculation
- ✅ AcrJob creation

**Testing:**
```bash
npm test -- pdf-remediation.service.test.ts --grep "transferToAcr"
```

---

#### BE-T2: ACR Transfer Endpoint
```typescript
// Add to controller:
POST /api/v1/pdf/:jobId/remediation/transfer-to-acr
```

**Deliverables:**
- ✅ Transfer endpoint
- ✅ Validation schema
- ✅ Integration test

**Testing:**
```bash
curl -X POST http://localhost:3000/api/v1/pdf/{jobId}/remediation/transfer-to-acr
```

---

#### FE-T1: Re-Audit Results
```tsx
// Create: src/components/pdf/ReauditResults.tsx
// Update: src/pages/PdfRemediationPlanPage.tsx (show re-audit)
```

**Deliverables:**
- ✅ Display re-audit results
- ✅ Show fixed vs remaining issues
- ✅ Visual comparison

**Testing:**
```bash
# View before/after comparison
```

---

#### FE-T2: Transfer to ACR Button
```tsx
// Create: src/components/pdf/TransferToAcrButton.tsx
// Create: src/hooks/useAcrTransfer.ts
```

**Deliverables:**
- ✅ "Transfer to ACR" button
- ✅ Confirmation modal
- ✅ Navigation to ACR workflow
- ✅ Success feedback

**Testing:**
```bash
# Transfer → Navigate to ACR → See pre-populated data
```

---

### Phase 5: Batch Processing (Week 9)

**Goal:** Remediate multiple PDFs in a single batch

#### BE-T1: Batch Remediation Service
```typescript
// Create: src/services/pdf/pdf-batch-remediation.service.ts
class PdfBatchRemediationService {
  async createBatchPlan(batchId: string): Promise<BatchRemediationPlan>
  async runBatchAutoRemediation(batchId: string): Promise<BatchResult>
  async getBatchProgress(batchId: string): Promise<BatchProgress>
}
```

**Deliverables:**
- ✅ Batch orchestration
- ✅ Parallel file processing
- ✅ Progress aggregation

**Testing:**
```bash
npm test -- pdf-batch-remediation.service.test.ts
```

---

#### BE-T2: Batch Endpoints
```typescript
// Create: src/controllers/pdf-batch-remediation.controller.ts
POST /api/v1/batches/:batchId/pdf/remediation/plan
POST /api/v1/batches/:batchId/pdf/remediation/auto-fix
GET /api/v1/batches/:batchId/pdf/remediation/progress
```

**Deliverables:**
- ✅ Batch controller
- ✅ Routes
- ✅ Schemas

**Testing:**
```bash
curl -X POST http://localhost:3000/api/v1/batches/{batchId}/pdf/remediation/plan
```

---

#### FE-T1: Batch Progress View
```tsx
// Create: src/components/pdf/BatchProgressView.tsx
// Create: src/hooks/useBatchRemediation.ts
```

**Deliverables:**
- ✅ Batch progress display
- ✅ Per-file status
- ✅ Overall progress

**Testing:**
```bash
# View batch progress with multiple files
```

---

#### FE-T2: Batch Remediation Page
```tsx
// Create: src/pages/BatchPdfRemediationPage.tsx
// Create: src/components/pdf/BatchRemediationView.tsx
```

**Deliverables:**
- ✅ Batch page
- ✅ File list with statuses
- ✅ Start/cancel batch actions

**Testing:**
```bash
# Navigate to /batches/{batchId}/pdf/remediation
```

---

### Phase 6: Advanced Handlers (Weeks 10-12)

**Goal:** Implement complex remediation handlers

#### BE-T1: Advanced Handlers
```typescript
// Create: src/services/pdf/handlers/alt-text.handler.ts (Gemini AI)
// Create: src/services/pdf/handlers/heading-structure.handler.ts
// Create: src/services/pdf/handlers/table-headers.handler.ts
// Create: src/services/pdf/handlers/bookmark.handler.ts
// Create: src/services/pdf/handlers/reading-order.handler.ts
```

**Deliverables:**
- ✅ 5 advanced handlers
- ✅ AI integration (alt-text)
- ✅ Structure manipulation
- ✅ Extensive testing

**Testing:**
```bash
npm test -- handlers/alt-text.handler.test.ts
```

---

#### BE-T2: Advanced Endpoints
```typescript
// Add to controller:
POST /api/v1/pdf/:jobId/remediation/ai-alt-text/:issueId
POST /api/v1/pdf/:jobId/remediation/structure/:issueId
```

**Deliverables:**
- ✅ AI alt-text endpoint
- ✅ Structure manipulation endpoints
- ✅ Validation

**Testing:**
```bash
curl -X POST http://localhost:3000/api/v1/pdf/{jobId}/remediation/ai-alt-text/{issueId}
```

---

#### FE-T1: Advanced Fix Modals
```tsx
// Create: src/components/pdf/AltTextModal.tsx (AI-generated suggestions)
// Create: src/components/pdf/HeadingStructureEditor.tsx
// Create: src/components/pdf/TableHeadersEditor.tsx
```

**Deliverables:**
- ✅ Alt-text modal with AI suggestions
- ✅ Heading structure editor
- ✅ Table headers editor

**Testing:**
```bash
# Edit complex structures via UI
```

---

#### FE-T2: Comparison View
```tsx
// Create: src/components/pdf/RemediationComparison.tsx
// Show before/after for structure changes
```

**Deliverables:**
- ✅ Visual comparison
- ✅ Highlight changes
- ✅ Download comparison report

**Testing:**
```bash
# View detailed before/after comparison
```

---

## File Ownership Matrix

### Backend Files

| File | Owner | Type | Conflicts? |
|------|-------|------|------------|
| `services/pdf/pdf-remediation.service.ts` | BE-T1 | Service | ❌ No |
| `services/pdf/pdf-modifier.service.ts` | BE-T1 | Service | ❌ No |
| `services/pdf/pdf-auto-remediation.service.ts` | BE-T1 | Service | ❌ No |
| `services/pdf/pdf-batch-remediation.service.ts` | BE-T1 | Service | ❌ No |
| `services/pdf/handlers/*.handler.ts` | BE-T1 | Handlers | ❌ No |
| `controllers/pdf-remediation.controller.ts` | BE-T2 | Controller | ❌ No |
| `controllers/pdf-batch-remediation.controller.ts` | BE-T2 | Controller | ❌ No |
| `routes/pdf-remediation.routes.ts` | BE-T2 | Routes | ❌ No |
| `schemas/pdf-remediation.schemas.ts` | BE-T2 | Schemas | ❌ No |
| `types/pdf-remediation.types.ts` | BE-T2 | Types | ⚠️ Shared* |
| `constants/pdf-fix-classification.ts` | BE-T2 | Constants | ❌ No |
| `utils/pdf-helpers.ts` | BE-T1 | Utilities | ❌ No |

*BE-T2 creates types, BE-T1 imports them. Coordinate on type changes.

### Frontend Files

| File | Owner | Type | Conflicts? |
|------|-------|------|------------|
| `pages/PdfRemediationPlanPage.tsx` | FE-T1 | Page | ❌ No |
| `pages/BatchPdfRemediationPage.tsx` | FE-T2 | Page | ❌ No |
| `components/pdf/RemediationPlanView.tsx` | FE-T1 | Component | ❌ No |
| `components/pdf/RemediationTaskCard.tsx` | FE-T1 | Component | ❌ No |
| `components/pdf/AutoFixProgress.tsx` | FE-T1 | Component | ❌ No |
| `components/pdf/AutoFixButton.tsx` | FE-T1 | Component | ❌ No |
| `components/pdf/ReauditButton.tsx` | FE-T1 | Component | ❌ No |
| `components/pdf/ReauditResults.tsx` | FE-T1 | Component | ❌ No |
| `components/pdf/TransferToAcrButton.tsx` | FE-T2 | Component | ❌ No |
| `components/pdf/BatchRemediationView.tsx` | FE-T2 | Component | ❌ No |
| `components/pdf/BatchProgressView.tsx` | FE-T1 | Component | ❌ No |
| `components/pdf/QuickFixModal.tsx` | FE-T2 | Component | ❌ No |
| `components/pdf/RemediationComparison.tsx` | FE-T2 | Component | ❌ No |
| `components/pdf/AltTextModal.tsx` | FE-T1 | Component | ❌ No |
| `hooks/usePdfRemediation.ts` | FE-T1 | Hook | ❌ No |
| `hooks/useBatchRemediation.ts` | FE-T1 | Hook | ❌ No |
| `hooks/useQuickFix.ts` | FE-T2 | Hook | ❌ No |
| `hooks/useAcrTransfer.ts` | FE-T2 | Hook | ❌ No |
| `api/pdf-remediation.api.ts` | FE-T1 | API | ❌ No |
| `api/pdf-batch.api.ts` | FE-T2 | API | ❌ No |
| `types/pdf-remediation.types.ts` | ⚠️ | Types | ⚠️ Shared* |

*FE-T1 and FE-T2 both import. Coordinate type changes.

---

## Parallel Work Streams

### Week 1-2: Phase 1 - Foundation

```
┌──────────────────────────┬──────────────────────────┐
│ BE-T1                    │ BE-T2                    │
├──────────────────────────┼──────────────────────────┤
│ • PdfRemediationService  │ • Controller skeleton    │
│   - createPlan()         │ • Routes                 │
│   - getPlan()            │   POST /plan             │
│   - classifyIssues()     │   GET /plan              │
│   - updateTaskStatus()   │   PATCH /tasks/:id       │
│ • Database queries       │ • Zod schemas            │
│ • Classification logic   │ • TypeScript types       │
│ • Unit tests             │ • Fix classification     │
│                          │ • Integration tests      │
└──────────────────────────┴──────────────────────────┘

┌──────────────────────────┬──────────────────────────┐
│ FE-T1                    │ FE-T2                    │
├──────────────────────────┼──────────────────────────┤
│ • RemediationPlanPage    │ • "Create Plan" button   │
│ • RemediationPlanView    │   in PdfAuditResults     │
│ • RemediationTaskCard    │ • Navigation logic       │
│ • usePdfRemediation hook │ • Success toasts         │
│ • API service methods    │ • Error handling         │
│ • Loading states         │ • Route integration      │
└──────────────────────────┴──────────────────────────┘

Dependencies: BE-T2 types → BE-T1 imports
              BE-T2 API → FE-T1 consumes
              No FE-T1/FE-T2 dependencies
```

**Merge Order:** BE-T2 → BE-T1 → FE-T2 → FE-T1

---

### Week 3-5: Phase 2 - PDF Modifier + Handlers

```
┌──────────────────────────┬──────────────────────────┐
│ BE-T1                    │ BE-T2                    │
├──────────────────────────┼──────────────────────────┤
│ • PdfModifierService     │ • Quick-fix endpoint     │
│   - loadPDF()            │   POST /quick-fix/:id    │
│   - savePDF()            │ • Preview endpoint       │
│   - addLanguage()        │   GET /preview/:id       │
│   - addTitle()           │ • QuickFixRequestSchema  │
│   - addMetadata()        │ • QuickFixPreviewSchema  │
│   - addCreator()         │ • Integration tests      │
│ • 4 handler files        │                          │
│ • Before/after tracking  │                          │
│ • Error handling         │                          │
│ • Unit tests (4 files)   │                          │
└──────────────────────────┴──────────────────────────┘

┌──────────────────────────┬──────────────────────────┐
│ FE-T1                    │ FE-T2                    │
├──────────────────────────┼──────────────────────────┤
│ • AutoFixProgress        │ • QuickFixModal          │
│ • TaskStatusBadge        │ • useQuickFix hook       │
│ • Polling logic (5s)     │ • Form validation        │
│ • Real-time updates      │ • Preview display        │
│ • Progress bar UI        │ • Apply mutation         │
│                          │ • Success/error feedback │
└──────────────────────────┴──────────────────────────┘

Dependencies: BE-T1 handlers → BE-T2 quick-fix endpoint
              BE-T2 endpoint → FE-T2 modal
              FE-T1 progress → FE-T2 displays status
```

**Merge Order:** BE-T1 → BE-T2 → FE-T1 → FE-T2

---

### Week 6-7: Phase 3 - Auto-Remediation

```
┌──────────────────────────┬──────────────────────────┐
│ BE-T1                    │ BE-T2                    │
├──────────────────────────┼──────────────────────────┤
│ • AutoRemediationService │ • Start auto-fix         │
│   - runAutoRemediation() │   POST /auto-fix/start   │
│   - executeHandler()     │ • Status endpoint        │
│   - saveRemediatedPdf()  │   GET /auto-fix/status   │
│   - rollbackChanges()    │ • Cancel endpoint        │
│ • Progress tracking      │   POST /auto-fix/cancel  │
│ • S3 file management     │ • Integration tests      │
│ • Error handling         │                          │
│ • Unit tests             │                          │
└──────────────────────────┴──────────────────────────┘

┌──────────────────────────┬──────────────────────────┐
│ FE-T1                    │ FE-T2                    │
├──────────────────────────┼──────────────────────────┤
│ • AutoFixButton          │ • ReauditButton          │
│ • AutoFixProgress (full) │ • Upload remediated file │
│ • usePdfRemediation      │ • Trigger new audit      │
│   mutations              │ • Compare results        │
│ • Cancel button          │ • Navigation to audit    │
│ • Download button        │                          │
└──────────────────────────┴──────────────────────────┘

Dependencies: BE-T1 → BE-T2 → FE-T1 → FE-T2
```

**Merge Order:** BE-T1 → BE-T2 → FE-T1 → FE-T2

---

### Week 8: Phase 4 - ACR Integration

```
┌──────────────────────────┬──────────────────────────┐
│ BE-T1                    │ BE-T2                    │
├──────────────────────────┼──────────────────────────┤
│ • transferToAcr()        │ • Transfer endpoint      │
│ • Issue → WCAG mapping   │   POST /transfer-to-acr  │
│ • Confidence calculation │ • Validation schema      │
│ • AcrJob creation        │ • Integration test       │
│ • Unit tests             │                          │
└──────────────────────────┴──────────────────────────┘

┌──────────────────────────┬──────────────────────────┐
│ FE-T1                    │ FE-T2                    │
├──────────────────────────┼──────────────────────────┤
│ • ReauditResults         │ • TransferToAcrButton    │
│ • Before/after display   │ • useAcrTransfer hook    │
│ • Visual comparison      │ • Confirmation modal     │
│                          │ • Navigation to ACR      │
│                          │ • Success feedback       │
└──────────────────────────┴──────────────────────────┘

Dependencies: BE-T1 → BE-T2 → FE-T2
              FE-T1 parallel to FE-T2
```

**Merge Order:** BE-T1 → BE-T2 → FE-T1 → FE-T2

---

### Week 9: Phase 5 - Batch Processing

```
┌──────────────────────────┬──────────────────────────┐
│ BE-T1                    │ BE-T2                    │
├──────────────────────────┼──────────────────────────┤
│ • BatchRemediationSvc    │ • BatchController        │
│   - createBatchPlan()    │ • Batch routes           │
│   - runBatchAutoFix()    │   POST /plan             │
│   - getBatchProgress()   │   POST /auto-fix         │
│ • Parallel processing    │   GET /progress          │
│ • Progress aggregation   │ • Batch schemas          │
│ • Unit tests             │ • Integration tests      │
└──────────────────────────┴──────────────────────────┘

┌──────────────────────────┬──────────────────────────┐
│ FE-T1                    │ FE-T2                    │
├──────────────────────────┼──────────────────────────┤
│ • BatchProgressView      │ • BatchRemediationPage   │
│ • useBatchRemediation    │ • BatchRemediationView   │
│ • Per-file status        │ • File list with status  │
│ • Overall progress       │ • Start/cancel actions   │
│                          │ • Route integration      │
└──────────────────────────┴──────────────────────────┘

Dependencies: BE-T1 → BE-T2 → FE-T1 → FE-T2
```

**Merge Order:** BE-T1 → BE-T2 → FE-T1 → FE-T2

---

### Week 10-12: Phase 6 - Advanced Handlers

```
┌──────────────────────────┬──────────────────────────┐
│ BE-T1                    │ BE-T2                    │
├──────────────────────────┼──────────────────────────┤
│ • alt-text.handler.ts    │ • AI alt-text endpoint   │
│   (Gemini AI)            │   POST /ai-alt-text/:id  │
│ • heading-structure      │ • Structure endpoints    │
│   .handler.ts            │   POST /structure/:id    │
│ • table-headers          │ • Validation schemas     │
│   .handler.ts            │ • Integration tests      │
│ • bookmark.handler.ts    │                          │
│ • reading-order          │                          │
│   .handler.ts            │                          │
│ • 5 unit test files      │                          │
└──────────────────────────┴──────────────────────────┘

┌──────────────────────────┬──────────────────────────┐
│ FE-T1                    │ FE-T2                    │
├──────────────────────────┼──────────────────────────┤
│ • AltTextModal           │ • RemediationComparison  │
│   (AI suggestions)       │ • Visual comparison      │
│ • HeadingStructureEditor │ • Highlight changes      │
│ • TableHeadersEditor     │ • Download report        │
│ • Complex structure UI   │                          │
└──────────────────────────┴──────────────────────────┘

Dependencies: BE-T1 handlers → BE-T2 endpoints → FE-T1 modals
              FE-T2 parallel
```

**Merge Order:** BE-T1 → BE-T2 → FE-T1 → FE-T2

---

## Dependencies & Sequencing

### Critical Path

```
Phase 1 (Foundation):
  BE-T2 (types) → BE-T1 (services)
  BE-T2 (API) → FE-T1 (UI)
  FE-T2 parallel to FE-T1

Phase 2 (Modifier):
  BE-T1 (handlers) → BE-T2 (endpoints)
  BE-T2 → FE-T2 (modals)
  FE-T1 parallel (progress UI)

Phase 3 (Auto-Fix):
  BE-T1 → BE-T2 → FE-T1 → FE-T2
  Sequential dependencies

Phase 4 (ACR):
  BE-T1 → BE-T2 → FE-T2
  FE-T1 parallel (re-audit UI)

Phase 5 (Batch):
  BE-T1 → BE-T2 → FE-T1 → FE-T2
  Sequential dependencies

Phase 6 (Advanced):
  BE-T1 (handlers) → BE-T2 (endpoints) → FE-T1 (modals)
  FE-T2 parallel (comparison)
```

### Coordination Points

**Week 1 (Phase 1 Start):**
- BE-T2 must define types FIRST (Day 1-2)
- BE-T1 imports types (Day 3+)
- FE-T1 waits for API routes (Day 5+)
- FE-T2 parallel work (integration)

**Week 3 (Phase 2 Start):**
- BE-T1 implements handlers first
- BE-T2 builds endpoints using handlers
- FE-T2 builds modal using endpoints
- FE-T1 parallel (progress UI)

**Week 6 (Phase 3 Start):**
- Strictly sequential: BE-T1 → BE-T2 → FE-T1 → FE-T2

---

## Merge Strategy

### Per-Phase Merging

**Step 1: Complete All Work**
- All 4 terminals finish their assigned work
- All unit tests pass locally
- All integration tests pass locally

**Step 2: Merge Backend (BE-T2 → BE-T1)**
```bash
cd C:\Users\avrve\projects\ninja-workspace\ninja-backend

# Merge BE-T2 first (types, routes, controllers)
git checkout main
git pull
git merge feature/pdf-remediation-backend-2
npm test
npm run lint

# Then merge BE-T1 (services)
git merge feature/pdf-remediation-backend-1
npm test
npm run lint
```

**Step 3: Merge Frontend (FE-T2 → FE-T1)**
```bash
cd C:\Users\avrve\projects\ninja-workspace\ninja-frontend

# Merge FE-T2 first (ACR, batch, modals)
git checkout main
git pull
git merge feature/pdf-remediation-frontend-2
npm test
npm run lint

# Then merge FE-T1 (remediation UI)
git merge feature/pdf-remediation-frontend-1
npm test
npm run lint
```

**Step 4: Integration Testing**
```bash
# Run E2E tests
cd ninja-backend
npm run test:e2e

cd ninja-frontend
npm run test:e2e
```

**Step 5: Deploy to Staging**
```bash
git push origin main
# CI/CD triggers deployment
# Monitor GitHub Actions
```

**Step 6: QA Validation**
- Manual testing checklist
- Accessibility testing
- Performance testing
- No critical bugs → Proceed to next phase

---

### Conflict Resolution

**If Conflicts Occur:**
1. Identify conflicting files
2. Check file ownership matrix
3. Owner terminal has final say
4. Resolve conflicts preserving both implementations if possible
5. Re-run all tests after resolution

**Most Likely Conflicts:**
- `src/types/pdf-remediation.types.ts` (shared)
- Route registration order in `src/routes/index.ts`
- Type imports in multiple files

**Prevention:**
- Clear file ownership
- Coordinate on shared types early
- Merge frequently (end of each week)

---

## Testing Strategy

### Unit Tests (Each Terminal)

**BE-T1:**
```bash
npm test -- pdf-remediation.service.test.ts
npm test -- pdf-modifier.service.test.ts
npm test -- pdf-auto-remediation.service.test.ts
npm test -- handlers/*.handler.test.ts
```

**BE-T2:**
```bash
npm test -- pdf-remediation.controller.test.ts
npm test -- pdf-batch-remediation.controller.test.ts
```

**FE-T1:**
```bash
npm test -- PdfRemediationPlanPage.test.tsx
npm test -- usePdfRemediation.test.ts
```

**FE-T2:**
```bash
npm test -- TransferToAcrButton.test.tsx
npm test -- BatchRemediationView.test.tsx
```

**Target:** 80%+ coverage per terminal

---

### Integration Tests (End of Phase)

**Phase 1:**
```bash
# Test: Create plan → View plan → Update task status
curl -X POST http://localhost:3000/api/v1/pdf/{jobId}/remediation/plan
curl -X GET http://localhost:3000/api/v1/pdf/{jobId}/remediation/plan
```

**Phase 2:**
```bash
# Test: Quick-fix flow → Preview → Apply
curl -X GET http://localhost:3000/api/v1/pdf/{jobId}/remediation/preview/{issueId}
curl -X POST http://localhost:3000/api/v1/pdf/{jobId}/remediation/quick-fix/{issueId}
```

**Phase 3:**
```bash
# Test: Start auto-fix → Poll status → Download remediated
curl -X POST http://localhost:3000/api/v1/pdf/{jobId}/remediation/auto-fix/start
curl -X GET http://localhost:3000/api/v1/pdf/{jobId}/remediation/auto-fix/status
```

**Phase 4:**
```bash
# Test: Transfer to ACR → Verify AcrJob created
curl -X POST http://localhost:3000/api/v1/pdf/{jobId}/remediation/transfer-to-acr
curl -X GET http://localhost:3000/api/v1/acr/jobs/{acrJobId}
```

**Phase 5:**
```bash
# Test: Batch remediation → Multiple files
curl -X POST http://localhost:3000/api/v1/batches/{batchId}/pdf/remediation/auto-fix
```

---

### E2E Tests (End-to-End)

**Full Remediation Flow:**
1. Upload PDF
2. Run audit
3. View audit results
4. Click "Create Remediation Plan"
5. View plan with classified tasks
6. Click "Start Auto-Fix"
7. Watch progress update
8. Download remediated PDF
9. Click "Re-Audit"
10. Upload remediated file
11. See issues resolved
12. Click "Transfer to ACR"
13. Navigate to ACR workflow
14. Verify pre-populated data

**Playwright Test:**
```typescript
test('PDF remediation full flow', async ({ page }) => {
  // 1. Upload
  await page.goto('/upload');
  await page.setInputFiles('input[type="file"]', 'test.pdf');
  await page.click('button:has-text("Upload")');

  // 2. Audit
  await page.click('button:has-text("Run Audit")');
  await page.waitForSelector('text=Audit Complete');

  // 3. View results
  await page.click('a:has-text("View Results")');

  // 4. Create plan
  await page.click('button:has-text("Create Remediation Plan")');
  await page.waitForURL(/\/pdf\/.*\/remediation/);

  // 5. Verify tasks
  expect(await page.locator('.task-card').count()).toBeGreaterThan(0);

  // 6. Start auto-fix
  await page.click('button:has-text("Start Auto-Fix")');

  // 7. Wait for completion
  await page.waitForSelector('text=Auto-Fix Complete', { timeout: 60000 });

  // 8. Download
  const downloadPromise = page.waitForEvent('download');
  await page.click('button:has-text("Download Remediated PDF")');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain('_remediated.pdf');

  // 9. Re-audit
  await page.click('button:has-text("Re-Audit")');
  await page.setInputFiles('input[type="file"]', await download.path());
  await page.click('button:has-text("Upload & Audit")');
  await page.waitForSelector('text=Audit Complete');

  // 10. Verify issues resolved
  const issueCount = await page.locator('.issue-card').count();
  expect(issueCount).toBeLessThan(10); // Assuming some were fixed

  // 11. Transfer to ACR
  await page.click('button:has-text("Transfer to ACR")');
  await page.click('button:has-text("Confirm")');
  await page.waitForURL(/\/acr\/.*/);

  // 12. Verify ACR data
  expect(await page.locator('text=SUPPORTS').count()).toBeGreaterThan(0);
});
```

---

### Manual QA Checklist

**Per Phase:**
- [ ] All endpoints return expected responses
- [ ] UI renders without errors
- [ ] Loading states display correctly
- [ ] Error messages are user-friendly
- [ ] Mobile responsive (test on 375px, 768px, 1920px)
- [ ] Accessibility: keyboard navigation works
- [ ] Accessibility: screen reader friendly (NVDA/JAWS test)
- [ ] No console errors
- [ ] Performance: operations complete in <5s
- [ ] Data persists correctly in database
- [ ] Files stored correctly in S3

---

## Success Criteria

### Phase 1 Success Criteria
- ✅ Create remediation plan endpoint returns 200
- ✅ Plan contains auto-fixable, quick-fixable, manual tasks
- ✅ Remediation plan page renders without errors
- ✅ Task cards display with correct status badges
- ✅ Can update task status (pending → in-progress → completed)
- ✅ All unit tests pass (80%+ coverage)
- ✅ 0 TypeScript errors
- ✅ 0 ESLint errors

### Phase 2 Success Criteria
- ✅ PDF modifier can add language, title, metadata, creator
- ✅ 4 handlers implemented and tested
- ✅ Quick-fix endpoint accepts user input and applies fix
- ✅ Preview endpoint shows what will change
- ✅ AutoFixProgress component displays real-time updates
- ✅ QuickFixModal validates input and handles errors
- ✅ All unit tests pass for handlers
- ✅ Integration tests pass

### Phase 3 Success Criteria
- ✅ Start auto-fix endpoint triggers remediation
- ✅ Auto-remediation service executes handlers sequentially
- ✅ Progress updates every 5 seconds
- ✅ Remediated PDF saved to S3 with backup
- ✅ Re-audit works with remediated file
- ✅ "Before vs After" comparison shows fixed issues
- ✅ Can cancel auto-fix in progress
- ✅ All E2E tests pass

### Phase 4 Success Criteria
- ✅ Transfer to ACR creates AcrJob
- ✅ Fixed issues mapped to WCAG criteria
- ✅ Confidence scores calculated correctly
- ✅ Criterion reviews pre-populated with 'SUPPORTS'
- ✅ Navigation to ACR workflow works
- ✅ Re-audit results display correctly
- ✅ Integration with existing ACR workflow seamless

### Phase 5 Success Criteria
- ✅ Batch plan creates plans for all PDFs
- ✅ Batch auto-fix processes files in parallel
- ✅ Progress aggregation shows overall + per-file status
- ✅ Batch page displays all files with statuses
- ✅ Can cancel batch operation
- ✅ Batch endpoints handle errors gracefully
- ✅ All batch integration tests pass

### Phase 6 Success Criteria
- ✅ Alt-text handler uses Gemini AI for generation
- ✅ Heading structure handler reorganizes headings
- ✅ Table headers handler adds missing headers
- ✅ Bookmark handler creates PDF bookmarks
- ✅ Reading order handler fixes tab order
- ✅ Advanced fix modals (alt-text, heading, table) work
- ✅ Comparison view highlights structure changes
- ✅ All 5 advanced handlers tested
- ✅ Full E2E flow works end-to-end

### Overall Success
- ✅ Complete feature parity with EPUB remediation
- ✅ All 28 gaps from gap analysis addressed
- ✅ 80%+ code coverage across all modules
- ✅ 0 critical bugs in staging
- ✅ Performance: Auto-fix <30s for typical PDF
- ✅ Performance: Batch <2 min for 10 PDFs
- ✅ All documentation complete
- ✅ 0 accessibility violations (WCAG AA)
- ✅ NPS score: 40+ (user satisfaction)

---

## Communication & Coordination

### Daily Standup (15 minutes)

**Format:**
```
BE-T1: What I completed / Working on / Blockers
BE-T2: What I completed / Working on / Blockers
FE-T1: What I completed / Working on / Blockers
FE-T2: What I completed / Working on / Blockers
```

**Schedule:** 9:00 AM daily (or beginning of Claude Code session)

---

### Weekly Sync (30 minutes)

**Agenda:**
1. Demo progress from all 4 terminals
2. Review integration points
3. Discuss upcoming dependencies
4. Plan merge strategy for end of week
5. Adjust timeline if needed
6. Identify risks

**Schedule:** Every Friday 2:00 PM

---

### Phase Completion Review (1 hour)

**Agenda:**
1. Demo all deliverables
2. Run E2E tests together
3. Merge all branches (follow merge strategy)
4. QA validation
5. Deploy to staging
6. Go/No-Go decision for next phase

**Schedule:** End of each phase

---

## Prompt Files

Each terminal should have a dedicated prompt file:

### BE-T1.md - Backend Terminal 1 Prompts
```markdown
# PDF Remediation - Backend Terminal 1 (Services)

You are working in terminal BE-T1 on the PDF Remediation feature.

## Your Responsibility
Create and maintain all service layer business logic for PDF remediation.

## Your Files
- src/services/pdf/pdf-remediation.service.ts
- src/services/pdf/pdf-modifier.service.ts
- src/services/pdf/pdf-auto-remediation.service.ts
- src/services/pdf/pdf-batch-remediation.service.ts
- src/services/pdf/handlers/*.handler.ts
- src/utils/pdf-helpers.ts

## Phase 1 Task
Create PdfRemediationService with methods:
- createRemediationPlan()
- getRemediationPlan()
- classifyIssues()
- updateTaskStatus()

## Testing
npm test -- pdf-remediation.service.test.ts

## Definition of Done
- All methods implemented
- Unit tests pass (80%+ coverage)
- TypeScript compiles
- ESLint passes
```

### BE-T2.md - Backend Terminal 2 Prompts
```markdown
# PDF Remediation - Backend Terminal 2 (API)

You are working in terminal BE-T2 on the PDF Remediation feature.

## Your Responsibility
Create and maintain all HTTP layer: routes, controllers, schemas, types.

## Your Files
- src/controllers/pdf-remediation.controller.ts
- src/routes/pdf-remediation.routes.ts
- src/schemas/pdf-remediation.schemas.ts
- src/types/pdf-remediation.types.ts
- src/constants/pdf-fix-classification.ts

## Phase 1 Task
Create endpoints:
- POST /api/v1/pdf/:jobId/remediation/plan
- GET /api/v1/pdf/:jobId/remediation/plan
- PATCH /api/v1/pdf/:jobId/remediation/tasks/:taskId

## Testing
npm test -- pdf-remediation.controller.test.ts
curl -X POST http://localhost:3000/api/v1/pdf/{jobId}/remediation/plan

## Definition of Done
- All endpoints implemented
- Zod schemas validate requests
- TypeScript types exported
- Integration tests pass
```

### FE-T1.md - Frontend Terminal 1 Prompts
```markdown
# PDF Remediation - Frontend Terminal 1 (Remediation UI)

You are working in terminal FE-T1 on the PDF Remediation feature.

## Your Responsibility
Create and maintain remediation plan page and progress UI.

## Your Files
- src/pages/PdfRemediationPlanPage.tsx
- src/components/pdf/RemediationPlanView.tsx
- src/components/pdf/RemediationTaskCard.tsx
- src/components/pdf/AutoFixProgress.tsx
- src/hooks/usePdfRemediation.ts
- src/api/pdf-remediation.api.ts

## Phase 1 Task
Create remediation plan page that displays:
- Auto-fixable tasks
- Quick-fixable tasks
- Manual tasks
- Task status (pending/in-progress/completed/failed)

## Testing
npm run dev
Navigate to /pdf/{jobId}/remediation

## Definition of Done
- Page renders without errors
- Tasks display correctly
- Loading/error states work
- Mobile responsive
```

### FE-T2.md - Frontend Terminal 2 Prompts
```markdown
# PDF Remediation - Frontend Terminal 2 (ACR & Batch)

You are working in terminal FE-T2 on the PDF Remediation feature.

## Your Responsibility
Create and maintain ACR integration and batch UI.

## Your Files
- src/components/pdf/TransferToAcrButton.tsx
- src/components/pdf/BatchRemediationView.tsx
- src/components/pdf/QuickFixModal.tsx
- src/hooks/useAcrTransfer.ts
- src/api/pdf-batch.api.ts

## Phase 1 Task
Add "Create Remediation Plan" button to PdfAuditResultsPage.

## Testing
npm run dev
Upload PDF → Audit → Click "Create Plan" → Should navigate to plan page

## Definition of Done
- Button displays correctly
- Navigation works
- Success toast shows
- Error handling works
```

---

## Risk Mitigation

### Risk 1: File Conflicts During Merge
**Likelihood:** Medium
**Impact:** Medium
**Mitigation:**
- Clear file ownership matrix
- Daily standups to coordinate
- Merge frequently (end of each week)
- Review prompt files before starting work

### Risk 2: API Contract Misalignment
**Likelihood:** Medium
**Impact:** High
**Mitigation:**
- BE-T2 defines types first (Day 1-2 of each phase)
- BE-T1 and FE terminals import types
- Mock API responses for frontend development
- Integration tests at end of each phase

### Risk 3: Complex PDF Structure Issues
**Likelihood:** High
**Impact:** High
**Mitigation:**
- Start with simple metadata handlers (Phase 2)
- Defer complex handlers to Phase 6
- Use pdf-lib documentation extensively
- Test with variety of PDF files (simple → complex)
- Have fallback for unsupported modifications

### Risk 4: Gemini API Rate Limits (Alt-Text)
**Likelihood:** Medium
**Impact:** Medium
**Mitigation:**
- Cache generated alt-text for 1 hour
- Implement exponential backoff
- Fallback to manual input if API fails
- Monitor usage in Phase 6

### Risk 5: Scope Creep
**Likelihood:** High
**Impact:** Medium
**Mitigation:**
- Strict phase boundaries
- "Post-MVP" parking lot for nice-to-haves
- Product owner approval required for additions
- Weekly scope review

### Risk 6: Performance Issues (Large PDFs)
**Likelihood:** Medium
**Impact:** Medium
**Mitigation:**
- Set file size limits (e.g., 50 MB)
- Use streaming where possible
- Optimize pdf-lib operations
- Add progress indicators for long operations
- Performance testing with large files

---

## Timeline Visualization

```
Week 1-2: Phase 1 - Foundation
┌─────────┬─────────┬─────────┬─────────┐
│ BE-T1   │ BE-T2   │ FE-T1   │ FE-T2   │
│ Service │ API     │ Plan UI │ Nav     │
└─────────┴─────────┴─────────┴─────────┘
         ↓ Merge & Test ↓

Week 3-5: Phase 2 - Modifier
┌─────────┬─────────┬─────────┬─────────┐
│ BE-T1   │ BE-T2   │ FE-T1   │ FE-T2   │
│ Modifier│ QuickFix│ Progress│ Modal   │
│ +4 Hdlrs│ API     │ UI      │         │
└─────────┴─────────┴─────────┴─────────┘
         ↓ Merge & Test ↓

Week 6-7: Phase 3 - Auto-Remediation
┌─────────┬─────────┬─────────┬─────────┐
│ BE-T1   │ BE-T2   │ FE-T1   │ FE-T2   │
│ AutoRem │ AutoAPI │ AutoBtn │ Reaudit │
│ Service │         │ Progress│ Button  │
└─────────┴─────────┴─────────┴─────────┘
         ↓ Merge & Test ↓

Week 8: Phase 4 - ACR Integration
┌─────────┬─────────┬─────────┬─────────┐
│ BE-T1   │ BE-T2   │ FE-T1   │ FE-T2   │
│ Transfer│ Transfer│ Reaudit │ Transfer│
│ Logic   │ API     │ Results │ Button  │
└─────────┴─────────┴─────────┴─────────┘
         ↓ Merge & Test ↓

Week 9: Phase 5 - Batch Processing
┌─────────┬─────────┬─────────┬─────────┐
│ BE-T1   │ BE-T2   │ FE-T1   │ FE-T2   │
│ Batch   │ Batch   │ Batch   │ Batch   │
│ Service │ API     │ Progress│ Page    │
└─────────┴─────────┴─────────┴─────────┘
         ↓ Merge & Test ↓

Week 10-12: Phase 6 - Advanced Handlers
┌─────────┬─────────┬─────────┬─────────┐
│ BE-T1   │ BE-T2   │ FE-T1   │ FE-T2   │
│ 5 Adv   │ Adv API │ Adv     │ Compare │
│ Handlers│         │ Modals  │ View    │
└─────────┴─────────┴─────────┴─────────┘
         ↓ Final Merge & QA ↓

        🎉 PDF REMEDIATION COMPLETE 🎉
```

---

## Next Steps

### 1. Review This Plan
- Read through entire plan
- Understand terminal responsibilities
- Clarify any questions

### 2. Set Up Git Worktrees
```bash
# Follow instructions in "Git Worktree Setup" section
```

### 3. Launch 4 Claude Code Sessions
```bash
# Open 4 separate terminal windows
# Launch Claude Code in each worktree
```

### 4. Read Your Prompt File
- BE-T1: Read BE-T1.md
- BE-T2: Read BE-T2.md
- FE-T1: Read FE-T1.md
- FE-T2: Read FE-T2.md

### 5. Start Phase 1 Work
- BE-T2 starts Day 1 (define types first)
- BE-T1 starts Day 3 (after types defined)
- FE-T1 starts Day 5 (after API routes ready)
- FE-T2 starts Day 1 (parallel work)

### 6. Daily Coordination
- Daily standup at 9 AM
- Weekly sync Friday 2 PM
- Phase completion review at end of each phase

---

## Appendix: Example Commands

### Terminal BE-T1
```bash
cd C:\Users\avrve\projects\ninja-workspace\ninja-backend-be-t1

# Start work
git status
git pull origin main

# Create service file
# Implement methods
# Write tests

# Test
npm test -- pdf-remediation.service.test.ts

# Commit
git add src/services/pdf/pdf-remediation.service.ts
git add src/services/pdf/__tests__/pdf-remediation.service.test.ts
git commit -m "feat: implement PdfRemediationService

- createRemediationPlan()
- getRemediationPlan()
- classifyIssues()
- updateTaskStatus()

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"

git push -u origin feature/pdf-remediation-backend-1
```

### Terminal BE-T2
```bash
cd C:\Users\avrve\projects\ninja-workspace\ninja-backend-be-t2

# Create types first
# Create schemas
# Create controller
# Create routes

# Test
npm test -- pdf-remediation.controller.test.ts

# Integration test
npm run dev
curl -X POST http://localhost:3000/api/v1/pdf/{jobId}/remediation/plan

# Commit
git add src/types/pdf-remediation.types.ts
git add src/schemas/pdf-remediation.schemas.ts
git add src/controllers/pdf-remediation.controller.ts
git add src/routes/pdf-remediation.routes.ts
git commit -m "feat: add PDF remediation API endpoints

- POST /api/v1/pdf/:jobId/remediation/plan
- GET /api/v1/pdf/:jobId/remediation/plan
- PATCH /api/v1/pdf/:jobId/remediation/tasks/:taskId

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"

git push -u origin feature/pdf-remediation-backend-2
```

### Terminal FE-T1
```bash
cd C:\Users\avrve\projects\ninja-workspace\ninja-frontend-fe-t1

# Create page
# Create components
# Create hooks
# Create API service

# Test
npm run dev
# Navigate to /pdf/{jobId}/remediation

# Commit
git add src/pages/PdfRemediationPlanPage.tsx
git add src/components/pdf/RemediationPlanView.tsx
git add src/hooks/usePdfRemediation.ts
git commit -m "feat: add PDF remediation plan page

- Displays auto-fixable, quick-fixable, manual tasks
- Task status tracking
- Loading/error states
- Mobile responsive

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"

git push -u origin feature/pdf-remediation-frontend-1
```

### Terminal FE-T2
```bash
cd C:\Users\avrve\projects\ninja-workspace\ninja-frontend-fe-t2

# Add button to audit results page
# Create navigation logic

# Test
npm run dev
# Upload → Audit → Click "Create Plan"

# Commit
git add src/pages/PdfAuditResultsPage.tsx
git commit -m "feat: add Create Remediation Plan button

- Button in PDF audit results page
- Navigation to remediation plan
- Success toast notification
- Error handling

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"

git push -u origin feature/pdf-remediation-frontend-2
```

---

**Document Status:** ✅ Ready for Implementation
**Owner:** Project Lead
**Last Updated:** February 9, 2026
**Next Review:** End of Phase 1 (Week 2)
