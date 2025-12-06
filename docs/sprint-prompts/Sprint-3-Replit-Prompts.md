# Sprint 3 Replit Prompts
## PDF Accessibility + Section 508 + ACR Generation

**Version:** 4.0 - ACR Research Update  
**Sprint Duration:** Weeks 5-6 (December 20, 2025 - January 3, 2026)  
**Total Story Points:** 96 (+24 from v3.0 - HIGH RISK SPRINT)

---

## ⚠️ ACR Research Update - Critical Terminology

> **IMPORTANT:** This version incorporates critical findings from VPAT/ACR research:
> - **VPAT** = blank template from ITI
> - **ACR** = Accessibility Conformance Report (the completed deliverable)
> - All code, APIs, and documentation must use correct terminology

---

## Sprint 3 Technical Standards

Before executing any prompt in this sprint, ensure these standards are followed consistently:

| Category | Standard |
|----------|----------|
| **Runtime** | Node.js 18+ |
| **Language** | TypeScript 5.x (strict mode) |
| **API Framework** | Express 4.x |
| **Module System** | ES Modules (import/export) |
| **Validation** | Zod schemas |
| **ORM** | Prisma |
| **Async Pattern** | async/await (no callbacks) |
| **File Naming** | kebab-case for files, PascalCase for classes/interfaces |
| **Base Path** | All code in `src/` |
| **Testing** | Jest with TypeScript |
| **PDF Libraries** | pdf-lib, pdfjs-dist |
| **AI Integration** | Google Gemini API (@google/generative-ai) |

---

## Epic 3.1: WCAG 2.2 & PDF/UA Validation

### Prompt US-3.1.1: PDF Structure Validation

#### Context
We're building the Ninja Platform, an accessibility validation SaaS for educational publishers. This prompt implements the core PDF structure validation service that checks documents against WCAG 2.2 criteria.

#### Prerequisites
- US-2.4.1 (PDF Parsing Service) is complete
- US-2.4.2 (Text Extraction Service) is complete
- US-2.4.4 (PDF Structure Analysis) is complete
- PDF structure tree parsing is working

#### Current State
You should have:
- `src/services/pdf/pdf-parser.service.ts` - Basic PDF parsing
- `src/services/pdf/structure-analyzer.service.ts` - Structure tree extraction
- PDF files being stored in S3 and metadata in PostgreSQL

#### Objective
Create a PDF structure validation service that checks WCAG 2.2 compliance for heading hierarchy, reading order, and language declaration.

#### Technical Requirements

**Create file: `src/services/accessibility/pdf-structure-validator.service.ts`**

```typescript
// Service should implement these interfaces
interface StructureValidationResult {
  isValid: boolean;
  score: number; // 0-100
  issues: AccessibilityIssue[];
  summary: {
    totalChecks: number;
    passed: number;
    failed: number;
    warnings: number;
  };
}

interface AccessibilityIssue {
  id: string;
  wcagCriterion: string; // e.g., "1.3.1", "1.3.2", "3.1.1"
  wcagLevel: 'A' | 'AA' | 'AAA';
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  title: string;
  description: string;
  location: {
    page?: number;
    element?: string;
    xpath?: string;
  };
  remediation: string;
}
```

**Implement these validation checks:**

1. **Heading Hierarchy (WCAG 1.3.1 - Level A)**
   - Verify document has H1 as top-level heading
   - Verify headings don't skip levels (H1→H2→H3, never H1→H3)
   - Flag empty headings
   - Report heading structure as outline

2. **Reading Order (WCAG 1.3.2 - Level A)**
   - Compare visual layout order with tag structure order
   - Flag content that appears out of logical sequence
   - Identify multi-column layouts and verify reading order

3. **Language Declaration (WCAG 3.1.1 - Level A)**
   - Check document-level language attribute in PDF metadata
   - Flag missing language declaration
   - Validate language code is valid ISO 639-1

**Create file: `src/services/accessibility/validators/heading-validator.ts`**

Implement heading-specific validation logic with these rules:
- Maximum 1 H1 per document (or section for multi-section docs)
- Heading levels must be sequential (no skipping)
- Headings must contain text content
- Return remediation suggestions for each issue

