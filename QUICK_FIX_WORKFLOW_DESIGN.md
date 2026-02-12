# Quick-Fix Workflow Design Document

## Overview

Quick-fix issues are accessibility problems that **require user input** but can be fixed through a **guided workflow**. Out of 1,693 total issues in the PDF, **796 (47%)** are quick-fix issues.

## Issue Types & Priority

### High Priority (Most Common)
1. **Alt Text for Images** (~400-500 issues)
   - User provides descriptive text for each image
   - Can use AI suggestions
   - Preview image while adding alt text

2. **Table Headers** (~100-200 issues)
   - User marks which cells are headers
   - Specify row/column/both
   - Visual table preview

3. **Form Field Labels** (~50-100 issues)
   - User provides accessible labels
   - Associate with form fields
   - Preview form structure

4. **Link Text** (~50-100 issues)
   - User provides descriptive link text
   - Replace generic "click here" links
   - Show link destination

### Medium Priority
5. **Heading Structure** (~50 issues)
   - Fix heading hierarchy
   - User adjusts heading levels

6. **List Structure** (~20-30 issues)
   - Mark proper list items
   - Distinguish ordered/unordered

## UI/UX Design

### Workflow Entry Points

1. **From Remediation Plan Page**
   - "Start Quick Fix" button in Quick-fix section
   - Shows: "796 issues require your input"

2. **From Individual Issue**
   - "Fix This" button on specific issue
   - Jumps directly to that issue in workflow

### Workflow Layout

```
┌─────────────────────────────────────────────────────┐
│ Quick-Fix Workflow                    [X] Exit      │
├─────────────────────────────────────────────────────┤
│ Progress: 45/796 (5%)  ████░░░░░░░░░░░░░░░░░       │
├─────────────────────────────────────────────────────┤
│                                                      │
│  ┌──────────────────┐  ┌──────────────────────────┐│
│  │                  │  │ Issue #45 of 796          ││
│  │   PDF Preview    │  │                           ││
│  │   (Page 23)      │  │ Image Missing Alt Text   ││
│  │                  │  │                           ││
│  │  [Image shown    │  │ Location: Page 23, Img 1 ││
│  │   in context]    │  │                           ││
│  │                  │  │ Provide alt text:         ││
│  │                  │  │ ┌────────────────────────┐││
│  │                  │  │ │                        │││
│  │                  │  │ │                        │││
│  │                  │  │ └────────────────────────┘││
│  │                  │  │                           ││
│  │                  │  │ [✨ AI Suggest] [Skip]    ││
│  └──────────────────┘  └──────────────────────────┘│
│                                                      │
│  [⬅️ Previous]  [Skip]  [Next ➡️]  [Save & Exit]   │
└─────────────────────────────────────────────────────┘
```

### Key Features

1. **Progress Tracking**
   - Visual progress bar
   - Count: X of Y completed
   - Percentage display

2. **Context Preview**
   - Show PDF page with issue highlighted
   - Zoom controls
   - Navigate to exact location

3. **Input Forms**
   - Type-specific forms (alt text, table headers, etc.)
   - Validation and character limits
   - AI suggestions where applicable

4. **Navigation**
   - Previous/Next buttons
   - Skip button (mark for later)
   - Jump to specific issue
   - Save & Exit (resume later)

5. **Bulk Operations**
   - "Apply to all similar" option
   - Batch edit for repeated patterns
   - Templates for common text

## Backend API Design

### New Endpoints

```typescript
// Start/Resume Quick-Fix Session
POST /api/v1/pdf/:jobId/remediation/quick-fix/start
Response: {
  sessionId: string;
  totalIssues: number;
  completed: number;
  currentIssue: QuickFixIssue;
}

// Get Next Issue
GET /api/v1/pdf/:jobId/remediation/quick-fix/next?sessionId=xxx
Response: QuickFixIssue

// Submit Fix for Current Issue
POST /api/v1/pdf/:jobId/remediation/quick-fix/submit
Body: {
  sessionId: string;
  taskId: string;
  fixData: Record<string, any>;
}

// Skip Issue
POST /api/v1/pdf/:jobId/remediation/quick-fix/skip
Body: {
  sessionId: string;
  taskId: string;
}

// Save & Exit Session
POST /api/v1/pdf/:jobId/remediation/quick-fix/save
Body: {
  sessionId: string;
}

// Apply Fixes to PDF
POST /api/v1/pdf/:jobId/remediation/quick-fix/apply
Body: {
  sessionId: string;
}
Response: {
  success: boolean;
  appliedCount: number;
  remediatedFileUrl: string;
}
```

