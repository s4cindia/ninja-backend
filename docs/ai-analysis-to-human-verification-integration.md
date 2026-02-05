# AI Analysis to Human Verification Integration: Gap Analysis & Design

**Document Version:** 1.0
**Last Updated:** 2026-02-05
**Status:** 📋 Requirements & Design

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Current State Analysis](#current-state-analysis)
3. [Desired State (Post-AI Analysis Integration)](#desired-state-post-ai-analysis-integration)
4. [Gap Analysis](#gap-analysis)
5. [Integration Flow Design](#integration-flow-design)
6. [Requirements](#requirements)
7. [Technical Design](#technical-design)
8. [UI/UX Design](#uiux-design)
9. [Implementation Plan](#implementation-plan)
10. [Success Metrics](#success-metrics)

---

## Executive Summary

### Current State
The Human Verification system exists as a **separate workflow** from ACR Analysis, with:
- Basic verification queue (sorted by severity)
- Manual verification submission
- Audit log tracking
- Finalization blocking logic

### Problem
Users must **manually navigate** from ACR results → Human Verification without:
- Context about WHY criteria need verification (confidence levels)
- Prioritized guidance from AI Analysis Report
- Seamless transition with pre-loaded action items
- AI-generated testing recommendations

### Proposed Solution
Create a **seamless integration** where:
1. AI Analysis Report becomes the **entry point** for manual testing
2. "Start Manual Testing" button flows directly into Human Verification with context
3. Verification queue is **pre-populated** and **prioritized** based on AI Analysis
4. AI insights are embedded in verification interface
5. Progress tracked in real-time, visible in AI Analysis Report

### Impact
- **50% reduction** in time to start manual testing
- **30% improvement** in verification completion rates
- **Clear prioritization** based on risk and confidence
- **Guided workflow** reduces confusion for first-time testers

---

## Current State Analysis

### 1. Human Verification Service

**File:** `src/services/acr/human-verification.service.ts`

**Capabilities:**
- ✅ Queue initialization with criteria IDs
- ✅ Sorted by severity (critical → serious → moderate → minor)
- ✅ Secondary sort by confidence level (manual → low → medium → high)
- ✅ Verification submission (individual & bulk)
- ✅ Audit log tracking
- ✅ Finalization blocking (checks critical/serious items verified)
- ✅ Filter by severity, confidence, status
- ✅ Persist to job output (in-memory + database backup)

**Data Model:**
```typescript
interface VerificationQueueItem {
  id: string;
  criterionId: string;              // e.g., "1.1.1"
  wcagCriterion: string;            // e.g., "Non-text Content"
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  confidenceLevel: 'HIGH' | 'MEDIUM' | 'LOW' | 'MANUAL_REQUIRED';
  automatedResult: string;          // 'pass', 'fail', 'pending'
  status: VerificationStatus;       // 'PENDING', 'VERIFIED_PASS', etc.
  verificationHistory: VerificationRecord[];
  relatedIssues?: RelatedIssue[];   // Remaining issues
  fixedIssues?: RelatedIssue[];     // Remediated issues
}
```

**Workflow:**
1. Queue initialized with criteria IDs
2. Items enriched with ACR analysis issues
3. User verifies items one-by-one or in bulk
4. Audit log records all changes
5. Finalization check ensures critical items verified

**Limitations:**
- ❌ No direct link from ACR results page
- ❌ No AI-generated insights in verification UI
- ❌ No task-specific testing guidance
- ❌ No time estimates per criterion
- ❌ No progress visualization
- ❌ No integration with AI Analysis Report
- ❌ Generic "verification methods" dropdown (not criterion-specific)

---

### 2. AI Analysis Report (Proposed)

**File:** `docs/ai-analysis-report-feature-spec.md`

**Capabilities:**
- ✅ Comprehensive analysis with 6 sections
- ✅ Visual charts and prioritization
- ✅ AI-generated insights (Gemini)
- ✅ Detailed action plan with time estimates
- ✅ Category-specific explanations
- ✅ Export capabilities (PDF, CSV, JSON)

**Current State:**
- ⚠️ **Not yet integrated** with Human Verification
- ⚠️ Action items are **informational only** (no direct workflow)
- ⚠️ No way to "Start Manual Testing" from report
- ⚠️ No progress tracking visible in report

---

### 3. Current User Journey

```text
┌─────────────────────────────────────────────────────┐
│ 1. User completes ACR analysis                      │
│    └─> Sees categorized results                     │
│    └─> 7 criteria marked "Manual Review Required"   │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│ 2. User confused about next steps                   │
│    └─> What does "Manual Review" mean?              │
│    └─> How do I test these criteria?                │
│    └─> Where do I record results?                   │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│ 3. User manually navigates to Human Verification    │
│    └─> No clear button/link                         │
│    └─> Must remember job ID                         │
│    └─> Arrives at unfamiliar verification queue     │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│ 4. User attempts verification without guidance      │
│    └─> Generic verification form                    │
│    └─> No testing instructions                      │
│    └─> Unclear which tools to use                   │
│    └─> No time estimates                            │
└─────────────────────────────────────────────────────┘
```

**Pain Points:**
1. **Disconnected workflows** - No clear path from analysis → verification
2. **Lost context** - AI insights not carried forward
3. **No guidance** - Users don't know HOW to test
4. **Poor prioritization** - Queue is sorted but rationale unclear
5. **No progress visibility** - Can't see completion status in context

---

## Desired State (Post-AI Analysis Integration)

### 1. Seamless User Journey

```text
┌─────────────────────────────────────────────────────┐
│ 1. User completes ACR analysis                      │
│    └─> Sees categorized results with confidence     │
│    └─> [📊 View AI Analysis Report] button visible  │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│ 2. User clicks to view AI Analysis Report           │
│    └─> Opens in new tab                             │
│    └─> Shows comprehensive analysis                 │
│    └─> AI insights highlight priorities             │
│    └─> Clear action plan with time estimates        │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│ 3. User sees "📋 Start Manual Testing" button       │
│    └─> Located in Action Plan section               │
│    └─> Shows: "7 criteria (45-60 min estimated)"    │
│    └─> Click initiates verification workflow        │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│ 4. Human Verification opens with context            │
│    └─> Queue pre-loaded with 7 manual criteria      │
│    └─> AI insights visible for each criterion       │
│    └─> Step-by-step testing guide per criterion     │
│    └─> Time estimate per task                       │
│    └─> Recommended tools listed                     │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│ 5. User completes verification with guidance        │
│    └─> Follows AI-generated testing steps           │
│    └─> Uses recommended tools (NVDA, keyboard)      │
│    └─> Records pass/fail with notes                 │
│    └─> Progress bar shows completion (3/7)          │
└─────────────────────────────────────────────────────┘
                        ↓
┌─────────────────────────────────────────────────────┐
│ 6. User returns to AI Analysis Report               │
│    └─> Progress visible in Action Plan section      │
│    └─> Completed items marked with ✓                │
│    └─> Remaining time estimate updates              │
│    └─> Can export report with verification results  │
└─────────────────────────────────────────────────────┘
```

**Key Improvements:**
1. **Clear entry point** - Prominent button in AI Analysis Report
2. **Contextual flow** - AI insights carry forward to verification
3. **Guided testing** - Step-by-step instructions per criterion
4. **Progress tracking** - Visible in both interfaces
5. **Bi-directional sync** - Changes reflected in AI Report

---

## Gap Analysis

### Gap 1: No Direct Link from AI Analysis Report to Human Verification
**Current:** AI Analysis Report is informational only
**Needed:** "Start Manual Testing" button that initializes verification workflow

**Impact:** High - Users don't know how to proceed after viewing report

---

### Gap 2: AI Insights Not Available in Verification Interface
**Current:** Verification queue shows basic criterion info only
**Needed:** Each queue item should show:
- AI-generated priority reasoning
- Specific issues detected (e.g., "37 images with formulaic alt text")
- Risk assessment
- Estimated time

**Impact:** High - Users lack context for prioritization and testing

---

### Gap 3: No Criterion-Specific Testing Guidance
**Current:** Generic verification form with free-text notes
**Needed:**
- Step-by-step testing checklist per criterion
- Recommended tools (e.g., NVDA for 1.1.1, keyboard-only for 2.1.1)
- Links to WCAG guidance and tutorials
- Example test cases

**Impact:** Critical - Users don't know HOW to test properly

---

### Gap 4: No Time Estimates for Individual Criteria
**Current:** Queue shows all items equally
**Needed:**
- Time estimate per criterion (e.g., "15-20 min")
- Total remaining time
- Time spent tracking

**Impact:** Medium - Users can't plan testing sessions effectively

---

### Gap 5: No Progress Tracking in AI Analysis Report
**Current:** AI Report is static after generation
**Needed:**
- Live progress indicators (3/7 completed)
- Checkboxes in action plan that reflect verification status
- Visual progress bar
- "Last updated" timestamp

**Impact:** High - Users have to navigate between interfaces to check progress

---

### Gap 6: No AI-Powered Prioritization Explanation
**Current:** Queue sorted by severity + confidence, but not explained
**Needed:**
- Visual priority badges (CRITICAL, HIGH, MEDIUM)
- Explanation of why item is prioritized
- Risk score based on AI analysis

**Impact:** Medium - Users may not understand why certain items are first

---

### Gap 7: Generic Verification Methods List
**Current:** Dropdown with 11 generic methods (NVDA, JAWS, etc.)
**Needed:**
- Criterion-specific recommended methods
- Pre-selected based on criterion type
- Links to download/install tools
- Tutorial videos embedded

**Impact:** Medium - Users waste time figuring out which tool to use

---

### Gap 8: No Guided Testing Workflow
**Current:** Single form: Status + Method + Notes
**Needed:**
- Multi-step wizard per criterion
- Interactive checklist (check off test steps)
- Contextual help at each step
- Screenshot upload for evidence
- Pass/Fail decision support

**Impact:** Critical - Users don't know what constitutes proper verification

---

### Gap 9: No Integration with AI Report Export
**Current:** PDF export of AI Report doesn't include verification results
**Needed:**
- Verification status in exported reports
- Audit log summary in PDF
- "Verified By" and "Verified At" metadata
- Before/After comparison

**Impact:** Medium - Reports don't reflect actual testing completion

---

### Gap 10: No Notification/Reminder System
**Current:** Silent workflow
**Needed:**
- Reminder after X days if verification incomplete
- Team notifications when verification completed
- Summary email when all items verified

**Impact:** Low - Nice-to-have for team workflows

---

## Integration Flow Design

### Flow 1: Initiating Manual Testing from AI Analysis Report

```typescript
// User Journey: AI Analysis Report → Human Verification

1. User views AI Analysis Report at /acr/reports/:jobId/analysis
2. Scrolls to "Section 4: Action Plan"
3. Sees:
   ┌────────────────────────────────────────────────────┐
   │ Phase 1: Critical Manual Testing                   │
   │ ⚠️ 7 criteria require mandatory verification       │
   │ ⏱️ Estimated time: 45-60 minutes                   │
   │                                                    │
   │ [📋 Start Manual Testing]                          │
   │                                                    │
   │ What happens next:                                 │
   │ • Opens Human Verification interface               │
   │ • Queue pre-loaded with 7 manual criteria          │
   │ • AI insights and testing guides included          │
   │ • Your progress saved automatically                │
   └────────────────────────────────────────────────────┘

4. User clicks [Start Manual Testing]

5. Frontend calls: POST /api/v1/verification/:jobId/init-from-report
   Body: {
     criteriaIds: ['1.1.1', '1.3.1', '2.1.1', ...],
     aiInsights: { /* Gemini insights from report */ },
     reportId: 'report-123'
   }

6. Backend:
   a. Initializes verification queue with criteria
   b. Enriches each item with AI insights
   c. Generates criterion-specific testing guides
   d. Calculates time estimates
   e. Returns verification session ID

7. Frontend redirects to: /verification/:jobId?session=:sessionId
   Query params preserve context:
   - fromReport=true
   - reportId=report-123
   - autoStart=true

8. Human Verification page loads with:
   - "Initiated from AI Analysis Report" banner
   - [← Back to Report] button
   - Pre-loaded queue (no manual search needed)
   - AI insights visible per item
```

---

### Flow 2: Enriching Verification Queue with AI Context

```typescript
// When verification queue is loaded:

1. Backend fetches ACR analysis results
2. For each criterion in queue:

   // Current data
   {
     criterionId: '1.1.1',
     wcagCriterion: 'Non-text Content',
     severity: 'critical',
     confidenceLevel: 'MANUAL_REQUIRED',
     status: 'PENDING'
   }

   // Enhanced with AI context
   {
     criterionId: '1.1.1',
     wcagCriterion: 'Non-text Content',
     severity: 'critical',
     confidenceLevel: 'MANUAL_REQUIRED',
     status: 'PENDING',

     // NEW: AI-generated context
     aiContext: {
       priority: 'CRITICAL',
       priorityReason: 'High volume (37 images) with formulaic alt text patterns',
       estimatedTime: '20 minutes',
       riskScore: 85, // 0-100
       detectedIssues: [
         'Alt text appears auto-generated (e.g., "image001.jpg")',
         'No descriptive context in 23/37 images',
         'Decorative images may lack empty alt attributes'
       ],
       recommendations: [
         'Use screen reader to verify alt text meaningfulness',
         'Pay special attention to images in critical workflows',
         'Ensure decorative images have alt=""'
       ]
     },

     // NEW: Testing guide
     testingGuide: {
       steps: [
         {
           order: 1,
           instruction: 'Open content with NVDA screen reader',
           helpText: 'Press Ctrl+Alt+N to start NVDA',
           helpLink: 'https://...',
           estimatedTime: '2 min'
         },
         {
           order: 2,
           instruction: 'Navigate to each image using "G" key',
           helpText: 'NVDA will read the alt text for each image',
           estimatedTime: '10 min'
         },
         {
           order: 3,
           instruction: 'Verify alt text conveys equivalent information',
           helpText: 'Ask: Does the alt text communicate the same message as the image?',
           estimatedTime: '5 min'
         },
         {
           order: 4,
           instruction: 'Check decorative images have empty alt',
           helpText: 'Decorative images should have alt="" (empty string)',
           estimatedTime: '3 min'
         }
       ],
       tools: [
         {
           name: 'NVDA Screen Reader',
           type: 'screen-reader',
           downloadUrl: 'https://www.nvaccess.org/',
           tutorialUrl: 'https://...',
           isRecommended: true
         },
         {
           name: 'JAWS',
           type: 'screen-reader',
           downloadUrl: 'https://www.freedomscientific.com/products/software/jaws/',
           tutorialUrl: 'https://...',
           isRecommended: false
         }
       ],
       resources: [
         {
           title: 'WCAG 1.1.1 Quick Reference',
           url: 'https://www.w3.org/WAI/WCAG21/quickref/#non-text-content',
           type: 'documentation'
         },
         {
           title: 'How to Write Alt Text (Video)',
           url: 'https://...',
           type: 'tutorial',
           duration: '5 min'
         }
       ]
     },

     // NEW: Pass/Fail criteria
     passCriteria: [
       'All non-decorative images have meaningful alt text',
       'Alt text conveys equivalent information to visual content',
       'Decorative images have empty alt attribute (alt="")',
       'Complex images have detailed descriptions or long descriptions'
     ],

     // Existing fields
     relatedIssues: [...],
     fixedIssues: [...]
   }

3. Frontend displays enhanced queue with:
   - Priority badges
   - Time estimates
   - Risk indicators
   - Expandable testing guides
   - AI insights highlighted
```

---

### Flow 3: Guided Verification Workflow

```typescript
// When user clicks "Verify" on a criterion:

1. Opens verification wizard/modal
2. Shows multi-step interface:

   ┌─────────────────────────────────────────────────────┐
   │ Verify: 1.1.1 Non-text Content                     │
   ├─────────────────────────────────────────────────────┤
   │                                                     │
   │ Step 1 of 4: Open Screen Reader                    │
   │                                                     │
   │ Instruction:                                        │
   │ Open content with NVDA screen reader               │
   │                                                     │
   │ ℹ️ Help: Press Ctrl+Alt+N to start NVDA            │
   │                                                     │
   │ 🔗 Need NVDA? [Download Here]                      │
   │ 📹 [Watch Tutorial: Using NVDA for Alt Text]       │
   │                                                     │
   │ ☐ I've completed this step                         │
   │                                                     │
   │ [Next Step →]                                       │
   └─────────────────────────────────────────────────────┘

3. User checks off each step
4. Final step shows pass/fail decision:

   ┌─────────────────────────────────────────────────────┐
   │ Step 4 of 4: Verification Decision                  │
   │                                                     │
   │ Based on your testing, does this criterion pass?   │
   │                                                     │
   │ Pass Criteria:                                      │
   │ ☐ All non-decorative images have meaningful alt    │
   │ ☐ Alt text conveys equivalent information          │
   │ ☐ Decorative images have empty alt (alt="")        │
   │ ☐ Complex images have detailed descriptions        │
   │                                                     │
   │ Result:                                             │
   │ ○ Pass - All criteria met                          │
   │ ○ Fail - Issues remain                             │
   │ ○ Partial - Some issues fixed                      │
   │                                                     │
   │ Testing Method: [NVDA 2024.1 ▼]                    │
   │                                                     │
   │ Notes:                                              │
   │ ┌─────────────────────────────────────────────┐   │
   │ │ 35/37 images have meaningful alt text.      │   │
   │ │ 2 images still using filenames as alt.      │   │
   │ │ All decorative images properly marked.      │   │
   │ └─────────────────────────────────────────────┘   │
   │                                                     │
   │ [Submit Verification]                               │
   └─────────────────────────────────────────────────────┘

5. Submission creates verification record with:
   - Detailed step completion data
   - Pass criteria checkboxes state
   - Time spent (calculated from step start times)
   - Testing method
   - Notes
```

---

### Flow 4: Progress Sync Between AI Report and Verification

```typescript
// Real-time progress updates:

1. User completes verification in Human Verification interface
2. Frontend calls: POST /api/v1/verification/:itemId/submit
3. Backend updates:
   - Verification queue item status
   - Audit log with new record
   - Job output persistence
   - **NEW:** Triggers event: 'verification.completed'

4. Event handler updates AI Report cache:
   - Increments completedCount
   - Updates remaining time estimate
   - Recalculates risk score
   - Generates updated action plan

5. If user has AI Report open in another tab:
   - WebSocket/SSE notification sent
   - Frontend updates progress bar
   - Action plan checkboxes update
   - Toast notification: "1.1.1 verified ✓"

6. If user returns to AI Report later:
   - Report regenerated with latest data
   - Verification status reflected in all sections:
     * Executive Summary shows progress
     * Action Plan items marked complete
     * Detailed Analysis shows "Verified Pass" badges
     * Export includes verification results
```

---

### Flow 5: Returning to AI Report from Verification

```typescript
// User completes verification and wants to see report:

1. Verification interface shows:
   ┌─────────────────────────────────────────────────────┐
   │ Progress: 7/7 criteria verified ✓                   │
   │                                                     │
   │ All critical manual testing complete!               │
   │                                                     │
   │ [← Back to AI Analysis Report]                      │
   │ [📄 Export Final Report with Verification Results]  │
   │ [✅ Finalize ACR]                                   │
   └─────────────────────────────────────────────────────┘

2. User clicks "Back to AI Analysis Report"
3. Frontend navigates to: /acr/reports/:jobId/analysis?verified=true
4. AI Report loads with updated content:

   Executive Summary:
   - "All 7 manual criteria verified ✓"
   - Verification completion date/time
   - "Verified by: John Doe"

   Action Plan:
   - All checkboxes marked complete
   - Green success message
   - "Export final report" button highlighted

   Detailed Analysis:
   - Each manual criterion shows "✓ Verified Pass"
   - Verification notes visible
   - Testing method recorded

5. PDF export includes:
   - Verification status per criterion
   - Audit log summary
   - "Verified by" attestation
   - Completion timestamp
```

---

## Requirements

### Functional Requirements

#### FR-1: AI Report to Verification Integration
- **FR-1.1:** AI Analysis Report shall display a "Start Manual Testing" button in the Action Plan section
- **FR-1.2:** Button shall show count of items requiring verification and estimated time
- **FR-1.3:** Clicking button shall initialize Human Verification queue with context
- **FR-1.4:** User shall be redirected to Human Verification interface
- **FR-1.5:** "Back to Report" link shall be visible in verification interface

#### FR-2: Enhanced Verification Queue
- **FR-2.1:** Each queue item shall display AI-generated priority level (CRITICAL/HIGH/MEDIUM)
- **FR-2.2:** Each item shall show priority reasoning from AI analysis
- **FR-2.3:** Each item shall display estimated time to verify
- **FR-2.4:** Each item shall show risk score (0-100)
- **FR-2.5:** Each item shall list specific detected issues from AI analysis
- **FR-2.6:** Each item shall display AI-generated recommendations

#### FR-3: Criterion-Specific Testing Guides
- **FR-3.1:** Each criterion shall have a step-by-step testing guide
- **FR-3.2:** Each step shall include instruction text, help text, and time estimate
- **FR-3.3:** Each guide shall list recommended tools with download links
- **FR-3.4:** Each guide shall include links to WCAG documentation and tutorials
- **FR-3.5:** Each guide shall define clear pass criteria as checkboxes

#### FR-4: Guided Verification Workflow
- **FR-4.1:** Verification shall use a multi-step wizard interface
- **FR-4.2:** User shall check off each testing step as completed
- **FR-4.3:** Final step shall present pass/fail decision with criteria checkboxes
- **FR-4.4:** User shall select testing method from criterion-specific list
- **FR-4.5:** User shall enter notes about their findings
- **FR-4.6:** System shall track time spent per criterion
- **FR-4.7:** User shall be able to upload screenshots as evidence (optional)

#### FR-5: Progress Tracking
- **FR-5.1:** Verification interface shall show overall progress (X/Y completed)
- **FR-5.2:** Progress bar shall update in real-time as items are verified
- **FR-5.3:** Estimated remaining time shall recalculate after each completion
- **FR-5.4:** AI Analysis Report shall reflect verification progress when reopened
- **FR-5.5:** Action plan items in report shall show checkmarks when verified

#### FR-6: Real-Time Synchronization
- **FR-6.1:** When verification completed, AI Report cache shall be updated
- **FR-6.2:** If AI Report is open, progress shall update via WebSocket/SSE
- **FR-6.3:** Toast notification shall appear when verification completed
- **FR-6.4:** Report regenerated on reload shall include latest verification status

#### FR-7: Report Export with Verification
- **FR-7.1:** PDF export shall include verification status per criterion
- **FR-7.2:** Export shall show "Verified by" and "Verified at" metadata
- **FR-7.3:** Export shall include audit log summary
- **FR-7.4:** Export shall include verification notes
- **FR-7.5:** Export shall display completion attestation

#### FR-8: Bulk Operations
- **FR-8.1:** User shall be able to verify multiple criteria with same result
- **FR-8.2:** Bulk verification shall show confirmation with item count
- **FR-8.3:** Bulk operation shall record individual verification records per item
- **FR-8.4:** Bulk verification shall respect criterion-specific testing guides

---

### Non-Functional Requirements

#### NFR-1: Performance
- **NFR-1.1:** AI Report generation shall complete within 3 seconds
- **NFR-1.2:** Verification queue initialization shall complete within 1 second
- **NFR-1.3:** Progress updates shall sync within 500ms
- **NFR-1.4:** Report regeneration with verification data shall complete within 2 seconds

#### NFR-2: Usability
- **NFR-2.1:** Workflow transitions shall be intuitive and require ≤1 click
- **NFR-2.2:** Testing guides shall be written at 8th-grade reading level
- **NFR-2.3:** Help text shall be contextual and action-oriented
- **NFR-2.4:** Interface shall work on mobile devices (responsive)

#### NFR-3: Accessibility
- **NFR-3.1:** All interfaces shall meet WCAG 2.1 AA standards
- **NFR-3.2:** Keyboard navigation shall be fully supported
- **NFR-3.3:** Screen readers shall announce progress updates
- **NFR-3.4:** Focus management shall follow logical order

#### NFR-4: Reliability
- **NFR-4.1:** Verification submissions shall persist immediately
- **NFR-4.2:** Progress shall not be lost if user navigates away
- **NFR-4.3:** System shall recover gracefully from API failures
- **NFR-4.4:** Audit log shall be immutable and complete

#### NFR-5: Scalability
- **NFR-5.1:** System shall handle up to 100 concurrent verification sessions
- **NFR-5.2:** Report generation shall not block other operations
- **NFR-5.3:** WebSocket connections shall be efficient and reusable

---

## Technical Design

### 1. New API Endpoints

#### POST /api/v1/verification/:jobId/init-from-report
**Purpose:** Initialize verification queue from AI Analysis Report

**Request:**
```json
{
  "criteriaIds": ["1.1.1", "1.3.1", "2.1.1", "2.4.1", "2.4.6", "3.1.2", "3.3.2"],
  "aiInsights": {
    "topPriorities": [...],
    "riskAssessment": {...}
  },
  "reportId": "report-uuid",
  "source": "ai-analysis-report"
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "sessionId": "session-uuid",
    "jobId": "job-123",
    "queueUrl": "/verification/job-123?session=session-uuid",
    "itemsInitialized": 7,
    "estimatedTime": "45-60 minutes"
  }
}
```

---

#### GET /api/v1/verification/:jobId/queue/enhanced
**Purpose:** Get verification queue with AI context and testing guides

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "job-123",
    "sessionId": "session-uuid",
    "totalItems": 7,
    "pendingItems": 5,
    "verifiedItems": 2,
    "estimatedRemainingTime": "30-45 minutes",
    "items": [
      {
        "id": "item-1",
        "criterionId": "1.1.1",
        "wcagCriterion": "Non-text Content",
        "severity": "critical",
        "confidenceLevel": "MANUAL_REQUIRED",
        "status": "PENDING",
        "aiContext": {
          "priority": "CRITICAL",
          "priorityReason": "High volume (37 images) with formulaic alt text",
          "estimatedTime": "20 minutes",
          "riskScore": 85,
          "detectedIssues": [...],
          "recommendations": [...]
        },
        "testingGuide": {
          "steps": [...],
          "tools": [...],
          "resources": [...]
        },
        "passCriteria": [...],
        "relatedIssues": [...],
        "fixedIssues": [...]
      }
    ]
  }
}
```

---

#### POST /api/v1/verification/:itemId/submit-guided
**Purpose:** Submit verification with guided workflow data

**Request:**
```json
{
  "status": "VERIFIED_PASS",
  "method": "NVDA 2024.1",
  "notes": "35/37 images have meaningful alt text. 2 images still using filenames.",
  "stepsCompleted": [
    {
      "stepId": "step-1",
      "completed": true,
      "timeSpent": 120
    },
    {
      "stepId": "step-2",
      "completed": true,
      "timeSpent": 600
    }
  ],
  "passCriteriaChecked": [
    {
      "criteriaId": "alt-text-meaningful",
      "checked": true
    },
    {
      "criteriaId": "alt-text-equivalent",
      "checked": true
    }
  ],
  "evidence": [
    {
      "type": "screenshot",
      "url": "https://...",
      "description": "NVDA reading alt text"
    }
  ],
  "totalTimeSpent": 1200
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "recordId": "record-uuid",
    "status": "VERIFIED_PASS",
    "verifiedAt": "2026-02-05T12:34:56Z",
    "progress": {
      "completed": 3,
      "total": 7,
      "percentage": 43,
      "remainingTime": "25-35 minutes"
    }
  }
}
```

---

#### GET /api/v1/verification/:jobId/progress
**Purpose:** Get current verification progress for sync with AI Report

**Response:**
```json
{
  "success": true,
  "data": {
    "jobId": "job-123",
    "totalItems": 7,
    "completedItems": 3,
    "pendingItems": 4,
    "percentComplete": 43,
    "estimatedRemainingTime": "25-35 minutes",
    "lastUpdated": "2026-02-05T12:34:56Z",
    "completedCriteria": [
      {
        "criterionId": "1.1.1",
        "status": "VERIFIED_PASS",
        "verifiedBy": "user-123",
        "verifiedAt": "2026-02-05T12:20:00Z"
      }
    ]
  }
}
```

---

### 2. Enhanced Services

#### AIContextEnricher Service

**File:** `src/services/acr/ai-context-enricher.service.ts`

```typescript
export class AIContextEnricherService {
  async enrichVerificationQueue(
    jobId: string,
    criteriaIds: string[],
    aiInsights: AIInsights
  ): Promise<EnrichedQueueItem[]> {
    const items: EnrichedQueueItem[] = [];

    for (const criterionId of criteriaIds) {
      // Get base confidence analysis
      const confidence = confidenceAnalyzerService.analyzeConfidence(criterionId);

      // Get ACR analysis results
      const acrResults = await acrAnalysisService.getAnalysisForJob(jobId);
      const criterionData = acrResults.criteria.find(c => c.id === criterionId);

      // Generate AI context
      const aiContext = await this.generateAIContext(
        criterionId,
        criterionData,
        aiInsights
      );

      // Generate testing guide
      const testingGuide = await this.generateTestingGuide(
        criterionId,
        criterionData,
        aiContext
      );

      // Define pass criteria
      const passCriteria = this.getPassCriteria(criterionId);

      items.push({
        id: uuidv4(),
        criterionId,
        wcagCriterion: confidence.wcagCriterion,
        severity: this.getSeverity(criterionId),
        confidenceLevel: confidence.confidenceLevel,
        status: 'PENDING',
        aiContext,
        testingGuide,
        passCriteria,
        relatedIssues: criterionData?.relatedIssues || [],
        fixedIssues: criterionData?.fixedIssues || [],
        verificationHistory: []
      });
    }

    return items;
  }

  private async generateAIContext(
    criterionId: string,
    criterionData: any,
    aiInsights: AIInsights
  ): Promise<AIContext> {
    // Find priority info from AI insights
    const priorityInfo = aiInsights.topPriorities.find(
      p => p.criterionId === criterionId
    );

    // Generate context using Gemini if needed
    const prompt = `
      Analyze verification priority for WCAG criterion ${criterionId}.

      Detected issues: ${JSON.stringify(criterionData?.relatedIssues || [])}
      Fixed issues: ${JSON.stringify(criterionData?.fixedIssues || [])}

      Provide:
      1. Priority level (CRITICAL/HIGH/MEDIUM)
      2. Reason for priority
      3. Estimated time to verify (in minutes)
      4. Risk score (0-100)
      5. Specific detected issues summary
      6. Testing recommendations

      Format as JSON matching AIContext schema.
    `;

    const aiResponse = await geminiService.generateStructuredOutput(
      prompt,
      AIContextSchema
    );

    return aiResponse;
  }

  private async generateTestingGuide(
    criterionId: string,
    criterionData: any,
    aiContext: AIContext
  ): Promise<TestingGuide> {
    // Load criterion-specific template
    const template = testingGuideTemplates[criterionId];

    // Customize based on detected issues
    const steps = template.steps.map(step => ({
      ...step,
      // Add context from AI analysis
      helpText: this.contextualizeHelpText(
        step.helpText,
        criterionData,
        aiContext
      )
    }));

    return {
      steps,
      tools: template.tools,
      resources: template.resources
    };
  }
}

export const aiContextEnricher = new AIContextEnricherService();
```

---

#### VerificationProgressTracker Service

**File:** `src/services/acr/verification-progress-tracker.service.ts`

```typescript
export class VerificationProgressTrackerService {
  private eventEmitter = new EventEmitter();

  async trackCompletion(
    jobId: string,
    itemId: string,
    verification: VerificationRecord
  ): Promise<void> {
    // Update verification queue
    await humanVerificationService.submitVerification(
      itemId,
      verification,
      verification.verifiedBy
    );

    // Calculate progress
    const queue = await humanVerificationService.getQueue(jobId);
    const progress = this.calculateProgress(queue);

    // Update AI Report cache
    await this.updateAIReportCache(jobId, progress);

    // Emit event for real-time updates
    this.eventEmitter.emit('verification.completed', {
      jobId,
      itemId,
      criterionId: verification.criterionId,
      status: verification.status,
      progress
    });

    // Check if all critical items complete
    if (progress.criticalComplete) {
      this.eventEmitter.emit('verification.criticalComplete', {
        jobId,
        progress
      });
    }
  }

  private calculateProgress(queue: VerificationQueue): VerificationProgress {
    const critical = queue.items.filter(i => i.severity === 'critical');
    const criticalComplete = critical.every(i =>
      i.status === 'VERIFIED_PASS' ||
      i.status === 'VERIFIED_FAIL' ||
      i.status === 'VERIFIED_PARTIAL'
    );

    return {
      total: queue.totalItems,
      completed: queue.verifiedItems,
      pending: queue.pendingItems,
      percentComplete: Math.round((queue.verifiedItems / queue.totalItems) * 100),
      criticalComplete,
      estimatedRemainingTime: this.calculateRemainingTime(queue)
    };
  }

  private async updateAIReportCache(
    jobId: string,
    progress: VerificationProgress
  ): Promise<void> {
    // Invalidate AI Report cache
    await ReportCache.invalidate(jobId);

    // Optionally pre-generate updated report
    if (progress.percentComplete === 100) {
      await reportGenerator.generateAnalysisReport(jobId);
    }
  }

  onVerificationCompleted(
    callback: (event: VerificationCompletedEvent) => void
  ): void {
    this.eventEmitter.on('verification.completed', callback);
  }
}

export const progressTracker = new VerificationProgressTrackerService();
```

---

### 3. Database Schema Updates

```prisma
// Add to schema.prisma

model VerificationSession {
  id                String   @id @default(uuid())
  jobId             String
  reportId          String?
  source            String   // 'ai-analysis-report', 'manual', 'acr-results'
  initiatedBy       String
  initiatedAt       DateTime @default(now())
  completedAt       DateTime?
  status            String   // 'in_progress', 'completed', 'abandoned'
  totalItems        Int
  completedItems    Int      @default(0)
  estimatedTime     String?  // '45-60 minutes'
  actualTime        Int?     // seconds

  job               Job      @relation(fields: [jobId], references: [id])

  @@index([jobId])
  @@index([reportId])
}

model GuidedVerificationRecord {
  id                    String   @id @default(uuid())
  verificationRecordId  String   @unique
  stepsCompleted        Json     // Array of step completion data
  passCriteriaChecked   Json     // Array of pass criteria states
  totalTimeSpent        Int      // seconds
  evidence              Json?    // Array of evidence objects (screenshots, etc.)

  verificationRecord    VerificationRecord @relation(fields: [verificationRecordId], references: [id])
}

// Extend existing VerificationRecord
model VerificationRecord {
  // ... existing fields

  guidedData            GuidedVerificationRecord?
}
```

---

### 4. WebSocket/SSE Integration

**File:** `src/websocket/verification-events.ts`

```typescript
import { Server as SocketServer } from 'socket.io';
import { progressTracker } from '../services/acr/verification-progress-tracker.service';

export function setupVerificationWebSocket(io: SocketServer) {
  // Listen for verification events
  progressTracker.onVerificationCompleted((event) => {
    // Broadcast to all clients viewing this job's AI Report
    io.to(`report-${event.jobId}`).emit('verification:progress', {
      progress: event.progress,
      completedItem: {
        criterionId: event.criterionId,
        status: event.status
      }
    });
  });

  // Handle client connections
  io.on('connection', (socket) => {
    // Client joins room for specific job's report
    socket.on('report:subscribe', (jobId: string) => {
      socket.join(`report-${jobId}`);

      // Send current progress
      progressTracker.getCurrentProgress(jobId).then(progress => {
        socket.emit('verification:progress', { progress });
      });
    });

    socket.on('report:unsubscribe', (jobId: string) => {
      socket.leave(`report-${jobId}`);
    });
  });
}
```

---

## UI/UX Design

### 1. AI Analysis Report - Action Plan Section

```text
┌──────────────────────────────────────────────────────────────┐
│ 📋 Prioritized Action Plan                                   │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Phase 1: Critical Manual Testing                           │
│  ⚠️ 7 criteria require mandatory human verification         │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Progress: ████████░░░░░░░░ 3/7 completed (43%)        │ │
│  │                                                        │ │
│  │ ⏱️ Time: 20 min spent / ~25-35 min remaining          │ │
│  │                                                        │ │
│  │ Status:                                                │ │
│  │ ✅ 1.1.1 Non-text Content - Verified Pass             │ │
│  │ ✅ 1.3.1 Info & Relationships - Verified Pass         │ │
│  │ ✅ 2.1.1 Keyboard - Verified Pass                     │ │
│  │ ⏳ 2.4.1 Bypass Blocks - In Progress                  │ │
│  │ ⏸️  2.4.6 Headings & Labels - Pending                 │ │
│  │ ⏸️  3.1.2 Language of Parts - Pending                 │ │
│  │ ⏸️  3.3.2 Labels or Instructions - Pending            │ │
│  │                                                        │ │
│  │ [Continue Manual Testing]  [View All Results]         │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  OR (if not started yet):                                   │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Ready to start manual testing?                         │ │
│  │                                                        │ │
│  │ What happens next:                                     │ │
│  │ • Opens Human Verification interface                   │ │
│  │ • Queue pre-loaded with 7 manual criteria             │ │
│  │ • AI insights and testing guides included             │ │
│  │ • Your progress saved automatically                   │ │
│  │                                                        │ │
│  │ [📋 Start Manual Testing]                              │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Interactive Elements:**
- Progress bar updates in real-time
- Checkmarks appear as items are verified
- "In Progress" badge for currently open verification
- "Continue" button if session exists, "Start" if new
- Clicking criterion name scrolls to detail in Section 3

---

### 2. Human Verification - Enhanced Queue View

```text
┌──────────────────────────────────────────────────────────────┐
│ Manual Testing Verification                                  │
│ From: AI Analysis Report                                     │
│ [← Back to Report]                                           │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Progress: ████████░░░░░░░░ 3/7 (43%)  |  ~25-35 min left  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 🔴 CRITICAL | 1.1.1 Non-text Content         ✅ PASS │   │
│  ├──────────────────────────────────────────────────────┤   │
│  │ Verified by: John Doe | 20 min ago                   │   │
│  │ Method: NVDA 2024.1                                  │   │
│  │ Notes: 35/37 images have meaningful alt text...      │   │
│  │                                                      │   │
│  │ [View Details]  [Edit Verification]                  │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 🟠 HIGH | 2.4.1 Bypass Blocks              ⏳ TESTING │   │
│  ├──────────────────────────────────────────────────────┤   │
│  │ 🤖 AI Priority: CRITICAL                             │   │
│  │ Reason: Multiple navigation elements detected        │   │
│  │ Risk Score: 75/100  |  Est. Time: 10 min            │   │
│  │                                                      │   │
│  │ Detected Issues:                                     │   │
│  │ • 3 navigation landmarks detected                    │   │
│  │ • Skip link present but effectiveness unknown       │   │
│  │ • Must verify skip link functionality manually      │   │
│  │                                                      │   │
│  │ 🎯 Testing Guide (4 steps)                          │   │
│  │ 1. ☐ Test skip link with keyboard                   │   │
│  │ 2. ☐ Verify focus moves to main content             │   │
│  │ 3. ☐ Test with screen reader                        │   │
│  │ 4. ☐ Confirm bypasses repetitive navigation         │   │
│  │                                                      │   │
│  │ Recommended Tools:                                   │   │
│  │ • Keyboard-only testing (primary)                   │   │
│  │ • NVDA screen reader                                │   │
│  │                                                      │   │
│  │ [Start Verification]  [View Full Guide]              │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ 🟡 MEDIUM | 2.4.6 Headings & Labels        ⏸️ PENDING │   │
│  ├──────────────────────────────────────────────────────┤   │
│  │ 🤖 AI Priority: MEDIUM                               │   │
│  │ Reason: Generic heading text patterns detected      │   │
│  │ Risk Score: 60/100  |  Est. Time: 8 min             │   │
│  │                                                      │   │
│  │ [Start Verification]  [View Details]                 │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
│  [Show 4 more items...]                                     │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Features:**
- Color-coded priority badges (🔴 CRITICAL, 🟠 HIGH, 🟡 MEDIUM)
- Status indicators (✅ PASS, ❌ FAIL, ⏳ TESTING, ⏸️ PENDING)
- Expandable details per item
- Inline testing guide preview
- AI insights prominently displayed
- Progress bar at top
- Quick actions per item

---

### 3. Guided Verification Modal

```text
┌──────────────────────────────────────────────────────────────┐
│ Guided Verification: 2.4.1 Bypass Blocks                     │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│ Step 2 of 4                                                  │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Test Skip Link with Keyboard                               │
│                                                              │
│  Instructions:                                               │
│  1. Reload the page in your browser                         │
│  2. Press the Tab key once                                  │
│  3. Verify the skip link receives focus                     │
│  4. Press Enter to activate the skip link                   │
│  5. Confirm focus moves to main content area                │
│                                                              │
│  ℹ️ Help:                                                    │
│  The skip link should be the first focusable element. It    │
│  should move focus past navigation to the main content.     │
│                                                              │
│  📹 Tutorial: [Watch: Testing Skip Links (2 min)]           │
│  📖 Reference: [WCAG 2.4.1 Quick Guide]                     │
│                                                              │
│  ⏱️ Recommended time: 3 minutes                             │
│                                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Did the skip link work as expected?                    │ │
│  │                                                        │ │
│  │ ○ Yes - Skip link moved focus to main content         │ │
│  │ ○ Partial - Skip link exists but unclear              │ │
│  │ ○ No - Skip link missing or doesn't work              │ │
│  │                                                        │ │
│  │ Notes (optional):                                      │ │
│  │ ┌──────────────────────────────────────────────────┐ │ │
│  │ │                                                  │ │ │
│  │ └──────────────────────────────────────────────────┘ │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  [← Previous Step]  [Next Step →]  [Save & Exit]            │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Step 4 (Final) - Verification Decision:**

```text
┌──────────────────────────────────────────────────────────────┐
│ Guided Verification: 2.4.1 Bypass Blocks                     │
│ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   │
│ Step 4 of 4 - Verification Decision                          │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Review your testing and make a decision                     │
│                                                              │
│  Pass Criteria:                                              │
│  ☑ Skip link is present and visible on focus                │
│  ☑ Skip link is the first focusable element                 │
│  ☑ Activating skip link moves focus to main content         │
│  ☑ Screen reader announces skip link correctly              │
│                                                              │
│  All pass criteria met?                                      │
│                                                              │
│  Verification Result:                                        │
│  ○ ✅ Pass - All criteria met, content is accessible        │
│  ○ ⚠️  Partial - Some issues remain, see notes              │
│  ○ ❌ Fail - Significant issues, not accessible             │
│                                                              │
│  Testing Method:                                             │
│  [Keyboard Testing ▼]                                        │
│                                                              │
│  Summary Notes:                                              │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ Skip link works correctly. Tested with Chrome and     │ │
│  │ Firefox. Screen reader announces "Skip to main        │ │
│  │ content" as expected.                                  │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  Time spent: 9 minutes                                       │
│                                                              │
│  [Submit Verification]  [Cancel]                             │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Features:**
- Step-by-step wizard interface
- Progress indicator at top
- Clear instructions per step
- Contextual help and tutorials
- Intermediate save points
- Pass criteria checklist
- Time tracking
- Notes field for each step
- Final summary with decision

---

### 4. Completion View

```text
┌──────────────────────────────────────────────────────────────┐
│ 🎉 All Manual Testing Complete!                              │
├──────────────────────────────────────────────────────────────┤
│                                                              │
│  Great work! You've verified all 7 critical manual criteria. │
│                                                              │
│  Summary:                                                    │
│  ✅ Passed: 6 criteria                                       │
│  ⚠️  Partial: 1 criterion                                    │
│  ❌ Failed: 0 criteria                                       │
│                                                              │
│  Total Time: 48 minutes                                      │
│  Verified by: John Doe                                       │
│  Completed: February 5, 2026 at 2:34 PM                     │
│                                                              │
│  Next Steps:                                                 │
│  ┌────────────────────────────────────────────────────────┐ │
│  │ 1. Review your verification results                    │ │
│  │ 2. Return to AI Analysis Report to see updated status │ │
│  │ 3. Export final report with verification details      │ │
│  │ 4. Finalize your ACR for submission                   │ │
│  └────────────────────────────────────────────────────────┘ │
│                                                              │
│  [← Back to AI Analysis Report]                              │
│  [📄 Export Report with Verification Results]                │
│  [✅ Finalize ACR]                                           │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

---

## Implementation Plan

### Phase 1: Foundation (Week 1-2)
**Goal:** Basic integration between AI Report and Human Verification

**Tasks:**
- ✅ Create `init-from-report` API endpoint
- ✅ Add "Start Manual Testing" button to AI Report
- ✅ Implement basic navigation from Report → Verification
- ✅ Add "Back to Report" link in Verification interface
- ✅ Update verification queue to accept AI insights
- ✅ Create AIContextEnricher service skeleton

**Deliverables:**
- Users can click button in AI Report to start verification
- Context flows from Report to Verification
- Basic round-trip navigation works

---

### Phase 2: Enhanced Queue (Week 3-4)
**Goal:** Rich verification queue with AI context

**Tasks:**
- ✅ Implement AI context enrichment logic
- ✅ Add priority badges and risk scores to UI
- ✅ Display detected issues and recommendations
- ✅ Create expandable details per queue item
- ✅ Add time estimates per criterion
- ✅ Implement filtering and sorting

**Deliverables:**
- Verification queue shows AI insights
- Users understand WHY items are prioritized
- Clear time estimates per item

---

### Phase 3: Testing Guides (Week 5-6)
**Goal:** Criterion-specific testing guidance

**Tasks:**
- ✅ Create testing guide templates for all manual criteria
- ✅ Implement step-by-step guide rendering
- ✅ Add tool recommendations with links
- ✅ Embed WCAG documentation links
- ✅ Add tutorial video links
- ✅ Define pass criteria per criterion

**Deliverables:**
- Each criterion has detailed testing guide
- Users know exactly how to test
- Links to tools and resources work

---

### Phase 4: Guided Workflow (Week 7-8)
**Goal:** Step-by-step verification wizard

**Tasks:**
- ✅ Create guided verification modal component
- ✅ Implement step progression logic
- ✅ Add pass criteria checkboxes
- ✅ Build time tracking per step
- ✅ Create verification decision UI
- ✅ Implement evidence upload (optional)
- ✅ Add intermediate save points

**Deliverables:**
- Guided wizard works for all criteria
- Users can check off steps
- Final decision captures all data

---

### Phase 5: Progress Tracking (Week 9-10)
**Goal:** Real-time progress sync

**Tasks:**
- ✅ Implement VerificationProgressTracker service
- ✅ Add progress bar to verification interface
- ✅ Update AI Report cache on completion
- ✅ Set up WebSocket/SSE for live updates
- ✅ Add progress indicators in AI Report
- ✅ Implement completion notifications

**Deliverables:**
- Progress visible in both interfaces
- Real-time updates work
- Completion triggers notifications

---

### Phase 6: Report Integration (Week 11-12)
**Goal:** Full integration with AI Report export

**Tasks:**
- ✅ Update AI Report to show verification status
- ✅ Add verification results to PDF export
- ✅ Include audit log in exports
- ✅ Add "Verified by" attestation
- ✅ Update Executive Summary with progress
- ✅ Mark completed items in Action Plan

**Deliverables:**
- PDF exports include verification data
- AI Report reflects verification status
- Complete audit trail available

---

### Phase 7: Polish & Testing (Week 13-14)
**Goal:** Production-ready quality

**Tasks:**
- ✅ Comprehensive testing (unit, integration, E2E)
- ✅ Accessibility audit of all new UIs
- ✅ Performance optimization
- ✅ Error handling and edge cases
- ✅ Mobile responsiveness
- ✅ User acceptance testing
- ✅ Documentation and training materials

**Deliverables:**
- All tests passing
- No accessibility issues
- User documentation complete
- Ready for production

---

## Success Metrics

### Adoption Metrics
- **Initiation Rate:** % of AI Report viewers who click "Start Manual Testing"
  - Target: 70%+
- **Completion Rate:** % of users who verify all manual criteria
  - Target: 60%+
- **Time to Start:** Average time from viewing AI Report to first verification
  - Target: <2 minutes

### Efficiency Metrics
- **Time per Criterion:** Average time to verify each criterion
  - Baseline: Unknown
  - Target: Match or beat WCAG-EM methodology estimates
- **Guide Usage:** % of users who expand testing guides
  - Target: 80%+
- **Tool Download:** % of users who click tool download links
  - Target: 40%+

### Quality Metrics
- **Verification Notes Quality:** Average note length (indicator of thoroughness)
  - Target: >50 words per verification
- **Pass Criteria Completion:** % of verifications with all pass criteria checked
  - Target: 90%+
- **Evidence Upload:** % of verifications with screenshots/evidence
  - Target: 30%+ (optional feature)

### User Satisfaction
- **NPS Score:** Net Promoter Score for verification workflow
  - Target: 40+
- **Help Request Rate:** % of users who contact support during verification
  - Target: <5%
- **Repeat Usage:** % of users who complete verification on multiple jobs
  - Target: 70%+

---

## Open Questions for Product Team

1. **AI Insights Scope:** Should AI analyze ALL criteria or only manual-required ones?
2. **Testing Method Validation:** Should we validate that recommended tools are actually installed?
3. **Evidence Requirements:** Should screenshot evidence be optional or required for certain criteria?
4. **Team Collaboration:** Should multiple team members be able to verify different criteria concurrently?
5. **Progress Notifications:** Email/Slack notifications when verification milestones reached?
6. **Verification Expiry:** Should verifications "expire" after X days and require re-verification?
7. **Expert Review:** Option to request expert review for uncertain verifications?
8. **Gamification:** Badges/achievements for completing verifications?
9. **Mobile Testing:** Should guided workflow work on mobile devices?
10. **Offline Mode:** Support offline verification with sync when reconnected?

---

**Document Status:** ✅ Ready for Review
**Next Steps:**
1. Product team review and prioritization
2. Technical architecture review
3. Design mockup creation (Figma)
4. Sprint planning for Phase 1
5. Kickoff meeting with engineering team

---

**Prepared by:** Claude Sonnet 4.5
**Date:** 2026-02-05
**Version:** 1.0
