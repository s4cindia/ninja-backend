# Document Workflow Lineage System Design

## Overview

This document describes the design for tracking the complete lifecycle of documents (EPUB/PDF) through the audit, remediation, and re-audit workflow. The system provides full traceability, version control, and artifact management.

## Version History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0 | 2026-01-06 | Claude/AVR | Initial design |

---

## Requirements

### Functional Requirements

1. **Workflow Tracking**: Track the complete history of a document from upload through multiple audit/remediation cycles
2. **File Versioning**: Link original files to remediated versions with clear lineage
3. **Artifact Association**: Associate all artifacts (reports, exports) with specific workflow steps
4. **Manual Edit Tracking**: Record manual edits as workflow steps
5. **Multiple Cycles**: Support multiple audit → remediate → re-audit cycles
6. **Configurable Behavior**: Allow user and system-level configuration for workflow behavior
7. **Archive Support**: Archive workflows instead of deleting for audit history

### Non-Functional Requirements

1. **Performance**: Workflow queries should complete in < 500ms
2. **Scalability**: Support thousands of workflows per tenant
3. **Auditability**: Full history preserved for compliance

---

## Data Model

### Entity Relationship Diagram

```
┌─────────────────┐       ┌─────────────────┐       ┌─────────────────┐
│ WorkflowConfig  │       │ WorkflowSession │       │  WorkflowStep   │
│ (Tenant-level)  │       │                 │       │                 │
├─────────────────┤       ├─────────────────┤       ├─────────────────┤
│ tenantId (PK)   │       │ id (PK)         │──────<│ id (PK)         │
│ autoCreate      │       │ tenantId (FK)   │       │ sessionId (FK)  │
│ maxCycles       │       │ userId (FK)     │       │ stepNumber      │
│ defaultWorkflow │       │ name            │       │ type            │
└─────────────────┘       │ status          │       │ status          │
                          │ originalFileId  │       │ jobId (FK)      │
                          │ currentFileId   │       │ inputFileId     │
                          │ cycleCount      │       │ outputFileId    │
                          │ archived        │       │ summary         │
                          │ createdAt       │       │ notes           │
                          │ updatedAt       │       │ createdBy       │
                          │ archivedAt      │       │ startedAt       │
                          └─────────────────┘       │ completedAt     │
                                   │                └─────────────────┘
                                   │                        │
                                   ▼                        ▼
                          ┌─────────────────┐       ┌─────────────────┐
                          │      File       │       │    Artifact     │
                          ├─────────────────┤       ├─────────────────┤
                          │ id (PK)         │       │ id (PK)         │
                          │ parentId (FK)   │       │ jobId (FK)      │
                          │ workflowId (FK) │       │ stepId (FK)     │
                          │ fileType        │       │ type            │
                          │ version         │       │ name            │
                          │ ...             │       │ data            │
                          └─────────────────┘       └─────────────────┘
```

### Prisma Schema

