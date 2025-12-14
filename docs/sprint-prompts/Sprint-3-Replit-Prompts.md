# Sprint 3 Replit Prompts
## PDF/EPUB Accessibility + ACR Generation + Alt-Text AI

**Version:** 4.0 — Merged Scope with ACR Research  
**Sprint Duration:** December 20, 2025 - January 10, 2026  
**Total Story Points:** 120

---

## ⚠️ Critical Terminology

> **VPAT** = Blank template from ITI (Information Technology Industry Council)  
> **ACR** = Accessibility Conformance Report (the completed deliverable)  
> All code, APIs, and documentation must use correct ACR terminology.

---

## Sprint 3 Technical Standards

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

## Epic 3.1: PDF Accessibility Audit

### US-3.1.1: PDF Structure Validation (5 pts)

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

```
Create a PDF structure validation service that checks WCAG 2.2 compliance.

**Create file: `src/services/accessibility/pdf-structure-validator.service.ts`**

Implement these interfaces:

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
POST /api/v1/accessibility/validate/structure
Body: { jobId: string } or { fileId: string }
Response: StructureValidationResult

**Update file: `src/routes/accessibility.routes.ts`**

Register the new endpoint with authentication middleware.

**Implementation Notes:**
- Use the existing PDF structure analyzer from Sprint 2
- Store validation results in the ValidationResult table with jobId reference
- Log validation duration for performance monitoring
- Handle edge cases: untagged PDFs should return a critical error, not crash
```

#### Acceptance Criteria
- [ ] Given a PDF is submitted for validation
- [ ] When accessibility check runs
- [ ] Then verify document has proper heading hierarchy (H1→H2→H3, no skips)
- [ ] And verify reading order is logical and sequential (Criterion 1.3.2)
- [ ] And verify language is declared in document metadata (Criterion 3.1.1)
- [ ] And each issue includes WCAG criterion number, severity, location, and remediation suggestion

---

### US-3.1.2: Alt Text Validation (8 pts)

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

```
Create an alt text validation service for WCAG 1.1.1 compliance.

**Create file: `src/services/accessibility/validators/alt-text-validator.ts`**

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
  qualityFlags: string[]; // e.g., ['too_short', 'filename_as_alt', 'starts_with_image_of']
}

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
async validateAltText(jobId: string): Promise<AltTextValidationResult>

**Update `src/controllers/accessibility.controller.ts`**

Add endpoint:
POST /api/v1/accessibility/validate/alt-text
Body: { jobId: string }
Response: AltTextValidationResult

**Implementation Notes:**
- Decorative images without alt text are COMPLIANT (not a violation)
- Empty alt text (alt="") is valid for decorative images
- Report includes thumbnails (already generated in Sprint 2) for review context
- Consider memory efficiency when processing documents with hundreds of images
```

#### Acceptance Criteria
- [ ] Given a PDF is submitted for validation
- [ ] When alt text check runs
- [ ] Then identify all images in the document
- [ ] And check each image for /Alt attribute
- [ ] And identify decorative images (marked as Artifact)
- [ ] And calculate compliance percentage (e.g., 387/412 = 94%)
- [ ] And generate issues for missing alt text with WCAG 1.1.1 reference

---

### US-3.1.3: Color Contrast Analysis (5 pts)

#### Context
Implementing WCAG 1.4.3 color contrast validation to ensure text is readable.

#### Prerequisites
- US-3.1.1 complete
- PDF text extraction working

#### Objective
Create color contrast analysis service using WCAG luminance formula.

#### Technical Requirements

```
Build a color contrast analysis service for PDF documents.

**Create file: `src/services/accessibility/validators/contrast-validator.ts`**

interface ContrastValidationResult {
  totalTextElements: number;
  passing: number;
  failing: number;
  issues: ContrastIssue[];
}

interface ContrastIssue {
  page: number;
  elementId: string;
  text: string;
  foregroundColor: string; // hex
  backgroundColor: string; // hex
  contrastRatio: number;
  requiredRatio: number;
  isLargeText: boolean;
  wcagCriterion: '1.4.3' | '1.4.6';
}

**Implementation:**

1. Extract text color (fill color) and background color for each text element
2. Calculate relative luminance using WCAG formula:
   L = 0.2126*R + 0.7152*G + 0.0722*B (where R, G, B are linearized)
3. Calculate contrast ratio: (L1 + 0.05) / (L2 + 0.05)
4. Apply WCAG thresholds:
   - 4.5:1 for normal text (WCAG 1.4.3 AA)
   - 3:1 for large text (≥18pt or ≥14pt bold)
   - 7:1 for enhanced contrast (WCAG 1.4.6 AAA)
5. Handle edge cases:
   - Transparent backgrounds: sample from rendered page
   - Gradients: check worst-case contrast
   - Images behind text: flag for manual review

**Create API endpoint:**
POST /api/v1/accessibility/validate/contrast
Body: { jobId: string }
Response: ContrastValidationResult
```

#### Acceptance Criteria
- [ ] Extract foreground and background colors for all text elements
- [ ] Calculate contrast ratio using WCAG luminance formula
- [ ] Apply thresholds: 4.5:1 normal text, 3:1 large text
- [ ] Handle transparency and gradient backgrounds
- [ ] Report failing elements with page, location, and actual ratio

---

### US-3.1.4: Table Accessibility Validation (5 pts)

#### Context
Tables are critical for data accessibility. This validates proper table markup for screen readers.

#### Prerequisites
- US-3.1.1 complete

#### Technical Requirements

```
Create table accessibility validation service.

**Create file: `src/services/accessibility/validators/table-validator.ts`**

interface TableValidationResult {
  totalTables: number;
  compliantTables: number;
  issues: TableIssue[];
}

interface TableIssue {
  tableId: string;
  page: number;
  issueType: 'missing_headers' | 'missing_scope' | 'missing_id_headers' | 'layout_table_marked_data' | 'complex_table_needs_summary';
  description: string;
  remediation: string;
}

**Validation checks:**

1. **Header Cells (WCAG 1.3.1)**
   - Verify tables have TH elements for headers
   - Check TH elements have scope attribute (row/col/rowgroup/colgroup)

2. **Complex Tables**
   - Detect tables with merged cells (colspan/rowspan)
   - Verify complex tables use id/headers attributes
   - Check for table summary/caption

3. **Layout vs Data Tables**
   - Detect tables used for layout (should be marked role="presentation")
   - Flag data tables missing structure
   - Detect misuse patterns (single-column tables, nested layout tables)

**Create API endpoint:**
POST /api/v1/accessibility/validate/tables
Body: { jobId: string }
Response: TableValidationResult
```

