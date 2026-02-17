# Editorial Services - Week 1 Shared Infrastructure
## Replit Prompts for Ambai

**Purpose:** Create the shared infrastructure that Dev2's Citation Module depends on.  
**Story Points:** 5  
**Priority:** BLOCKER - Must complete before Dev2 can start US-4.1, US-4.2  
**Owner:** Ambai  

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
Base Path: All code in src/
```

---

# PROMPT 1: Editorial AI Client Service
## (Extends existing Gemini service for Editorial-specific methods)

### Context

We're building the Ninja Platform Editorial Services module. This prompt creates a specialized AI client service that wraps our existing `src/services/ai/gemini.service.ts` with methods specifically needed by Editorial features (Plagiarism, Citation, Style validation).

Dev2 is blocked waiting for this service to start Citation Management development.

### Objective

Create `src/services/shared/editorial-ai-client.ts` that provides a unified interface for all Editorial Services AI operations, built on top of the existing Gemini service.

### Prerequisites

- Existing file: `src/services/ai/gemini.service.ts` with `generateText()`, `analyzeImage()`, `generateStructuredOutput()` methods
- `@google/generative-ai` SDK already installed
- Environment variable `GEMINI_API_KEY` configured

### Technical Requirements

**File to create:** `src/services/shared/editorial-ai-client.ts`

**Dependencies to import:**
```typescript
import { GeminiService } from '../ai/gemini.service';
```

**Interface definitions (create in same file or `src/types/editorial.types.ts`):**

```typescript
// Text chunk for embedding generation
interface TextChunk {
  id: string;
  text: string;
  startOffset: number;
  endOffset: number;
  pageNumber?: number;
  paragraphIndex?: number;
}

// Embedding result
interface EmbeddingResult {
  chunkId: string;
  vector: number[];  // 768-dimensional
  tokenCount: number;
}

// Classification categories for plagiarism
type PlagiarismClassification = 
  | 'VERBATIM_COPY' 
  | 'PARAPHRASED' 
  | 'COMMON_PHRASE' 
  | 'PROPERLY_CITED' 
  | 'COINCIDENTAL';

// Classification result with reasoning
interface ClassificationResult {
  classification: PlagiarismClassification;
  confidence: number;  // 0-100
  reasoning: string;
}

// Citation extraction result
interface ExtractedCitation {
  text: string;
  type: 'parenthetical' | 'narrative' | 'footnote' | 'endnote';
  style: 'APA' | 'MLA' | 'Chicago' | 'Vancouver' | 'unknown';
  location: {
    pageNumber?: number;
    paragraphIndex: number;
    startOffset: number;
    endOffset: number;
  };
  confidence: number;
}

// Parsed citation components
interface ParsedCitation {
  authors: string[];
  year?: string;
  title?: string;
  source?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  url?: string;
  type: 'journal' | 'book' | 'chapter' | 'website' | 'conference' | 'unknown';
  confidence: Record<string, number>;  // Confidence per field
  rawText: string;
}

// Style violation
interface StyleViolation {
  rule: string;
  ruleReference: string;  // e.g., "CMOS 6.28"
  location: { start: number; end: number };
  originalText: string;
  suggestedFix: string;
  severity: 'error' | 'warning' | 'suggestion';
}
```

**Class implementation:**

```typescript
export class EditorialAiClient {
  private gemini: GeminiService;

  constructor() {
    this.gemini = new GeminiService();
  }

  /**
   * Generate semantic embeddings for text chunks
   * Used by: Plagiarism Detection (US-1.1)
   */
  async generateEmbeddings(chunks: TextChunk[]): Promise<EmbeddingResult[]> {
    // Implementation: Use Gemini embedding model
    // Return 768-dimensional vectors for each chunk
  }

  /**
   * Detect and extract all citations from text
   * Used by: Citation Management (US-4.1)
   */
  async detectCitations(text: string): Promise<ExtractedCitation[]> {
    // Implementation: Use Gemini with NER-style prompt
    // Identify parenthetical, narrative, footnote citations
    // Distinguish from non-citations like "(see Figure 1)"
  }