```prisma
// ============================================
// WORKFLOW CONFIGURATION
// ============================================

model WorkflowConfig {
  id                    String   @id @default(cuid())
  tenantId              String   @unique

  // Workflow creation settings
  autoCreateOnUpload    Boolean  @default(false)  // Auto-create workflow when file uploaded
  autoStartAudit        Boolean  @default(false)  // Auto-start audit after upload

  // Cycle settings
  maxRemediationCycles  Int      @default(5)      // Max audit→remediate cycles allowed
  warnAtCycle           Int      @default(3)      // Show warning after this many cycles

  // Default workflow settings
  defaultWorkflowName   String?                   // Template for workflow names
  requireApproval       Boolean  @default(false)  // Require approval before remediation

  // Retention settings
  archiveAfterDays      Int      @default(365)    // Auto-archive after N days
  deleteArchivedAfter   Int      @default(2555)   // Delete archived after N days (7 years)

  createdAt             DateTime @default(now())
  updatedAt             DateTime @updatedAt

  tenant                Tenant   @relation(fields: [tenantId], references: [id])
}

// ============================================
// WORKFLOW SESSION
// ============================================

model WorkflowSession {
  id                String          @id @default(cuid())
  tenantId          String
  userId            String

  // Identification
  name              String                        // Display name (usually original filename)
  description       String?                       // Optional description

  // Status tracking
  status            WorkflowStatus  @default(CREATED)
  cycleCount        Int             @default(0)   // Number of audit→remediate cycles completed

  // File references
  originalFileId    String                        // First uploaded file
  currentFileId     String                        // Latest version (original or remediated)

  // Archive support
  archived          Boolean         @default(false)
  archivedAt        DateTime?
  archivedBy        String?
  archiveReason     String?

  // Timestamps
  createdAt         DateTime        @default(now())
  updatedAt         DateTime        @updatedAt
  completedAt       DateTime?

  // Relations
  tenant            Tenant          @relation(fields: [tenantId], references: [id])
  user              User            @relation(fields: [userId], references: [id])
  originalFile      File            @relation("OriginalFile", fields: [originalFileId], references: [id])
  currentFile       File            @relation("CurrentFile", fields: [currentFileId], references: [id])
  steps             WorkflowStep[]
  files             File[]          @relation("WorkflowFiles")

  @@index([tenantId])
  @@index([userId])
  @@index([status])
  @@index([archived])
  @@index([createdAt])
}

enum WorkflowStatus {
  CREATED                 // Session created, no audit yet
  AUDITING                // Initial audit in progress
  AUDIT_COMPLETE          // Audit done, issues found, awaiting action
  AUDIT_PASSED            // Audit done, no issues (or all minor)
  REMEDIATING             // Remediation in progress
  REMEDIATION_COMPLETE    // Remediation done, awaiting re-audit
  MANUAL_EDIT_PENDING     // Manual edits requested
  RE_AUDITING             // Re-audit in progress
  COMPLETED               // Workflow finished successfully
  FAILED                  // Workflow failed
  ARCHIVED                // Workflow archived
}

// ============================================
// WORKFLOW STEP
// ============================================

model WorkflowStep {
  id              String        @id @default(cuid())
  sessionId       String

  // Step identification
  stepNumber      Int                             // Sequential step number (1, 2, 3...)
  cycleNumber     Int           @default(1)       // Which audit→remediate cycle this belongs to
  type            StepType
  status          StepStatus    @default(PENDING)

  // Related entities
  jobId           String?                         // Related job (for audit/remediation)
  inputFileId     String?                         // File input to this step
  outputFileId    String?                         // File output from this step (e.g., remediated)

  // Step details
  summary         Json?                           // Quick stats (issues found, fixes applied, etc.)
  notes           String?                         // User notes or system messages
  errorMessage    String?                         // Error details if failed

  // Manual edit tracking
  editType        ManualEditType?                 // Type of manual edit
  editDetails     Json?                           // Details of what was edited

  // Attribution
  createdBy       String                          // User who initiated this step
  approvedBy      String?                         // User who approved (if approval required)

  // Timestamps
  createdAt       DateTime      @default(now())
  startedAt       DateTime?
  completedAt     DateTime?

  // Relations
  session         WorkflowSession @relation(fields: [sessionId], references: [id], onDelete: Cascade)
  job             Job?            @relation(fields: [jobId], references: [id])
  inputFile       File?           @relation("StepInput", fields: [inputFileId], references: [id])
  outputFile      File?           @relation("StepOutput", fields: [outputFileId], references: [id])
  artifacts       Artifact[]

  @@index([sessionId])
  @@index([type])
  @@index([status])
  @@index([cycleNumber])
}

enum StepType {
  UPLOAD              // File uploaded
  AUDIT               // Accessibility audit
  AUTO_REMEDIATION    // Automated fixes applied
  MANUAL_REMEDIATION  // Manual fixes by user
  MANUAL_EDIT         // Direct file edit by user
  REVIEW              // Human review step
  APPROVAL            // Approval step
  RE_AUDIT            // Re-audit after remediation
  EXPORT              // Export/download
  ARCHIVE             // Workflow archived
}

enum StepStatus {
  PENDING       // Not started
  IN_PROGRESS   // Currently running
  COMPLETED     // Successfully completed
  FAILED        // Failed with error
  SKIPPED       // Skipped by user
  CANCELLED     // Cancelled by user
}

enum ManualEditType {
  CONTENT_EDIT      // Text/content changes
  METADATA_EDIT     // Metadata changes
  STRUCTURE_EDIT    // Document structure changes
  IMAGE_EDIT        // Image/alt-text changes
  STYLE_EDIT        // CSS/styling changes
  NAVIGATION_EDIT   // Navigation/TOC changes
  EXTERNAL_EDIT     // Edited outside the system
}

// ============================================
// FILE MODEL UPDATES
// ============================================

model File {
  id                  String    @id @default(cuid())
  tenantId            String

  // Existing fields...
  originalName        String
  filename            String
  mimeType            String
  size                Int
  path                String
  status              FileStatus @default(UPLOADED)

  // NEW: Versioning and lineage
  parentId            String?                     // Reference to parent file (for remediated files)
  fileType            FileType   @default(ORIGINAL)
  version             Int        @default(1)      // Version number within lineage
  versionLabel        String?                     // Human-readable version label (e.g., "v1.2-remediated")

  // NEW: Workflow association
  workflowSessionId   String?                     // Associated workflow session

  // Storage
  storageType         StorageType @default(LOCAL)

  // Timestamps
  createdAt           DateTime  @default(now())
  updatedAt           DateTime  @updatedAt

  // Relations
  tenant              Tenant    @relation(fields: [tenantId], references: [id])
  parent              File?     @relation("FileVersions", fields: [parentId], references: [id])
  children            File[]    @relation("FileVersions")
  workflowSession     WorkflowSession? @relation("WorkflowFiles", fields: [workflowSessionId], references: [id])

  // Workflow relations (as original/current file)
  workflowsAsOriginal WorkflowSession[] @relation("OriginalFile")
  workflowsAsCurrent  WorkflowSession[] @relation("CurrentFile")

  // Step relations
  stepsAsInput        WorkflowStep[] @relation("StepInput")
  stepsAsOutput       WorkflowStep[] @relation("StepOutput")

  artifacts           Artifact[]
  jobs                Job[]

  @@index([tenantId])
  @@index([parentId])
  @@index([workflowSessionId])
  @@index([fileType])
}

enum FileType {
  ORIGINAL      // Originally uploaded file
  REMEDIATED    // Auto-remediated version
  MANUALLY_EDITED // Manually edited version
  EXPORTED      // Exported package
}

enum StorageType {
  LOCAL
  S3
}

// ============================================
// ARTIFACT MODEL UPDATES
// ============================================

model Artifact {
  id          String   @id @default(cuid())

  // Existing relations
  jobId       String
  fileId      String?

  // NEW: Step relation for workflow tracking
  stepId      String?                           // Associated workflow step

  // Artifact details
  type        String                            // audit_result, remediation_plan, comparison_report, etc.
  name        String?                           // Human-readable name
  data        Json                              // Artifact data
  size        Int?                              // Size in bytes

  // Timestamps
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt

  // Relations
  job         Job      @relation(fields: [jobId], references: [id], onDelete: Cascade)
  file        File?    @relation(fields: [fileId], references: [id], onDelete: SetNull)
  step        WorkflowStep? @relation(fields: [stepId], references: [id], onDelete: SetNull)

  @@index([jobId])
  @@index([fileId])
  @@index([stepId])
  @@index([jobId, type])
}
```