**Create file: `src/services/accessibility/validators/reading-order-validator.ts`**

Implement reading order validation:
- Extract tag order from PDF structure tree
- Compare with visual rendering order
- Flag discrepancies with page location

**Create file: `src/controllers/accessibility.controller.ts`**

Add endpoint:
```
POST /api/v1/accessibility/validate/structure
Body: { jobId: string } or { fileId: string }
Response: StructureValidationResult
```

**Update file: `src/routes/accessibility.routes.ts`**

Register the new endpoint with authentication middleware.

#### Acceptance Criteria
- [ ] Given a PDF is submitted for validation
- [ ] When accessibility check runs
- [ ] Then verify document has proper heading hierarchy (H1→H2→H3, no skips)
- [ ] And verify reading order is logical and sequential (Criterion 1.3.2)
- [ ] And verify language is declared in document metadata (Criterion 3.1.1)
- [ ] And each issue includes WCAG criterion number, severity, location, and remediation suggestion

#### Implementation Notes
- Use the existing PDF structure analyzer from Sprint 2
- Store validation results in the `ValidationResult` table with `jobId` reference
- Log validation duration for performance monitoring
- Handle edge cases: untagged PDFs should return a critical error, not crash

---

### Prompt US-3.1.2: Alt Text Validation

#### Context
Continuing the Ninja Platform accessibility validation. This prompt adds image alt text checking, which is critical for WCAG 1.1.1 (Non-text Content).

#### Prerequisites
- US-2.4.3 (Image Extraction Service) is complete
- US-3.1.1 (PDF Structure Validation) is complete
- Images are being extracted and stored with metadata

#### Current State
You should have:
- `src/services/pdf/image-extractor.service.ts` - Extracts images from PDFs
- `src/services/accessibility/pdf-structure-validator.service.ts` - From US-3.1.1
- Images stored in S3: `/{tenantId}/projects/{projectId}/processed/{jobId}/images/`

#### Objective
Create an alt text validation service that identifies images missing alternative text and distinguishes decorative images from meaningful content.

#### Technical Requirements

**Create file: `src/services/accessibility/validators/alt-text-validator.ts`**

```typescript
interface AltTextValidationResult {
  totalImages: number;
  withAltText: number;
  missingAltText: number;
  decorativeImages: number;
  compliancePercentage: number; // e.g., 94.0
  images: ImageAltTextStatus[];
}

interface ImageAltTextStatus {
  imageId: string;
  page: number;
  position: { x: number; y: number; width: number; height: number };
  hasAltText: boolean;
  altText: string | null;
  isDecorative: boolean; // Marked as Artifact in PDF
  wcagCompliant: boolean;
  issue?: AccessibilityIssue;
}
```

**Implement these checks:**

1. **Alt Text Presence (WCAG 1.1.1 - Level A)**
   - Check each Figure tag for /Alt attribute
   - Flag images without alt text as critical issues
   - Report alt text content for review (may be inadequate)

2. **Decorative Image Detection**
   - Identify images marked as Artifact (decorative)
   - Verify decorative images don't have alt text (or have alt="")
   - Flag images that appear decorative but have alt text (over-description)

3. **Alt Text Quality Indicators** (informational, not violations)
   - Flag suspiciously short alt text (<5 characters)
   - Flag alt text that appears to be filename (e.g., "image001.jpg")
   - Flag alt text that starts with "Image of" or "Picture of" (redundant)

**Update `src/services/accessibility/pdf-structure-validator.service.ts`**

Add method:
```typescript
async validateAltText(jobId: string): Promise<AltTextValidationResult>
```

**Update `src/controllers/accessibility.controller.ts`**

Add endpoint:
```
POST /api/v1/accessibility/validate/alt-text
Body: { jobId: string }
Response: AltTextValidationResult
```