  /**
   * Parse citation into structured components
   * Used by: Citation Management (US-4.2)
   */
  async parseCitation(citationText: string): Promise<ParsedCitation> {
    // Implementation: Use Gemini structured output
    // Extract authors, year, title, source, DOI, etc.
  }

  /**
   * Classify similarity match type
   * Used by: Plagiarism Detection (US-1.5)
   */
  async classifyMatch(
    sourceText: string, 
    matchedText: string
  ): Promise<ClassificationResult> {
    // Implementation: Use Gemini with few-shot classification prompt
    // Return classification + confidence + reasoning
  }

  /**
   * Analyze text for paraphrase detection
   * Used by: Plagiarism Detection (US-1.2)
   */
  async detectParaphrase(
    text1: string, 
    text2: string
  ): Promise<{
    isParaphrase: boolean;
    confidence: number;
    matchedPhrases: Array<{ original: string; paraphrased: string }>;
    explanation: string;
  }> {
    // Implementation: Use Gemini to analyze semantic equivalence
  }

  /**
   * Validate text against style guide rules
   * Used by: Style Validation (US-7.1, US-7.2)
   */
  async validateStyle(
    text: string,
    styleGuide: 'chicago' | 'apa' | 'mla' | 'custom',
    customRules?: string[]
  ): Promise<StyleViolation[]> {
    // Implementation: Use Gemini with style guide context
  }

  /**
   * Generate corrected text for a style violation
   * Used by: Style Validation (US-6.1)
   */
  async suggestCorrection(
    text: string,
    violation: StyleViolation
  ): Promise<string> {
    // Implementation: Use Gemini text transformation
  }

  /**
   * Extract rules from uploaded house style document
   * Used by: Style Validation (US-7.4)
   */
  async extractStyleRules(documentText: string): Promise<{
    explicitRules: string[];
    preferences: Array<{ preferred: string; avoid: string }>;
    terminology: Array<{ use: string; instead: string }>;
  }> {
    // Implementation: Use Gemini document understanding
  }
}

// Export singleton instance
export const editorialAi = new EditorialAiClient();
```

### Acceptance Criteria

- [ ] File created at `src/services/shared/editorial-ai-client.ts`
- [ ] All interfaces defined and exported
- [ ] Class implements all 8 methods listed above
- [ ] Methods call underlying GeminiService appropriately
- [ ] Proper error handling with try/catch and meaningful error messages
- [ ] TypeScript compiles without errors
- [ ] Export both class and singleton instance

### Implementation Notes

- The existing `GeminiService.generateStructuredOutput()` method accepts a Zod schema for type-safe responses - use this for `parseCitation()` and `extractStyleRules()`
- For embeddings, check if Gemini embedding model is already configured; if not, add `text-embedding-004` model
- Include reasonable token limits in prompts to control costs
- Add JSDoc comments explaining which user stories use each method

---

# PROMPT 2: Document Parser Service
## (Unified interface over existing parsing libraries)

### Context

We're building the Ninja Platform Editorial Services module. This prompt creates a unified document parser service that wraps our existing parsing libraries (EPUBCheck, AdmZip, fast-xml-parser, pdf-lib, pdfjs-dist) into a consistent interface.

Dev2 needs this to process uploaded documents for citation extraction.

### Objective

Create `src/services/shared/document-parser.ts` that provides format-agnostic document parsing, returning structured text with location information.

### Prerequisites

Existing libraries already installed:
- `adm-zip` - EPUB container extraction
- `fast-xml-parser` - XML/OPF parsing
- `pdf-lib` - PDF structure/metadata
- `pdfjs-dist` - PDF text extraction

### Technical Requirements

**File to create:** `src/services/shared/document-parser.ts`

**Interface definitions:**

```typescript
// Represents a chunk of text with location metadata
export interface TextChunk {
  id: string;
  text: string;
  wordCount: number;
  startOffset: number;
  endOffset: number;
  pageNumber?: number;
  chapterTitle?: string;
  paragraphIndex: number;
}

