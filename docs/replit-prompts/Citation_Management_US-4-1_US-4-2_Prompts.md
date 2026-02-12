# Citation Management - US-4.1 & US-4.2 (BACKEND)
## Replit Prompts for Dev2 (Sakthi)

**Repository:** `ninja-backend`
**Purpose:** Implement Citation Detection and Parsing services for Editorial Services module
**Note:** This is BACKEND only. Frontend components are NOT included in this plan.
**Story Points:** 8 (US-4.1: 5, US-4.2: 3)
**Dependencies:** Shared Infrastructure (COMPLETED by Ambai)
**Owner:** Dev2 (Sakthi)

**Schema Update (PR: fix/editorial-schema-citation-component-relation):**
- CitationComponent has `parseVariant` field (`String?`) for tracking which style was used
- CitationComponent has `confidence` field (`Float`) for parse confidence score
- CitationComponent has validation fields: `doiVerified`, `urlValid`, `urlCheckedAt`
- **Primary component pattern:** Citation has `primaryComponentId` pointing to the selected CitationComponent
- Use `CitationValidationService.setPrimaryComponent()` to set the primary (AVR created this)
- Removed @@unique constraint to allow multiple parses per citation
- Added SourceType values: NEWSPAPER, MAGAZINE, PATENT, LEGAL, PERSONAL_COMMUNICATION

---

## Sprint Technical Standards (Include in Each Session)

```
Runtime: Node.js 18+
Language: TypeScript 5.x (strict mode)
API Framework: Express 4.x
Module System: ES Modules (import/export)
Validation: Zod
ORM: Prisma
Async Pattern: async/await (no callbacks)
File Naming: kebab-case for files, PascalCase for classes
Base Path: All code in src/services/citation/
AI Provider: Uses shared editorialAi service (DO NOT modify)
```

---

## Module Ownership Rules

**YOUR directories (create and own):**
```
src/services/citation/
├── index.ts
├── citation.types.ts
├── citation-detection.service.ts
├── citation-parsing.service.ts
├── citation.schemas.ts
├── citation.controller.ts
└── citation.routes.ts
```

**DO NOT modify (Ambai owns):**
```
src/services/shared/
src/services/plagiarism/
src/services/style/
```

---

## Prerequisites

Before starting, ensure:

1. **Pull latest main:**
   ```bash
   git checkout main
   git pull origin main
   ```

2. **Generate Prisma client:**
   ```bash
   npx prisma generate
   ```

3. **Create feature branch:**
   ```bash
   git checkout -b feature/citation/US-4-1-US-4-2
   ```

4. **Verify shared services exist:**
   ```bash
   ls src/services/shared/
   # Should see: editorial-ai-client.ts, document-parser.ts, report-generator.ts, index.ts
   ```

---

## User Story Specifications

### US-4.1: Citation Detection

**As a** publisher reviewing a manuscript
**I want to** automatically detect all citations in a document
**So that** I can verify they are properly formatted and complete

**Acceptance Criteria:**
- [ ] System detects parenthetical citations: (Smith, 2020), (Smith & Jones, 2020)
- [ ] System detects narrative citations: Smith (2020) argues...
- [ ] System detects footnote/endnote markers when notes are provided
- [ ] System detects numeric citations: [1], [1-3], [1,2,5]
- [ ] System does NOT flag non-citations: (see Figure 1), (p. 42), (emphasis added)
- [ ] Each citation includes: text, type, detected style, location, confidence score
- [ ] Results stored in `Citation` table linked to `EditorialDocument`
- [ ] API endpoint returns detection results with summary statistics

### US-4.2: Citation Parsing

**As a** publisher reviewing citations
**I want to** parse each citation into structured components
**So that** I can validate completeness and check against reference lists

**Acceptance Criteria:**
- [ ] System extracts author names (handles multiple authors, et al.) [AC-22, AC-23]
- [ ] System extracts publication year [AC-22]
- [ ] System extracts title (when present in full citation) [AC-22]
- [ ] System extracts source/journal name [AC-22]
- [ ] System extracts volume, issue, pages (when present) [AC-22]
- [ ] System extracts DOI and URL (when present) [AC-22]
- [ ] System determines source type (journal, book, website, etc.) [AC-24]
- [ ] Each field has confidence score (0-100) [AC-25]
- [ ] **System flags ambiguous/incomplete citations with `needsReview` and `reviewReasons`** [AC-26]
- [ ] Results stored in `CitationComponent` table linked to `Citation`
- [ ] Supports re-parsing (creates new component, preserves history)

---

# PROMPT 1: Create Type Definitions
## File: `src/services/citation/citation.types.ts`

### Context

You are implementing the Citation Management module for Ninja Platform Editorial Services. Start by creating TypeScript type definitions that will be used across all citation services.

### Objective

Create `src/services/citation/citation.types.ts` with all interfaces, types, and mapping constants needed for citation detection and parsing.

### Technical Requirements

**File to create:** `src/services/citation/citation.types.ts`

**Implementation:**