#### Acceptance Criteria
- [ ] Given a PDF is submitted for validation
- [ ] When alt text check runs
- [ ] Then identify all images in the document
- [ ] And check each image for /Alt attribute
- [ ] And identify decorative images (marked as Artifact)
- [ ] And calculate compliance percentage (e.g., 387/412 = 94%)
- [ ] And generate issues for missing alt text with WCAG 1.1.1 reference

#### Implementation Notes
- Decorative images without alt text are COMPLIANT (not a violation)
- Empty alt text (alt="") is valid for decorative images
- Report includes thumbnails (already generated in Sprint 2) for review context
- Consider memory efficiency when processing documents with hundreds of images

---

### Prompt US-3.1.3: Color Contrast Analysis

*(Story Points: 5 - Existing story, no changes)*

Implement WCAG 1.4.3 color contrast validation using the formula: (L1 + 0.05) / (L2 + 0.05) with thresholds of 4.5:1 for normal text and 3:1 for large text.

---

### Prompt US-3.1.4: Table Accessibility Validation

*(Story Points: 5 - Existing story, no changes)*

Validate table markup for header cells (<TH>), scope attributes, and proper structure.

---

### Prompt US-3.1.5: PDF/UA Compliance Check

*(Story Points: 5 - Existing story, no changes)*

Validate documents against PDF/UA (ISO 14289-1) using the Matterhorn Protocol.

---

## Epic 3.2: Section 508 Specific Validation

### Prompt US-3.2.1: Revised Section 508 Mapping Engine [REVISED]

#### Context
> 🔬 **RESEARCH DRIVER:** Section 508 uses 'Best Meets' standard - vendors don't need perfect compliance, they need better documentation than competitors. A detailed, honest ACR showing 85% compliance often defeats a competitor with no documentation.

This prompt creates the Section 508 mapping engine with "Best Meets" guidance for competitive procurement positioning.

#### Prerequisites
- US-3.1.1 through US-3.1.5 complete
- WCAG 2.1 validation results available

#### Objective
Create a service that maps WCAG validation results to Section 508 criteria and provides competitive positioning guidance.

#### Technical Requirements

**Create file: `src/services/compliance/section508-mapper.service.ts`**

```typescript
interface Section508MappingResult {
  overallCompliance: number; // Percentage
  criteriaResults: Section508Criterion[];
  bestMeetsGuidance: BestMeetsGuidance[];
  competitivePositioning: string; // Generated text for procurement response
}

interface Section508Criterion {
  criterionId: string; // e.g., "501.1", "504.2", "E205.4"
  title: string;
  wcagMapping: string[]; // e.g., ["1.1.1", "1.3.1"]
  conformanceLevel: ConformanceLevel;
  remarks: string;
}

interface BestMeetsGuidance {
  criterionId: string;
  currentStatus: ConformanceLevel;
  bestMeetsLanguage: string; // Suggested language for procurement response
  improvementPath?: string; // What would be needed for full compliance
}

type ConformanceLevel = 
  | 'Supports'
  | 'Partially Supports'
  | 'Does Not Support'
  | 'Not Applicable';
```

**Create mapping table: `src/data/section508-wcag-mapping.ts`**

Map WCAG 2.1 criteria to Section 508 sections including:
- E205 (Electronic Content)
- E205.4 (PDF/UA requirements)
- Chapter 3 (Functional Performance Criteria)
- Chapter 6 (Support Documentation)

**Add "Best Meets" guidance generator:**

```typescript
function generateBestMeetsGuidance(
  criterionId: string,
  wcagResults: ValidationResult[],
  competitorContext?: CompetitorInfo
): BestMeetsGuidance {
  // Generate procurement-ready language even for partial compliance
  // Example: "Product achieves 87% compliance with E205 requirements.
  //          Alt text is present for 387 of 445 images. Remaining 
  //          decorative images are properly marked as artifacts."
}
```

#### Acceptance Criteria
- [ ] Given WCAG 2.1 validation results exist
- [ ] When the system generates Section 508 mapping
- [ ] Then results are mapped to 508 criteria numbers (e.g., 501.1, 504.2)
- [ ] And E205 (Electronic Content) requirements are specifically validated
- [ ] **[NEW]** And 'Best Meets' guidance is provided when partial compliance exists
- [ ] **[NEW]** And competitive positioning language is suggested for procurement responses
- [ ] And PDF/UA requirements (E205.4) are validated