---

## Manual Edit Tracking

### How Manual Edits Connect to Lineage

When a user makes manual edits to a file, the system tracks this as follows:

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Manual Edit Workflow                              │
└─────────────────────────────────────────────────────────────────────┘

1. User initiates edit on File v1 (after audit)
   │
   ▼
2. System creates WorkflowStep:
   {
     type: MANUAL_EDIT,
     status: IN_PROGRESS,
     inputFileId: "file_v1",
     editType: CONTENT_EDIT,
     notes: "User editing alt-text for images"
   }
   │
   ▼
3. User makes edits (tracked in editDetails):
   {
     editType: "IMAGE_EDIT",
     editDetails: {
       changes: [
         { file: "chapter1.xhtml", element: "img#fig1", field: "alt", before: "", after: "A bar chart showing..." },
         { file: "chapter2.xhtml", element: "img#fig2", field: "alt", before: "image", after: "Photo of..." }
       ],
       toolUsed: "in-app-editor",
       timeSpent: 1800 // seconds
     }
   }
   │
   ▼
4. User saves edits
   │
   ▼
5. System creates new File version:
   {
     id: "file_v2",
     parentId: "file_v1",
     fileType: MANUALLY_EDITED,
     version: 2,
     versionLabel: "v2-manual-edit"
   }
   │
   ▼