```typescript
/**
 * Citation Management Type Definitions
 * US-4.1: Citation Detection
 * US-4.2: Citation Parsing
 */

import { CitationType, CitationStyle, SourceType } from '@prisma/client';

// ============================================
// DETECTION TYPES (US-4.1)
// ============================================

/** Single detected citation from document */
export interface DetectedCitation {
  id: string;
  rawText: string;
  citationType: CitationType;
  detectedStyle: CitationStyle | null;
  pageNumber: number | null;
  paragraphIndex: number | null;
  startOffset: number;
  endOffset: number;
  confidence: number; // 0-1 normalized
}

/** Detection result summary for a document */
export interface DetectionResult {
  documentId: string;
  jobId: string;
  citations: DetectedCitation[];
  totalCount: number;
  byType: Record<string, number>;
  byStyle: Record<string, number>;
  processingTimeMs: number;
}

/** Input for detection operation */
export interface DetectionInput {
  jobId: string;
  tenantId: string;
  userId: string;
  fileBuffer: Buffer;
  fileName: string;
}

// ============================================
// PARSING TYPES (US-4.2)
// ============================================

/** Parsed citation component with all extracted fields */
export interface ParsedCitationResult {
  citationId: string;
  componentId: string;
  parseVariant: string | null;   // Which style was used to parse (e.g., "APA", "MLA")
  confidence: number;            // Overall parse confidence (0-1)
  authors: string[];
  year: string | null;
  title: string | null;
  source: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  url: string | null;
  publisher: string | null;
  edition: string | null;
  accessDate: string | null;
  sourceType: SourceType | null;
  fieldConfidence: Record<string, number>;
  // Validation fields
  doiVerified: boolean | null;
  urlValid: boolean | null;
  urlCheckedAt: Date | null;
  // AC-26: Explicit flag for ambiguous/incomplete citations
  needsReview: boolean;          // True if citation is ambiguous or incomplete
  reviewReasons: string[];       // Reasons why review is needed
  createdAt: Date;
}

/** Reasons for flagging a citation as needing review (AC-26) */
export const REVIEW_REASONS = {
  LOW_OVERALL_CONFIDENCE: 'Overall parse confidence below 70%',
  LOW_FIELD_CONFIDENCE: 'One or more fields have confidence below 50%',
  MISSING_AUTHORS: 'No authors could be extracted',
  MISSING_YEAR: 'Publication year could not be determined',
  MISSING_TITLE: 'Title could not be extracted',
  AMBIGUOUS_TYPE: 'Source type could not be determined',
  INVALID_DOI: 'DOI format appears invalid',
  INVALID_URL: 'URL format appears invalid',
} as const;

/** Bulk parse operation result */
export interface BulkParseResult {
  documentId: string;
  totalCitations: number;
  parsed: number;
  skipped: number; // Already had components
  failed: number;
  results: ParsedCitationResult[];
  errors: Array<{ citationId: string; error: string }>;
  processingTimeMs: number;
}

/** Citation with its primary/latest parsed component */
export interface CitationWithComponent {
  id: string;
  documentId: string;
  rawText: string;
  citationType: CitationType;
  detectedStyle: CitationStyle | null;
  confidence: number;
  pageNumber: number | null;
  paragraphIndex: number | null;
  startOffset: number;
  endOffset: number;
  isValid: boolean | null;
  validationErrors: string[];
  createdAt: Date;
  // Primary component pattern (from schema)
  primaryComponentId: string | null;
  primaryComponent: ParsedCitationResult | null;
  componentCount: number;
  // AC-26: Aggregated review status from primary component
  needsReview: boolean;
}

// ============================================
// ENUM MAPPING CONSTANTS
// ============================================

/** Map AI response type string to Prisma CitationType enum */
export const CITATION_TYPE_MAP: Record<string, CitationType> = {
  parenthetical: 'PARENTHETICAL',
  narrative: 'NARRATIVE',
  footnote: 'FOOTNOTE',
  endnote: 'ENDNOTE',
  numeric: 'NUMERIC',
  // Fallback handled in code
};

/** Map AI response style string to Prisma CitationStyle enum */
export const CITATION_STYLE_MAP: Record<string, CitationStyle> = {
  APA: 'APA',
  apa: 'APA',
  MLA: 'MLA',
  mla: 'MLA',
  Chicago: 'CHICAGO',
  chicago: 'CHICAGO',
  CMOS: 'CHICAGO',
  Vancouver: 'VANCOUVER',
  vancouver: 'VANCOUVER',
  Harvard: 'HARVARD',
  harvard: 'HARVARD',
  IEEE: 'IEEE',
  ieee: 'IEEE',
  // Fallback handled in code
};

/** Map AI response source type to Prisma SourceType enum */
export const SOURCE_TYPE_MAP: Record<string, SourceType> = {
  journal: 'JOURNAL_ARTICLE',
  'journal article': 'JOURNAL_ARTICLE',
  'journal-article': 'JOURNAL_ARTICLE',
  book: 'BOOK',
  chapter: 'BOOK_CHAPTER',
  'book chapter': 'BOOK_CHAPTER',
  'book-chapter': 'BOOK_CHAPTER',
  conference: 'CONFERENCE_PAPER',
  'conference paper': 'CONFERENCE_PAPER',
  website: 'WEBSITE',
  web: 'WEBSITE',
  thesis: 'THESIS',
  dissertation: 'THESIS',
  report: 'REPORT',
  newspaper: 'NEWSPAPER',
  magazine: 'MAGAZINE',
  patent: 'PATENT',
  legal: 'LEGAL',
  'personal communication': 'PERSONAL_COMMUNICATION',
  // Fallback handled in code
};

// ============================================
// HELPER FUNCTIONS
// ============================================

/** Safely map string to CitationType with fallback */
export function mapToCitationType(value: string | undefined | null): CitationType {
  if (!value) return 'UNKNOWN';
  const normalized = value.toLowerCase().trim();
  return CITATION_TYPE_MAP[normalized] || 'UNKNOWN';
}

/** Safely map string to CitationStyle with fallback */
export function mapToCitationStyle(value: string | undefined | null): CitationStyle | null {
  if (!value || value.toLowerCase() === 'unknown') return null;
  return CITATION_STYLE_MAP[value] || CITATION_STYLE_MAP[value.toLowerCase()] || null;
}

/** Safely map string to SourceType with fallback */
export function mapToSourceType(value: string | undefined | null): SourceType | null {
  if (!value || value.toLowerCase() === 'unknown') return null;
  const normalized = value.toLowerCase().trim();
  return SOURCE_TYPE_MAP[normalized] || null;
}
```

### Acceptance Criteria

- [ ] File created at `src/services/citation/citation.types.ts`
- [ ] All interfaces properly typed with JSDoc comments
- [ ] Mapping constants cover all Prisma enum values
- [ ] Helper functions handle edge cases (null, undefined, unknown)
- [ ] TypeScript compiles without errors
- [ ] Types are exportable for use in other files

### Testing

```bash
# Verify compilation
npx tsc --noEmit src/services/citation/citation.types.ts
```

---

# PROMPT 2: Create Citation Detection Service (US-4.1)
## File: `src/services/citation/citation-detection.service.ts`

### Context

You are implementing US-4.1 Citation Detection. This service uses the shared `editorialAi` and `documentParser` services (created by Ambai) to detect citations in uploaded documents and store them in the database.

### Objective

Create `src/services/citation/citation-detection.service.ts` that:
1. Parses uploaded documents to extract text
2. Uses AI to detect all citations in the text
3. Stores citations in the database with location information
4. Returns detection results with statistics