---

### Prompt US-3.2.2: Functional Performance Criteria (Chapter 3)

*(Story Points: 5 - Existing story, no changes)*

---

### Prompt US-3.2.3: Support Documentation (Chapter 6)

*(Story Points: 3 - Existing story, no changes)*

---

## Epic 3.3: ACR Generation [MAJOR REVISION]

> ⚠️ **TERMINOLOGY UPDATE:** VPAT is the blank template from ITI. ACR (Accessibility Conformance Report) is the completed deliverable. All features now use correct ACR terminology.

### Prompt US-3.3.1: Multi-Edition ACR Support [REVISED]

#### Context
> 🔬 **RESEARCH DRIVER:** VPAT 2.5 INT Edition is emerging as 'Gold Standard' for multinational vendors, satisfying US (Section 508), EU (EN 301 549), and global requirements in a single document. Should be default recommendation.

#### Prerequisites
- US-3.2.1 through US-3.2.3 complete
- Section 508 mapping available

#### Objective
Create ACR generation service with INT Edition as the default recommendation.

#### Technical Requirements

**Create file: `src/services/acr/acr-generator.service.ts`**

```typescript
type AcrEdition = 
  | 'VPAT2.5-508'      // U.S. Federal only
  | 'VPAT2.5-WCAG'     // General accessibility
  | 'VPAT2.5-EU'       // EN 301 549 for EAA
  | 'VPAT2.5-INT';     // International (RECOMMENDED DEFAULT)

interface AcrGenerationOptions {
  edition: AcrEdition;
  includeAppendix: boolean;
  includeMethodology: boolean;
  productInfo: ProductInfo;
}

interface AcrDocument {
  id: string;
  edition: AcrEdition;
  productInfo: ProductInfo;
  evaluationMethods: EvaluationMethod[];
  criteria: AcrCriterion[];
  generatedAt: Date;
  version: number;
  status: 'draft' | 'pending_review' | 'final';
}

async function generateAcr(
  jobId: string,
  options: AcrGenerationOptions
): Promise<AcrDocument> {
  // Default to INT edition if not specified
  const edition = options.edition || 'VPAT2.5-INT';

  // Show tooltip/guidance about INT edition benefits
  if (edition === 'VPAT2.5-INT') {
    // Log: "INT Edition satisfies US Section 508, EU EN 301 549, and WCAG requirements in one document"
  }

  // Generate appropriate sections based on edition
}
```

**Create edition templates: `src/services/acr/templates/`**
- `vpat-508-template.ts`
- `vpat-wcag-template.ts`
- `vpat-eu-template.ts`
- `vpat-int-template.ts`

#### Acceptance Criteria
- [ ] Given a document has been validated
- [ ] When I request ACR generation
- [ ] **[UPDATED]** Then VPAT 2.5 INT Edition is recommended as default for maximum coverage
- [ ] And I can select VPAT 2.5 Section 508 Edition (U.S. Federal only)
- [ ] And I can select VPAT 2.5 WCAG Edition (General accessibility)
- [ ] And I can select VPAT 2.5 EU Edition (EN 301 549 for European Accessibility Act)
- [ ] **[NEW]** And tooltip explains: 'INT Edition satisfies US Section 508, EU EN 301 549, and WCAG requirements in one document'
- [ ] And each edition includes only the relevant standards and criteria

---

### Prompt US-3.3.2: Confidence Level Indicators [NEW]

#### Context
> 🔬 **RESEARCH DRIVER:** Automated accessibility scanners only detect 30-57% of WCAG failures. Human verification is mandatory for credible reporting. AI cannot 'use' a screen reader; it can only predict text about screen readers.

#### Prerequisites
- US-3.1.1 through US-3.2.3 complete
- Validation results with detection method metadata

#### Objective
Add confidence level indicators to each automated check so users know which items require human verification.

#### Technical Requirements

**Create file: `src/services/acr/confidence-analyzer.service.ts`**