#### Acceptance Criteria
- [ ] Validate TH elements have scope attributes
- [ ] Check header-data cell associations
- [ ] Detect layout tables vs. data tables
- [ ] Verify complex tables have id/headers attributes

---

### US-3.1.5: PDF/UA Compliance Check (5 pts)

#### Context
PDF/UA (ISO 14289-1) is the international standard for PDF accessibility. Using Matterhorn Protocol for validation.

#### Prerequisites
- US-3.1.1 through US-3.1.4 complete

#### Technical Requirements

```
Create PDF/UA compliance validation using Matterhorn Protocol.

**Create file: `src/services/accessibility/pdfua-validator.service.ts`**

interface PdfUaValidationResult {
  isPdfUaCompliant: boolean;
  pdfUaVersion: string | null; // '1' or '2' or null
  matterhornCheckpoints: MatterhornCheckpoint[];
  summary: {
    passed: number;
    failed: number;
    manual: number;
  };
}

interface MatterhornCheckpoint {
  id: string; // e.g., "01-001", "07-001"
  category: string;
  description: string;
  status: 'pass' | 'fail' | 'manual';
  details?: string;
}

**Validation checks:**

1. **PDF/UA Identifier**
   - Check XMP metadata for pdfuaid:part=1 (or part=2)
   - Verify document is marked as tagged (Marked = true in MarkInfo)

2. **Structure Tree**
   - Validate structure tree contains all content
   - Check no content is untagged
   - Verify proper tag nesting

3. **Figure Alt Text**
   - All Figure tags have Alt or ActualText attribute
   - Artifact-marked decorative images are excluded

4. **Table Structure**
   - TH elements have Scope attribute
   - Complex tables have proper id/headers

5. **Language**
   - Document Lang specified
   - Language changes marked with Lang attribute

6. **Unicode Mapping**
   - All fonts have Unicode mappings (ToUnicode)
   - No text relies on visual appearance only

**Create API endpoint:**
POST /api/v1/accessibility/validate/pdfua
Body: { jobId: string }
Response: PdfUaValidationResult
```

#### Acceptance Criteria
- [ ] Check PDF/UA identifier presence (pdfuaid:part=1)
- [ ] Validate document is tagged (Marked = true)
- [ ] Verify structure tree completeness
- [ ] Check all figures have Alt or ActualText
- [ ] Validate Unicode mappings for all fonts

---

## Epic 3.2: Section 508 Mapping

### US-3.2.1: Section 508 Mapping Engine (5 pts)

#### Context
> 🔬 **RESEARCH DRIVER:** Section 508 uses 'Best Meets' standard - vendors don't need perfect compliance, they need better documentation than competitors. A detailed, honest ACR showing 85% compliance often defeats a competitor with no documentation.

#### Prerequisites
- US-3.1.1 through US-3.1.5 complete
- WCAG validation results available

#### Objective
Create a service that maps WCAG validation results to Section 508 criteria and provides competitive positioning guidance.

#### Technical Requirements

```
Create Section 508 mapping service with "Best Meets" guidance.

**Create file: `src/services/compliance/section508-mapper.service.ts`**

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

**Create mapping table: `src/data/section508-wcag-mapping.ts`**

Map WCAG 2.1 criteria to Section 508 sections including:
- E205 (Electronic Content)
- E205.4 (PDF/UA requirements)
- Chapter 3 (Functional Performance Criteria)
- Chapter 6 (Support Documentation)

**Add "Best Meets" guidance generator:**

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

**Create API endpoint:**
POST /api/v1/compliance/section508/map
Body: { jobId: string }
Response: Section508MappingResult
```

#### Acceptance Criteria
- [ ] Map WCAG 2.1 AA criteria to Section 508 requirements (E205, E206)
- [ ] Include E205.4 (PDF/UA requirements) validation
- [ ] Generate 'Best Meets' guidance when partial compliance exists
- [ ] Suggest competitive positioning language for procurement responses

---

### US-3.2.2: Functional Performance Criteria - Chapter 3 (5 pts)

#### Context
Chapter 3 of Section 508 covers Functional Performance Criteria for assistive technology compatibility.

#### Prerequisites
- US-3.2.1 complete

#### Technical Requirements

```
Create Chapter 3 FPC validation service.

**Create file: `src/services/compliance/fpc-validator.service.ts`**

interface FpcValidationResult {
  criteria: FpcCriterion[];
  summary: {
    applicable: number;
    supported: number;
    partiallySupported: number;
  };
}

interface FpcCriterion {
  id: string; // e.g., "302.1", "302.2"
  title: string;
  description: string;
  wcagMapping: string[];
  status: ConformanceLevel;
  remarks: string;
  testMethod: string;
}

**Implement FPC mappings:**

302.1 Without Vision
- Maps to: WCAG 1.1.1, 1.3.1, 1.3.2, 1.4.1, 4.1.2
- Check: All content available via screen reader

302.2 With Limited Vision  
- Maps to: WCAG 1.4.3, 1.4.4, 1.4.10, 1.4.12
- Check: Text resizable, contrast adequate

302.3 Without Perception of Color
- Maps to: WCAG 1.4.1
- Check: Color not sole means of conveying info

302.4 Without Hearing
- Maps to: WCAG 1.2.1, 1.2.2, 1.2.3
- Check: Captions, transcripts for audio

302.5 With Limited Hearing
- Maps to: WCAG 1.2.1, 1.2.2
- Check: Audio clarity, captions available

302.6 Without Speech
- Maps to: WCAG 2.1.1
- Check: No voice-only input required

302.7 With Limited Manipulation
- Maps to: WCAG 2.1.1, 2.4.7
- Check: Keyboard accessible

302.8 With Limited Reach and Strength
- Maps to: WCAG 2.4.1, 2.4.3
- Check: No precise movements required

302.9 With Limited Language, Cognitive, and Learning Abilities
- Maps to: WCAG 3.1.5, 3.2.3, 3.2.4
- Check: Clear language, consistent navigation
```