### Prerequisites

- Shared services available: `import { editorialAi, documentParser } from '../shared'`
- Prisma models: `EditorialDocument`, `Citation`
- Types from `./citation.types.ts`

### Technical Requirements

**File to create:** `src/services/citation/citation-detection.service.ts`

**Implementation:**

```typescript
/**
 * Citation Detection Service
 * US-4.1: Detect and extract citations from documents
 */

import { editorialAi, documentParser } from '../shared';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { EditorialDocStatus, Prisma } from '@prisma/client';
import {
  DetectedCitation,
  DetectionResult,
  DetectionInput,
  mapToCitationType,
  mapToCitationStyle,
} from './citation.types';

export class CitationDetectionService {
  /**
   * Detect all citations in a document
   * Main entry point for US-4.1
   *
   * @param input - Detection input with file buffer and metadata
   * @returns Detection result with all found citations
   */
  async detectCitations(input: DetectionInput): Promise<DetectionResult> {
    const startTime = Date.now();
    const { jobId, tenantId, fileBuffer, fileName } = input;

    logger.info(`[Citation Detection] Starting for jobId=${jobId}, file=${fileName}`);

    try {
      // 1. Parse document to extract text
      const parsed = await documentParser.parse(fileBuffer, fileName);
      logger.info(`[Citation Detection] Parsed document: ${parsed.metadata.wordCount} words, ${parsed.chunks.length} chunks`);

      // 2. Create or update EditorialDocument record
      const editorialDoc = await this.createEditorialDocument(
        jobId,
        tenantId,
        fileName,
        fileBuffer.length,
        parsed
      );

      // 3. Detect citations using AI
      const extractedCitations = await editorialAi.detectCitations(parsed.text);
      logger.info(`[Citation Detection] AI found ${extractedCitations.length} citations`);

      // 4. Store citations in database
      const citations = await this.storeCitations(editorialDoc.id, extractedCitations);

      // 5. Update document status
      await prisma.editorialDocument.update({
        where: { id: editorialDoc.id },
        data: { status: EditorialDocStatus.PARSED },
      });

      // 6. Build and return result
      const result = this.buildDetectionResult(editorialDoc.id, jobId, citations, startTime);

      logger.info(`[Citation Detection] Completed: ${result.totalCount} citations in ${result.processingTimeMs}ms`);
      return result;

    } catch (error) {
      logger.error('[Citation Detection] Failed', error instanceof Error ? error : undefined);
      throw error;
    }
  }

  /**
   * Get detection results for an existing document
   */
  async getDetectionResults(documentId: string): Promise<DetectionResult | null> {
    const doc = await prisma.editorialDocument.findUnique({
      where: { id: documentId },
      include: {
        citations: {
          orderBy: { startOffset: 'asc' }
        }
      },
    });

    if (!doc) return null;

    const citations = this.mapCitationsToDetected(doc.citations);
    return this.buildDetectionResult(documentId, doc.jobId, citations, Date.now());
  }

  /**
   * Get detection results by job ID
   */
  async getDetectionResultsByJob(jobId: string): Promise<DetectionResult | null> {
    const doc = await prisma.editorialDocument.findUnique({
      where: { jobId },
      include: {
        citations: {
          orderBy: { startOffset: 'asc' }
        }
      },
    });

    if (!doc) return null;

    const citations = this.mapCitationsToDetected(doc.citations);
    return this.buildDetectionResult(doc.id, jobId, citations, Date.now());
  }

  /**
   * Re-run detection on an existing document
   * Deletes existing citations and creates new ones
   */
  async redetectCitations(documentId: string): Promise<DetectionResult> {
    const startTime = Date.now();

    const doc = await prisma.editorialDocument.findUnique({
      where: { id: documentId },
    });

    if (!doc) {
      throw new Error(`Editorial document not found: ${documentId}`);
    }

    if (!doc.fullText) {
      throw new Error(`Document has no extracted text: ${documentId}`);
    }

    logger.info(`[Citation Detection] Re-detecting for documentId=${documentId}`);

    // Delete existing citations
    await prisma.citation.deleteMany({
      where: { documentId },
    });

    // Update status
    await prisma.editorialDocument.update({
      where: { id: documentId },
      data: { status: EditorialDocStatus.ANALYZING },
    });

    // Re-detect
    const extractedCitations = await editorialAi.detectCitations(doc.fullText);
    const citations = await this.storeCitations(documentId, extractedCitations);

    // Update status
    await prisma.editorialDocument.update({
      where: { id: documentId },
      data: { status: EditorialDocStatus.PARSED },
    });

    return this.buildDetectionResult(documentId, doc.jobId, citations, startTime);
  }

  /**
   * Create EditorialDocument record
   */
  private async createEditorialDocument(
    jobId: string,
    tenantId: string,
    fileName: string,
    fileSize: number,
    parsed: Awaited<ReturnType<typeof documentParser.parse>>
  ) {
    // Check if document already exists for this job
    const existing = await prisma.editorialDocument.findUnique({
      where: { jobId },
    });

    if (existing) {
      // Update existing document
      return prisma.editorialDocument.update({
        where: { id: existing.id },
        data: {
          fullText: parsed.text,
          wordCount: parsed.metadata.wordCount,
          pageCount: parsed.metadata.pageCount || null,
          chunkCount: parsed.chunks.length,
          title: parsed.metadata.title || null,
          authors: parsed.metadata.authors || [],
          language: parsed.metadata.language || null,
          status: EditorialDocStatus.ANALYZING,
          parsedAt: new Date(),
        },
      });
    }

    // Create new document
    return prisma.editorialDocument.create({
      data: {
        tenantId,
        jobId,
        fileName,
        originalName: fileName,
        mimeType: this.getMimeType(fileName),
        fileSize,
        storagePath: '', // Buffer-based, not stored
        fullText: parsed.text,
        wordCount: parsed.metadata.wordCount,
        pageCount: parsed.metadata.pageCount || null,
        chunkCount: parsed.chunks.length,
        title: parsed.metadata.title || null,
        authors: parsed.metadata.authors || [],
        language: parsed.metadata.language || null,
        status: EditorialDocStatus.ANALYZING,
        parsedAt: new Date(),
      },
    });
  }

  /**
   * Store detected citations in database
   */
  private async storeCitations(
    documentId: string,
    extractedCitations: Awaited<ReturnType<typeof editorialAi.detectCitations>>
  ): Promise<DetectedCitation[]> {
    const citations: DetectedCitation[] = [];

    for (const extracted of extractedCitations) {
      try {
        const citation = await prisma.citation.create({
          data: {
            documentId,
            rawText: extracted.text,
            citationType: mapToCitationType(extracted.type),
            detectedStyle: mapToCitationStyle(extracted.style),
            pageNumber: extracted.location.pageNumber || null,
            paragraphIndex: extracted.location.paragraphIndex,
            startOffset: extracted.location.startOffset,
            endOffset: extracted.location.endOffset,
            confidence: extracted.confidence / 100, // Normalize to 0-1
            isValid: null, // Not validated yet
            validationErrors: [],
          },
        });

        citations.push({
          id: citation.id,
          rawText: citation.rawText,
          citationType: citation.citationType,
          detectedStyle: citation.detectedStyle,
          pageNumber: citation.pageNumber,
          paragraphIndex: citation.paragraphIndex,
          startOffset: citation.startOffset,
          endOffset: citation.endOffset,
          confidence: citation.confidence,
        });
      } catch (error) {
        logger.warn(`[Citation Detection] Failed to store citation: ${extracted.text.substring(0, 50)}...`,
          error instanceof Error ? error : undefined);
      }
    }

    return citations;
  }

  /**
   * Map Prisma Citation records to DetectedCitation interface
   */
  private mapCitationsToDetected(citations: Array<{
    id: string;
    rawText: string;
    citationType: string;
    detectedStyle: string | null;
    pageNumber: number | null;
    paragraphIndex: number | null;
    startOffset: number;
    endOffset: number;
    confidence: number;
  }>): DetectedCitation[] {
    return citations.map((c) => ({
      id: c.id,
      rawText: c.rawText,
      citationType: c.citationType as DetectedCitation['citationType'],
      detectedStyle: c.detectedStyle as DetectedCitation['detectedStyle'],
      pageNumber: c.pageNumber,
      paragraphIndex: c.paragraphIndex,
      startOffset: c.startOffset,
      endOffset: c.endOffset,
      confidence: c.confidence,
    }));
  }

  /**
   * Build detection result with statistics
   */
  private buildDetectionResult(
    documentId: string,
    jobId: string,
    citations: DetectedCitation[],
    startTime: number
  ): DetectionResult {
    const byType: Record<string, number> = {};
    const byStyle: Record<string, number> = {};

    for (const citation of citations) {
      // Count by type
      byType[citation.citationType] = (byType[citation.citationType] || 0) + 1;

      // Count by style
      const style = citation.detectedStyle || 'UNKNOWN';
      byStyle[style] = (byStyle[style] || 0) + 1;
    }

    return {
      documentId,
      jobId,
      citations,
      totalCount: citations.length,
      byType,
      byStyle,
      processingTimeMs: Date.now() - startTime,
    };
  }

  /**
   * Get MIME type from filename
   */
  private getMimeType(fileName: string): string {
    const ext = fileName.toLowerCase().split('.').pop();
    const mimeMap: Record<string, string> = {
      pdf: 'application/pdf',
      epub: 'application/epub+zip',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xml: 'application/xml',
      txt: 'text/plain',
    };
    return mimeMap[ext || ''] || 'application/octet-stream';
  }
}

// Export singleton instance
export const citationDetectionService = new CitationDetectionService();
```