```typescript
type ConfidenceLevel = 
  | 'HIGH'              // 90%+ - automated verification reliable
  | 'MEDIUM'            // 60-89% - automated + spot check recommended
  | 'LOW'               // <60% - automated flagging only, human review required
  | 'MANUAL_REQUIRED';  // Cannot be automated at all

interface ConfidenceAssessment {
  criterionId: string;
  wcagCriterion: string;
  confidenceLevel: ConfidenceLevel;
  confidencePercentage: number;
  reason: string;
  humanVerificationRequired: boolean;
  automatedChecks: string[];
  manualChecksNeeded: string[];
}

// Criteria that ALWAYS require manual verification
const ALWAYS_MANUAL_CRITERIA = [
  '1.1.1',  // Alt text meaningfulness (can detect presence, not quality)
  '1.3.1',  // Info and relationships (partial automation only)
  '2.1.1',  // Keyboard accessibility (cannot automate full workflow)
  '2.4.1',  // Bypass blocks (requires understanding of content)
  '2.4.6',  // Headings and labels (descriptive quality)
  '3.1.2',  // Language of parts (cannot detect need for markup)
  '3.3.2',  // Labels or instructions (quality assessment)
];

function analyzeConfidence(
  criterionId: string,
  validationResult: ValidationResult
): ConfidenceAssessment {
  // Determine confidence based on:
  // 1. Whether criterion is in ALWAYS_MANUAL list
  // 2. Complexity of automated check
  // 3. Historical accuracy data
}
```

**Update database schema: `prisma/schema.prisma`**

```prisma
model ValidationResultItem {
  id                String    @id @default(uuid())
  validationResultId String
  criterionId       String
  wcagCriterion     String
  status            String    // pass, fail, warning
  confidenceLevel   String    // HIGH, MEDIUM, LOW, MANUAL_REQUIRED
  confidenceScore   Float
  humanVerified     Boolean   @default(false)
  humanVerifiedAt   DateTime?
  humanVerifiedBy   String?
  verificationNotes String?

  validationResult  ValidationResult @relation(fields: [validationResultId], references: [id])
}
```

**Create API endpoint:**

```
GET /api/v1/validation/:jobId/confidence-summary
Response: {
  totalCriteria: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  manualRequired: number;
  humanVerificationNeeded: number;
  items: ConfidenceAssessment[];
}
```

#### Acceptance Criteria
- [ ] Given automated validation has completed
- [ ] When viewing results for each WCAG criterion
- [ ] Then confidence level displays: HIGH (90%+ - automated verification reliable)
- [ ] And confidence level displays: MEDIUM (60-89% - automated + spot check recommended)
- [ ] And confidence level displays: LOW (<60% - automated flagging only, human review required)
- [ ] And confidence level displays: MANUAL VERIFICATION REQUIRED (criteria cannot be automated)
- [ ] And criteria that cannot be automated are always flagged (e.g., meaningful alt text, keyboard navigation workflows)
- [ ] And dashboard shows count of items requiring human verification

---

### Prompt US-3.3.3: Human Verification Workflow [NEW]

#### Context
> 🔬 **RESEARCH DRIVER:** Audit trails required for legal defensibility (who verified what and when). ACR cannot be finalized until all required items are human-reviewed.

#### Prerequisites
- US-3.3.2 (Confidence Level Indicators) complete

#### Objective
Create a verification workflow for human review of automated results with complete audit trails.

#### Technical Requirements

**Create file: `src/services/acr/human-verification.service.ts`**