#### Acceptance Criteria
- [ ] Validate 302.1 Without Vision requirements
- [ ] Validate 302.2 With Limited Vision requirements
- [ ] Map functional criteria to WCAG success criteria

---

### US-3.2.3: Support Documentation - Chapter 6 (3 pts)

#### Context
Chapter 6 requires accessible support documentation.

#### Prerequisites
- US-3.2.1 complete

#### Technical Requirements

```
Create Chapter 6 documentation validation.

**Create file: `src/services/compliance/documentation-validator.service.ts`**

interface DocumentationValidationResult {
  hasAccessibilityDocumentation: boolean;
  documentationAccessible: boolean;
  issues: DocumentationIssue[];
}

**Validation checks:**

602.3 Electronic Support Documentation
- Check if accessibility documentation exists
- Verify documentation itself is accessible
- Check for multiple format availability

602.4 Alternate Formats
- Documentation available in alternative formats
- Braille, large print, audio upon request

**Generate checklist for manual verification:**
- [ ] Accessibility statement available
- [ ] Contact method for accessibility requests
- [ ] Documentation in accessible format
```

#### Acceptance Criteria
- [ ] Check for accessibility documentation presence
- [ ] Validate documentation format accessibility

---

## Epic 3.3: ACR Generation (Research-Enhanced)

> ⚠️ **This epic includes 4 NEW stories from ACR research findings addressing legal, credibility, and compliance requirements.**

### US-3.3.1: Multi-Edition ACR Support (8 pts)

#### Context
> 🔬 **RESEARCH DRIVER:** VPAT 2.5 INT Edition is emerging as 'Gold Standard' for multinational vendors, satisfying US (Section 508), EU (EN 301 549), and global requirements in a single document. Should be default recommendation.

#### Prerequisites
- US-3.2.1 through US-3.2.3 complete
- Section 508 mapping available

#### Objective
Create ACR generation service with INT Edition as the default recommendation.

#### Technical Requirements

```
Create ACR generation service supporting all VPAT 2.5 editions.

**Create file: `src/services/acr/acr-generator.service.ts`**

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

interface ProductInfo {
  name: string;
  version: string;
  description: string;
  vendor: string;
  contactEmail: string;
  evaluationDate: Date;
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

**Create edition templates: `src/services/acr/templates/`**
- vpat-508-template.ts (Section 508 criteria only)
- vpat-wcag-template.ts (WCAG 2.x criteria)
- vpat-eu-template.ts (EN 301 549 mapping)
- vpat-int-template.ts (All standards combined)

**Create API endpoints:**
POST /api/v1/acr/generate
Body: { jobId: string, options: AcrGenerationOptions }
Response: AcrDocument

GET /api/v1/acr/editions
Response: { editions: AcrEdition[], recommended: 'VPAT2.5-INT' }
```

#### Acceptance Criteria
- [ ] INT Edition recommended as default for maximum coverage
- [ ] Support Section 508 Edition (US Federal only)
- [ ] Support WCAG Edition (General accessibility)
- [ ] Support EU Edition (EN 301 549 for European Accessibility Act)
- [ ] Tooltip explains: 'INT Edition satisfies US Section 508, EU EN 301 549, and WCAG requirements in one document'

---

### US-3.3.2: Confidence Level Indicators (5 pts) — NEW

#### Context
> 🔬 **RESEARCH DRIVER:** Automated accessibility scanners only detect 30-57% of WCAG failures. Human verification is mandatory for credible reporting. AI cannot 'use' a screen reader; it can only predict text about screen readers.

#### Prerequisites
- US-3.1.1 through US-3.2.3 complete
- Validation results with detection method metadata

#### Objective
Add confidence level indicators to each automated check so users know which items require human verification.

#### Technical Requirements

```
Create confidence level analysis service.

**Create file: `src/services/acr/confidence-analyzer.service.ts`**

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

// HIGH confidence criteria (fully automatable)
const HIGH_CONFIDENCE_CRITERIA = [
  '1.4.3',  // Color contrast (formula-based)
  '3.1.1',  // Language of page (presence check)
  '4.1.1',  // Parsing (validation)
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

**Update database schema: `prisma/schema.prisma`**

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

**Create API endpoint:**
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
- [ ] HIGH (90%+): Automated verification reliable
- [ ] MEDIUM (60-89%): Automated + spot check recommended
- [ ] LOW (<60%): Automated flagging only, human review required
- [ ] MANUAL REQUIRED: Criteria that cannot be automated
- [ ] Dashboard shows count of items requiring human verification

---

### US-3.3.3: Human Verification Workflow (8 pts) — NEW

#### Context
> 🔬 **RESEARCH DRIVER:** Audit trails required for legal defensibility (who verified what and when). ACR cannot be finalized until all required items are human-reviewed.

#### Prerequisites
- US-3.3.2 (Confidence Level Indicators) complete

#### Objective
Create a verification workflow for human review of automated results with complete audit trails.

#### Technical Requirements

```
Create human verification workflow service.

**Create file: `src/services/acr/human-verification.service.ts`**

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

**Update database schema:**

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

**Create API endpoints:**

GET /api/v1/verification/:jobId/queue
Response: VerificationQueue

POST /api/v1/verification/:itemId/submit
Body: { status, method, notes }
Response: VerificationRecord

GET /api/v1/verification/:jobId/audit-log
Response: { records: VerificationRecord[], exportUrl: string }

GET /api/v1/acr/:jobId/can-finalize
Response: { canFinalize: boolean, blockers: string[] }

**Create React component: `src/components/verification/VerificationQueue.tsx`**