6. System updates WorkflowStep:
   {
     status: COMPLETED,
     outputFileId: "file_v2",
     summary: { imagesEdited: 2, fieldsChanged: 2 }
   }
   │
   ▼
7. System updates WorkflowSession:
   {
     currentFileId: "file_v2"
   }
```

### Manual Edit Types

| Edit Type | Description | Tracking Details |
|-----------|-------------|------------------|
| CONTENT_EDIT | Text/content changes | Changed paragraphs, text corrections |
| METADATA_EDIT | Metadata changes | Title, author, language, accessibility metadata |
| STRUCTURE_EDIT | Document structure | Heading hierarchy, landmarks, reading order |
| IMAGE_EDIT | Image/alt-text | Alt text additions/changes, long descriptions |
| STYLE_EDIT | CSS/styling | Color contrast fixes, font changes |
| NAVIGATION_EDIT | Navigation/TOC | Table of contents, page list, landmarks |
| EXTERNAL_EDIT | Edited outside system | User downloaded, edited externally, re-uploaded |

### External Edit Handling

When a user downloads a file, edits it externally, and re-uploads:

```
1. User downloads File v1
2. User edits in external tool (Calibre, Sigil, etc.)
3. User uploads edited file
4. System detects this is related to existing workflow:
   - Option A: User selects "This is an edited version of [File v1]"
   - Option B: System auto-detects via filename/metadata matching
5. System creates:
   - New File v2 (parentId: v1, fileType: MANUALLY_EDITED)
   - WorkflowStep (type: MANUAL_EDIT, editType: EXTERNAL_EDIT)
6. System prompts: "Run re-audit on edited file?"
```

---

## Configuration Options

### Tenant-Level Configuration

```typescript
interface WorkflowConfig {
  // Workflow Creation
  autoCreateOnUpload: boolean;     // Create workflow automatically when file uploaded
  autoStartAudit: boolean;         // Start audit automatically after upload

  // Cycle Limits
  maxRemediationCycles: number;    // Maximum audit→remediate cycles (default: 5)
  warnAtCycle: number;             // Show warning after N cycles (default: 3)

  // Approval
  requireApproval: boolean;        // Require approval before remediation
  approvalRoles: string[];         // Roles that can approve

  // Retention
  archiveAfterDays: number;        // Auto-archive completed workflows after N days
  deleteArchivedAfterDays: number; // Delete archived workflows after N days
}
```

### Per-File Override

When uploading a file, user can choose:

```typescript
interface UploadOptions {
  createWorkflow: boolean;         // Override tenant default
  startAuditImmediately: boolean;  // Start audit right away
  workflowName?: string;           // Custom workflow name
  description?: string;            // Workflow description
}
```

### UI Configuration Panel

```
┌─────────────────────────────────────────────────────────────────────┐
│ Workflow Settings                                          [Save]   │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ Workflow Creation                                                   │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ [✓] Automatically create workflow when file is uploaded         │ │
│ │ [✓] Automatically start audit after upload                      │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ Remediation Cycles                                                  │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ Maximum cycles allowed: [5    ▼]                                │ │
│ │ Show warning after:     [3    ▼] cycles                         │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ Approval                                                            │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ [ ] Require approval before auto-remediation                    │ │
│ │ Approvers: [Admins ▼] [Managers ▼]                             │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ Retention                                                           │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ Archive completed workflows after: [365  ] days                 │ │
│ │ Delete archived workflows after:   [2555 ] days (7 years)       │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## API Endpoints