### Acceptance Criteria

- [ ] File created at `src/services/citation/citation-detection.service.ts`
- [ ] `detectCitations()` method parses document and extracts citations
- [ ] `getDetectionResults()` retrieves existing results by document ID
- [ ] `getDetectionResultsByJob()` retrieves results by job ID
- [ ] `redetectCitations()` re-runs detection on existing document
- [ ] Citations stored in database with correct enum mappings
- [ ] Statistics calculated correctly (byType, byStyle)
- [ ] Processing time tracked
- [ ] Proper error handling and logging
- [ ] TypeScript compiles without errors

### Testing

```bash
# Verify compilation
npx tsc --noEmit src/services/citation/citation-detection.service.ts

# Check imports work
node -e "require('./dist/services/citation/citation-detection.service.js')"
```

---

# PROMPT 3: Create Citation Parsing Service (US-4.2)
## File: `src/services/citation/citation-parsing.service.ts`

### Context

You are implementing US-4.2 Citation Parsing. This service takes detected citations and parses them into structured components (authors, year, title, etc.) using AI.

### Objective

Create `src/services/citation/citation-parsing.service.ts` that:
1. Parses individual citations into structured components
2. Supports bulk parsing of all citations in a document
3. Stores components in database (one-to-many: Citation has many CitationComponents)
4. Supports re-parsing (creates new component, preserves history)

### Technical Requirements

**File to create:** `src/services/citation/citation-parsing.service.ts`

**Implementation:**

