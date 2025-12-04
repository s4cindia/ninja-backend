# Sprint 4 Replit Prompts
## EPUB Accessibility + Citation Validation

**Version:** 4.0 - ACR Research Update  
**Sprint Duration:** Weeks 7-8 (January 3 - January 17, 2026)  
**Total Story Points:** 48 (-3 from v3.0 - LOW RISK)

---

## ⚡ ACR Research Update

> **Changes in v4.0:**
> - **EPUB-Specific ACR Sections (US-4.4.1):** Enhanced with reading system compatibility matrix and ONIX metadata mapping (+3 points)
> - **Plagiarism Detection (US-4.3.1):** REMOVED - Deferred to post-MVP to focus on compliance market (-8 points)
> - **Net Impact:** -3 points (LOW RISK)

---

## Sprint 4 Technical Standards

| Category | Standard |
|----------|----------|
| **Runtime** | Node.js 18+ |
| **Language** | TypeScript 5.x (strict mode) |
| **EPUB Libraries** | epubcheck (Java CLI), @daisy/ace |
| **AI Integration** | Google Gemini API |

---

## Epic 4.1: EPUB Accessibility Validation

### Prompt US-4.1.1: EPUBCheck Integration

#### Context
We're extending the Ninja Platform to validate EPUB files. EPUBCheck is the W3C-endorsed validator for EPUB structure.

#### Prerequisites
- Sprint 2 file upload and processing infrastructure complete
- Java runtime available in container

#### Objective
Integrate EPUBCheck to validate EPUB 2.x and 3.x structure and report errors.

#### Technical Requirements

**Create file: `src/services/epub/epubcheck.service.ts`**

```typescript
interface EpubCheckResult {
  isValid: boolean;
  epubVersion: '2.0' | '3.0' | '3.2';
  errors: EpubCheckMessage[];
  warnings: EpubCheckMessage[];
  infos: EpubCheckMessage[];
}

interface EpubCheckMessage {
  severity: 'ERROR' | 'WARNING' | 'INFO';
  id: string;           // EPUBCheck message ID
  message: string;
  locations: {
    path: string;       // File within EPUB
    line?: number;
    column?: number;
  }[];
  suggestion?: string;  // AI-generated remediation suggestion
}

async function runEpubCheck(epubPath: string): Promise<EpubCheckResult> {
  // Run EPUBCheck CLI: java -jar epubcheck.jar file.epub --json output.json
  // Parse JSON output
  // Map to our interface
}
```

**Install EPUBCheck:**
```bash
# In Dockerfile or setup script
RUN curl -L https://github.com/w3c/epubcheck/releases/download/v5.1.0/epubcheck-5.1.0.zip -o epubcheck.zip
RUN unzip epubcheck.zip -d /opt/epubcheck
```

**Create API endpoint:**
```
POST /api/v1/epub/validate/structure
Body: { jobId: string }
Response: EpubCheckResult
```

#### Acceptance Criteria
- [ ] Given an EPUB file is uploaded
- [ ] When validation runs
- [ ] Then EPUBCheck validates EPUB 2.x and 3.x formats
- [ ] And structural errors are reported (missing manifest items, invalid spine)
- [ ] And metadata completeness is checked
- [ ] And results include error severity and location

---

### Prompt US-4.1.2: Ace by DAISY Integration

#### Context
Ace by DAISY is the accessibility checker specifically designed for EPUB. It validates WCAG 2.1 and EPUB Accessibility 1.0 compliance.

#### Prerequisites
- US-4.1.1 (EPUBCheck Integration) complete
- EPUB passes basic structure validation

#### Objective
Integrate Ace by DAISY to check EPUB accessibility and generate detailed violation reports.

#### Technical Requirements

**Create file: `src/services/epub/ace.service.ts`**

```typescript
interface AceResult {
  epubTitle: string;
  epubVersion: string;
  score: number;           // 0-100 accessibility score
  wcagViolations: AceViolation[];
  epubAccessibility: {
    conformsTo: string[];  // e.g., ['EPUB Accessibility 1.0']
    certifiedBy?: string;
    certifierCredential?: string;
  };
  a11yMetadata: {
    accessMode: string[];
    accessModeSufficient: string[];
    accessibilityFeature: string[];
    accessibilityHazard: string[];
    accessibilitySummary?: string;
  };
}

interface AceViolation {
  ruleId: string;
  wcagCriteria: string[];   // e.g., ['1.1.1', '1.3.1']
  impact: 'critical' | 'serious' | 'moderate' | 'minor';
  description: string;
  html: string;             // Affected HTML snippet
  location: {
    filename: string;
    line?: number;
  };
  remediation: string;      // AI-enhanced suggestion
}

async function runAce(epubPath: string): Promise<AceResult> {
  // Run Ace CLI: npx @daisy/ace epubPath --outdir outputDir
  // Parse ace.json output
  // Enhance remediation suggestions with Gemini
}
```