### Workflow Configuration

```
GET    /api/v1/workflow-config                    # Get tenant config
PUT    /api/v1/workflow-config                    # Update tenant config
```

### Workflow Sessions

```
# List and Create
GET    /api/v1/workflows                          # List all workflows
POST   /api/v1/workflows                          # Create new workflow manually
POST   /api/v1/workflows/from-file/:fileId        # Create workflow from existing file

# Single Workflow
GET    /api/v1/workflows/:id                      # Get workflow with all steps
GET    /api/v1/workflows/:id/timeline             # Get timeline visualization data
GET    /api/v1/workflows/:id/artifacts            # Get all artifacts
GET    /api/v1/workflows/:id/files                # Get all file versions

# Workflow Actions
POST   /api/v1/workflows/:id/archive              # Archive workflow
POST   /api/v1/workflows/:id/restore              # Restore from archive
DELETE /api/v1/workflows/:id                      # Permanently delete (admin only)
```

### Workflow Steps

```
# Step Operations
POST   /api/v1/workflows/:id/steps/audit          # Start audit step
POST   /api/v1/workflows/:id/steps/remediate      # Start remediation step
POST   /api/v1/workflows/:id/steps/manual-edit    # Record manual edit
POST   /api/v1/workflows/:id/steps/re-audit       # Start re-audit
POST   /api/v1/workflows/:id/steps/export         # Export/download

# Step Details
GET    /api/v1/workflows/:id/steps                # Get all steps
GET    /api/v1/workflows/:id/steps/:stepId        # Get step details
PATCH  /api/v1/workflows/:id/steps/:stepId        # Update step (add notes, etc.)
```

### File Lineage

```
GET    /api/v1/files/:id/lineage                  # Get file's complete lineage
GET    /api/v1/files/:id/versions                 # Get all versions
GET    /api/v1/files/:id/workflow                 # Get associated workflow
POST   /api/v1/files/:id/link-to-workflow/:wfId   # Link orphan file to workflow
```

---

## UI Components

### 1. Workflow Timeline

```
┌─────────────────────────────────────────────────────────────────────┐
│ History_of_Tom_Jones.epub                                           │
│ Workflow Status: ● Remediation Complete (Cycle 1 of 5)              │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ Cycle 1                                                             │
│ ════════════════════════════════════════════════════════════════    │
│                                                                     │
│   ✓ Upload        ✓ Audit         ✓ Auto-Fix      ✓ Manual Edit     │
│   ────●──────────────●───────────────●───────────────●────────      │
│       │              │               │               │              │
│   10:01 AM       10:03 AM        10:15 AM        10:45 AM           │
│                                                                     │
│   ○ Re-Audit      ○ Export                                          │
│   ────○──────────────○────────────────────────────────────────      │
│                                                                     │
├─────────────────────────────────────────────────────────────────────┤
│ [Start Re-Audit]  [Download Current]  [View All Artifacts]          │
└─────────────────────────────────────────────────────────────────────┘
```

### 2. Step Detail Panel