```typescript
type VerificationStatus = 
  | 'PENDING'
  | 'VERIFIED_PASS'
  | 'VERIFIED_FAIL'
  | 'VERIFIED_PARTIAL'
  | 'DEFERRED';

interface VerificationRecord {
  id: string;
  validationItemId: string;
  status: VerificationStatus;
  verifiedBy: string;       // User ID
  verifiedAt: Date;
  method: string;           // e.g., "Tested with NVDA 2024.1"
  notes: string;
  previousStatus?: VerificationStatus;
}

interface VerificationQueue {
  jobId: string;
  totalItems: number;
  pendingItems: number;
  verifiedItems: number;
  canFinalize: boolean;     // False until all CRITICAL items verified
  items: VerificationQueueItem[];
}

interface VerificationQueueItem {
  id: string;
  criterionId: string;
  wcagCriterion: string;
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  confidenceLevel: ConfidenceLevel;
  automatedResult: string;
  status: VerificationStatus;
  verificationHistory: VerificationRecord[];
}

async function submitVerification(
  itemId: string,
  verification: {
    status: VerificationStatus;
    method: string;
    notes: string;
  },
  userId: string
): Promise<VerificationRecord> {
  // Create immutable audit record
  // Update item status
  // Check if ACR can now be finalized
}

async function canFinalizeAcr(jobId: string): Promise<{
  canFinalize: boolean;
  blockers: string[];
}> {
  // Check all CRITICAL and HIGH severity items are verified
  // Return list of blocking items if cannot finalize
}
```

**Update database schema:**

```prisma
model VerificationRecord {
  id              String    @id @default(uuid())
  validationItemId String
  status          String
  verifiedBy      String
  verifiedAt      DateTime  @default(now())
  method          String
  notes           String?

  validationItem  ValidationResultItem @relation(fields: [validationItemId], references: [id])

  @@index([validationItemId])
}
```

**Create API endpoints:**

```
GET /api/v1/verification/:jobId/queue
Response: VerificationQueue

POST /api/v1/verification/:itemId/submit
Body: { status, method, notes }
Response: VerificationRecord

GET /api/v1/verification/:jobId/audit-log
Response: { records: VerificationRecord[], exportUrl: string }

GET /api/v1/acr/:jobId/can-finalize
Response: { canFinalize: boolean, blockers: string[] }
```

**Create React component: `src/components/verification/VerificationQueue.tsx`**

Display verification queue with:
- Filter by severity, confidence level, status
- Progress indicator: "X of Y items verified"
- Method selector (NVDA, JAWS, VoiceOver, Manual Review)
- Notes field for each verification
- Bulk verification for similar items

#### Acceptance Criteria
- [ ] Given automated validation has completed with items requiring human verification
- [ ] When reviewer opens human verification workflow
- [ ] Then each LOW/MANUAL item appears in a verification queue
- [ ] And reviewer can mark as: VERIFIED (passes), VERIFIED (fails), VERIFIED (partial), DEFERRED
- [ ] And each verification records: timestamp, reviewer ID, notes, method used
- [ ] And ACR cannot be marked 'Final' until all CRITICAL and HIGH severity items are human-verified
- [ ] And audit log is exportable for compliance documentation
- [ ] And verification progress shows: X of Y items verified

---

### Prompt US-3.3.4: Nuanced Compliance Status [NEW]

#### Context
> 🔬 **RESEARCH DRIVER:** Sophisticated procurement teams view reports claiming 100% 'Supports' ratings as indicators of fraud or incompetence. Credible ACRs require nuanced partial compliance with detailed 'Remarks and Explanations.'

#### Prerequisites
- US-3.3.3 (Human Verification Workflow) complete

#### Objective
Implement accurate conformance level determination that prevents overstated compliance and requires detailed remarks.

#### Technical Requirements

**Create file: `src/services/acr/conformance-engine.service.ts`**