Display verification queue with:
- Filter by severity, confidence level, status
- Progress indicator: "X of Y items verified"
- Method selector (NVDA, JAWS, VoiceOver, Manual Review)
- Notes field for each verification
- Bulk verification for similar items
```

#### Acceptance Criteria
- [ ] LOW/MANUAL items appear in verification queue
- [ ] Reviewer can mark: VERIFIED (pass), VERIFIED (fail), VERIFIED (partial), DEFERRED
- [ ] Each verification records: timestamp, reviewer ID, method used, notes
- [ ] ACR cannot be 'Final' until all CRITICAL severity items verified
- [ ] Audit log exportable for compliance documentation

---

### US-3.3.4: Nuanced Compliance Status (5 pts) — NEW

#### Context
> 🔬 **RESEARCH DRIVER:** Sophisticated procurement teams view reports claiming 100% 'Supports' ratings as indicators of fraud or incompetence. Credible ACRs require nuanced partial compliance with detailed 'Remarks and Explanations.'

#### Prerequisites
- US-3.3.3 (Human Verification Workflow) complete

#### Objective
Implement accurate conformance level determination that prevents overstated compliance and requires detailed remarks.

#### Technical Requirements

```
Create nuanced conformance determination engine.

**Create file: `src/services/acr/conformance-engine.service.ts`**

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

**Create remarks validation:**

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

  return { valid: errors.length === 0, errors };
}

**Create API endpoint:**
POST /api/v1/acr/:jobId/validate-credibility
Response: { credible: boolean, warnings: CredibilityWarning[] }
```

#### Acceptance Criteria
- [ ] 'Supports' requires human verification (never auto-populated)
- [ ] 'Partially Supports' requires mandatory Remarks (what works AND what doesn't)
- [ ] 'Does Not Support' requires mandatory Remarks (limitations)
- [ ] 'Not Applicable' requires justification
- [ ] **CRITICAL:** System WARNS if >95% criteria marked 'Supports' (red flag)
- [ ] Remarks include quantitative data (e.g., '387 of 412 images have alt text')

---

### US-3.3.5: AI Disclaimer and Attribution (3 pts) — NEW

#### Context
> 🔬 **RESEARCH DRIVER:** AI-generated compliance reports carry significant legal peril due to confident but inaccurate assertions. FTC fined accessibility overlay provider $1 million (January 2025) for deceptive claims that AI tool could make websites compliant.

#### Prerequisites
- US-3.3.4 (Nuanced Compliance Status) complete

#### Objective
Add clear attribution distinguishing AI-detected findings from human-verified findings to reduce legal liability.

#### Technical Requirements

```
Create AI attribution and disclaimer service.

**Create file: `src/services/acr/attribution.service.ts`**

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

**Update ACR export templates:**

Add to all exported ACR documents:
1. Methodology section near the beginning
2. Attribution tags in remarks column: [AUTOMATED], [AI-SUGGESTED], [HUMAN-VERIFIED]
3. Legal disclaimer in footer
4. Alt text suggestions clearly marked: "AI-Suggested - Requires Review"

**Create API endpoint:**
GET /api/v1/acr/:jobId/methodology
Response: MethodologySection
```

#### Acceptance Criteria
- [ ] Each finding tagged: [AUTOMATED], [AI-SUGGESTED], or [HUMAN-VERIFIED]
- [ ] ACR includes 'Assessment Methodology' section
- [ ] Methodology lists tools (e.g., 'Ninja Platform v1.0 using Google Gemini')
- [ ] Legal disclaimer in ACR footer
- [ ] Alt text suggestions marked 'AI-Suggested - Requires Review'

---

### US-3.3.6: Detailed Remarks Generation (5 pts)

#### Context
AI-assisted remarks generation with quantitative data for credible reporting.

#### Prerequisites
- US-3.3.4 complete

#### Technical Requirements

```
Create AI-assisted remarks generation service.

**Create file: `src/services/acr/remarks-generator.service.ts`**

interface RemarksGenerationRequest {
  criterionId: string;
  wcagCriterion: string;
  validationResults: ValidationResult[];
  conformanceLevel: ConformanceLevel;
}

interface GeneratedRemarks {
  remarks: string;
  quantitativeData: QuantitativeData[];
  aiGenerated: boolean;
  suggestedEdits: string[];
}

interface QuantitativeData {
  metric: string;
  value: number;
  total: number;
  percentage: number;
}

async function generateRemarks(
  request: RemarksGenerationRequest
): Promise<GeneratedRemarks> {
  // Use Gemini to generate remarks
  // Include specific counts from validation results
  // Flag as AI-generated
}

**Example output:**
{
  remarks: "Alt text is present for 387 of 412 images (94%). 
            25 images are marked as decorative. 
            Remaining images require manual review for alt text quality.",
  quantitativeData: [
    { metric: "Images with alt text", value: 387, total: 412, percentage: 94 },
    { metric: "Decorative images", value: 25, total: 412, percentage: 6 }
  ],
  aiGenerated: true,
  suggestedEdits: ["Consider adding specific alt text examples", "Mention screen reader testing results"]
}

**Create API endpoint:**
POST /api/v1/acr/generate-remarks
Body: RemarksGenerationRequest
Response: GeneratedRemarks
```

#### Acceptance Criteria
- [ ] Generate remarks using Gemini AI
- [ ] Include specific counts (e.g., '387 of 412 images')
- [ ] Allow manual editing of AI-generated remarks

---

### US-3.3.7: ACR Document Export (5 pts)

#### Context
Export ACRs in multiple formats with attribution and methodology.

#### Prerequisites
- US-3.3.1 through US-3.3.6 complete

#### Technical Requirements

```
Create ACR export service supporting multiple formats.

**Create file: `src/services/acr/acr-exporter.service.ts`**

type ExportFormat = 'docx' | 'pdf' | 'html';

interface ExportOptions {
  format: ExportFormat;
  includeMethodology: boolean;
  includeAttribution: boolean;
  branding?: BrandingOptions;
}

async function exportAcr(
  acrId: string,
  options: ExportOptions
): Promise<ExportResult> {
  // Generate document in requested format
  // Include methodology section
  // Include attribution tags
  // Apply branding if provided
}

**Word Export (using docx library):**
- Match ITI VPAT 2.5 template structure exactly
- Include tables with proper formatting
- Add attribution tags in remarks column
- Include methodology section