```
┌─────────────────────────────────────────────────────────────────────┐
│ Step 2: Audit                                              ✓ Done   │
├─────────────────────────────────────────────────────────────────────┤
│ Started: Jan 5, 2026 10:03 AM                                       │
│ Completed: Jan 5, 2026 10:05 AM                                     │
│ Duration: 2 minutes                                                 │
│                                                                     │
│ Input File: History_of_Tom_Jones.epub (v1, Original)                │
│                                                                     │
│ Summary:                                                            │
│ ┌─────────────────────────────────────────────────────────────────┐ │
│ │ Total Issues: 12                                                │ │
│ │ ├─ Critical: 2                                                  │ │
│ │ ├─ Serious: 3                                                   │ │
│ │ ├─ Moderate: 4                                                  │ │
│ │ └─ Minor: 3                                                     │ │
│ │                                                                 │ │
│ │ Auto-fixable: 8    Manual Required: 4                           │ │
│ └─────────────────────────────────────────────────────────────────┘ │
│                                                                     │
│ Artifacts:                                                          │
│ • 📊 Accessibility Audit Report         [View] [Download JSON]      │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 3. File Versions Panel

```
┌─────────────────────────────────────────────────────────────────────┐
│ File Versions                                                       │
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ v3 - Manual Edit (Current)                          Jan 5, 10:45 AM │
│     Type: Manually Edited                                           │
│     Changes: 4 images updated                                       │
│     [Download] [View Diff from v2]                                  │
│                                                                     │
│ v2 - Auto-Remediated                                Jan 5, 10:15 AM │
│     Type: Remediated                                                │
│     Fixes: 8 auto-fixes applied                                     │
│     [Download] [View Diff from v1]                                  │
│                                                                     │
│ v1 - Original                                       Jan 5, 10:01 AM │
│     Type: Original                                                  │
│     Size: 977.8 KB                                                  │
│     [Download] [Start New Workflow]                                 │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### 4. Artifacts Panel