```typescript
interface ConformanceDecision {
  level: ConformanceLevel;
  remarks: string;
  requiresHumanConfirmation: boolean;
  warningFlags: string[];
}

// CRITICAL: Never auto-populate 'Supports' without human confirmation
async function determineConformance(
  criterionId: string,
  validationResults: ValidationResult[],
  humanVerification?: VerificationRecord
): Promise<ConformanceDecision> {
  const autoResult = analyzeAutomatedResults(validationResults);

  // NEVER return 'Supports' without human verification
  if (autoResult.wouldBeSupports && !humanVerification) {
    return {
      level: 'Partially Supports',
      remarks: 'Automated testing indicates compliance. Human verification pending.',
      requiresHumanConfirmation: true,
      warningFlags: []
    };
  }

  // Require remarks for all non-'Supports' levels
  if (autoResult.level !== 'Supports' && !autoResult.remarks) {
    throw new Error(`Remarks required for ${autoResult.level} status`);
  }

  return autoResult;
}

// Warn if ACR has suspiciously high compliance
function validateAcrCredibility(acr: AcrDocument): CredibilityWarning[] {
  const supportsCount = acr.criteria.filter(c => c.level === 'Supports').length;
  const supportsPercentage = supportsCount / acr.criteria.length * 100;

  const warnings: CredibilityWarning[] = [];

  if (supportsPercentage > 95) {
    warnings.push({
      type: 'HIGH_COMPLIANCE_WARNING',
      message: 'ACR shows >95% "Supports" ratings. Sophisticated procurement teams may view this skeptically.',
      recommendation: 'Review each criterion carefully. Consider adding detailed remarks even for "Supports" items.'
    });
  }

  return warnings;
}
```

**Create remarks validation:**

```typescript
interface RemarksRequirement {
  level: ConformanceLevel;
  required: boolean;
  minimumLength: number;
  mustInclude: string[];
}

const REMARKS_REQUIREMENTS: Record<ConformanceLevel, RemarksRequirement> = {
  'Supports': {
    required: false,
    minimumLength: 0,
    mustInclude: []
  },
  'Partially Supports': {
    required: true,
    minimumLength: 50,
    mustInclude: ['what works', 'limitations'] // Must explain both
  },
  'Does Not Support': {
    required: true,
    minimumLength: 30,
    mustInclude: ['reason', 'workaround'] // If applicable
  },
  'Not Applicable': {
    required: true,
    minimumLength: 20,
    mustInclude: ['justification']
  }
};

function validateRemarks(
  level: ConformanceLevel,
  remarks: string
): { valid: boolean; errors: string[] } {
  const requirements = REMARKS_REQUIREMENTS[level];
  const errors: string[] = [];

  if (requirements.required && !remarks) {
    errors.push(`Remarks required for "${level}" status`);
  }

  if (remarks && remarks.length < requirements.minimumLength) {
    errors.push(`Remarks must be at least ${requirements.minimumLength} characters`);
  }

  // Include quantitative data when available
  // e.g., "387 of 412 images have alt text"

  return { valid: errors.length === 0, errors };
}
```

#### Acceptance Criteria
- [ ] Given validation results exist for a document
- [ ] When the system generates conformance levels
- [ ] Then 'Supports' requires human verification confirmation (never auto-populated)
- [ ] And 'Partially Supports' requires mandatory Remarks explaining what works and what doesn't
- [ ] And 'Does Not Support' requires mandatory Remarks explaining limitations
- [ ] And 'Not Applicable' requires justification
- [ ] **[CRITICAL]** And system WARNS if >95% of criteria are marked 'Supports' (red flag for reviewers)
- [ ] And remarks include quantitative data (e.g., '387 of 412 images have alt text')

---

### Prompt US-3.3.5: AI Disclaimer and Attribution [NEW]

#### Context
> 🔬 **RESEARCH DRIVER:** AI-generated compliance reports carry significant legal peril due to confident but inaccurate assertions. FTC fined accessibility overlay provider $1 million (January 2025) for deceptive claims that AI tool could make websites compliant.

#### Prerequisites
- US-3.3.4 (Nuanced Compliance Status) complete

#### Objective
Add clear attribution distinguishing AI-detected findings from human-verified findings to reduce legal liability.

#### Technical Requirements

**Create file: `src/services/acr/attribution.service.ts`**

```typescript
type AttributionTag = 
  | 'AUTOMATED'       // Fully automated check
  | 'AI_SUGGESTED'    // AI-generated content (alt text, remediation suggestions)
  | 'HUMAN_VERIFIED'; // Human has confirmed this finding

interface AttributedFinding {
  findingId: string;
  attributionTag: AttributionTag;
  automatedToolVersion: string;
  aiModelUsed?: string;      // e.g., "Google Gemini 1.5 Pro"
  humanVerifier?: string;
  verificationMethod?: string;
}

interface MethodologySection {
  assessmentDate: Date;
  toolsUsed: Tool[];
  aiModelsUsed: AiModel[];
  humanReviewers: Reviewer[];
  disclaimer: string;
}

const LEGAL_DISCLAIMER = `
This Accessibility Conformance Report was generated using automated testing tools 
supplemented by AI-assisted analysis. Automated tools can detect approximately 
30-57% of accessibility barriers. Items marked [AI-SUGGESTED] require human 
verification for accuracy. This report should be reviewed by qualified 
accessibility professionals before use in procurement decisions.