**PDF Export (using pdf-lib):**
- Generate accessible/tagged PDF
- Include document structure tags
- Support digital signature placeholder

**HTML Export:**
- Responsive design for web publication
- WCAG compliant HTML structure
- Include stylesheet for printing

**Create API endpoint:**
POST /api/v1/acr/:acrId/export
Body: ExportOptions
Response: { downloadUrl: string, expiresAt: Date }
```

#### Acceptance Criteria
- [ ] Export to Word (.docx) matching ITI template
- [ ] Export to accessible PDF (tagged)
- [ ] Export to HTML for web publication
- [ ] Include attribution tags and methodology section

---

### US-3.3.8: ACR Versioning and History (5 pts)

#### Context
Track ACR changes over time for compliance documentation.

#### Prerequisites
- US-3.3.7 complete

#### Technical Requirements

```
Create ACR versioning service.

**Create file: `src/services/acr/acr-versioning.service.ts`**

interface AcrVersion {
  id: string;
  acrId: string;
  version: number;
  createdAt: Date;
  createdBy: string;
  changeLog: ChangeLogEntry[];
  snapshot: AcrDocument;
}

interface ChangeLogEntry {
  field: string;
  previousValue: any;
  newValue: any;
  reason?: string;
}

async function createVersion(
  acrId: string,
  userId: string,
  reason?: string
): Promise<AcrVersion> {
  // Increment version number
  // Create snapshot of current state
  // Generate change log from previous version
}

async function compareVersions(
  acrId: string,
  versionA: number,
  versionB: number
): Promise<VersionComparison> {
  // Return side-by-side comparison
  // Highlight changes
}

**Create API endpoints:**
GET /api/v1/acr/:acrId/versions
Response: AcrVersion[]

GET /api/v1/acr/:acrId/versions/:version
Response: AcrVersion

GET /api/v1/acr/:acrId/compare?v1=1&v2=2
Response: VersionComparison
```

#### Acceptance Criteria
- [ ] Version numbers auto-increment on changes
- [ ] Change history with timestamps and user
- [ ] Compare versions side-by-side

---

## Epic 3.4: Alt-Text AI

### US-3.4.1: Photo Alt-Text Generation (5 pts)

#### Context
AI-generated alt text using Google Gemini Vision for photographs.

#### Prerequisites
- Image extraction service complete
- Gemini API integration available

#### Technical Requirements

```
Create AI-powered alt text generator for photographs.

**Create file: `src/services/alt-text/photo-alt-generator.service.ts`**

interface AltTextGenerationResult {
  imageId: string;
  shortAlt: string;        // <125 chars
  extendedAlt: string;     // up to 250 chars
  confidence: number;      // 0-100
  flags: AltTextFlag[];
  aiModel: string;
  generatedAt: Date;
}

type AltTextFlag = 
  | 'FACE_DETECTED'
  | 'TEXT_IN_IMAGE'
  | 'LOW_CONFIDENCE'
  | 'SENSITIVE_CONTENT'
  | 'COMPLEX_SCENE';

async function generatePhotoAltText(
  imageBuffer: Buffer,
  context?: DocumentContext
): Promise<AltTextGenerationResult> {
  // Use Gemini Pro Vision to analyze image
  // Generate alt text following accessibility best practices:
  // - Concise (under 125 chars for alt, up to 250 for aria-describedby)
  // - Describe subjects, actions, setting, colors when relevant
  // - Never start with "Image of", "Photo of", "Picture of"
  // - Use present tense

  // Implement confidence scoring (0-100)
  // Flag for human review when:
  // - Confidence < 70%
  // - Face detection triggers
  // - Potentially sensitive content detected
}

**Gemini prompt template:**
const ALT_TEXT_PROMPT = `
Describe this image for someone who cannot see it.
- Be concise (under 125 characters preferred)
- Focus on: subjects, actions, setting, important colors
- Do NOT start with "Image of", "Photo of", or "Picture of"
- Use present tense
- If text appears in the image, include it
- Return JSON: { shortAlt: string, extendedAlt: string, confidence: number, flags: string[] }
`;

**Create API endpoint:**
POST /api/v1/alt-text/generate
Body: { imageId: string, context?: DocumentContext }
Response: AltTextGenerationResult
```

#### Acceptance Criteria
- [ ] Generate concise descriptions (<125 chars short, up to 250 extended)
- [ ] Describe subjects, actions, setting, colors when relevant
- [ ] Never start with 'Image of' or 'Photo of'
- [ ] Flag for human review when confidence <70% or faces detected

---

### US-3.4.2: Context-Aware Description (5 pts)

#### Context
Alt text that considers surrounding document context.

#### Prerequisites
- US-3.4.1 complete

#### Technical Requirements

```
Extend alt text generator to incorporate document context.

**Create file: `src/services/alt-text/context-extractor.service.ts`**

interface DocumentContext {
  textBefore: string;      // Up to 500 chars before image
  textAfter: string;       // Up to 500 chars after image
  nearestHeading: string;
  caption?: string;
  documentTitle: string;
  chapterTitle?: string;
}

async function extractContext(
  jobId: string,
  imageId: string
): Promise<DocumentContext> {
  // Extract text surrounding the image
  // Find nearest heading
  // Detect caption
  // Get document and chapter titles
}

**Update photo-alt-generator.service.ts:**

async function generateContextAwareAltText(
  imageBuffer: Buffer,
  context: DocumentContext
): Promise<{
  contextAware: AltTextGenerationResult;
  standalone: AltTextGenerationResult;
}> {
  // Generate both versions
  // Context-aware: References surrounding content
  // Standalone: Works without document context
}

**Create API endpoint:**
POST /api/v1/alt-text/generate-contextual
Body: { imageId: string, jobId: string }
Response: { contextAware: AltTextGenerationResult, standalone: AltTextGenerationResult }
```

#### Acceptance Criteria
- [ ] Extract text before/after image (within 500 chars)
- [ ] Include heading and caption as context
- [ ] Return both context-aware and standalone versions

---

### US-3.4.3: Chart/Diagram Descriptions (5 pts)

#### Context
Specialized descriptions for data visualizations.

#### Prerequisites
- US-3.4.1 complete

#### Technical Requirements

```
Create specialized alt text generator for charts and diagrams.