**Create API endpoint:**
```
POST /api/v1/epub/validate/accessibility
Body: { jobId: string }
Response: AceResult
```

#### Acceptance Criteria
- [ ] Given an EPUB passes EPUBCheck
- [ ] When Ace validation runs
- [ ] Then WCAG 2.1 violations are detected
- [ ] And EPUB Accessibility 1.0 conformance is checked
- [ ] And results include violation details and impact level
- [ ] And AI-suggested remediation is provided

---

### Prompt US-4.1.3: EPUB Structure Analysis

#### Context
Beyond validation, we need to analyze EPUB structure for heading hierarchy, navigation, and landmarks.

#### Prerequisites
- US-4.1.1 complete

#### Technical Requirements

**Create file: `src/services/epub/structure-analyzer.service.ts`**

```typescript
interface EpubStructure {
  toc: TocItem[];           // Table of contents
  landmarks: Landmark[];    // Nav landmarks
  headingHierarchy: HeadingNode[];
  spine: SpineItem[];       // Reading order
  readingOrder: string[];   // Ordered list of content docs
}

interface TocItem {
  title: string;
  href: string;
  children: TocItem[];
  level: number;
}

interface Landmark {
  type: string;    // 'toc', 'bodymatter', 'cover', etc.
  title: string;
  href: string;
}

async function analyzeEpubStructure(epubPath: string): Promise<EpubStructure> {
  // Extract and parse OPF package document
  // Parse NCX (EPUB 2) or Nav document (EPUB 3)
  // Extract heading hierarchy from each content document
  // Build complete structure map
}
```

#### Acceptance Criteria
- [ ] Given an EPUB is parsed
- [ ] When structure analysis runs
- [ ] Then heading hierarchy is extracted from each content document
- [ ] And table of contents (NCX/Nav) is validated
- [ ] And landmarks are identified
- [ ] And reading order is determined

---

### Prompt US-4.1.4: EPUB Media Overlay Validation

*(Story Points: 5 - Validates SMIL timing and audio synchronization)*

---

## Epic 4.2: Citation & Reference Validation

### Prompt US-4.2.1: Citation Extraction

*(Story Points: 5 - Extracts citations and detects format)*

---

### Prompt US-4.2.2: Citation Format Validation

*(Story Points: 5 - Validates against APA/MLA/Chicago)*

---

### Prompt US-4.2.3: DOI/URL Verification

*(Story Points: 5 - Verifies DOIs via CrossRef, checks URL accessibility)*

---

## Epic 4.3: Plagiarism Detection [REMOVED]

> ❌ **US-4.3.1: Plagiarism Detection Service** has been REMOVED from this sprint.
> 
> This feature is deferred to post-MVP to focus on ACR compliance features per research recommendations.

---

## Epic 4.4: EPUB ACR Integration [REVISED]

### Prompt US-4.4.1: EPUB-Specific ACR Sections [REVISED]

#### Context
> 🔬 **RESEARCH DRIVER:** EPUB Accessibility 1.0 conformance must be explicitly documented in ACRs for e-book procurement. Reading system compatibility is a key procurement concern.

#### Prerequisites
- US-3.3.1 (Multi-Edition ACR Support) complete
- US-4.1.2 (Ace by DAISY Integration) complete

#### Objective
Extend ACR generation to include EPUB-specific accessibility criteria, reading system compatibility, and ONIX metadata mapping.

#### Technical Requirements

**Create file: `src/services/acr/epub-acr-section.service.ts`**