```typescript
/**
 * Citation Parsing Service
 * US-4.2: Parse citations into structured components
 */

import { editorialAi } from '../shared';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import {
  ParsedCitationResult,
  BulkParseResult,
  CitationWithComponent,
  mapToSourceType,
  REVIEW_REASONS,
} from './citation.types';

export class CitationParsingService {
  /**
   * Parse a single citation into structured components
   * Creates a new CitationComponent record
   *
   * @param citationId - ID of the citation to parse
   * @returns Parsed citation result with component ID
   */
  async parseCitation(citationId: string): Promise<ParsedCitationResult> {
    logger.info(`[Citation Parsing] Parsing citationId=${citationId}`);

    // 1. Get citation
    const citation = await prisma.citation.findUnique({
      where: { id: citationId },
    });

    if (!citation) {
      throw new Error(`Citation not found: ${citationId}`);
    }

    // 2. Parse using AI
    const parsed = await editorialAi.parseCitation(citation.rawText);

    // 3. Determine parse variant from detected style or default to UNKNOWN
    const parseVariant = citation.detectedStyle || 'UNKNOWN';

    // 4. Calculate overall confidence from field confidences
    const fieldConfidences = Object.values(parsed.confidence || {}) as number[];
    const avgConfidence = fieldConfidences.length > 0
      ? fieldConfidences.reduce((a, b) => a + b, 0) / fieldConfidences.length / 100
      : 0;

    // 5. AC-26: Determine if citation needs review (ambiguous/incomplete)
    const { needsReview, reviewReasons } = this.evaluateReviewNeeded(
      avgConfidence,
      parsed,
      fieldConfidences
    );

    // 6. Create CitationComponent record
    const component = await prisma.citationComponent.create({
      data: {
        citationId,
        parseVariant,                 // Which style was used to parse
        confidence: avgConfidence,    // Overall confidence (0-1)
        authors: parsed.authors || [],
        year: parsed.year || null,
        title: parsed.title || null,
        source: parsed.source || null,
        volume: parsed.volume || null,
        issue: parsed.issue || null,
        pages: parsed.pages || null,
        doi: parsed.doi || null,
        url: parsed.url || null,
        publisher: null, // Not in AI response currently
        edition: null,
        accessDate: null,
        sourceType: mapToSourceType(parsed.type),
        fieldConfidence: (parsed.confidence || {}) as Record<string, number>,
        // Validation fields - to be set later by validation service
        doiVerified: null,
        urlValid: null,
        urlCheckedAt: null,
        // AC-26: Explicit flagging for ambiguous/incomplete citations
        needsReview,
        reviewReasons,
      },
    });

    // 6. Set as primary component using AVR's CitationValidationService
    // Import: import { createCitationValidationService } from './citation-validation.service';
    const validationService = createCitationValidationService(prisma);
    await validationService.setPrimaryComponent(citationId, component.id);

    logger.info(`[Citation Parsing] Created component ${component.id} as primary for citation ${citationId}`);

    return this.mapComponentToResult(citationId, component);
  }

  /**
   * Parse all unparsed citations for a document
   * Skips citations that already have components
   *
   * @param documentId - ID of the editorial document
   * @returns Bulk parse result with statistics
   */
  async parseAllCitations(documentId: string): Promise<BulkParseResult> {
    const startTime = Date.now();
    logger.info(`[Citation Parsing] Bulk parsing for documentId=${documentId}`);

    // Get all citations for document
    const allCitations = await prisma.citation.findMany({
      where: { documentId },
      include: { components: { select: { id: true } } },
      orderBy: { startOffset: 'asc' },
    });

    // Filter to unparsed citations
    const unparsedCitations = allCitations.filter(c => c.components.length === 0);
    const skippedCount = allCitations.length - unparsedCitations.length;

    logger.info(`[Citation Parsing] ${unparsedCitations.length} to parse, ${skippedCount} already have components`);

    const results: ParsedCitationResult[] = [];
    const errors: Array<{ citationId: string; error: string }> = [];

    for (const citation of unparsedCitations) {
      try {
        const result = await this.parseCitation(citation.id);
        results.push(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        logger.warn(`[Citation Parsing] Failed for ${citation.id}: ${message}`);
        errors.push({ citationId: citation.id, error: message });
      }
    }

    const bulkResult: BulkParseResult = {
      documentId,
      totalCitations: allCitations.length,
      parsed: results.length,
      skipped: skippedCount,
      failed: errors.length,
      results,
      errors,
      processingTimeMs: Date.now() - startTime,
    };

    logger.info(`[Citation Parsing] Bulk complete: ${bulkResult.parsed} parsed, ${bulkResult.skipped} skipped, ${bulkResult.failed} failed in ${bulkResult.processingTimeMs}ms`);

    return bulkResult;
  }

  /**
   * Re-parse a citation (creates new component, preserves old ones)
   * Use for improved parsing or manual corrections
   *
   * @param citationId - ID of the citation to re-parse
   * @returns New parsed component
   */
  async reparseCitation(citationId: string): Promise<ParsedCitationResult> {
    logger.info(`[Citation Parsing] Re-parsing citationId=${citationId}`);
    // parseCitation always creates a new component, so we can just call it
    return this.parseCitation(citationId);
  }

  /**
   * Get all parsed components for a citation (version history)
   *
   * @param citationId - ID of the citation
   * @returns Array of parsed components, newest first
   */
  async getCitationComponents(citationId: string): Promise<ParsedCitationResult[]> {
    const components = await prisma.citationComponent.findMany({
      where: { citationId },
      orderBy: { createdAt: 'desc' },
    });

    return components.map(c => this.mapComponentToResult(citationId, c));
  }

  /**
   * Get the latest component for a citation
   *
   * @param citationId - ID of the citation
   * @returns Latest parsed component or null
   */
  async getLatestComponent(citationId: string): Promise<ParsedCitationResult | null> {
    const component = await prisma.citationComponent.findFirst({
      where: { citationId },
      orderBy: { createdAt: 'desc' },
    });

    if (!component) return null;

    return this.mapComponentToResult(citationId, component);
  }

  /**
   * Get citation with its latest component
   *
   * @param citationId - ID of the citation
   * @returns Citation with latest component and component count
   */
  async getCitationWithComponent(citationId: string): Promise<CitationWithComponent | null> {
    const citation = await prisma.citation.findUnique({
      where: { id: citationId },
      include: {
        components: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!citation) return null;

    const latestComponent = citation.components[0]
      ? this.mapComponentToResult(citationId, citation.components[0])
      : null;

    return {
      id: citation.id,
      documentId: citation.documentId,
      rawText: citation.rawText,
      citationType: citation.citationType,
      detectedStyle: citation.detectedStyle,
      confidence: citation.confidence,
      pageNumber: citation.pageNumber,
      paragraphIndex: citation.paragraphIndex,
      startOffset: citation.startOffset,
      endOffset: citation.endOffset,
      isValid: citation.isValid,
      validationErrors: citation.validationErrors,
      createdAt: citation.createdAt,
      primaryComponentId: citation.primaryComponentId,
      primaryComponent: latestComponent,
      componentCount: citation.components.length,
      // AC-26: Aggregate needsReview from primary component
      needsReview: latestComponent?.needsReview ?? false,
    };
  }

  /**
   * Get all citations with components for a document
   *
   * @param documentId - ID of the editorial document
   * @returns Array of citations with their latest components
   */
  async getCitationsWithComponents(documentId: string): Promise<CitationWithComponent[]> {
    const citations = await prisma.citation.findMany({
      where: { documentId },
      include: {
        components: {
          orderBy: { createdAt: 'desc' },
        },
      },
      orderBy: { startOffset: 'asc' },
    });

    return citations.map(citation => {
      const latestComponent = citation.components[0]
        ? this.mapComponentToResult(citation.id, citation.components[0])
        : null;

      return {
        id: citation.id,
        documentId: citation.documentId,
        rawText: citation.rawText,
        citationType: citation.citationType,
        detectedStyle: citation.detectedStyle,
        confidence: citation.confidence,
        pageNumber: citation.pageNumber,
        paragraphIndex: citation.paragraphIndex,
        startOffset: citation.startOffset,
        endOffset: citation.endOffset,
        isValid: citation.isValid,
        validationErrors: citation.validationErrors,
        createdAt: citation.createdAt,
        primaryComponentId: citation.primaryComponentId,
        primaryComponent: latestComponent,
        componentCount: citation.components.length,
        // AC-26: Aggregate needsReview from primary component
        needsReview: latestComponent?.needsReview ?? false,
      };
    });
  }

  /**
   * AC-26: Evaluate if a parsed citation needs human review
   * Returns needsReview flag and array of reasons
   */
  private evaluateReviewNeeded(
    avgConfidence: number,
    parsed: {
      authors?: string[];
      year?: string | null;
      title?: string | null;
      type?: string | null;
      doi?: string | null;
      url?: string | null;
      confidence?: Record<string, number>;
    },
    fieldConfidences: number[]
  ): { needsReview: boolean; reviewReasons: string[] } {
    const reviewReasons: string[] = [];

    // Check overall confidence
    if (avgConfidence < 0.7) {
      reviewReasons.push(REVIEW_REASONS.LOW_OVERALL_CONFIDENCE);
    }

    // Check if any field has low confidence (below 50%)
    if (fieldConfidences.some(c => c < 50)) {
      reviewReasons.push(REVIEW_REASONS.LOW_FIELD_CONFIDENCE);
    }

    // Check for missing critical fields
    if (!parsed.authors || parsed.authors.length === 0) {
      reviewReasons.push(REVIEW_REASONS.MISSING_AUTHORS);
    }

    if (!parsed.year) {
      reviewReasons.push(REVIEW_REASONS.MISSING_YEAR);
    }

    if (!parsed.title) {
      reviewReasons.push(REVIEW_REASONS.MISSING_TITLE);
    }

    // Check for ambiguous source type
    if (!parsed.type || parsed.type.toLowerCase() === 'unknown') {
      reviewReasons.push(REVIEW_REASONS.AMBIGUOUS_TYPE);
    }

    // Validate DOI format if present
    if (parsed.doi && !this.isValidDoiFormat(parsed.doi)) {
      reviewReasons.push(REVIEW_REASONS.INVALID_DOI);
    }

    // Validate URL format if present
    if (parsed.url && !this.isValidUrlFormat(parsed.url)) {
      reviewReasons.push(REVIEW_REASONS.INVALID_URL);
    }

    return {
      needsReview: reviewReasons.length > 0,
      reviewReasons,
    };
  }

  /**
   * Validate DOI format (basic validation)
   * DOI format: 10.prefix/suffix
   */
  private isValidDoiFormat(doi: string): boolean {
    const doiRegex = /^10\.\d{4,}\/[^\s]+$/;
    return doiRegex.test(doi);
  }

  /**
   * Validate URL format (basic validation)
   */
  private isValidUrlFormat(url: string): boolean {
    try {
      new URL(url);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Map Prisma CitationComponent to ParsedCitationResult
   */
  private mapComponentToResult(
    citationId: string,
    component: {
      id: string;
      parseVariant: string | null;
      confidence: number;
      authors: string[];
      year: string | null;
      title: string | null;
      source: string | null;
      volume: string | null;
      issue: string | null;
      pages: string | null;
      doi: string | null;
      url: string | null;
      publisher: string | null;
      edition: string | null;
      accessDate: string | null;
      sourceType: string | null;
      fieldConfidence: unknown;
      doiVerified: boolean | null;
      urlValid: boolean | null;
      urlCheckedAt: Date | null;
      needsReview: boolean;
      reviewReasons: string[];
      createdAt: Date;
    }
  ): ParsedCitationResult {
    return {
      citationId,
      componentId: component.id,
      parseVariant: component.parseVariant,
      confidence: component.confidence,
      authors: component.authors,
      year: component.year,
      title: component.title,
      source: component.source,
      volume: component.volume,
      issue: component.issue,
      pages: component.pages,
      doi: component.doi,
      url: component.url,
      publisher: component.publisher,
      edition: component.edition,
      accessDate: component.accessDate,
      sourceType: component.sourceType as ParsedCitationResult['sourceType'],
      fieldConfidence: (component.fieldConfidence || {}) as Record<string, number>,
      doiVerified: component.doiVerified,
      urlValid: component.urlValid,
      urlCheckedAt: component.urlCheckedAt,
      needsReview: component.needsReview,
      reviewReasons: component.reviewReasons,
      createdAt: component.createdAt,
    };
  }
}

// Export singleton instance
export const citationParsingService = new CitationParsingService();
```