**Create file: `src/services/alt-text/chart-diagram-generator.service.ts`**

type ImageType = 
  | 'BAR_CHART'
  | 'LINE_CHART'
  | 'PIE_CHART'
  | 'SCATTER_PLOT'
  | 'FLOWCHART'
  | 'ORG_CHART'
  | 'DIAGRAM'
  | 'TABLE_IMAGE'
  | 'MAP'
  | 'INFOGRAPHIC'
  | 'PHOTO';

interface ChartDescription {
  imageType: ImageType;
  shortAlt: string;
  longDescription: string;
  dataTable?: DataTableRow[];
  trends?: string[];
  keyFindings?: string[];
}

async function generateChartDescription(
  imageBuffer: Buffer
): Promise<ChartDescription> {
  // Classify image type
  // Extract data if possible
  // Generate appropriate description
}

**Gemini prompt for charts:**
const CHART_PROMPT = `
Analyze this chart or diagram.
1. Identify the type (bar chart, line chart, pie chart, flowchart, etc.)
2. Extract axis labels and data series names if visible
3. Identify key trends or patterns
4. Generate:
   - Short alt text (under 125 chars summarizing the visualization)
   - Long description (detailed explanation of all data)
   - Data table (if extractable)
Return JSON: { imageType, shortAlt, longDescription, dataTable?, trends?, keyFindings? }
`;

**Create API endpoint:**
POST /api/v1/alt-text/generate-chart
Body: { imageId: string }
Response: ChartDescription
```

#### Acceptance Criteria
- [ ] Detect image type: chart, diagram, flowchart, table image, map
- [ ] Extract data points and describe trends
- [ ] Generate data tables for complex charts

---

### US-3.4.4: Human Review Workflow (5 pts)

#### Context
Review and approve AI-generated alt text before publishing.

#### Prerequisites
- US-3.4.1 through US-3.4.3 complete

#### Technical Requirements

```
Build human review workflow for alt text.

**Create API endpoints:**

GET /api/v1/alt-text/:jobId/review-queue
Response: {
  totalImages: number;
  pendingReview: number;
  approved: number;
  items: AltTextReviewItem[];
}

interface AltTextReviewItem {
  imageId: string;
  thumbnailUrl: string;
  generatedAlt: AltTextGenerationResult;
  status: 'pending' | 'approved' | 'edited' | 'regenerated';
  confidence: number;
  flags: AltTextFlag[];
}

PUT /api/v1/alt-text/:imageId/approve
Body: { altText?: string } // Optional override
Response: { success: boolean }

POST /api/v1/alt-text/:imageId/regenerate
Body: { additionalContext?: string }
Response: AltTextGenerationResult

POST /api/v1/alt-text/batch-approve
Body: { imageIds: string[], minConfidence: number }
Response: { approved: number, skipped: number }

**Create React components:**
- src/components/alt-text/ReviewQueue.tsx
- src/components/alt-text/ReviewCard.tsx
- src/components/alt-text/ConfidenceIndicator.tsx
- src/components/alt-text/BatchApprovalModal.tsx
```

#### Acceptance Criteria
- [ ] Display image alongside generated alt text
- [ ] Show confidence score and review flags
- [ ] Approve, edit, or regenerate with different parameters
- [ ] Batch approval for high-confidence items

---

### US-3.4.5: Long Description Support (3 pts)

#### Context
Extended descriptions for complex images with aria-describedby support.

#### Prerequisites
- US-3.4.3 complete

#### Technical Requirements

```
Implement long description generator for complex images.

**Create file: `src/services/alt-text/long-description-generator.service.ts`**

interface LongDescription {
  id: string;
  imageId: string;
  content: {
    html: string;
    plainText: string;
    markdown: string;
  };
  wordCount: number;
  generatedAt: Date;
}

// Trigger conditions for long descriptions
const LONG_DESCRIPTION_TRIGGERS = [
  'COMPLEX_CHART',      // Multiple data series
  'MANY_COMPONENTS',    // >5 distinct elements
  'DENSE_INFORMATION',  // High information density
  'MANUAL_REQUEST',     // User requested
];

async function generateLongDescription(
  imageId: string,
  trigger: string
): Promise<LongDescription> {
  // Generate detailed prose description (up to 500 words)
  // Structure with headings for data
  // Include all data points from charts
  // Describe spatial relationships
}

**Create API endpoints:**

POST /api/v1/alt-text/:imageId/long-description
Body: { trigger?: string }
Response: LongDescription

GET /api/v1/alt-text/:imageId/long-description
Response: LongDescription | null
```

#### Acceptance Criteria
- [ ] Generate descriptions up to 500 words for complex images
- [ ] Support HTML, plain text, and Markdown formats
- [ ] Generate aria-describedby compatible markup

---

## Epic 3.5: EPUB & Remediation

### US-3.5.1: EPUB Accessibility Audit (5 pts)

#### Context
EPUB validation using EPUBCheck and Ace by DAISY.

#### Prerequisites
- File upload infrastructure complete
- Java runtime available for EPUBCheck

#### Technical Requirements

```
Create EPUB accessibility audit service.

**Create file: `src/services/epub/epub-audit.service.ts`**

interface EpubAuditResult {
  epubCheckResult: EpubCheckResult;
  aceResult: AceResult;
  combinedIssues: AccessibilityIssue[];
  accessibilityMetadata: EpubAccessibilityMetadata;
}

interface EpubCheckResult {
  isValid: boolean;
  epubVersion: '2.0' | '3.0' | '3.2';
  errors: EpubMessage[];
  warnings: EpubMessage[];
}

interface AceResult {
  score: number;
  violations: AceViolation[];
  metadata: {
    conformsTo: string[];
    accessMode: string[];
    accessibilityFeature: string[];
    accessibilityHazard: string[];
  };
}

async function runEpubAudit(epubPath: string): Promise<EpubAuditResult> {
  // Run EPUBCheck (Java CLI)
  const epubCheckResult = await runEpubCheck(epubPath);

  // Run Ace by DAISY
  const aceResult = await runAce(epubPath);

  // Combine and deduplicate results
  const combinedIssues = combineResults(epubCheckResult, aceResult);

  return { epubCheckResult, aceResult, combinedIssues, accessibilityMetadata };
}