// Document metadata
export interface DocumentMetadata {
  title?: string;
  authors?: string[];
  publisher?: string;
  publicationDate?: string;
  language?: string;
  pageCount?: number;
  wordCount: number;
  format: 'pdf' | 'epub' | 'docx' | 'xml' | 'txt';
}

// Complete parsed document
export interface ParsedDocument {
  text: string;                    // Full concatenated text
  chunks: TextChunk[];             // 500-word chunks for AI processing
  metadata: DocumentMetadata;
  structure: DocumentStructure;    // Chapters, sections, etc.
}

// Document structure info
export interface DocumentStructure {
  chapters: Array<{
    title: string;
    startOffset: number;
    endOffset: number;
  }>;
  headings: Array<{
    level: number;
    text: string;
    offset: number;
  }>;
}

// Supported input types
type SupportedFormat = 'pdf' | 'epub' | 'docx' | 'xml' | 'txt';
```

**Class implementation:**

```typescript
import AdmZip from 'adm-zip';
import { XMLParser } from 'fast-xml-parser';
import { PDFDocument } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';

export class DocumentParser {
  private xmlParser: XMLParser;
  private readonly CHUNK_SIZE = 500; // words per chunk

  constructor() {
    this.xmlParser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
    });
  }

  /**
   * Main entry point - detects format and delegates
   */
  async parse(buffer: Buffer, filename: string): Promise<ParsedDocument> {
    const format = this.detectFormat(filename);

    switch (format) {
      case 'pdf':
        return this.parsePDF(buffer);
      case 'epub':
        return this.parseEPUB(buffer);
      case 'docx':
        return this.parseDOCX(buffer);
      case 'xml':
        return this.parseXML(buffer.toString('utf-8'));
      case 'txt':
        return this.parsePlainText(buffer.toString('utf-8'));
      default:
        throw new Error(`Unsupported format: ${format}`);
    }
  }

  /**
   * Detect document format from filename
   */
  private detectFormat(filename: string): SupportedFormat {
    const ext = filename.toLowerCase().split('.').pop();
    const formatMap: Record<string, SupportedFormat> = {
      'pdf': 'pdf',
      'epub': 'epub',
      'docx': 'docx',
      'xml': 'xml',
      'txt': 'txt',
      'text': 'txt',
    };
    return formatMap[ext || ''] || 'txt';
  }

  /**
   * Parse PDF using pdfjs-dist for text, pdf-lib for metadata
   */
  async parsePDF(buffer: Buffer): Promise<ParsedDocument> {
    // Use pdfjs-dist for text extraction with page positions
    // Use pdf-lib for metadata extraction
    // Chunk text into 500-word segments preserving page boundaries
  }

  /**
   * Parse EPUB container
   */
  async parseEPUB(buffer: Buffer): Promise<ParsedDocument> {
    // Use AdmZip to extract EPUB container
    // Parse META-INF/container.xml to find OPF
    // Parse OPF for metadata and spine order
    // Extract and concatenate content documents in spine order
    // Parse each XHTML file for text content
    // Track chapter boundaries from NCX/nav
  }

  /**
   * Parse DOCX (Office Open XML)
   */
  async parseDOCX(buffer: Buffer): Promise<ParsedDocument> {
    // Use AdmZip to extract DOCX (it's also a ZIP)
    // Parse word/document.xml for text content
    // Parse docProps/core.xml for metadata
    // Handle paragraph and heading styles for structure
  }

  /**
   * Parse XML/JATS content
   */
  async parseXML(xmlContent: string): Promise<ParsedDocument> {
    // Use fast-xml-parser to parse
    // Extract text from body content elements
    // Preserve section structure
    // Handle JATS-specific elements (abstract, body, back)
  }

  /**
   * Parse plain text
   */
  async parsePlainText(text: string): Promise<ParsedDocument> {
    // Simple paragraph detection
    // Chunk into 500-word segments
    // Detect headings by patterns (ALL CAPS, numbered, etc.)
  }

  /**
   * Split text into chunks of approximately CHUNK_SIZE words
   * Preserves sentence boundaries where possible
   */
  private chunkText(text: string, baseOffset: number = 0): TextChunk[] {
    // Split on sentence boundaries
    // Group sentences until ~500 words
    // Track character offsets for each chunk
    // Return array of TextChunk objects
  }

  /**
   * Extract text content from XHTML (used by EPUB parser)
   */
  private extractTextFromXHTML(xhtml: string): string {
    // Strip tags while preserving whitespace appropriately
    // Handle common XHTML elements (p, h1-h6, li, etc.)
  }
}