```
┌─────────────────────────────────────────────────────────────────────┐
│ All Artifacts                                          [Download All]│
├─────────────────────────────────────────────────────────────────────┤
│                                                                     │
│ Cycle 1                                                             │
│ ─────────────────────────────────────────────────────────────────── │
│ │ Step        │ Artifact                    │ Created    │ Actions │ │
│ ├─────────────┼─────────────────────────────┼────────────┼─────────┤ │
│ │ Audit       │ 📊 Audit Report             │ 10:05 AM   │ [View]  │ │
│ │ Auto-Fix    │ 📋 Remediation Plan         │ 10:15 AM   │ [View]  │ │
│ │ Auto-Fix    │ 📈 Comparison Report        │ 10:15 AM   │ [View]  │ │
│ │ Auto-Fix    │ 📊 Auto-fix Results         │ 10:15 AM   │ [View]  │ │
│ │ Manual Edit │ 📝 Edit Summary             │ 10:45 AM   │ [View]  │ │
│ └─────────────┴─────────────────────────────┴────────────┴─────────┘ │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Implementation Phases

### Phase 1: Database Schema
**Estimated Effort: 1 day**

1. Add WorkflowConfig model
2. Add WorkflowSession model
3. Add WorkflowStep model
4. Update File model with versioning fields
5. Update Artifact model with stepId
6. Create and run migrations

### Phase 2: Core Services
**Estimated Effort: 2-3 days**

1. Create WorkflowConfigService
2. Create WorkflowService
3. Create WorkflowStepService
4. Update FileService for versioning
5. Update existing audit/remediation services to integrate

### Phase 3: API Endpoints
**Estimated Effort: 1-2 days**

1. Workflow config endpoints
2. Workflow CRUD endpoints
3. Workflow step endpoints
4. File lineage endpoints
5. Update existing endpoints for workflow integration

### Phase 4: Frontend - Core Components
**Estimated Effort: 2-3 days**

1. WorkflowTimeline component
2. StepDetailPanel component
3. FileVersionsPanel component
4. ArtifactsPanel component
5. WorkflowConfigSettings page

### Phase 5: Frontend - Integration
**Estimated Effort: 2-3 days**

1. Update Files page with workflow indicators
2. Update upload flow for workflow creation
3. Create Workflow detail page
4. Integrate workflow into audit/remediation flows
5. Add manual edit tracking UI

### Phase 6: Testing & Polish
**Estimated Effort: 1-2 days**

1. Unit tests for services
2. Integration tests for API
3. E2E tests for workflows
4. Performance testing
5. Documentation

**Total Estimated Effort: 9-14 days**

---

## Migration Strategy

### For Existing Data

1. Create migration script to:
   - Create WorkflowSession for each existing File that has associated Jobs
   - Create WorkflowSteps from existing Job data
   - Link existing Artifacts to Steps
   - Set appropriate statuses

2. Run migration in batches to avoid timeout

3. Verify data integrity after migration

### Rollback Plan

1. Keep original columns during migration
2. Add new columns as nullable initially
3. Run migration in transaction where possible
4. Keep backup of pre-migration state

---

## Security Considerations

1. **Tenant Isolation**: All queries must filter by tenantId
2. **Archive Access**: Archived workflows visible but not editable
3. **Permanent Delete**: Restricted to admin roles only
4. **Audit Log**: Log all workflow state changes
5. **File Access**: Ensure file version access respects permissions

---

## Future Enhancements

1. **Workflow Templates**: Predefined workflow sequences
2. **Batch Workflows**: Process multiple files in one workflow
3. **Workflow Sharing**: Share workflow results with external users
4. **API Webhooks**: Notify external systems of workflow events
5. **Analytics Dashboard**: Workflow performance metrics
6. **AI Suggestions**: Recommend next steps based on audit results

---

## Appendix: Example Workflow JSON

```json
{
  "id": "ws_abc123",
  "name": "History_of_Tom_Jones.epub",
  "status": "REMEDIATION_COMPLETE",
  "cycleCount": 1,
  "originalFile": {
    "id": "file_001",
    "name": "History_of_Tom_Jones.epub",
    "version": 1,
    "fileType": "ORIGINAL"
  },
  "currentFile": {
    "id": "file_003",
    "name": "History_of_Tom_Jones.epub",
    "version": 3,
    "fileType": "MANUALLY_EDITED"
  },
  "steps": [
    {
      "stepNumber": 1,
      "type": "UPLOAD",
      "status": "COMPLETED",
      "outputFileId": "file_001",
      "completedAt": "2026-01-05T10:01:00Z"
    },
    {
      "stepNumber": 2,
      "type": "AUDIT",
      "status": "COMPLETED",
      "jobId": "job_audit_001",
      "inputFileId": "file_001",
      "summary": { "totalIssues": 12, "critical": 2, "autoFixable": 8 },
      "artifacts": ["artifact_audit_001"],
      "completedAt": "2026-01-05T10:05:00Z"
    },
    {
      "stepNumber": 3,
      "type": "AUTO_REMEDIATION",
      "status": "COMPLETED",
      "jobId": "job_remediate_001",
      "inputFileId": "file_001",
      "outputFileId": "file_002",
      "summary": { "issuesFixed": 8, "issuesFailed": 0 },
      "artifacts": ["artifact_plan_001", "artifact_comparison_001"],
      "completedAt": "2026-01-05T10:15:00Z"
    },
    {
      "stepNumber": 4,
      "type": "MANUAL_EDIT",
      "status": "COMPLETED",
      "inputFileId": "file_002",
      "outputFileId": "file_003",
      "editType": "IMAGE_EDIT",
      "editDetails": { "imagesEdited": 4 },
      "summary": { "changesCount": 4 },
      "completedAt": "2026-01-05T10:45:00Z"
    }
  ],
  "files": [
    { "id": "file_001", "version": 1, "fileType": "ORIGINAL" },
    { "id": "file_002", "version": 2, "fileType": "REMEDIATED", "parentId": "file_001" },
    { "id": "file_003", "version": 3, "fileType": "MANUALLY_EDITED", "parentId": "file_002" }
  ],
  "createdAt": "2026-01-05T10:01:00Z",
  "updatedAt": "2026-01-05T10:45:00Z"
}
```