**EPUBCheck integration:**
// java -jar epubcheck.jar file.epub --json output.json

**Ace integration:**
// npx @daisy/ace epubPath --outdir outputDir

**Create API endpoint:**
POST /api/v1/epub/audit
Body: { jobId: string }
Response: EpubAuditResult
```

#### Acceptance Criteria
- [ ] Run EPUBCheck for structure validation
- [ ] Run DAISY Ace for accessibility checking
- [ ] Support EPUB 2 and EPUB 3 formats
- [ ] Check EPUB accessibility metadata presence
- [ ] Combine results into unified issue list

---

### US-3.5.2: Basic Remediation Workflow (8 pts)

#### Context
Guided remediation with auto-fix for simple issues.

#### Prerequisites
- US-3.1.1 through US-3.1.5 complete
- US-3.5.1 complete

#### Technical Requirements

```
Create remediation workflow engine.

**Create file: `src/services/remediation/remediation-engine.service.ts`**

type FixCategory = 
  | 'AUTO_FIX'      // Can fix automatically
  | 'AI_ASSISTED'   // AI can suggest, human approves
  | 'MANUAL';       // Requires manual intervention

interface RemediationPlan {
  jobId: string;
  issues: RemediationItem[];
  progress: {
    total: number;
    autoFixable: number;
    aiAssisted: number;
    manual: number;
    completed: number;
  };
}

interface RemediationItem {
  issueId: string;
  category: FixCategory;
  description: string;
  currentValue?: string;
  suggestedValue?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
}

// Auto-fixable issues (using pdf-lib)
const AUTO_FIX_RULES = [
  'MISSING_TITLE',        // Set from filename or first heading
  'MISSING_LANGUAGE',     // Detect from content
  'MISSING_PDFUA_ID',     // Add PDF/UA identifier
  'MISSING_TAGGED_FLAG',  // Mark document as tagged
];

async function createRemediationPlan(jobId: string): Promise<RemediationPlan> {
  // Categorize all issues
  // Identify auto-fixable items
  // Prioritize by severity
}

async function executeAutoFix(
  jobId: string,
  issueId: string
): Promise<FixResult> {
  // Apply automatic fix using pdf-lib
  // Re-validate to confirm fix
  // Update issue status
}

**Create API endpoints:**

GET /api/v1/remediation/:jobId/plan
Response: RemediationPlan

POST /api/v1/remediation/:jobId/auto-fix
Body: { issueIds?: string[] } // Empty = all auto-fixable
Response: { fixed: number, failed: number, results: FixResult[] }

POST /api/v1/remediation/:jobId/apply-fix/:issueId
Body: { value: string }
Response: FixResult

POST /api/v1/remediation/:jobId/re-validate
Response: ValidationResult
```

#### Acceptance Criteria
- [ ] Auto-fix: document title, language, PDF/UA identifier
- [ ] Guided fix for complex issues: alt text, heading structure
- [ ] Re-validate after fixes applied
- [ ] Track remediation progress

---

## Epic 3.6: Customer Feedback Enhancements

### US-3.6.1: Enhanced Semantic Tagging Audit (3 pts)

#### Context
Customer 1 feedback: "Accurate semantic tagging - tables, lists, footnotes"

#### Technical Requirements

```
Extend WCAG audit with detailed semantic validation.

**Create files in `src/services/accessibility/rules/`:**

tables.rules.ts:
- CHECK_TABLE_HEADERS: First row/column has TH tags
- CHECK_TABLE_SCOPE: TH elements have scope="col" or scope="row"
- CHECK_TABLE_COMPLEX: Multi-level headers use id/headers
- CHECK_TABLE_MERGE: Colspan/rowspan maintain header associations
- CHECK_TABLE_CAPTION: Complex tables have caption or summary
- DETECT_LAYOUT_TABLE: Tables used for layout marked presentational

lists.rules.ts:
- CHECK_LIST_TYPE: Ordered vs unordered correctly identified
- CHECK_LIST_NESTING: Nested lists maintain parent-child
- CHECK_LIST_ITEMS: LI contains complete content
- CHECK_DEFINITION_LIST: DL/DT/DD structure correct
- DETECT_FAKE_LIST: Paragraphs with bullet chars flagged

footnotes.rules.ts:
- CHECK_NOTE_LINK: Reference linked to footnote
- CHECK_NOTE_BACKLINK: Footnote links back to reference
- CHECK_NOTE_ROLE: Notes tagged with Note role
- CHECK_EPUB_FOOTNOTE: epub:type attributes correct

Add comprehensive test cases for each rule.
```

#### Acceptance Criteria
- [ ] Table audit: headers, scope, merged cells, captions
- [ ] List audit: type, nesting, completeness
- [ ] Footnote audit: linkage, back-links, tagging
- [ ] Detect fake structures (paragraph bullets)

---

### US-3.6.2: Reading Order Remediation Workflow (3 pts)

#### Context
Customer 1 feedback: "Consistent PDF remediation - reading order and complex layouts"

#### Technical Requirements

```
Build reading order remediation UI and service.

**Create file: `src/services/remediation/reading-order.service.ts`**

interface ReadingOrderAnalysis {
  pages: PageReadingOrder[];
  issues: ReadingOrderIssue[];
  aiSuggestion?: ReadingOrderSuggestion;
}

interface PageReadingOrder {
  pageNumber: number;
  elements: OrderedElement[];
  layoutType: 'single_column' | 'multi_column' | 'complex';
}

async function analyzeReadingOrder(jobId: string): Promise<ReadingOrderAnalysis> {
  // Extract current tag order from structure tree
  // Detect layout type
  // Flag potential issues
}

async function suggestReadingOrder(
  pageNumber: number,
  pageImageBuffer: Buffer
): Promise<ReadingOrderSuggestion> {
  // Use Gemini Vision to analyze page layout
  // Suggest optimal reading sequence
  // Handle: columns, headers/footers, sidebars, captions
}