### Data Models

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
  createdAt: Date;
  updatedAt: Date;
}

interface QuickFixIssue {
  taskId: string;
  issueCode: string;
  issueType: 'alt-text' | 'table-header' | 'form-label' | 'link-text' | 'heading';
  description: string;
  location: string;
  pageNumber: number;
  element?: string; // Element ID in PDF
  context?: any; // Additional context (image data, table structure, etc.)
  suggestions?: string[]; // AI-generated suggestions
}

interface QuickFixData {
  taskId: string;
  issueType: string;
  fixData: Record<string, any>;
  appliedAt?: Date;
}
```

## Frontend Components

### 1. QuickFixWorkflow (Main Container)
- Manages workflow state
- Navigation logic
- Progress tracking

### 2. QuickFixIssueCard
- Type-specific issue display
- Input forms
- Validation

### 3. PDFPreview
- Renders PDF page
- Highlights issue location
- Zoom/pan controls

### 4. QuickFixProgress
- Progress bar
- Statistics
- Save/Exit button

### 5. Type-Specific Forms

#### AltTextForm
```tsx
<AltTextForm
  image={imageData}
  onSubmit={(altText) => submitFix({ altText })}
  onSuggest={() => getAISuggestion()}
/>
```

#### TableHeaderForm
```tsx
<TableHeaderForm
  table={tableStructure}
  onSubmit={(headers) => submitFix({ headers })}
/>
```

#### FormLabelForm
```tsx
<FormLabelForm
  field={fieldData}
  onSubmit={(label) => submitFix({ label })}
/>
```

#### LinkTextForm
```tsx
<LinkTextForm
  link={linkData}
  onSubmit={(linkText) => submitFix({ linkText })}
/>
```

## Implementation Plan

### Phase 1: MVP (Core Workflow) - Week 1

**Backend:**
1. ✅ Quick-fix session management
2. ✅ Session CRUD operations
3. ✅ Progress tracking
4. ✅ Data persistence

**Frontend:**
1. ✅ QuickFixWorkflow container
2. ✅ Basic navigation (Next/Previous/Skip)
3. ✅ Progress bar
4. ✅ Alt-text form (most common issue type)
5. ✅ Basic PDF preview

**Deliverable:** Working workflow for alt-text issues only

### Phase 2: Additional Issue Types - Week 2

1. ✅ Table header form
2. ✅ Form label form
3. ✅ Link text form
4. ✅ Type detection and routing

**Deliverable:** All major issue types supported

### Phase 3: Advanced Features - Week 3

1. ✅ AI suggestions (integrate with Gemini)
2. ✅ Bulk operations
3. ✅ Templates
4. ✅ Enhanced PDF preview (zoom, highlight)
5. ✅ Jump to specific issue

**Deliverable:** Complete workflow with AI assistance

### Phase 4: Apply Fixes - Week 4

1. ✅ PDF modification engine for quick-fix types
2. ✅ Apply fixes to PDF
3. ✅ Verification and testing
4. ✅ Error handling and rollback

**Deliverable:** End-to-end working system

## Technical Challenges

### 1. PDF Element Identification
- Need reliable way to locate and identify elements in PDF
- Use PDF structure tree and element IDs
- May need OCR for images

### 2. PDF Modification
- Adding alt text to images requires PDF structure manipulation
- Table header modification is complex
- May need external tools (qpdf, mutool)

### 3. State Management
- Session persistence across browser refreshes
- Conflict resolution if multiple sessions
- Undo/redo functionality

### 4. Performance
- Loading 796 issues at once may be slow
- Lazy loading and pagination
- Caching PDF pages

### 5. AI Integration
- Cost considerations for AI suggestions
- Rate limiting
- Fallback if AI unavailable

## Success Metrics

1. **Completion Rate**: % of users who complete workflow
2. **Time to Complete**: Average time per issue
3. **Skip Rate**: % of issues skipped
4. **Fix Quality**: % of fixes that pass validation
5. **User Satisfaction**: Feedback scores

## Future Enhancements

1. **Collaborative Workflow**: Multiple users working on same PDF
2. **Mobile Support**: Tablet-optimized interface
3. **Keyboard Shortcuts**: Power user features
4. **Custom Templates**: User-defined fix templates
5. **Batch Processing**: Apply fixes to multiple PDFs
6. **Analytics Dashboard**: Track fix patterns and insights

---

## Next Steps

1. ✅ Create session management backend
2. ✅ Build workflow UI shell
3. ✅ Implement alt-text form
4. ✅ Test with sample PDF
5. ✅ Iterate based on feedback