Assessment Tool: Ninja Platform v1.0
AI Model: Google Gemini (for alt text suggestions and remediation guidance)
`;

function generateMethodologySection(
  findings: AttributedFinding[],
  verificationRecords: VerificationRecord[]
): MethodologySection {
  // Generate methodology section for ACR
  // List all tools, AI models, and human reviewers
  // Include disclaimer
}
```

**Update ACR export templates:**

Add to all exported ACR documents:
1. Methodology section near the beginning
2. Attribution tags in remarks column: `[AUTOMATED]`, `[AI-SUGGESTED]`, `[HUMAN-VERIFIED]`
3. Legal disclaimer in footer
4. Alt text suggestions clearly marked: "AI-Suggested - Requires Review"

#### Acceptance Criteria
- [ ] Given an ACR is being generated
- [ ] When AI-generated content is included
- [ ] Then each finding is tagged: [AUTOMATED], [AI-SUGGESTED], or [HUMAN-VERIFIED]
- [ ] And exported ACR includes methodology section: 'Assessment Methodology'
- [ ] And methodology lists tools used (e.g., 'Automated: Ninja Platform v1.0 using Google Gemini')
- [ ] And methodology states: 'AI-assisted validation requires human verification for accuracy'
- [ ] And legal disclaimer appears in ACR footer (template reviewed by counsel)
- [ ] And alt text suggestions are clearly marked as 'AI-Suggested - Requires Review'

---

### Prompt US-3.3.6: Detailed Remarks Generation

*(Story Points: 5 - Existing story, no changes)*

---

### Prompt US-3.3.7: ACR Document Export

*(Story Points: 5 - Existing story, minor update to include attribution tags and methodology section)*

---

### Prompt US-3.3.8: ACR Versioning and History

*(Story Points: 5 - Existing story, no changes)*

---

## Sprint 3 Execution Checklist

Execute prompts in this order, verifying each is complete before proceeding:

### Week 5 (Dec 20-27)
- [ ] US-3.1.1: PDF Structure Validation
- [ ] US-3.1.2: Alt Text Validation
- [ ] US-3.1.3: Color Contrast Analysis
- [ ] US-3.1.4: Table Accessibility Validation
- [ ] US-3.1.5: PDF/UA Compliance Check

### Week 6 (Dec 28 - Jan 3)
- [ ] US-3.2.1: Revised Section 508 Mapping Engine [REVISED]
- [ ] US-3.2.2: Functional Performance Criteria (Chapter 3)
- [ ] US-3.2.3: Support Documentation Requirements (Chapter 6)
- [ ] US-3.3.1: Multi-Edition ACR Support [REVISED]
- [ ] US-3.3.2: Confidence Level Indicators [NEW]
- [ ] US-3.3.3: Human Verification Workflow [NEW]
- [ ] US-3.3.4: Nuanced Compliance Status [NEW]
- [ ] US-3.3.5: AI Disclaimer and Attribution [NEW]
- [ ] US-3.3.6: Detailed Remarks Generation
- [ ] US-3.3.7: ACR Document Export
- [ ] US-3.3.8: ACR Versioning and History

---

## ⚠️ High Risk Sprint Mitigation

This sprint has +24 story points from research-driven additions.

**Recommended Mitigation (Option C):**
Implement basic ACR generation (US-3.3.1) in Sprint 3. Defer verification workflow (US-3.3.3) to Sprint 7 polish phase. This preserves the London Book Fair timeline while ensuring core functionality for demo.

---

*End of Sprint 3 Replit Prompts v4.0*