**Create React components:**
- src/components/remediation/ReadingOrderEditor.tsx
- src/components/remediation/DraggableElement.tsx
- src/components/remediation/ReadingOrderPreview.tsx

Features:
- Visual page view with numbered elements
- Drag-and-drop reordering
- AI suggestion button
- Preview with text-to-speech simulation
```

#### Acceptance Criteria
- [ ] Visual Order Editor with drag-and-drop
- [ ] AI Order Suggestion for complex layouts
- [ ] Preview mode (screen reader simulation)

---

### US-3.6.3: Audit Evidence & Trail (2 pts)

#### Context
Customer 2 feedback: "You cannot create VPAT without an audit"

#### Technical Requirements

```
Implement audit evidence and trail system.

**Update Prisma schema:**

model AuditSession {
  id              String    @id @default(uuid())
  jobId           String
  documentHash    String    // SHA-256 before audit
  timestamp       DateTime  @default(now())
  checkerVersions Json      // { ninja: "1.0", epubcheck: "5.1", ace: "1.3" }
  standardsSelected String[]
  status          String

  findings        AuditFinding[]
  remediations    RemediationAction[]
  vpats           VpatGeneration[]
}

model AuditFinding {
  id              String    @id @default(uuid())
  sessionId       String
  criterionId     String
  severity        String
  location        Json
  description     String
  status          String    // open, remediated, accepted

  session         AuditSession @relation(fields: [sessionId], references: [id])
}

model RemediationAction {
  id              String    @id @default(uuid())
  sessionId       String
  findingId       String
  actionType      String    // auto, ai, manual
  beforeValue     String?
  afterValue      String?
  userId          String
  timestamp       DateTime  @default(now())

  session         AuditSession @relation(fields: [sessionId], references: [id])
}

**Create API endpoints:**

GET /api/v1/audit/:jobId/trail
Response: { sessions: AuditSession[], timeline: TimelineEvent[] }

GET /api/v1/audit/:sessionId/evidence
Response: { session: AuditSession, findings: AuditFinding[], export: { pdfUrl: string } }
```

#### Acceptance Criteria
- [ ] Capture audit metadata: timestamp, checker version, standards
- [ ] Store findings snapshot with each audit
- [ ] Link ACR to source audit evidence

---

### US-3.6.4: Word/InDesign Import (2 pts)

#### Context
Customer 1 feedback: "Work smoothly with InDesign, Word, and CMS pipelines"

#### Technical Requirements

```
Add document conversion service.

**Create file: `src/services/conversion/document-converter.service.ts`**

type SupportedFormat = 'pdf' | 'epub' | 'docx' | 'doc' | 'idml';

interface ConversionResult {
  originalFile: string;
  convertedFile: string;
  format: SupportedFormat;
  preservedFeatures: string[];
  warnings: string[];
}

async function convertDocument(
  filePath: string,
  targetFormat: 'pdf'
): Promise<ConversionResult> {
  const sourceFormat = detectFormat(filePath);

  switch (sourceFormat) {
    case 'docx':
    case 'doc':
      // Use LibreOffice headless
      // soffice --headless --convert-to pdf:writer_pdf_Export --outdir /output input.docx
      break;
    case 'idml':
      // Parse IDML or flag for InDesign Server
      break;
    case 'indd':
      // Flag as requiring InDesign Server (post-MVP)
      break;
  }
}

**Configure LibreOffice for PDF/UA export:**
// Set accessibility options in conversion

**Create API endpoint:**

POST /api/v1/convert
Body: { jobId: string, targetFormat: 'pdf' }
Response: ConversionResult
```

#### Acceptance Criteria
- [ ] Accept .docx upload, convert via LibreOffice
- [ ] Accept .idml upload, convert to PDF
- [ ] Preserve accessibility features during conversion

---

## Sprint 3 Execution Checklist

### Week 5 (Dec 20-27)
- [ ] US-3.1.1: PDF Structure Validation
- [ ] US-3.1.2: Alt Text Validation
- [ ] US-3.1.3: Color Contrast Analysis
- [ ] US-3.1.4: Table Accessibility Validation
- [ ] US-3.1.5: PDF/UA Compliance Check
- [ ] US-3.2.1: Section 508 Mapping Engine
- [ ] US-3.2.2: Functional Performance Criteria
- [ ] US-3.2.3: Support Documentation

### Week 6 (Dec 28 - Jan 3)
- [ ] US-3.3.1: Multi-Edition ACR Support
- [ ] US-3.3.2: Confidence Level Indicators (NEW)
- [ ] US-3.3.3: Human Verification Workflow (NEW)
- [ ] US-3.3.4: Nuanced Compliance Status (NEW)
- [ ] US-3.3.5: AI Disclaimer and Attribution (NEW)
- [ ] US-3.3.6: Detailed Remarks Generation
- [ ] US-3.3.7: ACR Document Export
- [ ] US-3.3.8: ACR Versioning and History

### Week 7 (Jan 4-10 - Buffer)
- [ ] US-3.4.1: Photo Alt-Text Generation
- [ ] US-3.4.2: Context-Aware Description
- [ ] US-3.4.3: Chart/Diagram Descriptions
- [ ] US-3.4.4: Human Review Workflow
- [ ] US-3.4.5: Long Description Support
- [ ] US-3.5.1: EPUB Accessibility Audit
- [ ] US-3.5.2: Basic Remediation Workflow
- [ ] US-3.6.1: Enhanced Semantic Tagging Audit
- [ ] US-3.6.2: Reading Order Remediation Workflow
- [ ] US-3.6.3: Audit Evidence & Trail
- [ ] US-3.6.4: Word/InDesign Import

---

## Summary

| Epic | Stories | Points |
|------|---------|--------|
| 3.1 PDF Accessibility Audit | 5 | 28 |
| 3.2 Section 508 Mapping | 3 | 13 |
| 3.3 ACR Generation | 8 | 41 |
| 3.4 Alt-Text AI | 5 | 23 |
| 3.5 EPUB & Remediation | 2 | 13 |
| 3.6 Customer Feedback | 4 | 10 |
| **Total** | **27** | **128** |

*Note: Buffer of -8 points recommended due to high scope.*

---

*End of Sprint 3 Replit Prompts v4.0*