### Acceptance Criteria

- [ ] File created at `src/services/citation/citation-parsing.service.ts`
- [ ] `parseCitation()` parses single citation and stores component
- [ ] `parseAllCitations()` bulk parses all unparsed citations
- [ ] `reparseCitation()` creates new component (preserves history)
- [ ] `getCitationComponents()` returns version history
- [ ] `getLatestComponent()` returns most recent component
- [ ] `getCitationWithComponent()` returns citation with component
- [ ] `getCitationsWithComponents()` returns all for document
- [ ] Components stored correctly with all fields
- [ ] Proper error handling for each citation in bulk
- [ ] TypeScript compiles without errors

---

# PROMPT 4: Create Zod Validation Schemas
## File: `src/services/citation/citation.schemas.ts`

### Context

Create Zod validation schemas for API request validation.

### Objective

Create `src/services/citation/citation.schemas.ts` with all validation schemas.

### Implementation

```typescript
/**
 * Citation API Validation Schemas
 */

import { z } from 'zod';

// ============================================
// PARAMETER SCHEMAS
// ============================================

export const documentIdParamSchema = z.object({
  documentId: z.string().uuid('Invalid document ID format'),
});

export const citationIdParamSchema = z.object({
  citationId: z.string().uuid('Invalid citation ID format'),
});

export const jobIdParamSchema = z.object({
  jobId: z.string().uuid('Invalid job ID format'),
});

// ============================================
// QUERY SCHEMAS
// ============================================

export const listCitationsQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  type: z.enum([
    'PARENTHETICAL',
    'NARRATIVE',
    'FOOTNOTE',
    'ENDNOTE',
    'NUMERIC',
    'UNKNOWN'
  ]).optional(),
  style: z.enum([
    'APA',
    'MLA',
    'CHICAGO',
    'VANCOUVER',
    'HARVARD',
    'IEEE',
    'UNKNOWN'
  ]).optional(),
  minConfidence: z.coerce.number().min(0).max(1).optional(),
  maxConfidence: z.coerce.number().min(0).max(1).optional(),
  hasParsedComponent: z.coerce.boolean().optional(),
  // AC-26: Filter by review status
  needsReview: z.coerce.boolean().optional(),
});

// ============================================
// REQUEST BODY SCHEMAS
// ============================================

export const detectFromTextSchema = z.object({
  text: z.string().min(1, 'Text is required').max(500000, 'Text too long'),
  jobId: z.string().uuid().optional(),
});

// ============================================
// TYPE EXPORTS
// ============================================

export type DocumentIdParam = z.infer<typeof documentIdParamSchema>;
export type CitationIdParam = z.infer<typeof citationIdParamSchema>;
export type JobIdParam = z.infer<typeof jobIdParamSchema>;
export type ListCitationsQuery = z.infer<typeof listCitationsQuerySchema>;
export type DetectFromTextBody = z.infer<typeof detectFromTextSchema>;
```