// Export singleton instance
export const documentParser = new DocumentParser();
```

### Acceptance Criteria

- [ ] File created at `src/services/shared/document-parser.ts`
- [ ] All interfaces defined and exported
- [ ] `parse()` method correctly routes to format-specific parser
- [ ] PDF parsing extracts text with page numbers
- [ ] EPUB parsing extracts text in spine order with chapter info
- [ ] DOCX parsing extracts text with paragraph structure
- [ ] XML parsing handles JATS elements appropriately
- [ ] Plain text parsing creates sensible chunks
- [ ] All chunks are ~500 words with proper offset tracking
- [ ] TypeScript compiles without errors

### Implementation Notes

- Priority for Dev2: Focus on PDF and plain text first (most common for citation extraction)
- EPUB and DOCX can be basic initially - we'll enhance later
- The `chunkText()` method is critical - it powers the embedding generation
- Use existing patterns from EPUB accessibility code where applicable
- Test with a sample PDF to verify page number tracking works

---

# PROMPT 3: Report Generator Skeleton
## (Minimal implementation - can be enhanced later)

### Context

We're building the Ninja Platform Editorial Services module. This prompt creates a skeleton report generator that will be fleshed out later. For now, we just need the interface so other services can code against it.

### Objective

Create `src/services/shared/report-generator.ts` with the interface and basic JSON implementation. PDF and DOCX export can be stubbed.

### Technical Requirements

**File to create:** `src/services/shared/report-generator.ts`

**Interface definitions:**

```typescript
// Generic validation issue (used by all Editorial services)
export interface ValidationIssue {
  id: string;
  type: 'plagiarism' | 'citation' | 'style' | 'content';
  severity: 'critical' | 'major' | 'minor' | 'suggestion';
  title: string;
  description: string;
  location: {
    pageNumber?: number;
    paragraphIndex?: number;
    startOffset: number;
    endOffset: number;
  };
  originalText?: string;
  suggestedFix?: string;
  metadata?: Record<string, unknown>;
}

// Report configuration
export interface ReportConfig {
  title: string;
  documentName: string;
  generatedAt: Date;
  analyzedBy: string;
  includeOriginalText: boolean;
  includeSuggestions: boolean;
  groupByType: boolean;
}

// Generated report
export interface GeneratedReport {
  format: 'json' | 'pdf' | 'docx';
  content: Buffer | object;
  filename: string;
}
```

**Class implementation:**

```typescript
export class ReportGenerator {
  /**
   * Generate report in specified format
   */
  async generate(
    issues: ValidationIssue[],
    config: ReportConfig,
    format: 'json' | 'pdf' | 'docx' = 'json'
  ): Promise<GeneratedReport> {
    switch (format) {
      case 'json':
        return this.generateJSON(issues, config);
      case 'pdf':
        return this.generatePDF(issues, config);
      case 'docx':
        return this.generateDOCX(issues, config);
    }
  }

  private async generateJSON(
    issues: ValidationIssue[],
    config: ReportConfig
  ): Promise<GeneratedReport> {
    const report = {
      title: config.title,
      document: config.documentName,
      generatedAt: config.generatedAt.toISOString(),
      summary: {
        total: issues.length,
        bySeverity: this.countBySeverity(issues),
        byType: this.countByType(issues),
      },
      issues: config.groupByType 
        ? this.groupByType(issues)
        : issues,
    };

    return {
      format: 'json',
      content: report,
      filename: `${config.documentName}-report.json`,
    };
  }

  private async generatePDF(
    issues: ValidationIssue[],
    config: ReportConfig
  ): Promise<GeneratedReport> {
    // TODO: Implement PDF generation using pdf-lib
    throw new Error('PDF report generation not yet implemented');
  }