```typescript
interface EpubAcrSection {
  epubAccessibilityConformance: {
    version: string;              // 'EPUB Accessibility 1.0' or '1.1'
    conformanceLevel: string;     // 'WCAG 2.0 Level AA'
    certifiedBy?: string;
    certifierCredential?: string;
  };
  readingSystemCompatibility: ReadingSystemTest[];
  mediaOverlayAccessibility: {
    hasMediaOverlays: boolean;
    synchronized: boolean;
    escapable: boolean;
    skippable: boolean[];         // e.g., ['pagenum', 'sidebar', 'note']
  };
  navigationAccessibility: {
    hasToc: boolean;
    hasLandmarks: boolean;
    hasPageList: boolean;
    landmarkTypes: string[];
  };
  onixMetadataMapping: OnixAccessibility;
}

// NEW: Reading system compatibility matrix
interface ReadingSystemTest {
  readingSystem: string;          // 'Thorium Reader', 'Apple Books', 'Kindle', etc.
  version: string;
  testedDate: Date;
  compatibility: 'Full' | 'Partial' | 'None' | 'Not Tested';
  notes: string;
  testedFeatures: {
    textToSpeech: boolean;
    screenReader: boolean;
    brailleDisplay: boolean;
    fontResizing: boolean;
    colorContrast: boolean;
  };
}

// NEW: ONIX accessibility metadata for catalog distribution
interface OnixAccessibility {
  productFormFeature: {
    code: string;
    value: string;
    description: string;
  }[];
  accessMode: string[];
  accessibilityFeature: string[];
  accessibilityHazard: string[];
  accessibilitySummary: string;
}

const READING_SYSTEMS = [
  { name: 'Thorium Reader', platform: 'Desktop' },
  { name: 'Apple Books', platform: 'macOS/iOS' },
  { name: 'Google Play Books', platform: 'Android/Web' },
  { name: 'Kindle', platform: 'Amazon' },
  { name: 'Kobo', platform: 'Rakuten' },
  { name: 'VitalSource Bookshelf', platform: 'Education' },
  { name: 'RedShelf', platform: 'Education' },
];

async function generateEpubAcrSection(
  aceResult: AceResult,
  epubStructure: EpubStructure,
  readingSystemTests?: ReadingSystemTest[]
): Promise<EpubAcrSection> {
  // Map Ace results to EPUB Accessibility conformance
  // Generate reading system compatibility matrix (from tests or defaults)
  // Map to ONIX accessibility codes for catalog distribution
  // Include confidence levels for automated vs manual checks
}
```

**Update ACR template to include EPUB section:**

```typescript
// In acr-generator.service.ts
interface AcrDocument {
  // ... existing fields
  epubSection?: EpubAcrSection;  // Included when validating EPUB
}

function generateAcr(jobId: string, options: AcrGenerationOptions): Promise<AcrDocument> {
  const fileType = await getFileType(jobId);

  if (fileType === 'epub') {
    const aceResult = await getAceResult(jobId);
    const structure = await getEpubStructure(jobId);
    acr.epubSection = await generateEpubAcrSection(aceResult, structure);
  }

  return acr;
}
```

**Create ONIX mapping utility:**

```typescript
// Map EPUB accessibility features to ONIX codes
const ONIX_ACCESSIBILITY_CODES = {
  '00': 'Accessibility summary',
  '10': 'No reading system accessibility options actively disabled',
  '11': 'Table of contents navigation',
  '12': 'Index navigation',
  '13': 'Reading order',
  '14': 'Short alternative descriptions',
  '15': 'Full alternative descriptions',
  '16': 'Visualised data also available as non-graphical data',
  '17': 'Accessible math content',
  '18': 'Accessible chemistry content',
  '19': 'Print-equivalent page numbering',
  '20': 'Synchronised pre-recorded audio',
  '21': 'Text-to-speech hinting provided',
  '22': 'Language tagging provided',
  // ... complete list
};

function mapToOnix(epubAccessibility: EpubAccessibilityMetadata): OnixAccessibility {
  // Map EPUB accessibility metadata to ONIX Product Form Feature codes
  // Return structured ONIX data for catalog systems
}
```

#### Acceptance Criteria
- [ ] Given an EPUB has been validated with Ace by DAISY
- [ ] When ACR is generated
- [ ] Then EPUB Accessibility 1.0 conformance is included as a section
- [ ] **[NEW]** And reading system compatibility matrix is included (tested with: Thorium, Apple Books, Kindle, etc.)
- [ ] And media overlay accessibility is documented
- [ ] And navigation accessibility (NCX/Nav) is reported
- [ ] **[NEW]** And ONIX accessibility metadata mapping is provided for catalog distribution
- [ ] **[NEW]** And confidence levels distinguish automated Ace checks from manual verification items

#### Implementation Notes
- Reading system tests may be entered manually or defaulted to "Not Tested"
- ONIX codes are essential for publishers distributing through catalog systems
- Confidence levels should flag items like "screen reader compatibility" as requiring manual testing

---

## Sprint 4 Execution Checklist

### Week 7 (Jan 3-10)
- [ ] US-4.1.1: EPUBCheck Integration
- [ ] US-4.1.2: Ace by DAISY Integration
- [ ] US-4.1.3: EPUB Structure Analysis
- [ ] US-4.1.4: EPUB Media Overlay Validation

### Week 8 (Jan 10-17)
- [ ] US-4.2.1: Citation Extraction
- [ ] US-4.2.2: Citation Format Validation
- [ ] US-4.2.3: DOI/URL Verification
- [ ] US-4.4.1: EPUB-Specific ACR Sections [REVISED]

---

*End of Sprint 4 Replit Prompts v4.0*