---

# PROMPT 5: Create Controller
## File: `src/services/citation/citation.controller.ts`

### Context

Create the HTTP request handlers for citation endpoints.

### Objective

Create `src/services/citation/citation.controller.ts` following the class-based pattern.

### Implementation

```typescript
/**
 * Citation Controller
 * HTTP request handlers for citation detection and parsing APIs
 */

import { Request, Response, NextFunction } from 'express';
import { citationDetectionService } from './citation-detection.service';
import { citationParsingService } from './citation-parsing.service';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { DetectionInput } from './citation.types';

export class CitationController {
  /**
   * POST /api/v1/citation/detect
   * Upload file and detect citations
   */
  async detectFromUpload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const tenantId = req.user?.tenantId;
      const userId = req.user?.id;

      if (!tenantId || !userId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ success: false, error: 'File is required' });
        return;
      }

      // Create job for audit trail
      const job = await prisma.job.create({
        data: {
          tenantId,
          userId,
          type: 'CITATION_VALIDATION',
          status: 'PROCESSING',
          input: { fileName: req.file.originalname, fileSize: req.file.size },
          startedAt: new Date(),
        },
      });

      try {
        const input: DetectionInput = {
          jobId: job.id,
          tenantId,
          userId,
          fileBuffer: req.file.buffer,
          fileName: req.file.originalname,
        };

        const result = await citationDetectionService.detectCitations(input);

        // Update job to completed
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: 'COMPLETED',
            completedAt: new Date(),
            output: result as object,
          },
        });

        res.status(201).json({ success: true, data: result });
      } catch (error) {
        // Update job to failed
        await prisma.job.update({
          where: { id: job.id },
          data: {
            status: 'FAILED',
            error: error instanceof Error ? error.message : 'Unknown error',
          },
        });
        throw error;
      }
    } catch (error) {
      logger.error('[Citation Controller] detectFromUpload failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/job/:jobId
   * Get detection results by job ID
   */
  async getCitationsByJob(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationDetectionService.getDetectionResultsByJob(jobId);

      if (!result) {
        res.status(404).json({ success: false, error: 'No citations found for this job' });
        return;
      }

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] getCitationsByJob failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/document/:documentId
   * Get all citations for a document
   */
  async getCitations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationDetectionService.getDetectionResults(documentId);

      if (!result) {
        res.status(404).json({ success: false, error: 'Document not found' });
        return;
      }

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] getCitations failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/document/:documentId/redetect
   * Re-run detection on existing document
   */
  async redetect(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationDetectionService.redetectCitations(documentId);

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] redetect failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/:citationId/parse
   * Parse a single citation into components
   */
  async parseCitation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { citationId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationParsingService.parseCitation(citationId);

      res.status(201).json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] parseCitation failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/document/:documentId/parse-all
   * Parse all citations in a document
   */
  async parseAllCitations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationParsingService.parseAllCitations(documentId);

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] parseAllCitations failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/:citationId
   * Get single citation with latest component
   */
  async getCitation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { citationId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationParsingService.getCitationWithComponent(citationId);

      if (!result) {
        res.status(404).json({ success: false, error: 'Citation not found' });
        return;
      }

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] getCitation failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/:citationId/components
   * Get all components for a citation (version history)
   */
  async getComponents(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { citationId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationParsingService.getCitationComponents(citationId);

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] getComponents failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/:citationId/reparse
   * Re-parse a citation (creates new component version)
   */
  async reparseCitation(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { citationId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationParsingService.reparseCitation(citationId);

      res.status(201).json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] reparseCitation failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/document/:documentId/with-components
   * Get all citations with their components
   */
  async getCitationsWithComponents(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationParsingService.getCitationsWithComponents(documentId);

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Citation Controller] getCitationsWithComponents failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }
}

// Export singleton instance
export const citationController = new CitationController();
```

---

# PROMPT 6: Create Routes and Register
## File: `src/services/citation/citation.routes.ts`

### Implementation