  private async generateDOCX(
    issues: ValidationIssue[],
    config: ReportConfig
  ): Promise<GeneratedReport> {
    // TODO: Implement DOCX generation using docx library
    throw new Error('DOCX report generation not yet implemented');
  }

  private countBySeverity(issues: ValidationIssue[]): Record<string, number> {
    return issues.reduce((acc, issue) => {
      acc[issue.severity] = (acc[issue.severity] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  }

  private countByType(issues: ValidationIssue[]): Record<string, number> {
    return issues.reduce((acc, issue) => {
      acc[issue.type] = (acc[issue.type] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);
  }

  private groupByType(issues: ValidationIssue[]): Record<string, ValidationIssue[]> {
    return issues.reduce((acc, issue) => {
      if (!acc[issue.type]) acc[issue.type] = [];
      acc[issue.type].push(issue);
      return acc;
    }, {} as Record<string, ValidationIssue[]>);
  }
}

// Export singleton instance
export const reportGenerator = new ReportGenerator();
```

### Acceptance Criteria

- [ ] File created at `src/services/shared/report-generator.ts`
- [ ] All interfaces defined and exported
- [ ] JSON generation fully implemented
- [ ] PDF and DOCX methods exist but throw "not implemented" errors
- [ ] Summary statistics calculated correctly
- [ ] TypeScript compiles without errors

### Implementation Notes

- This is intentionally minimal - just enough for other services to import and use
- PDF/DOCX export will be added in Week 6 (US-3.4: Export Formats)
- The `ValidationIssue` interface is the KEY contract - make sure it covers all service needs

---

# PROMPT 4: Shared Types Index
## (Central export for all shared types)

### Context

Create a central types file that exports all shared types for easy importing by other services.

### Objective

Create `src/services/shared/index.ts` that re-exports all shared services and types.

### Technical Requirements

**File to create:** `src/services/shared/index.ts`

```typescript
// Services
export { EditorialAiClient, editorialAi } from './editorial-ai-client';
export { DocumentParser, documentParser } from './document-parser';
export { ReportGenerator, reportGenerator } from './report-generator';

// Types from editorial-ai-client
export type {
  TextChunk,
  EmbeddingResult,
  PlagiarismClassification,
  ClassificationResult,
  ExtractedCitation,
  ParsedCitation,
  StyleViolation,
} from './editorial-ai-client';

// Types from document-parser
export type {
  ParsedDocument,
  DocumentMetadata,
  DocumentStructure,
} from './document-parser';

// Types from report-generator
export type {
  ValidationIssue,
  ReportConfig,
  GeneratedReport,
} from './report-generator';
```

### Acceptance Criteria

- [ ] File created at `src/services/shared/index.ts`
- [ ] All services exported
- [ ] All types re-exported
- [ ] Other services can import like: `import { documentParser, ParsedDocument } from '../shared'`

---

# Execution Order

Run these prompts in order:

| Order | Prompt | Estimated Time | Unblocks |
|-------|--------|----------------|----------|
| 1 | Shared Types Index (create file structure first) | 5 min | - |
| 2 | Editorial AI Client | 30 min | Dev2's US-4.1, US-4.2 |
| 3 | Document Parser | 45 min | Dev2's US-4.1, US-4.2 |
| 4 | Report Generator | 15 min | Future: US-3.4 |

**Total estimated time: ~1.5 hours**

---

# After Completion - Notify Dev2

Once all files are created and pushed to `main`, send Dev2 this message:

```
@Dev2 - Shared infrastructure is ready! You can now start US-4.1 and US-4.2.

Import from shared like this:
```typescript
import { 
  editorialAi, 
  documentParser,
  ExtractedCitation,
  ParsedCitation,
  ParsedDocument 
} from '../shared';
```

Key methods you'll need:
- `documentParser.parse(buffer, filename)` - Returns ParsedDocument with text chunks
- `editorialAi.detectCitations(text)` - Returns ExtractedCitation[]
- `editorialAi.parseCitation(citationText)` - Returns ParsedCitation

Let me know if you need any interface changes!
```

---

*Document prepared for Ambai | Week 1 Blocker Resolution*