```typescript
/**
 * Citation Routes
 * API route definitions for citation detection and parsing
 */

import { Router } from 'express';
import multer from 'multer';
import { authenticate } from '../../middleware/auth.middleware';
import { validate } from '../../middleware/validate.middleware';
import { citationController } from './citation.controller';
import {
  documentIdParamSchema,
  citationIdParamSchema,
  jobIdParamSchema,
} from './citation.schemas';

const router = Router();

// File upload configuration
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100MB
  fileFilter: (req, file, cb) => {
    const allowedExt = ['pdf', 'epub', 'docx', 'xml', 'txt'];
    const ext = file.originalname.toLowerCase().split('.').pop();
    if (allowedExt.includes(ext || '')) {
      cb(null, true);
    } else {
      cb(new Error('Unsupported file type. Allowed: PDF, EPUB, DOCX, XML, TXT'));
    }
  },
});

// Apply authentication to all routes
router.use(authenticate);

// ============================================
// STATIC ROUTES (must come before parameterized)
// ============================================

// Upload and detect
router.post(
  '/detect',
  upload.single('file'),
  citationController.detectFromUpload.bind(citationController)
);

// ============================================
// DOCUMENT-LEVEL ROUTES
// ============================================

router.get(
  '/document/:documentId',
  validate({ params: documentIdParamSchema }),
  citationController.getCitations.bind(citationController)
);

router.post(
  '/document/:documentId/redetect',
  validate({ params: documentIdParamSchema }),
  citationController.redetect.bind(citationController)
);

router.post(
  '/document/:documentId/parse-all',
  validate({ params: documentIdParamSchema }),
  citationController.parseAllCitations.bind(citationController)
);

router.get(
  '/document/:documentId/with-components',
  validate({ params: documentIdParamSchema }),
  citationController.getCitationsWithComponents.bind(citationController)
);

// ============================================
// JOB-LEVEL ROUTES
// ============================================

router.get(
  '/job/:jobId',
  validate({ params: jobIdParamSchema }),
  citationController.getCitationsByJob.bind(citationController)
);

// ============================================
// CITATION-LEVEL ROUTES (parameterized - last)
// ============================================

router.get(
  '/:citationId',
  validate({ params: citationIdParamSchema }),
  citationController.getCitation.bind(citationController)
);

router.get(
  '/:citationId/components',
  validate({ params: citationIdParamSchema }),
  citationController.getComponents.bind(citationController)
);

router.post(
  '/:citationId/parse',
  validate({ params: citationIdParamSchema }),
  citationController.parseCitation.bind(citationController)
);

router.post(
  '/:citationId/reparse',
  validate({ params: citationIdParamSchema }),
  citationController.reparseCitation.bind(citationController)
);

export default router;
```

### Register in Main Router

**File to modify:** `src/routes/index.ts`

Add these lines:

```typescript
// Add import at top of file
import citationRoutes from '../services/citation/citation.routes';

// Add route registration (after other router.use statements)
router.use('/citation', citationRoutes);
```

---

# PROMPT 7: Create Index Export
## File: `src/services/citation/index.ts`

### Implementation

```typescript
/**
 * Citation Services - Central Exports
 * US-4.1: Citation Detection
 * US-4.2: Citation Parsing
 */

// Services
export { citationDetectionService } from './citation-detection.service';
export { citationParsingService } from './citation-parsing.service';

// Controller
export { citationController } from './citation.controller';

// Types
export * from './citation.types';

// Schemas
export * from './citation.schemas';
```

---

# Execution Order

Run prompts in this order:

| Order | Prompt | File | Estimated Time |
|-------|--------|------|----------------|
| 1 | Type Definitions | `citation.types.ts` | 10 min |
| 2 | Detection Service | `citation-detection.service.ts` | 30 min |
| 3 | Parsing Service | `citation-parsing.service.ts` | 25 min |
| 4 | Zod Schemas | `citation.schemas.ts` | 5 min |
| 5 | Controller | `citation.controller.ts` | 20 min |
| 6 | Routes + Register | `citation.routes.ts` + `routes/index.ts` | 10 min |
| 7 | Index Export | `index.ts` | 2 min |

**Total estimated time: ~2 hours**

---

# Verification Checklist

After all prompts completed:

```bash
# 1. Verify all files created
ls -la src/services/citation/

# 2. Type check
npm run type-check

# 3. Start server
npm run dev

# 4. Test detection endpoint
curl -X POST http://localhost:5000/api/v1/citation/detect \
  -H "Authorization: Bearer <token>" \
  -F "file=@test-document.pdf"

# 5. View database
npx prisma studio
# Check: EditorialDocument, Citation, CitationComponent tables

# 6. Commit changes
git add src/services/citation/
git add src/routes/index.ts
git commit -m "feat(citation): implement US-4.1 detection and US-4.2 parsing

- Add citation detection service with AI integration
- Add citation parsing service with component extraction
- Add REST API endpoints for citation management
- Store results in EditorialDocument, Citation, CitationComponent tables

Co-Authored-By: Claude <noreply@anthropic.com>"

git push -u origin feature/citation/US-4-1-US-4-2
```

---

# API Endpoints Summary

| Method | Endpoint | Description | User Story |
|--------|----------|-------------|------------|
| POST | `/api/v1/citation/detect` | Upload file, detect citations | US-4.1 |
| GET | `/api/v1/citation/job/:jobId` | Get results by job ID | US-4.1 |
| GET | `/api/v1/citation/document/:documentId` | Get all citations | US-4.1 |
| POST | `/api/v1/citation/document/:documentId/redetect` | Re-run detection | US-4.1 |
| POST | `/api/v1/citation/document/:documentId/parse-all` | Parse all citations | US-4.2 |
| GET | `/api/v1/citation/document/:documentId/with-components` | Get citations with parsed data | US-4.2 |
| GET | `/api/v1/citation/:citationId` | Get single citation | US-4.1 |
| GET | `/api/v1/citation/:citationId/components` | Get parse history | US-4.2 |
| POST | `/api/v1/citation/:citationId/parse` | Parse single citation | US-4.2 |
| POST | `/api/v1/citation/:citationId/reparse` | Re-parse citation | US-4.2 |

---

# Reply to AVR

After completion, send AVR:

```
@AVR - US-4.1 and US-4.2 implementation complete!

Citation Detection and Parsing services are ready:
- Detection: `citationDetectionService.detectCitations(input)`
- Parsing: `citationParsingService.parseCitation(citationId)`

API endpoints live at `/api/v1/citation/*`

Question answered: Keeping One-to-Many for Citation ↔ CitationComponent for version history support.

Branch: feature/citation/US-4-1-US-4-2
```

---

*Document prepared for Dev2 (Sakthi) | US-4.1 & US-4.2 Implementation*
