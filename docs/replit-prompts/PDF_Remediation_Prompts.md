# Sprint PDF: Complete User Stories and Replit Prompts

## Backend + Frontend Implementation Guide

**Version:** 2.0 (Merged Complete)  
**Created:** January 28, 2026  
**Total Story Points:** 68 (Backend) + 21 (Frontend) = 89  
**Sprint Duration:** 2 weeks (10 working days)

---

## Table of Contents

1. [Sprint Overview](#sprint-overview)
2. [Technical Standards](#technical-standards)
3. [Architecture: BaseAuditService Abstract Class](#architecture-baseauditservice-abstract-class)
   - US-PDF-0.1: Create BaseAuditService Abstract Class
4. [Epic PDF-1: Core Infrastructure](#epic-pdf-1-core-infrastructure)
   - US-PDF-1.1: PDF Parser Service
   - US-PDF-1.2: PDF Audit Service Orchestrator
5. [Epic PDF-2: PDF Validation Engine](#epic-pdf-2-pdf-validation-engine)
   - US-PDF-2.1: PDF Structure Validator
   - US-PDF-2.2: PDF Alt Text Validator
   - US-PDF-2.3: PDF Color Contrast Analyzer
   - US-PDF-2.4: PDF Table Validator
6. [Epic PDF-3: PDF/UA & Matterhorn Protocol](#epic-pdfua--matterhorn-protocol)
   - US-PDF-3.1: PDF/UA Validator (Matterhorn Protocol)
7. [Epic PDF-4: ACR Integration](#epic-pdf-4-acr-integration)
   - US-PDF-4.1: Update WCAG Issue Mapper for PDF
   - US-PDF-4.2: PDF Audit Controller & Routes
8. [Epic PDF-5: Frontend Integration](#epic-pdf-5-frontend-integration)
   - FE-PDF-1: File Upload Enhancement
   - FE-PDF-2: PDF Audit Results Page
   - FE-PDF-3: Matterhorn Protocol Summary
   - FE-PDF-4: PDF Issue Card Enhancement
   - FE-PDF-5: PDF Page Navigator
   - FE-PDF-6: PDF Preview Panel
   - FE-PDF-7: API Service Layer
   - FE-PDF-8: Type Definitions
9. [Component Reusability Matrix](#component-reusability-matrix)
10. [WCAG Rule Mappings for PDF](#wcag-rule-mappings-for-pdf)
11. [Testing Strategy](#testing-strategy)
12. [Acceptance Criteria Summary](#acceptance-criteria-summary)
13. [Appendix: File Structure](#appendix-file-structure)

---

## Sprint Overview

| Attribute | Value |
|-----------|-------|
| **Duration** | 2 weeks (10 working days) |
| **Sprint Goal** | Build comprehensive PDF accessibility validation with Matterhorn Protocol checking and seamless ACR generation using shared infrastructure |
| **Total Story Points** | 68 points |
| **Team** | 3 Backend, 1 Frontend, 0.5 QA |
| **Code Reuse Target** | 65-70% from EPUB implementation |

### Sprint Success Criteria

- ✅ PDF files can be uploaded and audited for accessibility
- ✅ Matterhorn Protocol checkpoints validated (key 31 checkpoints)
- ✅ WCAG 2.2 AA validation for PDF content
- ✅ Gemini AI generates alt text suggestions for PDF images
- ✅ ACR/VPAT generation works identically to EPUB flow
- ✅ Shared `BaseAuditService` abstracts common functionality
- ✅ Frontend displays PDF audit results with same UX as EPUB

---

## Technical Standards

| Category | Standard |
|----------|----------|
| **Runtime** | Node.js 18+ |
| **Language** | TypeScript 5.x (strict mode) |
| **API Framework** | Express 4.x |
| **Module System** | ES Modules (import/export) |
| **Validation** | Zod schemas |
| **ORM** | Prisma |
| **Async Pattern** | async/await (no callbacks) |
| **PDF Libraries** | pdf-lib (structure), pdfjs-dist (content) |
| **AI Integration** | Google Gemini API (@google/generative-ai) |
| **Testing** | Vitest + Supertest |

---

## Architecture: BaseAuditService Abstract Class

### User Story US-PDF-0.1: Create BaseAuditService Abstract Class

**User Story:**  
As a **Developer**, I want a shared abstract base class for audit services, so that EPUB and PDF audits share common functionality and maintain consistent interfaces.

**Story Points:** 8  
**Priority:** Critical (Prerequisite for all PDF stories)  
**Dependencies:** None

### Replit Prompt US-PDF-0.1

#### Context
We need to refactor the existing `EpubAuditService` to extract common functionality into a `BaseAuditService` abstract class. This will allow the new `PdfAuditService` to inherit shared logic for scoring, issue combination, and result formatting.

#### Prerequisites
- Existing `epub-audit.service.ts` is working
- Understanding of current `AccessibilityIssue` and `EpubAuditResult` interfaces

#### Objective
Create an abstract `BaseAuditService` class that both `EpubAuditService` and `PdfAuditService` will extend.

#### Technical Requirements

**Create file: `src/services/audit/base-audit.service.ts`**

```typescript
import { logger } from '../../lib/logger';

// ============= SHARED TYPES =============

export type DocumentType = 'epub' | 'pdf';
export type IssueSeverity = 'critical' | 'serious' | 'moderate' | 'minor';
export type IssueSource = 
  | 'epubcheck' | 'ace' | 'js-auditor'  // EPUB sources
  | 'pdf-structure' | 'pdf-ua' | 'pdf-contrast' | 'pdf-tables' | 'pdf-alttext';  // PDF sources

export interface AccessibilityIssue {
  id: string;
  source: IssueSource;
  documentType: DocumentType;
  severity: IssueSeverity;
  code: string;
  message: string;
  wcagCriteria?: string[];
  location?: string;
  page?: number;
  suggestion?: string;
  category?: string;
  element?: string;
  context?: string;
  htmlSnippet?: string;
  confidence?: number;  // For AI-generated suggestions
}

export interface ScoreBreakdown {
  score: number;
  formula: string;
  weights: { critical: number; serious: number; moderate: number; minor: number };
  deductions: {
    critical: { count: number; points: number };
    serious: { count: number; points: number };
    moderate: { count: number; points: number };
    minor: { count: number; points: number };
  };
  totalDeduction: number;
  maxScore: number;
}

export interface IssueSummary {
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
  total: number;
}

export interface IssueSummaryBySource {
  [source: string]: IssueSummary & { autoFixable?: number };
}

export interface BaseAuditResult {
  jobId: string;
  fileName: string;
  documentType: DocumentType;
  isValid: boolean;
  isAccessible: boolean;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  combinedIssues: AccessibilityIssue[];
  summary: IssueSummary;
  summaryBySource: IssueSummaryBySource;
  auditedAt: Date;
}

// ============= ABSTRACT BASE CLASS =============

export abstract class BaseAuditService<TResult extends BaseAuditResult> {
  protected issueCounter = 0;
  protected abstract documentType: DocumentType;

  /**
   * Main audit entry point - must be implemented by subclasses
   */
  abstract runAudit(buffer: Buffer, jobId: string, fileName: string): Promise<TResult>;

  /**
   * Reset issue counter for new audit
   */
  protected resetIssueCounter(): void {
    this.issueCounter = 0;
  }

  /**
   * Create a standardized issue with auto-generated ID
   */
  protected createIssue(data: Omit<AccessibilityIssue, 'id' | 'documentType'>): AccessibilityIssue {
    return {
      id: `${this.documentType}-issue-${++this.issueCounter}`,
      documentType: this.documentType,
      ...data,
    };
  }

  /**
   * Calculate accessibility score from issues
   * Formula: 100 - (critical × 15) - (serious × 8) - (moderate × 4) - (minor × 1)
   */
  protected calculateScore(issues: AccessibilityIssue[]): ScoreBreakdown {
    const weights = {
      critical: 15,
      serious: 8,
      moderate: 4,
      minor: 1,
    };

    const counts = {
      critical: issues.filter(i => i.severity === 'critical').length,
      serious: issues.filter(i => i.severity === 'serious').length,
      moderate: issues.filter(i => i.severity === 'moderate').length,
      minor: issues.filter(i => i.severity === 'minor').length,
    };

    const deductions = {
      critical: { count: counts.critical, points: counts.critical * weights.critical },
      serious: { count: counts.serious, points: counts.serious * weights.serious },
      moderate: { count: counts.moderate, points: counts.moderate * weights.moderate },
      minor: { count: counts.minor, points: counts.minor * weights.minor },
    };

    const totalDeduction =
      deductions.critical.points +
      deductions.serious.points +
      deductions.moderate.points +
      deductions.minor.points;

    return {
      score: Math.max(0, 100 - totalDeduction),
      formula: '100 - (critical × 15) - (serious × 8) - (moderate × 4) - (minor × 1)',
      weights,
      deductions,
      totalDeduction,
      maxScore: 100,
    };
  }

  /**
   * Generate summary counts by severity
   */
  protected summarizeIssues(issues: AccessibilityIssue[]): IssueSummary {
    return {
      critical: issues.filter(i => i.severity === 'critical').length,
      serious: issues.filter(i => i.severity === 'serious').length,
      moderate: issues.filter(i => i.severity === 'moderate').length,
      minor: issues.filter(i => i.severity === 'minor').length,
      total: issues.length,
    };
  }

  /**
   * Generate summary grouped by source
   */
  protected summarizeBySource(issues: AccessibilityIssue[]): IssueSummaryBySource {
    const sources = [...new Set(issues.map(i => i.source))];
    const result: IssueSummaryBySource = {};

    for (const source of sources) {
      const sourceIssues = issues.filter(i => i.source === source);
      result[source] = {
        ...this.summarizeIssues(sourceIssues),
      };
    }

    return result;
  }

  /**
   * Determine if document is accessible based on critical issues
   */
  protected isDocumentAccessible(issues: AccessibilityIssue[]): boolean {
    const criticalCount = issues.filter(i => i.severity === 'critical').length;
    return criticalCount === 0;
  }

  /**
   * Log audit summary
   */
  protected logAuditSummary(result: BaseAuditResult): void {
    logger.info(`\n========== AUDIT COMPLETE ==========`);
    logger.info(`Document: ${result.fileName} (${result.documentType.toUpperCase()})`);
    logger.info(`Valid: ${result.isValid}, Accessible: ${result.isAccessible}`);
    logger.info(`Score: ${result.score}/100`);
    logger.info(`Issues: ${result.summary.total} total`);
    logger.info(`  Critical: ${result.summary.critical}`);
    logger.info(`  Serious: ${result.summary.serious}`);
    logger.info(`  Moderate: ${result.summary.moderate}`);
    logger.info(`  Minor: ${result.summary.minor}`);
    logger.info(`====================================\n`);
  }
}

export type { AccessibilityIssue as SharedAccessibilityIssue };
```

**Update file: `src/services/epub/epub-audit.service.ts`**

Refactor to extend `BaseAuditService`:

```typescript
import { BaseAuditService, BaseAuditResult, AccessibilityIssue, DocumentType } from '../audit/base-audit.service';
// ... other imports

export interface EpubAuditResult extends BaseAuditResult {
  epubVersion: string;
  epubCheckResult: EpubCheckResult;
  aceResult: AceResult | null;
  accessibilityMetadata: AceResult['metadata'] | null;
  classificationStats: {
    autoFixable: number;
    quickFixable: number;
    manualRequired: number;
  };
}

class EpubAuditService extends BaseAuditService<EpubAuditResult> {
  protected documentType: DocumentType = 'epub';
  private epubCheckPath: string;

  constructor() {
    super();
    this.epubCheckPath = process.env.EPUBCHECK_PATH || 
      path.resolve(__dirname, '../../../lib/epubcheck/epubcheck.jar');
  }

  async runAudit(buffer: Buffer, jobId: string, fileName: string): Promise<EpubAuditResult> {
    this.resetIssueCounter();
    // ... rest of existing implementation
    // Replace direct issue creation with this.createIssue()
    // Replace score calculation with this.calculateScore()
    // Replace summary generation with this.summarizeIssues()
  }

  // ... rest of existing methods
}
```

#### Acceptance Criteria

- [ ] `BaseAuditService` abstract class is created with shared types
- [ ] `EpubAuditService` extends `BaseAuditService` and passes all existing tests
- [ ] `AccessibilityIssue` interface includes `documentType` field
- [ ] Score calculation is identical between base class and original implementation
- [ ] No regression in EPUB audit functionality

#### Testing

```bash
# Run existing EPUB tests to verify no regression
npm test -- --grep "EpubAuditService"

# Verify base class methods
npm test -- --grep "BaseAuditService"
```

---

## Epic PDF-1: Core Infrastructure

### User Story US-PDF-1.1: PDF Parser Service

**User Story:**  
As a **Developer**, I want a PDF parsing service that extracts structure, content, and metadata, so that validators can analyze PDF accessibility.

**Story Points:** 8  
**Priority:** Critical  
**Dependencies:** US-PDF-0.1

### Replit Prompt US-PDF-1.1

#### Context
Create a PDF parser service using both `pdf-lib` (for structure/tags) and `pdfjs-dist` (for text content extraction). This service will be used by all PDF validators.

#### Prerequisites
- `BaseAuditService` is implemented (US-PDF-0.1)
- Install dependencies: `npm install pdf-lib pdfjs-dist`

#### Objective
Create a PDF parser that extracts document structure, text content, images, and metadata.

#### Technical Requirements

**Create file: `src/services/pdf/pdf-parser.service.ts`**

```typescript
import { PDFDocument, PDFName, PDFDict, PDFArray, PDFRef, PDFString } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import { logger } from '../../lib/logger';

// Configure pdfjs worker
pdfjsLib.GlobalWorkerOptions.workerSrc = 'pdfjs-dist/build/pdf.worker.min.js';

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: Date;
  modificationDate?: Date;
  language?: string;
  isTagged: boolean;
  hasMarkedContent: boolean;
  pdfVersion: string;
  pageCount: number;
}

export interface PdfStructureTag {
  type: string;  // H1, H2, P, Figure, Table, etc.
  page: number;
  attributes: Record<string, string>;
  children: PdfStructureTag[];
  altText?: string;
  actualText?: string;
}

export interface PdfImage {
  id: string;
  page: number;
  width: number;
  height: number;
  altText?: string;
  isDecorative: boolean;
  bbox: { x: number; y: number; width: number; height: number };
  data?: Uint8Array;
}

export interface PdfTextBlock {
  page: number;
  text: string;
  fontSize: number;
  fontName: string;
  color: { r: number; g: number; b: number };
  backgroundColor?: { r: number; g: number; b: number };
  bbox: { x: number; y: number; width: number; height: number };
  isHeading: boolean;
  headingLevel?: number;
}

export interface PdfTableCell {
  row: number;
  column: number;
  rowSpan: number;
  colSpan: number;
  isHeader: boolean;
  scope?: 'row' | 'column' | 'rowgroup' | 'colgroup';
  content: string;
}

export interface PdfTable {
  id: string;
  page: number;
  rows: number;
  columns: number;
  cells: PdfTableCell[];
  hasHeaders: boolean;
  isComplex: boolean;  // Has merged cells
}

export interface ParsedPdf {
  metadata: PdfMetadata;
  structureTags: PdfStructureTag[];
  images: PdfImage[];
  textBlocks: PdfTextBlock[];
  tables: PdfTable[];
  headingHierarchy: Array<{ level: number; text: string; page: number }>;
  readingOrder: Array<{ type: string; page: number; index: number }>;
  raw: {
    pdfLibDoc: PDFDocument;
    pdfjsDoc: pdfjsLib.PDFDocumentProxy;
  };
}

export class PdfParserService {
  async parse(buffer: Buffer): Promise<ParsedPdf> {
    logger.info('Starting PDF parse...');

    // Load with both libraries
    const pdfLibDoc = await PDFDocument.load(buffer, { 
      ignoreEncryption: true,
      updateMetadata: false 
    });

    const pdfjsDoc = await pdfjsLib.getDocument({ data: buffer }).promise;

    // Extract all data
    const metadata = await this.extractMetadata(pdfLibDoc, pdfjsDoc);
    const structureTags = await this.extractStructureTags(pdfLibDoc);
    const textBlocks = await this.extractTextBlocks(pdfjsDoc);
    const images = await this.extractImages(pdfLibDoc, pdfjsDoc);
    const tables = this.extractTables(structureTags);
    const headingHierarchy = this.buildHeadingHierarchy(structureTags, textBlocks);
    const readingOrder = this.analyzeReadingOrder(structureTags);

    logger.info(`PDF parsed: ${metadata.pageCount} pages, ${images.length} images, ${tables.length} tables`);

    return {
      metadata,
      structureTags,
      images,
      textBlocks,
      tables,
      headingHierarchy,
      readingOrder,
      raw: { pdfLibDoc, pdfjsDoc },
    };
  }

  private async extractMetadata(
    pdfLibDoc: PDFDocument, 
    pdfjsDoc: pdfjsLib.PDFDocumentProxy
  ): Promise<PdfMetadata> {
    const pdfjsMetadata = await pdfjsDoc.getMetadata();
    const catalog = pdfLibDoc.catalog;

    // Check if document is tagged
    const markInfo = catalog.lookup(PDFName.of('MarkInfo'));
    const isTagged = markInfo instanceof PDFDict && 
      markInfo.lookup(PDFName.of('Marked'))?.toString() === 'true';

    // Check for structure tree (indicates marked content)
    const structTreeRoot = catalog.lookup(PDFName.of('StructTreeRoot'));
    const hasMarkedContent = structTreeRoot instanceof PDFDict;

    // Extract language
    const lang = catalog.lookup(PDFName.of('Lang'));
    const language = lang instanceof PDFString ? lang.decodeText() : undefined;

    return {
      title: pdfjsMetadata.info?.Title || pdfLibDoc.getTitle() || undefined,
      author: pdfjsMetadata.info?.Author || pdfLibDoc.getAuthor() || undefined,
      subject: pdfjsMetadata.info?.Subject || pdfLibDoc.getSubject() || undefined,
      keywords: pdfjsMetadata.info?.Keywords || pdfLibDoc.getKeywords() || undefined,
      creator: pdfjsMetadata.info?.Creator || pdfLibDoc.getCreator() || undefined,
      producer: pdfjsMetadata.info?.Producer || pdfLibDoc.getProducer() || undefined,
      creationDate: pdfLibDoc.getCreationDate() || undefined,
      modificationDate: pdfLibDoc.getModificationDate() || undefined,
      language,
      isTagged,
      hasMarkedContent,
      pdfVersion: `${pdfLibDoc.context.header.major}.${pdfLibDoc.context.header.minor}`,
      pageCount: pdfLibDoc.getPageCount(),
    };
  }

  private async extractStructureTags(pdfLibDoc: PDFDocument): Promise<PdfStructureTag[]> {
    const catalog = pdfLibDoc.catalog;
    const structTreeRoot = catalog.lookup(PDFName.of('StructTreeRoot'));

    if (!(structTreeRoot instanceof PDFDict)) {
      logger.warn('PDF has no structure tree - document is not tagged');
      return [];
    }

    const tags: PdfStructureTag[] = [];
    const kids = structTreeRoot.lookup(PDFName.of('K'));

    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size(); i++) {
        const kid = kids.lookup(i);
        if (kid instanceof PDFDict) {
          const tag = this.parseStructureElement(kid, pdfLibDoc, 1);
          if (tag) tags.push(tag);
        }
      }
    } else if (kids instanceof PDFDict) {
      const tag = this.parseStructureElement(kids, pdfLibDoc, 1);
      if (tag) tags.push(tag);
    }

    return tags;
  }

  private parseStructureElement(
    element: PDFDict, 
    pdfLibDoc: PDFDocument, 
    page: number
  ): PdfStructureTag | null {
    const typeObj = element.lookup(PDFName.of('S'));
    if (!typeObj) return null;

    const type = typeObj.toString().replace('/', '');
    const attributes: Record<string, string> = {};

    // Extract alt text
    const alt = element.lookup(PDFName.of('Alt'));
    const altText = alt instanceof PDFString ? alt.decodeText() : undefined;

    // Extract actual text
    const actualTextObj = element.lookup(PDFName.of('ActualText'));
    const actualText = actualTextObj instanceof PDFString ? actualTextObj.decodeText() : undefined;

    // Extract attributes
    const attrObj = element.lookup(PDFName.of('A'));
    if (attrObj instanceof PDFDict) {
      // Parse attribute dictionary
      const scope = attrObj.lookup(PDFName.of('Scope'));
      if (scope) attributes['Scope'] = scope.toString();

      const headers = attrObj.lookup(PDFName.of('Headers'));
      if (headers) attributes['Headers'] = headers.toString();
    }

    // Parse children
    const children: PdfStructureTag[] = [];
    const kids = element.lookup(PDFName.of('K'));

    if (kids instanceof PDFArray) {
      for (let i = 0; i < kids.size(); i++) {
        const kid = kids.lookup(i);
        if (kid instanceof PDFDict) {
          const childTag = this.parseStructureElement(kid, pdfLibDoc, page);
          if (childTag) children.push(childTag);
        }
      }
    }

    return {
      type,
      page,
      attributes,
      children,
      altText,
      actualText,
    };
  }

  private async extractTextBlocks(pdfjsDoc: pdfjsLib.PDFDocumentProxy): Promise<PdfTextBlock[]> {
    const textBlocks: PdfTextBlock[] = [];

    for (let pageNum = 1; pageNum <= pdfjsDoc.numPages; pageNum++) {
      const page = await pdfjsDoc.getPage(pageNum);
      const textContent = await page.getTextContent();

      for (const item of textContent.items) {
        if ('str' in item && item.str.trim()) {
          const fontSize = Math.abs(item.transform[0]) || 12;
          const isHeading = fontSize >= 14;  // Simple heuristic

          textBlocks.push({
            page: pageNum,
            text: item.str,
            fontSize,
            fontName: item.fontName || 'unknown',
            color: { r: 0, g: 0, b: 0 },  // Default to black
            bbox: {
              x: item.transform[4],
              y: item.transform[5],
              width: item.width || 0,
              height: item.height || fontSize,
            },
            isHeading,
            headingLevel: isHeading ? this.estimateHeadingLevel(fontSize) : undefined,
          });
        }
      }
    }

    return textBlocks;
  }

  private estimateHeadingLevel(fontSize: number): number {
    if (fontSize >= 24) return 1;
    if (fontSize >= 20) return 2;
    if (fontSize >= 16) return 3;
    if (fontSize >= 14) return 4;
    return 5;
  }

  private async extractImages(
    pdfLibDoc: PDFDocument, 
    pdfjsDoc: pdfjsLib.PDFDocumentProxy
  ): Promise<PdfImage[]> {
    const images: PdfImage[] = [];
    let imageId = 0;

    for (let pageNum = 1; pageNum <= pdfjsDoc.numPages; pageNum++) {
      const page = await pdfjsDoc.getPage(pageNum);
      const operatorList = await page.getOperatorList();

      for (let i = 0; i < operatorList.fnArray.length; i++) {
        const fn = operatorList.fnArray[i];
        // OPS.paintImageXObject = 85
        if (fn === 85) {
          const args = operatorList.argsArray[i];
          if (args && args[0]) {
            images.push({
              id: `img-${++imageId}`,
              page: pageNum,
              width: args[1] || 0,
              height: args[2] || 0,
              altText: undefined,  // Will be matched from structure tags
              isDecorative: false,
              bbox: { x: 0, y: 0, width: args[1] || 0, height: args[2] || 0 },
            });
          }
        }
      }
    }

    // Match images with structure tags to get alt text
    // This would require correlating page positions

    return images;
  }

  private extractTables(structureTags: PdfStructureTag[]): PdfTable[] {
    const tables: PdfTable[] = [];
    let tableId = 0;

    const findTables = (tags: PdfStructureTag[], page: number): void => {
      for (const tag of tags) {
        if (tag.type === 'Table') {
          const table = this.parseTable(tag, ++tableId, page);
          if (table) tables.push(table);
        }
        if (tag.children.length > 0) {
          findTables(tag.children, tag.page);
        }
      }
    };

    findTables(structureTags, 1);
    return tables;
  }

  private parseTable(tableTag: PdfStructureTag, id: number, page: number): PdfTable | null {
    const cells: PdfTableCell[] = [];
    let row = 0;
    let hasHeaders = false;
    let isComplex = false;
    let maxColumns = 0;

    const parseRow = (rowTag: PdfStructureTag, rowIndex: number): void => {
      let col = 0;
      for (const cellTag of rowTag.children) {
        if (cellTag.type === 'TH' || cellTag.type === 'TD') {
          const isHeader = cellTag.type === 'TH';
          if (isHeader) hasHeaders = true;

          const rowSpan = parseInt(cellTag.attributes['RowSpan'] || '1', 10);
          const colSpan = parseInt(cellTag.attributes['ColSpan'] || '1', 10);
          if (rowSpan > 1 || colSpan > 1) isComplex = true;

          cells.push({
            row: rowIndex,
            column: col,
            rowSpan,
            colSpan,
            isHeader,
            scope: cellTag.attributes['Scope'] as 'row' | 'column' | undefined,
            content: cellTag.actualText || '',
          });

          col += colSpan;
        }
      }
      maxColumns = Math.max(maxColumns, col);
    };

    for (const child of tableTag.children) {
      if (child.type === 'TR') {
        parseRow(child, row++);
      } else if (child.type === 'THead' || child.type === 'TBody' || child.type === 'TFoot') {
        for (const rowChild of child.children) {
          if (rowChild.type === 'TR') {
            parseRow(rowChild, row++);
          }
        }
      }
    }

    return {
      id: `table-${id}`,
      page,
      rows: row,
      columns: maxColumns,
      cells,
      hasHeaders,
      isComplex,
    };
  }

  private buildHeadingHierarchy(
    structureTags: PdfStructureTag[], 
    textBlocks: PdfTextBlock[]
  ): Array<{ level: number; text: string; page: number }> {
    const headings: Array<{ level: number; text: string; page: number }> = [];

    const findHeadings = (tags: PdfStructureTag[]): void => {
      for (const tag of tags) {
        const match = tag.type.match(/^H(\d)$/);
        if (match) {
          headings.push({
            level: parseInt(match[1], 10),
            text: tag.actualText || '',
            page: tag.page,
          });
        }
        if (tag.children.length > 0) {
          findHeadings(tag.children);
        }
      }
    };

    findHeadings(structureTags);
    return headings;
  }

  private analyzeReadingOrder(
    structureTags: PdfStructureTag[]
  ): Array<{ type: string; page: number; index: number }> {
    const order: Array<{ type: string; page: number; index: number }> = [];
    let index = 0;

    const traverse = (tags: PdfStructureTag[]): void => {
      for (const tag of tags) {
        order.push({ type: tag.type, page: tag.page, index: index++ });
        if (tag.children.length > 0) {
          traverse(tag.children);
        }
      }
    };

    traverse(structureTags);
    return order;
  }

  /**
   * Extract a specific image as buffer for AI analysis
   */
  async extractImageData(
    pdfjsDoc: pdfjsLib.PDFDocumentProxy, 
    pageNum: number, 
    imageIndex: number
  ): Promise<Uint8Array | null> {
    try {
      const page = await pdfjsDoc.getPage(pageNum);
      const operatorList = await page.getOperatorList();

      let currentImageIndex = 0;
      for (let i = 0; i < operatorList.fnArray.length; i++) {
        if (operatorList.fnArray[i] === 85) {  // paintImageXObject
          if (currentImageIndex === imageIndex) {
            // Get image data - this is simplified, actual implementation
            // would need to extract from the page's resources
            return null;  // Placeholder
          }
          currentImageIndex++;
        }
      }
    } catch (error) {
      logger.error('Failed to extract image data', error as Error);
    }
    return null;
  }
}

export const pdfParserService = new PdfParserService();
```

#### Acceptance Criteria

- [ ] PDF files are parsed successfully with both pdf-lib and pdfjs-dist
- [ ] Metadata extraction includes: title, author, language, tagged status
- [ ] Structure tags are extracted from tagged PDFs
- [ ] Images are identified with page numbers
- [ ] Tables are parsed with cell structure
- [ ] Heading hierarchy is built from structure tags
- [ ] Untagged PDFs are handled gracefully (return empty structure)

#### Testing

```bash
# Test with tagged PDF
npm test -- --grep "PdfParserService"

# Manual test
curl -X POST http://localhost:3000/api/v1/test/parse-pdf \
  -F "file=@test-tagged.pdf"
```

---

### User Story US-PDF-1.2: PDF Audit Service Orchestrator

**User Story:**  
As a **Publisher**, I want to upload a PDF and receive a comprehensive accessibility audit, so that I can identify and fix accessibility issues.

**Story Points:** 8  
**Priority:** Critical  
**Dependencies:** US-PDF-0.1, US-PDF-1.1

### Replit Prompt US-PDF-1.2

#### Context
Create the main `PdfAuditService` that orchestrates all PDF validators and produces a unified audit result compatible with ACR generation.

#### Prerequisites
- `BaseAuditService` is implemented (US-PDF-0.1)
- `PdfParserService` is implemented (US-PDF-1.1)

#### Objective
Create a PDF audit service that runs all validators and produces results in the same format as EPUB audits.

#### Technical Requirements

**Create file: `src/services/pdf/pdf-audit.service.ts`**

```typescript
import { 
  BaseAuditService, 
  BaseAuditResult, 
  AccessibilityIssue, 
  DocumentType,
  IssueSummaryBySource 
} from '../audit/base-audit.service';
import { pdfParserService, ParsedPdf, PdfMetadata } from './pdf-parser.service';
import { pdfStructureValidator } from './validators/pdf-structure.validator';
import { pdfAltTextValidator } from './validators/pdf-alttext.validator';
import { pdfContrastValidator } from './validators/pdf-contrast.validator';
import { pdfTableValidator } from './validators/pdf-table.validator';
import { pdfUaValidator } from './validators/pdfua.validator';
import { logger } from '../../lib/logger';
import prisma from '../../lib/prisma';
import { s3Service } from '../s3.service';

export interface PdfAuditResult extends BaseAuditResult {
  pdfVersion: string;
  isTagged: boolean;
  pageCount: number;
  metadata: PdfMetadata;
  validationResults: {
    structure: { passed: number; failed: number; issues: AccessibilityIssue[] };
    altText: { passed: number; failed: number; issues: AccessibilityIssue[] };
    contrast: { passed: number; failed: number; issues: AccessibilityIssue[] };
    tables: { passed: number; failed: number; issues: AccessibilityIssue[] };
    pdfua: { passed: number; failed: number; manual: number; issues: AccessibilityIssue[] };
  };
  summaryBySource: IssueSummaryBySource;
  matterhornSummary: {
    passed: number;
    failed: number;
    manual: number;
    notApplicable: number;
  };
}

class PdfAuditService extends BaseAuditService<PdfAuditResult> {
  protected documentType: DocumentType = 'pdf';

  async runAudit(buffer: Buffer, jobId: string, fileName: string): Promise<PdfAuditResult> {
    this.resetIssueCounter();
    logger.info(`Starting PDF audit for job ${jobId}: ${fileName}`);

    // Parse PDF
    const parsed = await pdfParserService.parse(buffer);

    // If PDF is not tagged, add critical issue
    if (!parsed.metadata.isTagged) {
      logger.warn('PDF is not tagged - limited accessibility validation possible');
    }

    // Run all validators in parallel
    const [
      structureResult,
      altTextResult,
      contrastResult,
      tableResult,
      pdfuaResult,
    ] = await Promise.all([
      this.runStructureValidation(parsed),
      this.runAltTextValidation(parsed, buffer),
      this.runContrastValidation(parsed),
      this.runTableValidation(parsed),
      this.runPdfUaValidation(parsed),
    ]);

    // Combine all issues
    const combinedIssues: AccessibilityIssue[] = [
      ...structureResult.issues,
      ...altTextResult.issues,
      ...contrastResult.issues,
      ...tableResult.issues,
      ...pdfuaResult.issues,
    ];

    // Calculate score and summaries
    const scoreBreakdown = this.calculateScore(combinedIssues);
    const summary = this.summarizeIssues(combinedIssues);
    const summaryBySource = this.summarizeBySource(combinedIssues);

    // Determine validity
    const isValid = parsed.metadata.isTagged && 
      pdfuaResult.issues.filter(i => i.severity === 'critical').length === 0;
    const isAccessible = this.isDocumentAccessible(combinedIssues);

    const result: PdfAuditResult = {
      jobId,
      fileName,
      documentType: 'pdf',
      pdfVersion: parsed.metadata.pdfVersion,
      isTagged: parsed.metadata.isTagged,
      pageCount: parsed.metadata.pageCount,
      metadata: parsed.metadata,
      isValid,
      isAccessible,
      score: scoreBreakdown.score,
      scoreBreakdown,
      combinedIssues,
      summary,
      summaryBySource,
      validationResults: {
        structure: structureResult,
        altText: altTextResult,
        contrast: contrastResult,
        tables: tableResult,
        pdfua: pdfuaResult,
      },
      matterhornSummary: {
        passed: pdfuaResult.passed,
        failed: pdfuaResult.failed,
        manual: pdfuaResult.manual,
        notApplicable: 0,  // Calculate based on document type
      },
      auditedAt: new Date(),
    };

    // Log summary
    this.logAuditSummary(result);

    // Store result
    await this.storeResult(result);

    return result;
  }

  private async runStructureValidation(parsed: ParsedPdf): Promise<{
    passed: number;
    failed: number;
    issues: AccessibilityIssue[];
  }> {
    const issues = await pdfStructureValidator.validate(parsed);
    const mappedIssues = issues.map(issue => this.createIssue({
      ...issue,
      source: 'pdf-structure',
    }));

    return {
      passed: parsed.headingHierarchy.length - mappedIssues.length,
      failed: mappedIssues.length,
      issues: mappedIssues,
    };
  }

  private async runAltTextValidation(parsed: ParsedPdf, buffer: Buffer): Promise<{
    passed: number;
    failed: number;
    issues: AccessibilityIssue[];
  }> {
    const issues = await pdfAltTextValidator.validate(parsed, buffer);
    const mappedIssues = issues.map(issue => this.createIssue({
      ...issue,
      source: 'pdf-alttext',
    }));

    const imagesWithAlt = parsed.images.filter(img => img.altText).length;

    return {
      passed: imagesWithAlt,
      failed: mappedIssues.length,
      issues: mappedIssues,
    };
  }

  private async runContrastValidation(parsed: ParsedPdf): Promise<{
    passed: number;
    failed: number;
    issues: AccessibilityIssue[];
  }> {
    const issues = await pdfContrastValidator.validate(parsed);
    const mappedIssues = issues.map(issue => this.createIssue({
      ...issue,
      source: 'pdf-contrast',
    }));

    return {
      passed: parsed.textBlocks.length - mappedIssues.length,
      failed: mappedIssues.length,
      issues: mappedIssues,
    };
  }

  private async runTableValidation(parsed: ParsedPdf): Promise<{
    passed: number;
    failed: number;
    issues: AccessibilityIssue[];
  }> {
    const issues = await pdfTableValidator.validate(parsed);
    const mappedIssues = issues.map(issue => this.createIssue({
      ...issue,
      source: 'pdf-tables',
    }));

    const tablesWithHeaders = parsed.tables.filter(t => t.hasHeaders).length;

    return {
      passed: tablesWithHeaders,
      failed: mappedIssues.length,
      issues: mappedIssues,
    };
  }

  private async runPdfUaValidation(parsed: ParsedPdf): Promise<{
    passed: number;
    failed: number;
    manual: number;
    issues: AccessibilityIssue[];
  }> {
    const result = await pdfUaValidator.validate(parsed);
    const mappedIssues = result.issues.map(issue => this.createIssue({
      ...issue,
      source: 'pdf-ua',
    }));

    return {
      passed: result.passed,
      failed: result.failed,
      manual: result.manual,
      issues: mappedIssues,
    };
  }

  private async storeResult(result: PdfAuditResult): Promise<void> {
    await prisma.job.update({
      where: { id: result.jobId },
      data: {
        output: JSON.parse(JSON.stringify(result)),
        status: 'COMPLETED',
        completedAt: new Date(),
      },
    });
  }

  async runAuditFromS3(fileKey: string, jobId: string, fileName: string): Promise<PdfAuditResult> {
    logger.info(`Fetching PDF from S3: ${fileKey}`);
    const buffer = await s3Service.getFileBuffer(fileKey);
    return this.runAudit(buffer, jobId, fileName);
  }
}

export const pdfAuditService = new PdfAuditService();
export type { PdfAuditResult };
```

#### Acceptance Criteria

- [ ] PDF files are audited with all validators running in parallel
- [ ] Untagged PDFs receive critical issue for missing tags
- [ ] Results follow same structure as EPUB audit results
- [ ] Score calculation uses shared `BaseAuditService` method
- [ ] Results are stored in database with job ID
- [ ] S3 integration works for file retrieval

---

## Epic PDF-2: PDF Validation Engine

### User Story US-PDF-2.1: PDF Structure Validator

**User Story:**  
As a **Compliance Officer**, I want PDF structure validated against WCAG 2.2, so that documents have proper heading hierarchy, reading order, and language declaration.

**Story Points:** 8  
**Priority:** Critical  
**Dependencies:** US-PDF-1.1

### Replit Prompt US-PDF-2.1

#### Context
Create a PDF structure validator that checks heading hierarchy, reading order, and language declaration - the same checks done for EPUB but adapted for PDF structure tags.

#### Prerequisites
- `PdfParserService` is implemented (US-PDF-1.1)

#### Objective
Validate PDF structure for WCAG 1.3.1 (Info and Relationships), 1.3.2 (Meaningful Sequence), and 3.1.1 (Language of Page).

#### Technical Requirements

**Create file: `src/services/pdf/validators/pdf-structure.validator.ts`**

```typescript
import { ParsedPdf, PdfStructureTag } from '../pdf-parser.service';
import { AccessibilityIssue, IssueSeverity } from '../../audit/base-audit.service';
import { logger } from '../../../lib/logger';

interface StructureIssue extends Omit<AccessibilityIssue, 'id' | 'documentType' | 'source'> {
  severity: IssueSeverity;
  code: string;
  message: string;
  wcagCriteria: string[];
  location?: string;
  page?: number;
  suggestion?: string;
}

export class PdfStructureValidator {
  async validate(parsed: ParsedPdf): Promise<StructureIssue[]> {
    const issues: StructureIssue[] = [];

    // Check if document is tagged at all
    if (!parsed.metadata.isTagged) {
      issues.push({
        severity: 'critical',
        code: 'PDF-STRUCT-UNTAGGED',
        message: 'PDF is not tagged. Screen readers cannot access content structure.',
        wcagCriteria: ['1.3.1', '4.1.2'],
        suggestion: 'Add tags to the PDF using Adobe Acrobat Pro or similar tool. Run "Add Tags to Document" feature.',
      });
      // Return early - no point checking structure on untagged PDF
      return issues;
    }

    // Validate heading hierarchy
    issues.push(...this.validateHeadingHierarchy(parsed));

    // Validate reading order
    issues.push(...this.validateReadingOrder(parsed));

    // Validate language declaration
    issues.push(...this.validateLanguage(parsed));

    // Validate document title
    issues.push(...this.validateTitle(parsed));

    // Validate landmarks/regions
    issues.push(...this.validateLandmarks(parsed));

    logger.info(`PDF Structure validation complete: ${issues.length} issues found`);
    return issues;
  }

  private validateHeadingHierarchy(parsed: ParsedPdf): StructureIssue[] {
    const issues: StructureIssue[] = [];
    const headings = parsed.headingHierarchy;

    if (headings.length === 0) {
      issues.push({
        severity: 'serious',
        code: 'PDF-STRUCT-NO-HEADINGS',
        message: 'Document has no heading structure. Users cannot navigate by headings.',
        wcagCriteria: ['1.3.1', '2.4.6'],
        suggestion: 'Add heading tags (H1, H2, etc.) to structure the document.',
      });
      return issues;
    }

    // Check if first heading is H1
    if (headings[0].level !== 1) {
      issues.push({
        severity: 'moderate',
        code: 'PDF-STRUCT-MISSING-H1',
        message: `Document does not start with H1. First heading is H${headings[0].level}.`,
        wcagCriteria: ['1.3.1'],
        page: headings[0].page,
        suggestion: 'Ensure the document starts with an H1 heading for the main title.',
      });
    }

    // Check for skipped heading levels
    for (let i = 1; i < headings.length; i++) {
      const prev = headings[i - 1].level;
      const curr = headings[i].level;

      if (curr > prev + 1) {
        issues.push({
          severity: 'moderate',
          code: 'PDF-STRUCT-HEADING-SKIP',
          message: `Heading level skipped from H${prev} to H${curr}: "${headings[i].text.substring(0, 50)}..."`,
          wcagCriteria: ['1.3.1', '2.4.6'],
          page: headings[i].page,
          location: `Page ${headings[i].page}`,
          suggestion: `Change H${curr} to H${prev + 1} or add intermediate heading levels.`,
        });
      }
    }

    // Check for empty headings
    for (const heading of headings) {
      if (!heading.text.trim()) {
        issues.push({
          severity: 'serious',
          code: 'PDF-STRUCT-EMPTY-HEADING',
          message: `Empty H${heading.level} heading found on page ${heading.page}.`,
          wcagCriteria: ['1.3.1', '2.4.6'],
          page: heading.page,
          suggestion: 'Remove empty heading or add meaningful text content.',
        });
      }
    }

    return issues;
  }

  private validateReadingOrder(parsed: ParsedPdf): StructureIssue[] {
    const issues: StructureIssue[] = [];

    if (parsed.readingOrder.length === 0 && parsed.metadata.isTagged) {
      issues.push({
        severity: 'serious',
        code: 'PDF-STRUCT-NO-READING-ORDER',
        message: 'Cannot determine reading order from document structure.',
        wcagCriteria: ['1.3.2'],
        suggestion: 'Verify tag order in the Tags panel matches visual reading order.',
      });
    }

    // Check for common reading order issues
    // This is a simplified check - real validation would need visual layout analysis
    const structureTags = parsed.structureTags;

    // Look for figures/tables that might interrupt text flow
    const contentTypes = parsed.readingOrder.map(r => r.type);
    for (let i = 1; i < contentTypes.length - 1; i++) {
      const prev = contentTypes[i - 1];
      const curr = contentTypes[i];
      const next = contentTypes[i + 1];

      // If Figure/Table is between two paragraphs, flag for manual review
      if ((curr === 'Figure' || curr === 'Table') && 
          prev === 'P' && next === 'P') {
        issues.push({
          severity: 'minor',
          code: 'PDF-STRUCT-READING-ORDER-REVIEW',
          message: `${curr} element between paragraphs may need reading order verification.`,
          wcagCriteria: ['1.3.2'],
          page: parsed.readingOrder[i].page,
          suggestion: 'Verify the reading order matches visual layout in Adobe Acrobat.',
        });
      }
    }

    return issues;
  }

  private validateLanguage(parsed: ParsedPdf): StructureIssue[] {
    const issues: StructureIssue[] = [];

    if (!parsed.metadata.language) {
      issues.push({
        severity: 'serious',
        code: 'PDF-STRUCT-NO-LANGUAGE',
        message: 'Document language is not declared. Screen readers may mispronounce content.',
        wcagCriteria: ['3.1.1'],
        suggestion: 'Set document language in Document Properties > Advanced > Language.',
      });
    } else {
      // Validate language code format
      const langCode = parsed.metadata.language;
      const validLangPattern = /^[a-z]{2}(-[A-Z]{2})?$/;

      if (!validLangPattern.test(langCode)) {
        issues.push({
          severity: 'moderate',
          code: 'PDF-STRUCT-INVALID-LANGUAGE',
          message: `Invalid language code: "${langCode}". Expected format: "en" or "en-US".`,
          wcagCriteria: ['3.1.1'],
          suggestion: 'Use a valid BCP 47 language tag (e.g., "en", "en-US", "fr-CA").',
        });
      }
    }

    return issues;
  }

  private validateTitle(parsed: ParsedPdf): StructureIssue[] {
    const issues: StructureIssue[] = [];

    if (!parsed.metadata.title) {
      issues.push({
        severity: 'serious',
        code: 'PDF-STRUCT-NO-TITLE',
        message: 'Document title is not set in metadata.',
        wcagCriteria: ['2.4.2'],
        suggestion: 'Set document title in Document Properties > Description > Title.',
      });
    } else if (parsed.metadata.title === 'Untitled' || 
               parsed.metadata.title.match(/^[A-Za-z0-9_-]+\.(pdf|PDF)$/)) {
      issues.push({
        severity: 'moderate',
        code: 'PDF-STRUCT-GENERIC-TITLE',
        message: `Document has generic title: "${parsed.metadata.title}". Title should be descriptive.`,
        wcagCriteria: ['2.4.2'],
        suggestion: 'Set a meaningful document title that describes the content.',
      });
    }

    return issues;
  }

  private validateLandmarks(parsed: ParsedPdf): StructureIssue[] {
    const issues: StructureIssue[] = [];

    // Check for Document tag at root
    const hasDocumentTag = parsed.structureTags.some(tag => tag.type === 'Document');

    if (!hasDocumentTag && parsed.structureTags.length > 0) {
      issues.push({
        severity: 'minor',
        code: 'PDF-STRUCT-NO-DOCUMENT-TAG',
        message: 'Document lacks root Document tag structure.',
        wcagCriteria: ['1.3.1'],
        suggestion: 'Wrap all content in a Document tag for proper structure.',
      });
    }

    return issues;
  }
}

export const pdfStructureValidator = new PdfStructureValidator();
```

#### Acceptance Criteria

- [ ] Untagged PDFs receive critical error
- [ ] Heading hierarchy is validated (no skipped levels)
- [ ] Empty headings are flagged as serious issues
- [ ] Missing language declaration is flagged
- [ ] Invalid language codes are detected
- [ ] Missing/generic document title is flagged
- [ ] All issues include WCAG criteria references

---

### User Story US-PDF-2.2: PDF Alt Text Validator

**User Story:**  
As a **Compliance Officer**, I want all images checked for alt text, so that visually impaired users can understand image content.

**Story Points:** 8  
**Priority:** Critical  
**Dependencies:** US-PDF-1.1, Gemini AI integration (existing)

### Replit Prompt US-PDF-2.2

#### Context
Create a PDF alt text validator that checks for missing, empty, or inadequate alt text on images, and uses Gemini AI to suggest appropriate alt text.

#### Prerequisites
- `PdfParserService` is implemented (US-PDF-1.1)
- Gemini AI service is available (existing from EPUB)

#### Objective
Validate image alt text for WCAG 1.1.1 (Non-text Content) and generate AI suggestions for missing alt text.

#### Technical Requirements

**Create file: `src/services/pdf/validators/pdf-alttext.validator.ts`**

```typescript
import { ParsedPdf, PdfImage, PdfStructureTag } from '../pdf-parser.service';
import { AccessibilityIssue, IssueSeverity } from '../../audit/base-audit.service';
import { geminiService } from '../../ai/gemini.service';
import { logger } from '../../../lib/logger';

interface AltTextIssue extends Omit<AccessibilityIssue, 'id' | 'documentType' | 'source'> {
  severity: IssueSeverity;
  code: string;
  message: string;
  wcagCriteria: string[];
  location?: string;
  page?: number;
  suggestion?: string;
  aiSuggestion?: string;
  confidence?: number;
}

// Common generic alt text patterns to flag
const GENERIC_ALT_PATTERNS = [
  /^image$/i,
  /^picture$/i,
  /^photo$/i,
  /^graphic$/i,
  /^figure$/i,
  /^img\d*$/i,
  /^image\d+$/i,
  /^untitled$/i,
  /^placeholder$/i,
  /^\s*$/,
];

// Patterns indicating decorative intent
const DECORATIVE_PATTERNS = [
  /decorative/i,
  /spacer/i,
  /border/i,
  /divider/i,
  /separator/i,
  /background/i,
];

export class PdfAltTextValidator {
  async validate(parsed: ParsedPdf, pdfBuffer: Buffer): Promise<AltTextIssue[]> {
    const issues: AltTextIssue[] = [];

    // Get all Figure tags from structure
    const figures = this.extractFigures(parsed.structureTags);

    // Also check images that might not be in structure
    const unmappedImages = parsed.images.filter(img => 
      !figures.some(fig => this.imagesMatch(img, fig))
    );

    // Validate each figure
    for (const figure of figures) {
      const figureIssues = await this.validateFigure(figure, pdfBuffer);
      issues.push(...figureIssues);
    }

    // Flag unmapped images (images without Figure tags)
    for (const image of unmappedImages) {
      issues.push({
        severity: 'serious',
        code: 'PDF-ALT-UNTAGGED-IMAGE',
        message: `Image on page ${image.page} is not tagged as a Figure.`,
        wcagCriteria: ['1.1.1'],
        page: image.page,
        location: `Page ${image.page}`,
        suggestion: 'Tag the image as a Figure element with appropriate alt text, or mark as Artifact if decorative.',
      });
    }

    logger.info(`PDF Alt Text validation complete: ${issues.length} issues found`);
    return issues;
  }

  private extractFigures(tags: PdfStructureTag[]): PdfStructureTag[] {
    const figures: PdfStructureTag[] = [];

    const traverse = (tagList: PdfStructureTag[]): void => {
      for (const tag of tagList) {
        if (tag.type === 'Figure') {
          figures.push(tag);
        }
        if (tag.children.length > 0) {
          traverse(tag.children);
        }
      }
    };

    traverse(tags);
    return figures;
  }

  private imagesMatch(image: PdfImage, figure: PdfStructureTag): boolean {
    // Simple matching by page - more sophisticated matching would
    // compare bounding boxes
    return image.page === figure.page;
  }

  private async validateFigure(
    figure: PdfStructureTag, 
    pdfBuffer: Buffer
  ): Promise<AltTextIssue[]> {
    const issues: AltTextIssue[] = [];
    const altText = figure.altText || figure.actualText;

    // Check for missing alt text
    if (!altText) {
      const aiSuggestion = await this.generateAltTextSuggestion(figure, pdfBuffer);

      issues.push({
        severity: 'critical',
        code: 'PDF-ALT-MISSING',
        message: `Figure on page ${figure.page} has no alternative text.`,
        wcagCriteria: ['1.1.1'],
        page: figure.page,
        location: `Page ${figure.page}`,
        suggestion: aiSuggestion?.suggestion || 'Add descriptive alt text or mark as decorative.',
        aiSuggestion: aiSuggestion?.suggestion,
        confidence: aiSuggestion?.confidence,
      });
      return issues;
    }

    // Check for empty alt text (might be intentionally decorative)
    if (altText.trim() === '') {
      // Check if it's marked as Artifact (correct for decorative)
      if (!figure.attributes['Role']?.includes('Artifact')) {
        issues.push({
          severity: 'moderate',
          code: 'PDF-ALT-EMPTY',
          message: `Figure on page ${figure.page} has empty alt text but is not marked as Artifact.`,
          wcagCriteria: ['1.1.1'],
          page: figure.page,
          location: `Page ${figure.page}`,
          suggestion: 'If decorative, mark as Artifact. Otherwise, add descriptive alt text.',
        });
      }
      return issues;
    }

    // Check for generic alt text
    if (this.isGenericAltText(altText)) {
      const aiSuggestion = await this.generateAltTextSuggestion(figure, pdfBuffer);

      issues.push({
        severity: 'serious',
        code: 'PDF-ALT-GENERIC',
        message: `Figure on page ${figure.page} has generic alt text: "${altText}"`,
        wcagCriteria: ['1.1.1'],
        page: figure.page,
        location: `Page ${figure.page}`,
        suggestion: aiSuggestion?.suggestion || 'Replace with descriptive alt text that conveys the image content.',
        aiSuggestion: aiSuggestion?.suggestion,
        confidence: aiSuggestion?.confidence,
      });
      return issues;
    }

    // Check for filename as alt text
    if (this.isFilenameAltText(altText)) {
      issues.push({
        severity: 'serious',
        code: 'PDF-ALT-FILENAME',
        message: `Figure on page ${figure.page} uses filename as alt text: "${altText}"`,
        wcagCriteria: ['1.1.1'],
        page: figure.page,
        location: `Page ${figure.page}`,
        suggestion: 'Replace filename with descriptive alt text.',
      });
      return issues;
    }

    // Check alt text length (too short or too long)
    if (altText.length < 5) {
      issues.push({
        severity: 'moderate',
        code: 'PDF-ALT-TOO-SHORT',
        message: `Figure on page ${figure.page} has very short alt text (${altText.length} chars): "${altText}"`,
        wcagCriteria: ['1.1.1'],
        page: figure.page,
        location: `Page ${figure.page}`,
        suggestion: 'Provide more descriptive alt text unless image is simple.',
      });
    } else if (altText.length > 150) {
      issues.push({
        severity: 'minor',
        code: 'PDF-ALT-TOO-LONG',
        message: `Figure on page ${figure.page} has very long alt text (${altText.length} chars).`,
        wcagCriteria: ['1.1.1'],
        page: figure.page,
        location: `Page ${figure.page}`,
        suggestion: 'Consider using a shorter alt text with a longer description in surrounding text.',
      });
    }

    return issues;
  }

  private isGenericAltText(altText: string): boolean {
    return GENERIC_ALT_PATTERNS.some(pattern => pattern.test(altText));
  }

  private isFilenameAltText(altText: string): boolean {
    // Check for common image file extensions
    return /\.(jpg|jpeg|png|gif|bmp|tiff|webp|svg)$/i.test(altText);
  }

  private async generateAltTextSuggestion(
    figure: PdfStructureTag, 
    pdfBuffer: Buffer
  ): Promise<{ suggestion: string; confidence: number } | null> {
    try {
      // In a full implementation, we would extract the actual image data
      // For now, return a placeholder
      // TODO: Implement image extraction from PDF and send to Gemini

      const result = await geminiService.generateAltText({
        context: `PDF document, page ${figure.page}`,
        surroundingText: figure.actualText || '',
      });

      if (result) {
        return {
          suggestion: result.altText,
          confidence: result.confidence || 0.8,
        };
      }
    } catch (error) {
      logger.warn('Failed to generate AI alt text suggestion', error as Error);
    }

    return null;
  }
}

export const pdfAltTextValidator = new PdfAltTextValidator();
```

#### Acceptance Criteria

- [ ] Missing alt text is flagged as critical
- [ ] Empty alt text on non-decorative images is flagged
- [ ] Generic alt text patterns are detected
- [ ] Filenames used as alt text are flagged
- [ ] Very short/long alt text is flagged with appropriate severity
- [ ] AI suggestions are generated for missing/generic alt text
- [ ] Images without Figure tags are identified

---

### User Story US-PDF-2.3: PDF Color Contrast Analyzer

**User Story:**  
As a **Compliance Officer**, I want text color contrast checked against WCAG requirements, so that content is readable for users with low vision.

**Story Points:** 5  
**Priority:** High  
**Dependencies:** US-PDF-1.1

### Replit Prompt US-PDF-2.3

#### Context
Create a PDF contrast analyzer that calculates contrast ratios between text and background colors and flags violations of WCAG 1.4.3 (Contrast Minimum).

#### Prerequisites
- `PdfParserService` is implemented (US-PDF-1.1)

#### Objective
Calculate contrast ratios for text elements and flag WCAG 1.4.3 violations.

#### Technical Requirements

**Create file: `src/services/pdf/validators/pdf-contrast.validator.ts`**

```typescript
import { ParsedPdf, PdfTextBlock } from '../pdf-parser.service';
import { AccessibilityIssue, IssueSeverity } from '../../audit/base-audit.service';
import { logger } from '../../../lib/logger';

interface ContrastIssue extends Omit<AccessibilityIssue, 'id' | 'documentType' | 'source'> {
  severity: IssueSeverity;
  code: string;
  message: string;
  wcagCriteria: string[];
  location?: string;
  page?: number;
  suggestion?: string;
}

interface RGB {
  r: number;
  g: number;
  b: number;
}

// WCAG contrast thresholds
const CONTRAST_AA_NORMAL = 4.5;
const CONTRAST_AA_LARGE = 3.0;
const CONTRAST_AAA_NORMAL = 7.0;
const CONTRAST_AAA_LARGE = 4.5;

// Large text threshold (14pt bold or 18pt regular = ~18.5px or ~24px)
const LARGE_TEXT_SIZE = 18;
const LARGE_TEXT_BOLD_SIZE = 14;

export class PdfContrastValidator {
  async validate(parsed: ParsedPdf): Promise<ContrastIssue[]> {
    const issues: ContrastIssue[] = [];

    for (const textBlock of parsed.textBlocks) {
      const blockIssues = this.validateTextBlock(textBlock);
      issues.push(...blockIssues);
    }

    logger.info(`PDF Contrast validation complete: ${issues.length} issues found`);
    return issues;
  }

  private validateTextBlock(block: PdfTextBlock): ContrastIssue[] {
    const issues: ContrastIssue[] = [];

    // Get foreground and background colors
    const foreground = block.color;
    const background = block.backgroundColor || { r: 255, g: 255, b: 255 }; // Default white

    // Calculate contrast ratio
    const ratio = this.calculateContrastRatio(foreground, background);

    // Determine if text is "large"
    const isLargeText = this.isLargeText(block.fontSize, false); // TODO: detect bold

    // Check against WCAG AA thresholds
    const requiredRatio = isLargeText ? CONTRAST_AA_LARGE : CONTRAST_AA_NORMAL;

    if (ratio < requiredRatio) {
      const severity: IssueSeverity = ratio < 2.5 ? 'critical' : 'serious';

      issues.push({
        severity,
        code: 'PDF-CONTRAST-FAIL',
        message: `Text "${block.text.substring(0, 30)}..." has insufficient contrast ratio: ${ratio.toFixed(2)}:1 (required: ${requiredRatio}:1 for ${isLargeText ? 'large' : 'normal'} text)`,
        wcagCriteria: ['1.4.3'],
        page: block.page,
        location: `Page ${block.page}`,
        suggestion: this.suggestFix(foreground, background, requiredRatio),
      });
    }

    return issues;
  }

  /**
   * Calculate relative luminance using WCAG formula
   * https://www.w3.org/WAI/GL/wiki/Relative_luminance
   */
  private calculateRelativeLuminance(rgb: RGB): number {
    const [r, g, b] = [rgb.r, rgb.g, rgb.b].map(c => {
      const sRGB = c / 255;
      return sRGB <= 0.03928
        ? sRGB / 12.92
        : Math.pow((sRGB + 0.055) / 1.055, 2.4);
    });

    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /**
   * Calculate contrast ratio using WCAG formula
   * https://www.w3.org/WAI/GL/wiki/Contrast_ratio
   */
  private calculateContrastRatio(foreground: RGB, background: RGB): number {
    const l1 = this.calculateRelativeLuminance(foreground);
    const l2 = this.calculateRelativeLuminance(background);

    const lighter = Math.max(l1, l2);
    const darker = Math.min(l1, l2);

    return (lighter + 0.05) / (darker + 0.05);
  }

  /**
   * Check if text qualifies as "large text" under WCAG
   */
  private isLargeText(fontSize: number, isBold: boolean): boolean {
    if (isBold) {
      return fontSize >= LARGE_TEXT_BOLD_SIZE;
    }
    return fontSize >= LARGE_TEXT_SIZE;
  }

  /**
   * Suggest a color fix to meet contrast requirements
   */
  private suggestFix(foreground: RGB, background: RGB, requiredRatio: number): string {
    const fgLuminance = this.calculateRelativeLuminance(foreground);
    const bgLuminance = this.calculateRelativeLuminance(background);

    if (fgLuminance < bgLuminance) {
      // Foreground is darker - suggest making it even darker
      const darkerFg = this.darkenColor(foreground);
      const newRatio = this.calculateContrastRatio(darkerFg, background);

      if (newRatio >= requiredRatio) {
        return `Consider using darker text color: rgb(${darkerFg.r}, ${darkerFg.g}, ${darkerFg.b}) would achieve ${newRatio.toFixed(2)}:1 ratio.`;
      }
    } else {
      // Foreground is lighter - suggest making it even lighter
      const lighterFg = this.lightenColor(foreground);
      const newRatio = this.calculateContrastRatio(lighterFg, background);

      if (newRatio >= requiredRatio) {
        return `Consider using lighter text color: rgb(${lighterFg.r}, ${lighterFg.g}, ${lighterFg.b}) would achieve ${newRatio.toFixed(2)}:1 ratio.`;
      }
    }

    return `Increase contrast by using darker text on light backgrounds or lighter text on dark backgrounds.`;
  }

  private darkenColor(rgb: RGB): RGB {
    return {
      r: Math.max(0, Math.floor(rgb.r * 0.7)),
      g: Math.max(0, Math.floor(rgb.g * 0.7)),
      b: Math.max(0, Math.floor(rgb.b * 0.7)),
    };
  }

  private lightenColor(rgb: RGB): RGB {
    return {
      r: Math.min(255, Math.floor(rgb.r + (255 - rgb.r) * 0.3)),
      g: Math.min(255, Math.floor(rgb.g + (255 - rgb.g) * 0.3)),
      b: Math.min(255, Math.floor(rgb.b + (255 - rgb.b) * 0.3)),
    };
  }

  /**
   * Convert hex color to RGB
   */
  hexToRgb(hex: string): RGB | null {
    const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return result
      ? {
          r: parseInt(result[1], 16),
          g: parseInt(result[2], 16),
          b: parseInt(result[3], 16),
        }
      : null;
  }

  /**
   * Convert RGB to hex color
   */
  rgbToHex(rgb: RGB): string {
    return '#' + [rgb.r, rgb.g, rgb.b]
      .map(c => c.toString(16).padStart(2, '0'))
      .join('');
  }
}

export const pdfContrastValidator = new PdfContrastValidator();
```

#### Acceptance Criteria

- [ ] Contrast ratio is calculated using WCAG formula
- [ ] WCAG AA thresholds applied (4.5:1 normal, 3.0:1 large text)
- [ ] Large text is correctly identified (18pt or 14pt bold)
- [ ] Very low contrast (<2.5:1) flagged as critical
- [ ] Color suggestions provided for fixing issues
- [ ] Each issue includes page location

---

### User Story US-PDF-2.4: PDF Table Validator

**User Story:**  
As a **Compliance Officer**, I want tables checked for proper accessibility markup, so that screen readers can navigate table data.

**Story Points:** 5  
**Priority:** High  
**Dependencies:** US-PDF-1.1

### Replit Prompt US-PDF-2.4

#### Context
Create a PDF table validator that checks for header cells, scope attributes, and complex table structures.

#### Prerequisites
- `PdfParserService` is implemented (US-PDF-1.1)

#### Objective
Validate table structure for WCAG 1.3.1 (Info and Relationships).

#### Technical Requirements

**Create file: `src/services/pdf/validators/pdf-table.validator.ts`**

```typescript
import { ParsedPdf, PdfTable, PdfTableCell } from '../pdf-parser.service';
import { AccessibilityIssue, IssueSeverity } from '../../audit/base-audit.service';
import { logger } from '../../../lib/logger';

interface TableIssue extends Omit<AccessibilityIssue, 'id' | 'documentType' | 'source'> {
  severity: IssueSeverity;
  code: string;
  message: string;
  wcagCriteria: string[];
  location?: string;
  page?: number;
  suggestion?: string;
}

export class PdfTableValidator {
  async validate(parsed: ParsedPdf): Promise<TableIssue[]> {
    const issues: TableIssue[] = [];

    for (const table of parsed.tables) {
      const tableIssues = this.validateTable(table);
      issues.push(...tableIssues);
    }

    logger.info(`PDF Table validation complete: ${issues.length} issues found`);
    return issues;
  }

  private validateTable(table: PdfTable): TableIssue[] {
    const issues: TableIssue[] = [];

    // Check for header cells
    if (!table.hasHeaders) {
      issues.push({
        severity: 'serious',
        code: 'PDF-TABLE-NO-HEADERS',
        message: `Table on page ${table.page} has no header cells (TH).`,
        wcagCriteria: ['1.3.1'],
        page: table.page,
        location: `Page ${table.page}, Table ${table.id}`,
        suggestion: 'Mark the first row or column cells as TH (header) elements.',
      });
    }

    // Check for scope attributes on headers
    const headerCells = table.cells.filter(c => c.isHeader);
    const headersWithoutScope = headerCells.filter(c => !c.scope);

    if (headerCells.length > 0 && headersWithoutScope.length > 0) {
      issues.push({
        severity: 'moderate',
        code: 'PDF-TABLE-NO-SCOPE',
        message: `Table on page ${table.page} has ${headersWithoutScope.length} header cells without scope attribute.`,
        wcagCriteria: ['1.3.1'],
        page: table.page,
        location: `Page ${table.page}, Table ${table.id}`,
        suggestion: 'Add scope="col" or scope="row" to each header cell.',
      });
    }

    // Check for complex tables (need manual review)
    if (table.isComplex) {
      issues.push({
        severity: 'moderate',
        code: 'PDF-TABLE-COMPLEX',
        message: `Table on page ${table.page} has merged cells and requires manual accessibility review.`,
        wcagCriteria: ['1.3.1'],
        page: table.page,
        location: `Page ${table.page}, Table ${table.id}`,
        suggestion: 'Complex tables with merged cells need headers attribute or ID/headers associations. Consider simplifying table structure.',
      });
    }

    // Check for empty cells that might need markup
    const emptyCells = table.cells.filter(c => !c.content.trim() && !c.isHeader);
    if (emptyCells.length > table.cells.length * 0.2) {
      issues.push({
        severity: 'minor',
        code: 'PDF-TABLE-MANY-EMPTY',
        message: `Table on page ${table.page} has many empty cells (${emptyCells.length} of ${table.cells.length}).`,
        wcagCriteria: ['1.3.1'],
        page: table.page,
        location: `Page ${table.page}, Table ${table.id}`,
        suggestion: 'Consider if this should be a table or if empty cells need content/headers.',
      });
    }

    // Check data cells reference headers
    const dataCells = table.cells.filter(c => !c.isHeader);
    if (table.isComplex && dataCells.some(c => !this.hasHeaderAssociation(c, table))) {
      issues.push({
        severity: 'serious',
        code: 'PDF-TABLE-NO-HEADER-ASSOCIATION',
        message: `Complex table on page ${table.page} has data cells without header associations.`,
        wcagCriteria: ['1.3.1'],
        page: table.page,
        location: `Page ${table.page}, Table ${table.id}`,
        suggestion: 'Use ID and headers attributes to associate data cells with header cells.',
      });
    }

    return issues;
  }

  private hasHeaderAssociation(cell: PdfTableCell, table: PdfTable): boolean {
    // In a complex table, check if data cell has a headers attribute
    // or if it can be associated by row/column
    if (!table.isComplex) {
      return true; // Simple tables don't need explicit associations
    }

    // Check if there's a header in the same row or column
    const rowHeaders = table.cells.filter(c => 
      c.isHeader && c.row === cell.row && c.scope === 'row'
    );
    const colHeaders = table.cells.filter(c => 
      c.isHeader && c.column === cell.column && c.scope === 'column'
    );

    return rowHeaders.length > 0 || colHeaders.length > 0;
  }
}

export const pdfTableValidator = new PdfTableValidator();
```

#### Acceptance Criteria

- [ ] Tables without headers are flagged as serious
- [ ] Headers without scope attributes are flagged
- [ ] Complex tables (merged cells) are flagged for manual review
- [ ] Many empty cells triggers a minor warning
- [ ] Each issue includes table ID and page location

---

## Epic PDF-3: PDF/UA & Matterhorn Protocol

### User Story US-PDF-3.1: PDF/UA Validator (Matterhorn Protocol)

**User Story:**  
As a **Compliance Officer**, I want PDF validated against PDF/UA (ISO 14289-1), so that documents meet international accessibility standards.

**Story Points:** 8  
**Priority:** Critical  
**Dependencies:** US-PDF-1.1

### Replit Prompt US-PDF-3.1

#### Context
Create a PDF/UA validator that checks against key Matterhorn Protocol checkpoints for ISO 14289-1 compliance.

#### Prerequisites
- `PdfParserService` is implemented (US-PDF-1.1)

#### Objective
Validate against Matterhorn Protocol checkpoints for PDF/UA compliance.

#### Technical Requirements

**Create file: `src/services/pdf/validators/pdfua.validator.ts`**

```typescript
import { ParsedPdf } from '../pdf-parser.service';
import { AccessibilityIssue, IssueSeverity } from '../../audit/base-audit.service';
import { logger } from '../../../lib/logger';

interface PdfUaIssue extends Omit<AccessibilityIssue, 'id' | 'documentType' | 'source'> {
  severity: IssueSeverity;
  code: string;
  message: string;
  wcagCriteria: string[];
  location?: string;
  page?: number;
  suggestion?: string;
  checkpoint: string;  // Matterhorn checkpoint ID
  checkpointStatus: 'pass' | 'fail' | 'manual';
}

interface PdfUaValidationResult {
  passed: number;
  failed: number;
  manual: number;
  issues: PdfUaIssue[];
}

/**
 * Key Matterhorn Protocol checkpoints
 * Full protocol has 136 checkpoints across 31 categories
 * We implement the most critical ones for MVP
 */
const MATTERHORN_CHECKPOINTS = {
  // Category 01: Document
  '01-001': {
    description: 'PDF not set to open with document title displayed',
    wcag: ['2.4.2'],
    automated: true,
  },
  '01-002': {
    description: 'Document does not have title in metadata',
    wcag: ['2.4.2'],
    automated: true,
  },
  '01-003': {
    description: 'ViewerPreferences dictionary does not contain DisplayDocTitle',
    wcag: ['2.4.2'],
    automated: true,
  },
  '01-004': {
    description: 'Metadata stream does not contain dc:title',
    wcag: ['2.4.2'],
    automated: true,
  },

  // Category 02: Text
  '02-001': {
    description: 'Document is not tagged (no StructTreeRoot)',
    wcag: ['1.3.1', '4.1.2'],
    automated: true,
  },
  '02-003': {
    description: 'Content is not fully tagged',
    wcag: ['1.3.1'],
    automated: true,
  },

  // Category 06: Headings
  '06-001': {
    description: 'Document does not use heading tags',
    wcag: ['1.3.1', '2.4.6'],
    automated: true,
  },
  '06-002': {
    description: 'Heading level skipped',
    wcag: ['1.3.1'],
    automated: true,
  },
  '06-003': {
    description: 'Incorrect nesting of headings',
    wcag: ['1.3.1'],
    automated: true,
  },

  // Category 07: Tables
  '07-001': {
    description: 'Table element does not contain TR',
    wcag: ['1.3.1'],
    automated: true,
  },
  '07-002': {
    description: 'TR does not contain TH or TD',
    wcag: ['1.3.1'],
    automated: true,
  },
  '07-005': {
    description: 'Table header cell does not have Scope attribute',
    wcag: ['1.3.1'],
    automated: true,
  },

  // Category 09: Lists
  '09-001': {
    description: 'L element does not contain LI',
    wcag: ['1.3.1'],
    automated: true,
  },
  '09-004': {
    description: 'LI element does not contain Lbl or LBody',
    wcag: ['1.3.1'],
    automated: true,
  },

  // Category 13: Graphics
  '13-001': {
    description: 'Figure element does not have Alt attribute',
    wcag: ['1.1.1'],
    automated: true,
  },
  '13-004': {
    description: 'Decorative image not marked as Artifact',
    wcag: ['1.1.1'],
    automated: false, // Requires human judgment
  },

  // Category 14: Language
  '14-002': {
    description: 'Document language not specified',
    wcag: ['3.1.1'],
    automated: true,
  },
  '14-003': {
    description: 'Language specified is not valid BCP 47',
    wcag: ['3.1.1'],
    automated: true,
  },

  // Category 17: Navigation
  '17-001': {
    description: 'Document does not contain Outlines (bookmarks)',
    wcag: ['2.4.5'],
    automated: true,
  },
  '17-003': {
    description: 'Tagged PDF does not have tab order set to Structure',
    wcag: ['2.4.3'],
    automated: true,
  },

  // Category 19: Security
  '19-003': {
    description: 'Document encryption prevents assistive technology access',
    wcag: ['1.3.1'],
    automated: true,
  },

  // Category 28: PDF/UA identifier
  '28-002': {
    description: 'Document does not contain PDF/UA identifier',
    wcag: [],
    automated: true,
  },
  '28-004': {
    description: 'PDF/UA identifier value is not 1',
    wcag: [],
    automated: true,
  },
};

export class PdfUaValidator {
  async validate(parsed: ParsedPdf): Promise<PdfUaValidationResult> {
    const issues: PdfUaIssue[] = [];
    let passed = 0;
    let failed = 0;
    let manual = 0;

    // Run each checkpoint
    for (const [checkpointId, checkpoint] of Object.entries(MATTERHORN_CHECKPOINTS)) {
      const result = this.runCheckpoint(checkpointId, checkpoint, parsed);

      if (result.status === 'pass') {
        passed++;
      } else if (result.status === 'fail') {
        failed++;
        issues.push(this.createIssue(checkpointId, checkpoint, result));
      } else {
        manual++;
        issues.push(this.createIssue(checkpointId, checkpoint, result));
      }
    }

    logger.info(`PDF/UA validation complete: ${passed} passed, ${failed} failed, ${manual} manual review`);

    return { passed, failed, manual, issues };
  }

  private runCheckpoint(
    checkpointId: string,
    checkpoint: { description: string; wcag: string[]; automated: boolean },
    parsed: ParsedPdf
  ): { status: 'pass' | 'fail' | 'manual'; details?: string } {

    // Document checks (Category 01)
    if (checkpointId === '01-002') {
      return parsed.metadata.title 
        ? { status: 'pass' }
        : { status: 'fail', details: 'Document metadata does not include title' };
    }

    // Tagging check (Category 02)
    if (checkpointId === '02-001') {
      return parsed.metadata.isTagged 
        ? { status: 'pass' }
        : { status: 'fail', details: 'Document is not tagged (no StructTreeRoot)' };
    }

    if (checkpointId === '02-003') {
      if (!parsed.metadata.isTagged) return { status: 'fail', details: 'Document is not tagged' };
      // Check for marked content
      return parsed.metadata.hasMarkedContent 
        ? { status: 'pass' }
        : { status: 'fail', details: 'Content is not fully tagged' };
    }

    // Heading checks (Category 06)
    if (checkpointId === '06-001') {
      return parsed.headingHierarchy.length > 0 
        ? { status: 'pass' }
        : { status: 'fail', details: 'No heading structure found' };
    }

    if (checkpointId === '06-002') {
      const headings = parsed.headingHierarchy;
      for (let i = 1; i < headings.length; i++) {
        if (headings[i].level > headings[i-1].level + 1) {
          return { status: 'fail', details: `Heading skip: H${headings[i-1].level} to H${headings[i].level}` };
        }
      }
      return { status: 'pass' };
    }

    // Table checks (Category 07)
    if (checkpointId === '07-005') {
      const tablesWithoutScope = parsed.tables.filter(t => 
        t.hasHeaders && t.cells.some(c => c.isHeader && !c.scope)
      );
      return tablesWithoutScope.length === 0
        ? { status: 'pass' }
        : { status: 'fail', details: `${tablesWithoutScope.length} tables have headers without scope` };
    }

    // Graphics checks (Category 13)
    if (checkpointId === '13-001') {
      const figuresWithoutAlt = this.findFiguresWithoutAlt(parsed);
      return figuresWithoutAlt.length === 0
        ? { status: 'pass' }
        : { status: 'fail', details: `${figuresWithoutAlt.length} figures lack Alt text` };
    }

    if (checkpointId === '13-004') {
      // Decorative image check requires human judgment
      return { status: 'manual', details: 'Decorative image identification requires manual review' };
    }

    // Language checks (Category 14)
    if (checkpointId === '14-002') {
      return parsed.metadata.language 
        ? { status: 'pass' }
        : { status: 'fail', details: 'Document language not specified' };
    }

    if (checkpointId === '14-003') {
      if (!parsed.metadata.language) return { status: 'fail', details: 'No language to validate' };
      const validLang = /^[a-z]{2,3}(-[A-Z]{2})?(-[a-z]+)?$/.test(parsed.metadata.language);
      return validLang 
        ? { status: 'pass' }
        : { status: 'fail', details: `Invalid language code: ${parsed.metadata.language}` };
    }

    // Navigation check (Category 17)
    if (checkpointId === '17-001') {
      // Check for bookmarks - simplified check
      // Full implementation would examine Outlines dictionary
      return parsed.headingHierarchy.length > 3
        ? { status: 'manual', details: 'Document with multiple sections should have bookmarks - manual verification needed' }
        : { status: 'pass' };
    }

    // PDF/UA identifier (Category 28)
    if (checkpointId === '28-002') {
      // Check for PDF/UA identifier in XMP metadata
      // This is a simplified check
      return { status: 'manual', details: 'PDF/UA identifier check requires XMP metadata examination' };
    }

    // Default: if not implemented, require manual review
    return { status: 'manual', details: 'Checkpoint requires manual verification' };
  }

  private findFiguresWithoutAlt(parsed: ParsedPdf): number[] {
    const pages: number[] = [];

    const traverse = (tags: typeof parsed.structureTags): void => {
      for (const tag of tags) {
        if (tag.type === 'Figure' && !tag.altText) {
          pages.push(tag.page);
        }
        if (tag.children.length > 0) {
          traverse(tag.children);
        }
      }
    };

    traverse(parsed.structureTags);
    return pages;
  }

  private createIssue(
    checkpointId: string,
    checkpoint: { description: string; wcag: string[]; automated: boolean },
    result: { status: 'pass' | 'fail' | 'manual'; details?: string }
  ): PdfUaIssue {
    const severity: IssueSeverity = result.status === 'fail' 
      ? (checkpointId.startsWith('02') || checkpointId.startsWith('13') ? 'critical' : 'serious')
      : 'moderate';

    return {
      severity,
      code: `PDF-UA-${checkpointId}`,
      message: `${checkpoint.description}${result.details ? `: ${result.details}` : ''}`,
      wcagCriteria: checkpoint.wcag,
      suggestion: this.getSuggestion(checkpointId),
      checkpoint: checkpointId,
      checkpointStatus: result.status,
    };
  }

  private getSuggestion(checkpointId: string): string {
    const suggestions: Record<string, string> = {
      '01-002': 'Set document title in Document Properties > Description.',
      '02-001': 'Run "Add Tags to Document" in Adobe Acrobat Pro.',
      '02-003': 'Ensure all content is included in the tag tree.',
      '06-001': 'Add heading tags (H1, H2, etc.) to structure the document.',
      '06-002': 'Ensure heading levels increment by one (no skipping).',
      '07-005': 'Add scope="col" or scope="row" to table header cells.',
      '13-001': 'Add Alt text to all Figure elements.',
      '13-004': 'Mark decorative images as Artifacts.',
      '14-002': 'Set document language in Advanced > Language.',
      '14-003': 'Use valid BCP 47 language code (e.g., "en", "en-US").',
      '17-001': 'Add bookmarks for document sections.',
      '28-002': 'Add PDF/UA identifier to XMP metadata.',
    };

    return suggestions[checkpointId] || 'Refer to Matterhorn Protocol documentation.';
  }
}

export const pdfUaValidator = new PdfUaValidator();
```

#### Acceptance Criteria

- [ ] Key Matterhorn Protocol checkpoints are validated
- [ ] Each checkpoint returns pass/fail/manual status
- [ ] Failed checkpoints create issues with appropriate severity
- [ ] Manual review items are flagged but not counted as failures
- [ ] Summary includes passed/failed/manual counts
- [ ] WCAG criteria mapped to each checkpoint

---

## Epic PDF-4: ACR Integration

### User Story US-PDF-4.1: Update WCAG Issue Mapper for PDF

**User Story:**  
As a **Developer**, I want the WCAG issue mapper to include PDF-specific rule mappings, so that PDF audit results flow seamlessly to ACR generation.

**Story Points:** 3  
**Priority:** Critical  
**Dependencies:** US-PDF-2.1 through US-PDF-3.1

### Replit Prompt US-PDF-4.1

#### Context
Add PDF-specific rule IDs to the existing WCAG issue mapper so PDF audit results can be used for ACR generation.

#### Prerequisites
- All PDF validators are implemented
- Existing `wcag-issue-mapper.service.ts` is working

#### Objective
Extend `RULE_TO_CRITERIA_MAP` with PDF-specific rules.

#### Technical Requirements

**Update file: `src/services/acr/wcag-issue-mapper.service.ts`**

Add the following mappings to `RULE_TO_CRITERIA_MAP`:

```typescript
export const RULE_TO_CRITERIA_MAP: Record<string, string[]> = {
  // ... existing EPUB rules ...

  // ============= PDF-SPECIFIC RULES =============

  // PDF Structure Rules
  'PDF-STRUCT-UNTAGGED': ['1.3.1', '4.1.2'],
  'PDF-STRUCT-NO-HEADINGS': ['1.3.1', '2.4.6'],
  'PDF-STRUCT-MISSING-H1': ['1.3.1'],
  'PDF-STRUCT-HEADING-SKIP': ['1.3.1', '2.4.6'],
  'PDF-STRUCT-EMPTY-HEADING': ['1.3.1', '2.4.6'],
  'PDF-STRUCT-NO-READING-ORDER': ['1.3.2'],
  'PDF-STRUCT-READING-ORDER-REVIEW': ['1.3.2'],
  'PDF-STRUCT-NO-LANGUAGE': ['3.1.1'],
  'PDF-STRUCT-INVALID-LANGUAGE': ['3.1.1'],
  'PDF-STRUCT-NO-TITLE': ['2.4.2'],
  'PDF-STRUCT-GENERIC-TITLE': ['2.4.2'],
  'PDF-STRUCT-NO-DOCUMENT-TAG': ['1.3.1'],

  // PDF Alt Text Rules
  'PDF-ALT-MISSING': ['1.1.1'],
  'PDF-ALT-EMPTY': ['1.1.1'],
  'PDF-ALT-GENERIC': ['1.1.1'],
  'PDF-ALT-FILENAME': ['1.1.1'],
  'PDF-ALT-TOO-SHORT': ['1.1.1'],
  'PDF-ALT-TOO-LONG': ['1.1.1'],
  'PDF-ALT-UNTAGGED-IMAGE': ['1.1.1'],

  // PDF Contrast Rules
  'PDF-CONTRAST-FAIL': ['1.4.3'],
  'PDF-CONTRAST-LARGE-FAIL': ['1.4.3'],

  // PDF Table Rules
  'PDF-TABLE-NO-HEADERS': ['1.3.1'],
  'PDF-TABLE-NO-SCOPE': ['1.3.1'],
  'PDF-TABLE-COMPLEX': ['1.3.1'],
  'PDF-TABLE-MANY-EMPTY': ['1.3.1'],
  'PDF-TABLE-NO-HEADER-ASSOCIATION': ['1.3.1'],

  // PDF/UA Matterhorn Protocol Rules
  'PDF-UA-01-002': ['2.4.2'],
  'PDF-UA-02-001': ['1.3.1', '4.1.2'],
  'PDF-UA-02-003': ['1.3.1'],
  'PDF-UA-06-001': ['1.3.1', '2.4.6'],
  'PDF-UA-06-002': ['1.3.1'],
  'PDF-UA-07-005': ['1.3.1'],
  'PDF-UA-13-001': ['1.1.1'],
  'PDF-UA-13-004': ['1.1.1'],
  'PDF-UA-14-002': ['3.1.1'],
  'PDF-UA-14-003': ['3.1.1'],
  'PDF-UA-17-001': ['2.4.5'],
  'PDF-UA-28-002': [],  // PDF/UA identifier (no direct WCAG mapping)
};
```

#### Acceptance Criteria

- [ ] All PDF rule codes are mapped to WCAG criteria
- [ ] Existing EPUB mappings are unchanged
- [ ] ACR generation works with PDF audit results
- [ ] No duplicate mappings

---

### User Story US-PDF-4.2: PDF Audit Controller & Routes

**User Story:**  
As a **Publisher**, I want API endpoints to upload and audit PDF files, so that I can integrate PDF accessibility checking into my workflow.

**Story Points:** 5  
**Priority:** Critical  
**Dependencies:** US-PDF-1.2

### Replit Prompt US-PDF-4.2

#### Context
Create controller and routes for PDF audit endpoints, following the same pattern as EPUB audit endpoints.

#### Prerequisites
- `PdfAuditService` is implemented (US-PDF-1.2)
- Existing EPUB routes work

#### Objective
Create API endpoints for PDF upload, audit, and results retrieval.

#### Technical Requirements

**Create file: `src/controllers/pdf-audit.controller.ts`**

```typescript
import { Request, Response, NextFunction } from 'express';
import { pdfAuditService } from '../services/pdf/pdf-audit.service';
import { acrGeneratorService } from '../services/acr/acr-generator.service';
import { s3Service } from '../services/s3.service';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { z } from 'zod';

const CreatePdfJobSchema = z.object({
  fileName: z.string(),
  fileKey: z.string(),
});

const GenerateAcrSchema = z.object({
  edition: z.enum(['VPAT2.5-508', 'VPAT2.5-WCAG', 'VPAT2.5-EU', 'VPAT2.5-INT']).optional(),
  productInfo: z.object({
    name: z.string(),
    version: z.string(),
    description: z.string(),
    vendor: z.string(),
    contactEmail: z.string().email(),
    evaluationDate: z.string().datetime(),
  }),
});

export class PdfAuditController {
  async createAuditJob(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { fileName, fileKey } = CreatePdfJobSchema.parse(req.body);
      const userId = req.user?.id;

      // Create job record
      const job = await prisma.job.create({
        data: {
          type: 'PDF_AUDIT',
          status: 'QUEUED',
          input: { fileName, fileKey },
          userId,
        },
      });

      // Queue the audit (could use BullMQ for production)
      this.processAuditAsync(job.id, fileKey, fileName);

      res.status(202).json({
        success: true,
        data: {
          jobId: job.id,
          status: 'QUEUED',
          message: 'PDF audit job created',
        },
      });
    } catch (error) {
      next(error);
    }
  }

  private async processAuditAsync(jobId: string, fileKey: string, fileName: string): Promise<void> {
    try {
      await prisma.job.update({
        where: { id: jobId },
        data: { status: 'PROCESSING' },
      });

      await pdfAuditService.runAuditFromS3(fileKey, jobId, fileName);

      logger.info(`PDF audit completed for job ${jobId}`);
    } catch (error) {
      logger.error(`PDF audit failed for job ${jobId}`, error as Error);
      await prisma.job.update({
        where: { id: jobId },
        data: { 
          status: 'FAILED',
          error: error instanceof Error ? error.message : 'Unknown error',
        },
      });
    }
  }

  async getAuditResult(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;

      const job = await prisma.job.findUnique({
        where: { id: jobId },
      });

      if (!job) {
        res.status(404).json({
          success: false,
          error: { code: 'JOB_NOT_FOUND', message: 'Job not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          jobId: job.id,
          status: job.status,
          result: job.output,
          error: job.error,
          createdAt: job.createdAt,
          completedAt: job.completedAt,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  async generateAcr(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;
      const options = GenerateAcrSchema.parse(req.body);

      // Get audit result
      const job = await prisma.job.findUnique({
        where: { id: jobId },
      });

      if (!job || job.status !== 'COMPLETED') {
        res.status(400).json({
          success: false,
          error: { code: 'AUDIT_NOT_COMPLETE', message: 'Audit must be completed before ACR generation' },
        });
        return;
      }

      const auditResult = job.output as any;

      // Convert issues to ACR format
      const auditIssues = auditResult.combinedIssues.map((issue: any) => ({
        id: issue.id,
        ruleId: issue.code,
        impact: issue.severity,
        message: issue.message,
        filePath: issue.location || `Page ${issue.page || 'unknown'}`,
      }));

      // Generate confidence analysis
      const confidenceAnalysis = await acrGeneratorService.generateConfidenceAnalysis(
        options.edition || 'VPAT2.5-INT',
        auditIssues
      );

      // Generate ACR document
      const acrDocument = await acrGeneratorService.generateAcr(jobId, {
        edition: options.edition,
        productInfo: {
          ...options.productInfo,
          evaluationDate: new Date(options.productInfo.evaluationDate),
        },
      });

      res.json({
        success: true,
        data: {
          acr: acrDocument,
          confidenceAnalysis,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const pdfAuditController = new PdfAuditController();
```

**Create file: `src/routes/pdf-audit.routes.ts`**

```typescript
import { Router } from 'express';
import { pdfAuditController } from '../controllers/pdf-audit.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

// All routes require authentication
router.use(authenticate);

// Create PDF audit job
router.post('/jobs', pdfAuditController.createAuditJob.bind(pdfAuditController));

// Get audit result
router.get('/jobs/:jobId', pdfAuditController.getAuditResult.bind(pdfAuditController));

// Generate ACR from audit
router.post('/jobs/:jobId/acr', pdfAuditController.generateAcr.bind(pdfAuditController));

export default router;
```

**Update `src/routes/index.ts`**

```typescript
import pdfAuditRoutes from './pdf-audit.routes';

// Add PDF routes
router.use('/api/v1/pdf', pdfAuditRoutes);
```

#### Acceptance Criteria

- [ ] POST /api/v1/pdf/jobs creates audit job
- [ ] GET /api/v1/pdf/jobs/:jobId returns audit status/results
- [ ] POST /api/v1/pdf/jobs/:jobId/acr generates ACR
- [ ] Authentication required for all endpoints
- [ ] Proper error handling and validation

---


## Epic PDF-5: Frontend Integration

**Duration:** 2 days  
**Team:** 1 Frontend Developer  
**Story Points:** 21 (8 prompts)

### Overview

This epic covers all frontend changes needed to support PDF accessibility auditing. The implementation achieves **80% component reuse** from the existing EPUB infrastructure, with only 3 new components required.

### Frontend Tech Stack

| Category | Technology |
|----------|------------|
| **Framework** | React 18 + TypeScript |
| **Build Tool** | Vite |
| **State Management** | TanStack Query + Zustand |
| **Styling** | Tailwind CSS |
| **UI Components** | Radix UI primitives |
| **Routing** | React Router 6 |

### Component Reusability Summary

| Component | Reuse % | Changes Needed |
|-----------|---------|----------------|
| `FileUpload` | 95% | Add PDF MIME type |
| `AuditHeader` | 100% | None |
| `ScoreDisplay` | 100% | None |
| `IssueSummaryCard` | 100% | None |
| `IssuesList` | 90% | Add page navigation |
| `IssueCard` | 85% | Add PDF-specific fields |
| `AcrGenerationPanel` | 100% | None |
| **New: MatterhornSummary** | 0% | PDF-only component |
| **New: PdfPageNavigator** | 0% | PDF-only component |
| **New: PdfPreviewPanel** | 0% | PDF-only component |

---

## Prompt FE-PDF-1: File Upload Enhancement

### Context
Update the existing file upload component to accept PDF files alongside EPUB.

### Prerequisites
- Existing `FileUpload` component working for EPUB
- S3 signed URL upload working

### Objective
Enable PDF file uploads with validation and type detection.

### Technical Requirements

**Update file: `src/constants/file-types.ts`**

```typescript
export const SUPPORTED_FILE_TYPES = {
  'application/epub+zip': {
    extension: '.epub',
    displayName: 'EPUB',
    icon: 'BookOpen',
    maxSize: 100 * 1024 * 1024, // 100MB
  },
  'application/pdf': {
    extension: '.pdf',
    displayName: 'PDF',
    icon: 'FileText',
    maxSize: 200 * 1024 * 1024, // 200MB (PDFs can be larger)
  },
} as const;

export type SupportedMimeType = keyof typeof SUPPORTED_FILE_TYPES;
export type DocumentType = 'epub' | 'pdf';

export function getDocumentType(mimeType: string): DocumentType | null {
  if (mimeType === 'application/epub+zip') return 'epub';
  if (mimeType === 'application/pdf') return 'pdf';
  return null;
}

export function isValidFileType(mimeType: string): mimeType is SupportedMimeType {
  return mimeType in SUPPORTED_FILE_TYPES;
}
```

**Update file: `src/components/upload/FileUpload.tsx`**

```tsx
import { useCallback, useState } from 'react';
import { useDropzone } from 'react-dropzone';
import { Upload, FileText, BookOpen, X, AlertCircle } from 'lucide-react';
import { 
  SUPPORTED_FILE_TYPES, 
  isValidFileType, 
  getDocumentType,
  type SupportedMimeType 
} from '../../constants/file-types';
import { formatFileSize } from '../../utils/format';
import { cn } from '../../utils/cn';

interface FileUploadProps {
  onFileSelect: (file: File, documentType: 'epub' | 'pdf') => void;
  isUploading?: boolean;
  uploadProgress?: number;
  error?: string | null;
  acceptedTypes?: SupportedMimeType[];
}

export function FileUpload({
  onFileSelect,
  isUploading = false,
  uploadProgress = 0,
  error = null,
  acceptedTypes,
}: FileUploadProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  const accept = acceptedTypes 
    ? Object.fromEntries(acceptedTypes.map(type => [type, [SUPPORTED_FILE_TYPES[type].extension]]))
    : Object.fromEntries(
        Object.entries(SUPPORTED_FILE_TYPES).map(([type, config]) => [type, [config.extension]])
      );

  const onDrop = useCallback((acceptedFiles: File[], rejectedFiles: any[]) => {
    setValidationError(null);

    if (rejectedFiles.length > 0) {
      const rejection = rejectedFiles[0];
      if (rejection.errors[0]?.code === 'file-invalid-type') {
        setValidationError('Please upload an EPUB or PDF file.');
      } else if (rejection.errors[0]?.code === 'file-too-large') {
        setValidationError('File is too large. Maximum size is 200MB.');
      }
      return;
    }

    if (acceptedFiles.length > 0) {
      const file = acceptedFiles[0];

      // Validate file type
      if (!isValidFileType(file.type)) {
        setValidationError('Unsupported file type. Please upload an EPUB or PDF.');
        return;
      }

      // Validate file size
      const maxSize = SUPPORTED_FILE_TYPES[file.type as SupportedMimeType].maxSize;
      if (file.size > maxSize) {
        setValidationError(`File too large. Maximum size for ${getDocumentType(file.type)?.toUpperCase()} is ${formatFileSize(maxSize)}.`);
        return;
      }

      const documentType = getDocumentType(file.type);
      if (documentType) {
        setSelectedFile(file);
        onFileSelect(file, documentType);
      }
    }
  }, [onFileSelect]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept,
    maxFiles: 1,
    disabled: isUploading,
  });

  const clearFile = () => {
    setSelectedFile(null);
    setValidationError(null);
  };

  const getFileIcon = (mimeType: string) => {
    if (mimeType === 'application/pdf') return <FileText className="w-8 h-8 text-red-500" />;
    return <BookOpen className="w-8 h-8 text-blue-500" />;
  };

  return (
    <div className="w-full">
      {!selectedFile ? (
        <div
          {...getRootProps()}
          className={cn(
            'border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors',
            isDragActive ? 'border-primary-500 bg-primary-50' : 'border-gray-300 hover:border-primary-400',
            isUploading && 'opacity-50 cursor-not-allowed'
          )}
        >
          <input {...getInputProps()} />
          <Upload className="w-12 h-12 mx-auto mb-4 text-gray-400" />
          <p className="text-lg font-medium text-gray-700">
            {isDragActive ? 'Drop your file here' : 'Drag & drop your document'}
          </p>
          <p className="mt-2 text-sm text-gray-500">
            or click to browse
          </p>
          <div className="mt-4 flex justify-center gap-4">
            <span className="inline-flex items-center gap-1 px-3 py-1 bg-blue-100 text-blue-700 rounded-full text-sm">
              <BookOpen className="w-4 h-4" /> EPUB
            </span>
            <span className="inline-flex items-center gap-1 px-3 py-1 bg-red-100 text-red-700 rounded-full text-sm">
              <FileText className="w-4 h-4" /> PDF
            </span>
          </div>
          <p className="mt-2 text-xs text-gray-400">
            Maximum file size: 200MB
          </p>
        </div>
      ) : (
        <div className="border rounded-lg p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {getFileIcon(selectedFile.type)}
              <div>
                <p className="font-medium text-gray-900">{selectedFile.name}</p>
                <p className="text-sm text-gray-500">
                  {formatFileSize(selectedFile.size)} • {getDocumentType(selectedFile.type)?.toUpperCase()}
                </p>
              </div>
            </div>
            {!isUploading && (
              <button
                onClick={clearFile}
                className="p-1 hover:bg-gray-100 rounded"
                aria-label="Remove file"
              >
                <X className="w-5 h-5 text-gray-500" />
              </button>
            )}
          </div>

          {isUploading && (
            <div className="mt-4">
              <div className="flex justify-between text-sm text-gray-600 mb-1">
                <span>Uploading...</span>
                <span>{uploadProgress}%</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className="bg-primary-500 h-2 rounded-full transition-all duration-300"
                  style={{ width: `${uploadProgress}%` }}
                />
              </div>
            </div>
          )}
        </div>
      )}

      {(error || validationError) && (
        <div className="mt-3 flex items-center gap-2 text-red-600 text-sm">
          <AlertCircle className="w-4 h-4" />
          <span>{error || validationError}</span>
        </div>
      )}
    </div>
  );
}
```

### Acceptance Criteria

- [ ] File upload accepts both EPUB and PDF files
- [ ] PDF files up to 200MB are accepted
- [ ] File type icon changes based on document type
- [ ] Invalid file types show error message
- [ ] Document type is passed to parent component
- [ ] Drag and drop works for both file types

---

## Prompt FE-PDF-2: PDF Audit Results Page

### Context
Create or update the audit results page to handle PDF-specific data and display.

### Prerequisites
- Backend PDF audit API is working (US-PDF-4.2)
- Existing EPUB audit results page as reference

### Objective
Display PDF audit results with PDF-specific sections (Matterhorn summary, page-based navigation).

### Technical Requirements

**Create file: `src/pages/audit/PdfAuditResultsPage.tsx`**

```tsx
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, Download, FileText, AlertTriangle, CheckCircle } from 'lucide-react';
import { usePdfAuditResult } from '../../hooks/usePdfAudit';
import { AuditHeader } from '../../components/audit/AuditHeader';
import { ScoreDisplay } from '../../components/audit/ScoreDisplay';
import { IssueSummaryCard } from '../../components/audit/IssueSummaryCard';
import { MatterhornSummary } from '../../components/pdf/MatterhornSummary';
import { PdfIssuesList } from '../../components/pdf/PdfIssuesList';
import { PdfPageNavigator } from '../../components/pdf/PdfPageNavigator';
import { AcrGenerationPanel } from '../../components/acr/AcrGenerationPanel';
import { LoadingSpinner } from '../../components/ui/LoadingSpinner';
import { ErrorMessage } from '../../components/ui/ErrorMessage';
import { Badge } from '../../components/ui/Badge';
import { Card, CardHeader, CardContent } from '../../components/ui/Card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/Tabs';

export function PdfAuditResultsPage() {
  const { jobId } = useParams<{ jobId: string }>();
  const { data: result, isLoading, error, refetch } = usePdfAuditResult(jobId!);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[60vh]">
        <LoadingSpinner size="lg" message="Loading audit results..." />
      </div>
    );
  }

  if (error || !result) {
    return (
      <ErrorMessage 
        title="Failed to load audit results"
        message={error?.message || 'Unknown error occurred'}
        onRetry={refetch}
      />
    );
  }

  // Group issues by page for navigation
  const issuesByPage = new Map<number, number>();
  result.combinedIssues.forEach(issue => {
    if (issue.page) {
      issuesByPage.set(issue.page, (issuesByPage.get(issue.page) || 0) + 1);
    }
  });

  return (
    <div className="max-w-7xl mx-auto px-4 py-8">
      {/* Back Navigation */}
      <Link 
        to="/audit" 
        className="inline-flex items-center gap-2 text-gray-600 hover:text-gray-900 mb-6"
      >
        <ArrowLeft className="w-4 h-4" />
        Back to Audit
      </Link>

      {/* Header */}
      <AuditHeader
        fileName={result.fileName}
        documentType="pdf"
        auditedAt={result.auditedAt}
      />

      {/* PDF-specific metadata */}
      <Card className="mb-6">
        <CardContent className="py-4">
          <div className="flex flex-wrap gap-4">
            <Badge variant={result.isTagged ? 'success' : 'destructive'}>
              {result.isTagged ? (
                <><CheckCircle className="w-3 h-3 mr-1" /> Tagged PDF</>
              ) : (
                <><AlertTriangle className="w-3 h-3 mr-1" /> Not Tagged</>
              )}
            </Badge>
            <Badge variant="secondary">
              <FileText className="w-3 h-3 mr-1" />
              {result.pageCount} pages
            </Badge>
            <Badge variant="secondary">
              PDF {result.pdfVersion}
            </Badge>
            {result.metadata.language && (
              <Badge variant="secondary">
                Language: {result.metadata.language}
              </Badge>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Score and Summary Row */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-8">
        <ScoreDisplay 
          score={result.score} 
          breakdown={result.scoreBreakdown}
        />
        <IssueSummaryCard summary={result.summary} />
        <MatterhornSummary summary={result.matterhornSummary} />
      </div>

      {/* Warning for untagged PDFs */}
      {!result.isTagged && (
        <div className="mb-6 p-4 bg-amber-50 border border-amber-200 rounded-lg">
          <div className="flex gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-500 flex-shrink-0 mt-0.5" />
            <div>
              <h4 className="font-medium text-amber-800">Untagged PDF Detected</h4>
              <p className="text-sm text-amber-700 mt-1">
                This PDF does not have accessibility tags. Screen readers cannot properly interpret 
                the content structure. Consider using Adobe Acrobat Pro's "Add Tags to Document" 
                feature to remediate.
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Tabbed Content */}
      <Tabs defaultValue="issues" className="mb-8">
        <TabsList>
          <TabsTrigger value="issues">
            Issues ({result.summary.total})
          </TabsTrigger>
          <TabsTrigger value="by-page">
            By Page
          </TabsTrigger>
          <TabsTrigger value="matterhorn">
            PDF/UA Checkpoints
          </TabsTrigger>
          <TabsTrigger value="validation">
            Validation Details
          </TabsTrigger>
        </TabsList>

        <TabsContent value="issues" className="mt-4">
          <PdfIssuesList 
            issues={result.combinedIssues}
            pageCount={result.pageCount}
          />
        </TabsContent>

        <TabsContent value="by-page" className="mt-4">
          <PdfPageNavigator
            pageCount={result.pageCount}
            issuesByPage={issuesByPage}
            issues={result.combinedIssues}
          />
        </TabsContent>

        <TabsContent value="matterhorn" className="mt-4">
          <MatterhornCheckpointsList 
            issues={result.combinedIssues.filter(i => i.code.startsWith('PDF-UA-'))}
            summary={result.matterhornSummary}
          />
        </TabsContent>

        <TabsContent value="validation" className="mt-4">
          <ValidationDetailsPanel results={result.validationResults} />
        </TabsContent>
      </Tabs>

      {/* ACR Generation */}
      <AcrGenerationPanel 
        jobId={jobId!}
        documentType="pdf"
        disabled={!result.isValid}
      />
    </div>
  );
}

// Sub-component for Matterhorn checkpoints list
function MatterhornCheckpointsList({ 
  issues, 
  summary 
}: { 
  issues: typeof result.combinedIssues;
  summary: typeof result.matterhornSummary;
}) {
  const checkpointGroups = groupBy(issues, issue => {
    const match = issue.code.match(/PDF-UA-(\d+)-/);
    return match ? match[1] : 'other';
  });

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-4 mb-6">
        <Card>
          <CardContent className="py-4 text-center">
            <div className="text-2xl font-bold text-green-600">{summary.passed}</div>
            <div className="text-sm text-gray-500">Passed</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4 text-center">
            <div className="text-2xl font-bold text-red-600">{summary.failed}</div>
            <div className="text-sm text-gray-500">Failed</div>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-4 text-center">
            <div className="text-2xl font-bold text-amber-600">{summary.manual}</div>
            <div className="text-sm text-gray-500">Manual Review</div>
          </CardContent>
        </Card>
      </div>

      {Object.entries(checkpointGroups).map(([category, categoryIssues]) => (
        <Card key={category}>
          <CardHeader>
            <h3 className="font-medium">Category {category}</h3>
          </CardHeader>
          <CardContent>
            <ul className="space-y-2">
              {categoryIssues.map(issue => (
                <li key={issue.id} className="flex items-start gap-2 text-sm">
                  <span className={cn(
                    'px-2 py-0.5 rounded text-xs font-medium',
                    issue.severity === 'critical' && 'bg-red-100 text-red-700',
                    issue.severity === 'serious' && 'bg-orange-100 text-orange-700',
                    issue.severity === 'moderate' && 'bg-yellow-100 text-yellow-700',
                    issue.severity === 'minor' && 'bg-blue-100 text-blue-700',
                  )}>
                    {issue.code.replace('PDF-UA-', '')}
                  </span>
                  <span className="text-gray-700">{issue.message}</span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// Sub-component for validation details
function ValidationDetailsPanel({ 
  results 
}: { 
  results: typeof result.validationResults;
}) {
  const sections = [
    { key: 'structure', label: 'Structure', icon: '🏗️' },
    { key: 'altText', label: 'Alt Text', icon: '🖼️' },
    { key: 'contrast', label: 'Contrast', icon: '🎨' },
    { key: 'tables', label: 'Tables', icon: '📊' },
    { key: 'pdfua', label: 'PDF/UA', icon: '📋' },
  ] as const;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {sections.map(section => {
        const data = results[section.key];
        const total = data.passed + data.failed;
        const passRate = total > 0 ? Math.round((data.passed / total) * 100) : 100;

        return (
          <Card key={section.key}>
            <CardContent className="py-4">
              <div className="flex items-center gap-2 mb-3">
                <span className="text-xl">{section.icon}</span>
                <h3 className="font-medium">{section.label}</h3>
              </div>
              <div className="flex justify-between text-sm mb-2">
                <span className="text-green-600">{data.passed} passed</span>
                <span className="text-red-600">{data.failed} failed</span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2">
                <div
                  className={cn(
                    'h-2 rounded-full transition-all',
                    passRate >= 80 ? 'bg-green-500' : passRate >= 50 ? 'bg-yellow-500' : 'bg-red-500'
                  )}
                  style={{ width: `${passRate}%` }}
                />
              </div>
              <p className="text-xs text-gray-500 mt-1 text-right">{passRate}%</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// Helper function
function groupBy<T>(array: T[], keyFn: (item: T) => string): Record<string, T[]> {
  return array.reduce((result, item) => {
    const key = keyFn(item);
    if (!result[key]) result[key] = [];
    result[key].push(item);
    return result;
  }, {} as Record<string, T[]>);
}
```

### Acceptance Criteria

- [ ] PDF audit results display correctly
- [ ] Tagged/untagged status is clearly shown
- [ ] Page count and PDF version displayed
- [ ] Matterhorn summary shows passed/failed/manual counts
- [ ] Tabs allow switching between different views
- [ ] Warning shown for untagged PDFs
- [ ] ACR generation panel is included

---

## Prompt FE-PDF-3: Matterhorn Protocol Summary

### Context
Create a dedicated component for displaying PDF/UA Matterhorn Protocol compliance summary.

### Prerequisites
- Understanding of Matterhorn Protocol checkpoint structure

### Objective
Display Matterhorn Protocol checkpoint results with visual indicators.

### Technical Requirements

**Create file: `src/components/pdf/MatterhornSummary.tsx`**

```tsx
import { CheckCircle, XCircle, AlertTriangle, Info, ExternalLink } from 'lucide-react';
import { Card, CardHeader, CardContent } from '../ui/Card';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/Tooltip';
import { cn } from '../../utils/cn';

interface MatterhornSummaryProps {
  summary: {
    passed: number;
    failed: number;
    manual: number;
    notApplicable: number;
  };
  compact?: boolean;
}

export function MatterhornSummary({ summary, compact = false }: MatterhornSummaryProps) {
  const total = summary.passed + summary.failed + summary.manual;
  const automatedTotal = summary.passed + summary.failed;
  const automatedPassRate = automatedTotal > 0 
    ? Math.round((summary.passed / automatedTotal) * 100) 
    : 100;

  if (compact) {
    return (
      <div className="flex items-center gap-4">
        <Tooltip>
          <TooltipTrigger>
            <div className="flex items-center gap-1 text-green-600">
              <CheckCircle className="w-4 h-4" />
              <span className="font-medium">{summary.passed}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent>Checkpoints Passed</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger>
            <div className="flex items-center gap-1 text-red-600">
              <XCircle className="w-4 h-4" />
              <span className="font-medium">{summary.failed}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent>Checkpoints Failed</TooltipContent>
        </Tooltip>

        <Tooltip>
          <TooltipTrigger>
            <div className="flex items-center gap-1 text-amber-600">
              <AlertTriangle className="w-4 h-4" />
              <span className="font-medium">{summary.manual}</span>
            </div>
          </TooltipTrigger>
          <TooltipContent>Manual Review Required</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h3 className="font-semibold text-gray-900">PDF/UA Compliance</h3>
            <Tooltip>
              <TooltipTrigger>
                <Info className="w-4 h-4 text-gray-400" />
              </TooltipTrigger>
              <TooltipContent className="max-w-xs">
                Matterhorn Protocol checkpoints for ISO 14289-1 (PDF/UA) compliance
              </TooltipContent>
            </Tooltip>
          </div>
          <a
            href="https://www.pdfa.org/resource/matterhorn-protocol/"
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-primary-600 hover:underline flex items-center gap-1"
          >
            Learn more <ExternalLink className="w-3 h-3" />
          </a>
        </div>
      </CardHeader>

      <CardContent>
        {/* Metrics Grid */}
        <div className="grid grid-cols-3 gap-3 mb-4">
          <div className="text-center p-3 bg-green-50 rounded-lg">
            <CheckCircle className="w-5 h-5 text-green-500 mx-auto mb-1" />
            <div className="text-2xl font-bold text-green-700">{summary.passed}</div>
            <div className="text-xs text-green-600">Passed</div>
          </div>

          <div className="text-center p-3 bg-red-50 rounded-lg">
            <XCircle className="w-5 h-5 text-red-500 mx-auto mb-1" />
            <div className="text-2xl font-bold text-red-700">{summary.failed}</div>
            <div className="text-xs text-red-600">Failed</div>
          </div>

          <div className="text-center p-3 bg-amber-50 rounded-lg">
            <AlertTriangle className="w-5 h-5 text-amber-500 mx-auto mb-1" />
            <div className="text-2xl font-bold text-amber-700">{summary.manual}</div>
            <div className="text-xs text-amber-600">Manual</div>
          </div>
        </div>

        {/* Progress Bar */}
        <div className="space-y-1">
          <div className="flex justify-between text-xs text-gray-500">
            <span>Automated Checks</span>
            <span>{automatedPassRate}% passing</span>
          </div>
          <div className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden flex">
            <div
              className="bg-green-500 h-full transition-all duration-500"
              style={{ width: `${(summary.passed / total) * 100}%` }}
            />
            <div
              className="bg-red-500 h-full transition-all duration-500"
              style={{ width: `${(summary.failed / total) * 100}%` }}
            />
            <div
              className="bg-amber-500 h-full transition-all duration-500"
              style={{ width: `${(summary.manual / total) * 100}%` }}
            />
          </div>
        </div>

        {/* Status Indicator */}
        <div className={cn(
          'mt-4 p-2 rounded text-center text-sm font-medium',
          summary.failed === 0 && summary.manual === 0 && 'bg-green-100 text-green-800',
          summary.failed === 0 && summary.manual > 0 && 'bg-amber-100 text-amber-800',
          summary.failed > 0 && 'bg-red-100 text-red-800',
        )}>
          {summary.failed === 0 && summary.manual === 0 && '✓ Fully Compliant'}
          {summary.failed === 0 && summary.manual > 0 && '⚠ Requires Manual Review'}
          {summary.failed > 0 && `✗ ${summary.failed} Checkpoint${summary.failed > 1 ? 's' : ''} Failed`}
        </div>
      </CardContent>
    </Card>
  );
}
```

### Acceptance Criteria

- [ ] Shows passed/failed/manual counts clearly
- [ ] Progress bar visualizes distribution
- [ ] Tooltips explain each category
- [ ] Link to Matterhorn Protocol documentation
- [ ] Compact mode available for inline use
- [ ] Status indicator shows overall compliance

---

## Prompt FE-PDF-4: PDF Issue Card Enhancement

### Context
Enhance the existing IssueCard component to display PDF-specific information like page numbers and Matterhorn checkpoint references.

### Prerequisites
- Existing `IssueCard` component working for EPUB

### Objective
Add PDF-specific fields to issue display without breaking EPUB functionality.

### Technical Requirements

**Update file: `src/components/audit/IssueCard.tsx`**

```tsx
import { useState } from 'react';
import { 
  ChevronDown, 
  ChevronUp, 
  Lightbulb, 
  Sparkles, 
  ExternalLink,
  FileText,
  BookOpen,
  Copy,
  Check
} from 'lucide-react';
import { Badge } from '../ui/Badge';
import { Button } from '../ui/Button';
import { Card, CardContent } from '../ui/Card';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/Tooltip';
import { cn } from '../../utils/cn';
import type { AccessibilityIssue } from '../../types/audit';

interface IssueCardProps {
  issue: AccessibilityIssue;
  onPageNavigate?: (page: number) => void;
  isExpanded?: boolean;
  showAiSuggestion?: boolean;
}

const SEVERITY_CONFIG = {
  critical: {
    bg: 'bg-red-50',
    border: 'border-red-200',
    badge: 'bg-red-100 text-red-800',
    icon: '🔴',
  },
  serious: {
    bg: 'bg-orange-50',
    border: 'border-orange-200',
    badge: 'bg-orange-100 text-orange-800',
    icon: '🟠',
  },
  moderate: {
    bg: 'bg-yellow-50',
    border: 'border-yellow-200',
    badge: 'bg-yellow-100 text-yellow-800',
    icon: '🟡',
  },
  minor: {
    bg: 'bg-blue-50',
    border: 'border-blue-200',
    badge: 'bg-blue-100 text-blue-800',
    icon: '🔵',
  },
} as const;

const MATTERHORN_DOCS: Record<string, string> = {
  '01': 'https://www.pdfa.org/resource/matterhorn-protocol/#cat01',
  '02': 'https://www.pdfa.org/resource/matterhorn-protocol/#cat02',
  '06': 'https://www.pdfa.org/resource/matterhorn-protocol/#cat06',
  '07': 'https://www.pdfa.org/resource/matterhorn-protocol/#cat07',
  '13': 'https://www.pdfa.org/resource/matterhorn-protocol/#cat13',
  '14': 'https://www.pdfa.org/resource/matterhorn-protocol/#cat14',
  '17': 'https://www.pdfa.org/resource/matterhorn-protocol/#cat17',
  '28': 'https://www.pdfa.org/resource/matterhorn-protocol/#cat28',
};

export function IssueCard({ 
  issue, 
  onPageNavigate,
  isExpanded: initialExpanded = false,
  showAiSuggestion = true,
}: IssueCardProps) {
  const [isExpanded, setIsExpanded] = useState(initialExpanded);
  const [copied, setCopied] = useState(false);

  const config = SEVERITY_CONFIG[issue.severity];
  const isPdf = issue.documentType === 'pdf';
  const isMatterhorn = issue.code.startsWith('PDF-UA-');
  const matterhornCategory = isMatterhorn ? issue.code.match(/PDF-UA-(\d+)-/)?.[1] : null;

  const handleCopyCode = () => {
    navigator.clipboard.writeText(issue.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <Card className={cn('border', config.border, config.bg)}>
      <CardContent className="p-4">
        {/* Header Row */}
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            {/* Badges Row */}
            <div className="flex flex-wrap items-center gap-2 mb-2">
              <Badge className={config.badge}>
                {config.icon} {issue.severity}
              </Badge>

              <Tooltip>
                <TooltipTrigger>
                  <Badge 
                    variant="outline" 
                    className="cursor-pointer font-mono text-xs"
                    onClick={handleCopyCode}
                  >
                    {issue.code}
                    {copied ? (
                      <Check className="w-3 h-3 ml-1 text-green-500" />
                    ) : (
                      <Copy className="w-3 h-3 ml-1 opacity-50" />
                    )}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>Click to copy</TooltipContent>
              </Tooltip>

              {/* Document Type Badge */}
              <Badge variant="secondary" className="text-xs">
                {isPdf ? (
                  <><FileText className="w-3 h-3 mr-1" /> PDF</>
                ) : (
                  <><BookOpen className="w-3 h-3 mr-1" /> EPUB</>
                )}
              </Badge>

              {/* WCAG Criteria Badges */}
              {issue.wcagCriteria?.map(criterion => (
                <a
                  key={criterion}
                  href={`https://www.w3.org/WAI/WCAG21/Understanding/${getWcagSlug(criterion)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex"
                >
                  <Badge variant="secondary" className="text-xs hover:bg-primary-100">
                    WCAG {criterion}
                    <ExternalLink className="w-3 h-3 ml-1 opacity-50" />
                  </Badge>
                </a>
              ))}
            </div>

            {/* Message */}
            <p className="text-gray-800 font-medium">{issue.message}</p>

            {/* Location Info */}
            <div className="flex flex-wrap items-center gap-3 mt-2 text-sm text-gray-600">
              {/* PDF: Page Number */}
              {isPdf && issue.page && (
                <button
                  onClick={() => onPageNavigate?.(issue.page!)}
                  className="inline-flex items-center gap-1 hover:text-primary-600 hover:underline"
                >
                  <FileText className="w-4 h-4" />
                  Page {issue.page}
                </button>
              )}

              {/* EPUB: File Location */}
              {!isPdf && issue.location && (
                <span className="inline-flex items-center gap-1">
                  <BookOpen className="w-4 h-4" />
                  {issue.location}
                </span>
              )}

              {/* Matterhorn Checkpoint Link */}
              {isMatterhorn && matterhornCategory && MATTERHORN_DOCS[matterhornCategory] && (
                <a
                  href={MATTERHORN_DOCS[matterhornCategory]}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1 text-primary-600 hover:underline"
                >
                  Matterhorn {issue.code.replace('PDF-UA-', '')}
                  <ExternalLink className="w-3 h-3" />
                </a>
              )}

              {/* Source */}
              <span className="text-gray-400">
                Source: {issue.source}
              </span>
            </div>
          </div>

          {/* Expand/Collapse Button */}
          {(issue.suggestion || issue.aiSuggestion || issue.htmlSnippet || issue.context) && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setIsExpanded(!isExpanded)}
              className="flex-shrink-0"
            >
              {isExpanded ? (
                <ChevronUp className="w-4 h-4" />
              ) : (
                <ChevronDown className="w-4 h-4" />
              )}
            </Button>
          )}
        </div>

        {/* Expanded Content */}
        {isExpanded && (
          <div className="mt-4 pt-4 border-t border-gray-200 space-y-3">
            {/* Manual Suggestion */}
            {issue.suggestion && (
              <div className="flex gap-2">
                <Lightbulb className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-gray-700">Suggestion</p>
                  <p className="text-sm text-gray-600">{issue.suggestion}</p>
                </div>
              </div>
            )}

            {/* AI Suggestion */}
            {showAiSuggestion && issue.aiSuggestion && (
              <div className="flex gap-2 p-3 bg-purple-50 rounded-lg">
                <Sparkles className="w-4 h-4 text-purple-500 flex-shrink-0 mt-0.5" />
                <div>
                  <div className="flex items-center gap-2 mb-1">
                    <p className="text-sm font-medium text-purple-700">AI Suggestion</p>
                    {issue.confidence && (
                      <Badge variant="secondary" className="text-xs">
                        {Math.round(issue.confidence * 100)}% confidence
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-purple-600">{issue.aiSuggestion}</p>
                </div>
              </div>
            )}

            {/* HTML Snippet */}
            {issue.htmlSnippet && (
              <div>
                <p className="text-sm font-medium text-gray-700 mb-1">Code Context</p>
                <pre className="text-xs bg-gray-800 text-gray-100 p-3 rounded overflow-x-auto">
                  <code>{issue.htmlSnippet}</code>
                </pre>
              </div>
            )}

            {/* Additional Context */}
            {issue.context && (
              <div>
                <p className="text-sm font-medium text-gray-700 mb-1">Context</p>
                <p className="text-sm text-gray-600">{issue.context}</p>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// Helper function to get WCAG understanding slug
function getWcagSlug(criterion: string): string {
  const slugMap: Record<string, string> = {
    '1.1.1': 'non-text-content',
    '1.3.1': 'info-and-relationships',
    '1.3.2': 'meaningful-sequence',
    '1.4.3': 'contrast-minimum',
    '2.4.2': 'page-titled',
    '2.4.5': 'multiple-ways',
    '2.4.6': 'headings-and-labels',
    '3.1.1': 'language-of-page',
    '4.1.2': 'name-role-value',
  };
  return slugMap[criterion] || criterion.replace(/\./g, '');
}
```

### Acceptance Criteria

- [ ] PDF issues show page number with navigation
- [ ] EPUB issues show file location
- [ ] Matterhorn checkpoint links to documentation
- [ ] WCAG criteria links to Understanding docs
- [ ] Code can be copied to clipboard
- [ ] AI suggestions display with confidence
- [ ] Expandable details section works

---

## Prompt FE-PDF-5: PDF Page Navigator

### Context
Create a component for navigating issues by page number in PDF documents.

### Prerequisites
- PDF audit results include page numbers

### Objective
Allow users to browse issues page by page or jump to specific pages.

### Technical Requirements

**Create file: `src/components/pdf/PdfPageNavigator.tsx`**

```tsx
import { useState, useMemo } from 'react';
import { ChevronLeft, ChevronRight, FileText, AlertTriangle } from 'lucide-react';
import { Button } from '../ui/Button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/Select';
import { Card, CardContent } from '../ui/Card';
import { IssueCard } from '../audit/IssueCard';
import { cn } from '../../utils/cn';
import type { AccessibilityIssue } from '../../types/audit';

interface PdfPageNavigatorProps {
  pageCount: number;
  issuesByPage: Map<number, number>;
  issues: AccessibilityIssue[];
  initialPage?: number;
}

export function PdfPageNavigator({
  pageCount,
  issuesByPage,
  issues,
  initialPage = 1,
}: PdfPageNavigatorProps) {
  const [currentPage, setCurrentPage] = useState(initialPage);

  const pageIssues = useMemo(() => 
    issues.filter(issue => issue.page === currentPage),
    [issues, currentPage]
  );

  const pagesWithIssues = useMemo(() => 
    Array.from(issuesByPage.keys()).sort((a, b) => a - b),
    [issuesByPage]
  );

  const goToPrevPage = () => {
    if (currentPage > 1) setCurrentPage(currentPage - 1);
  };

  const goToNextPage = () => {
    if (currentPage < pageCount) setCurrentPage(currentPage + 1);
  };

  const goToPrevPageWithIssues = () => {
    const prevPages = pagesWithIssues.filter(p => p < currentPage);
    if (prevPages.length > 0) {
      setCurrentPage(prevPages[prevPages.length - 1]);
    }
  };

  const goToNextPageWithIssues = () => {
    const nextPages = pagesWithIssues.filter(p => p > currentPage);
    if (nextPages.length > 0) {
      setCurrentPage(nextPages[0]);
    }
  };

  const issueCount = issuesByPage.get(currentPage) || 0;

  return (
    <div className="space-y-4">
      {/* Navigation Controls */}
      <Card>
        <CardContent className="py-4">
          <div className="flex items-center justify-between">
            {/* Page Navigation */}
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={goToPrevPage}
                disabled={currentPage <= 1}
              >
                <ChevronLeft className="w-4 h-4" />
              </Button>

              <Select
                value={currentPage.toString()}
                onValueChange={(value) => setCurrentPage(parseInt(value))}
              >
                <SelectTrigger className="w-32">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent className="max-h-60">
                  {Array.from({ length: pageCount }, (_, i) => i + 1).map(page => (
                    <SelectItem key={page} value={page.toString()}>
                      <span className="flex items-center gap-2">
                        Page {page}
                        {issuesByPage.has(page) && (
                          <span className="text-xs text-red-600">
                            ({issuesByPage.get(page)} issues)
                          </span>
                        )}
                      </span>
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>

              <Button
                variant="outline"
                size="sm"
                onClick={goToNextPage}
                disabled={currentPage >= pageCount}
              >
                <ChevronRight className="w-4 h-4" />
              </Button>

              <span className="text-sm text-gray-500 ml-2">
                of {pageCount} pages
              </span>
            </div>

            {/* Jump to Issues Navigation */}
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-500">Jump to issues:</span>
              <Button
                variant="ghost"
                size="sm"
                onClick={goToPrevPageWithIssues}
                disabled={!pagesWithIssues.some(p => p < currentPage)}
              >
                <ChevronLeft className="w-4 h-4" />
                Prev
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={goToNextPageWithIssues}
                disabled={!pagesWithIssues.some(p => p > currentPage)}
              >
                Next
                <ChevronRight className="w-4 h-4" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Page Thumbnail Strip */}
      <div className="flex gap-1 overflow-x-auto pb-2">
        {Array.from({ length: Math.min(pageCount, 20) }, (_, i) => i + 1).map(page => {
          const hasIssues = issuesByPage.has(page);
          const issues = issuesByPage.get(page) || 0;

          return (
            <button
              key={page}
              onClick={() => setCurrentPage(page)}
              className={cn(
                'relative flex-shrink-0 w-10 h-14 border rounded text-xs font-medium transition-all',
                currentPage === page 
                  ? 'border-primary-500 bg-primary-50 text-primary-700' 
                  : 'border-gray-200 hover:border-gray-300',
                hasIssues && currentPage !== page && 'bg-red-50'
              )}
            >
              {page}
              {hasIssues && (
                <span className={cn(
                  'absolute -top-1 -right-1 w-4 h-4 rounded-full text-[10px] flex items-center justify-center',
                  issues >= 5 ? 'bg-red-500 text-white' : 'bg-amber-500 text-white'
                )}>
                  {issues > 9 ? '9+' : issues}
                </span>
              )}
            </button>
          );
        })}
        {pageCount > 20 && (
          <span className="flex items-center px-2 text-sm text-gray-400">
            +{pageCount - 20} more
          </span>
        )}
      </div>

      {/* Current Page Issues */}
      <div>
        <div className="flex items-center gap-2 mb-4">
          <FileText className="w-5 h-5 text-gray-500" />
          <h3 className="font-medium">Page {currentPage}</h3>
          {issueCount > 0 ? (
            <span className="flex items-center gap-1 text-sm text-red-600">
              <AlertTriangle className="w-4 h-4" />
              {issueCount} issue{issueCount !== 1 ? 's' : ''}
            </span>
          ) : (
            <span className="text-sm text-green-600">No issues</span>
          )}
        </div>

        {pageIssues.length > 0 ? (
          <div className="space-y-3">
            {pageIssues.map(issue => (
              <IssueCard key={issue.id} issue={issue} />
            ))}
          </div>
        ) : (
          <Card>
            <CardContent className="py-8 text-center text-gray-500">
              <FileText className="w-12 h-12 mx-auto mb-3 text-gray-300" />
              <p>No accessibility issues on this page</p>
            </CardContent>
          </Card>
        )}
      </div>

      {/* Summary */}
      <Card>
        <CardContent className="py-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-gray-600">
              {pagesWithIssues.length} of {pageCount} pages have issues
            </span>
            <span className="text-gray-600">
              {issues.length} total issues
            </span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
```

### Acceptance Criteria

- [ ] Navigate between pages with prev/next buttons
- [ ] Jump directly to any page via dropdown
- [ ] Page thumbnail strip shows issue indicators
- [ ] "Jump to issues" navigates to pages with problems
- [ ] Current page issues are displayed
- [ ] Summary shows pages with issues count

---

## Prompt FE-PDF-6: PDF Preview Panel

### Context
Create an optional PDF preview panel that shows the document alongside issues.

### Prerequisites
- PDF.js library available (pdfjs-dist)

### Objective
Display PDF pages with optional issue highlighting.

### Technical Requirements

**Create file: `src/components/pdf/PdfPreviewPanel.tsx`**

```tsx
import { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { ZoomIn, ZoomOut, RotateCw, Maximize2 } from 'lucide-react';
import { Button } from '../ui/Button';
import { Card } from '../ui/Card';
import { LoadingSpinner } from '../ui/LoadingSpinner';

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = '/pdf.worker.min.js';

interface PdfPreviewPanelProps {
  pdfUrl: string;
  currentPage: number;
  onPageChange?: (page: number) => void;
  issueHighlights?: Array<{
    page: number;
    bbox?: { x: number; y: number; width: number; height: number };
    severity: 'critical' | 'serious' | 'moderate' | 'minor';
  }>;
}

export function PdfPreviewPanel({
  pdfUrl,
  currentPage,
  onPageChange,
  issueHighlights = [],
}: PdfPreviewPanelProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [scale, setScale] = useState(1.0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Load PDF document
  useEffect(() => {
    let cancelled = false;

    async function loadPdf() {
      try {
        setIsLoading(true);
        setError(null);

        const loadingTask = pdfjsLib.getDocument(pdfUrl);
        const pdf = await loadingTask.promise;

        if (!cancelled) {
          setPdfDoc(pdf);
          setPageCount(pdf.numPages);
        }
      } catch (err) {
        if (!cancelled) {
          setError('Failed to load PDF preview');
          console.error('PDF loading error:', err);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    loadPdf();

    return () => {
      cancelled = true;
    };
  }, [pdfUrl]);

  // Render current page
  useEffect(() => {
    if (!pdfDoc || !canvasRef.current) return;

    let cancelled = false;

    async function renderPage() {
      try {
        const page = await pdfDoc!.getPage(currentPage);
        const viewport = page.getViewport({ scale });

        const canvas = canvasRef.current!;
        const context = canvas.getContext('2d')!;

        canvas.height = viewport.height;
        canvas.width = viewport.width;

        await page.render({
          canvasContext: context,
          viewport,
        }).promise;

        // Draw issue highlights
        if (!cancelled) {
          const pageHighlights = issueHighlights.filter(h => h.page === currentPage);
          drawHighlights(context, pageHighlights, viewport.scale);
        }
      } catch (err) {
        console.error('Page render error:', err);
      }
    }

    renderPage();

    return () => {
      cancelled = true;
    };
  }, [pdfDoc, currentPage, scale, issueHighlights]);

  const drawHighlights = (
    ctx: CanvasRenderingContext2D,
    highlights: typeof issueHighlights,
    scale: number
  ) => {
    const severityColors = {
      critical: 'rgba(239, 68, 68, 0.3)',
      serious: 'rgba(249, 115, 22, 0.3)',
      moderate: 'rgba(234, 179, 8, 0.3)',
      minor: 'rgba(59, 130, 246, 0.3)',
    };

    highlights.forEach(highlight => {
      if (highlight.bbox) {
        ctx.fillStyle = severityColors[highlight.severity];
        ctx.fillRect(
          highlight.bbox.x * scale,
          highlight.bbox.y * scale,
          highlight.bbox.width * scale,
          highlight.bbox.height * scale
        );
        ctx.strokeStyle = severityColors[highlight.severity].replace('0.3', '1');
        ctx.lineWidth = 2;
        ctx.strokeRect(
          highlight.bbox.x * scale,
          highlight.bbox.y * scale,
          highlight.bbox.width * scale,
          highlight.bbox.height * scale
        );
      }
    });
  };

  const zoomIn = () => setScale(s => Math.min(s + 0.25, 3));
  const zoomOut = () => setScale(s => Math.max(s - 0.25, 0.5));
  const resetZoom = () => setScale(1);

  if (error) {
    return (
      <Card className="p-4 text-center text-red-600">
        {error}
      </Card>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toolbar */}
      <div className="flex items-center justify-between p-2 border-b bg-gray-50">
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={zoomOut} disabled={scale <= 0.5}>
            <ZoomOut className="w-4 h-4" />
          </Button>
          <span className="text-sm text-gray-600 w-16 text-center">
            {Math.round(scale * 100)}%
          </span>
          <Button variant="ghost" size="sm" onClick={zoomIn} disabled={scale >= 3}>
            <ZoomIn className="w-4 h-4" />
          </Button>
          <Button variant="ghost" size="sm" onClick={resetZoom}>
            <RotateCw className="w-4 h-4" />
          </Button>
        </div>

        <span className="text-sm text-gray-600">
          Page {currentPage} of {pageCount}
        </span>
      </div>

      {/* Canvas Container */}
      <div 
        ref={containerRef}
        className="flex-1 overflow-auto bg-gray-100 p-4 flex items-center justify-center"
      >
        {isLoading ? (
          <LoadingSpinner message="Loading PDF..." />
        ) : (
          <canvas
            ref={canvasRef}
            className="shadow-lg bg-white"
          />
        )}
      </div>
    </div>
  );
}
```

### Acceptance Criteria

- [ ] PDF pages render correctly
- [ ] Zoom in/out controls work
- [ ] Current page is synchronized with navigator
- [ ] Issue highlights overlay on page (if bounding boxes provided)
- [ ] Loading state displays spinner
- [ ] Error state shows message

---

## Prompt FE-PDF-7: API Service Layer

### Context
Create the API service layer for PDF audit operations.

### Prerequisites
- Backend PDF API endpoints are defined

### Objective
Create typed API service functions for PDF audit operations.

### Technical Requirements

**Create file: `src/services/api/pdf-audit.api.ts`**

```typescript
import { apiClient } from './client';
import type { 
  PdfAuditResult, 
  AcrGenerationOptions, 
  AcrDocument,
  ConfidenceAnalysis 
} from '../../types/audit';

export interface CreatePdfAuditJobRequest {
  fileKey: string;
  fileName: string;
}

export interface CreatePdfAuditJobResponse {
  jobId: string;
  status: 'QUEUED';
  message: string;
}

export interface GetPdfAuditResultResponse {
  jobId: string;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  result?: PdfAuditResult;
  error?: string;
  createdAt: string;
  completedAt?: string;
}

export interface GeneratePdfAcrResponse {
  acr: AcrDocument;
  confidenceAnalysis: ConfidenceAnalysis;
}

/**
 * Create a PDF audit job
 */
export async function createPdfAuditJob(
  request: CreatePdfAuditJobRequest
): Promise<CreatePdfAuditJobResponse> {
  const response = await apiClient.post<{ success: boolean; data: CreatePdfAuditJobResponse }>(
    '/pdf/jobs',
    request
  );
  return response.data.data;
}

/**
 * Get PDF audit result by job ID
 */
export async function getPdfAuditResult(
  jobId: string
): Promise<GetPdfAuditResultResponse> {
  const response = await apiClient.get<{ success: boolean; data: GetPdfAuditResultResponse }>(
    `/pdf/jobs/${jobId}`
  );
  return response.data.data;
}

/**
 * Generate ACR from PDF audit
 */
export async function generatePdfAcr(
  jobId: string,
  options: AcrGenerationOptions
): Promise<GeneratePdfAcrResponse> {
  const response = await apiClient.post<{ success: boolean; data: GeneratePdfAcrResponse }>(
    `/pdf/jobs/${jobId}/acr`,
    options
  );
  return response.data.data;
}

/**
 * Poll for PDF audit completion
 */
export async function waitForPdfAuditCompletion(
  jobId: string,
  options: {
    interval?: number;
    timeout?: number;
    onProgress?: (status: string) => void;
  } = {}
): Promise<PdfAuditResult> {
  const { interval = 2000, timeout = 300000, onProgress } = options;
  const startTime = Date.now();

  while (true) {
    const result = await getPdfAuditResult(jobId);

    onProgress?.(result.status);

    if (result.status === 'COMPLETED' && result.result) {
      return result.result;
    }

    if (result.status === 'FAILED') {
      throw new Error(result.error || 'PDF audit failed');
    }

    if (Date.now() - startTime > timeout) {
      throw new Error('PDF audit timed out');
    }

    await new Promise(resolve => setTimeout(resolve, interval));
  }
}
```

**Create file: `src/hooks/usePdfAudit.ts`**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { 
  createPdfAuditJob,
  getPdfAuditResult,
  generatePdfAcr,
  waitForPdfAuditCompletion,
  type CreatePdfAuditJobRequest,
  type GetPdfAuditResultResponse,
} from '../services/api/pdf-audit.api';
import type { AcrGenerationOptions, PdfAuditResult } from '../types/audit';

export const pdfAuditKeys = {
  all: ['pdf-audit'] as const,
  results: () => [...pdfAuditKeys.all, 'results'] as const,
  result: (jobId: string) => [...pdfAuditKeys.results(), jobId] as const,
};

/**
 * Hook to create a new PDF audit job
 */
export function useCreatePdfAuditJob() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (request: CreatePdfAuditJobRequest) => createPdfAuditJob(request),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: pdfAuditKeys.results() });
    },
  });
}

/**
 * Hook to get PDF audit result
 */
export function usePdfAuditResult(jobId: string | undefined) {
  return useQuery({
    queryKey: pdfAuditKeys.result(jobId!),
    queryFn: () => getPdfAuditResult(jobId!),
    enabled: !!jobId,
    refetchInterval: (data) => {
      // Poll every 2 seconds while processing
      if (data?.status === 'QUEUED' || data?.status === 'PROCESSING') {
        return 2000;
      }
      return false;
    },
    select: (data): PdfAuditResult | null => {
      if (data.status === 'COMPLETED' && data.result) {
        return data.result;
      }
      return null;
    },
  });
}

/**
 * Hook to get raw audit status (including loading states)
 */
export function usePdfAuditStatus(jobId: string | undefined) {
  return useQuery({
    queryKey: [...pdfAuditKeys.result(jobId!), 'status'],
    queryFn: () => getPdfAuditResult(jobId!),
    enabled: !!jobId,
    refetchInterval: (data) => {
      if (data?.status === 'QUEUED' || data?.status === 'PROCESSING') {
        return 2000;
      }
      return false;
    },
  });
}

/**
 * Hook to generate ACR from PDF audit
 */
export function useGeneratePdfAcr() {
  return useMutation({
    mutationFn: ({ jobId, options }: { jobId: string; options: AcrGenerationOptions }) =>
      generatePdfAcr(jobId, options),
  });
}

/**
 * Hook to run full PDF audit workflow (upload + audit + wait)
 */
export function usePdfAuditWorkflow() {
  const createJob = useCreatePdfAuditJob();

  return useMutation({
    mutationFn: async ({
      fileKey,
      fileName,
      onProgress,
    }: {
      fileKey: string;
      fileName: string;
      onProgress?: (status: string) => void;
    }): Promise<PdfAuditResult> => {
      // Create job
      onProgress?.('Creating audit job...');
      const job = await createJob.mutateAsync({ fileKey, fileName });

      // Wait for completion
      onProgress?.('Processing...');
      return waitForPdfAuditCompletion(job.jobId, { onProgress });
    },
  });
}
```

### Acceptance Criteria

- [ ] API functions are fully typed
- [ ] Polling mechanism for job status works
- [ ] React Query hooks manage caching
- [ ] Auto-refetch while job is processing
- [ ] Error handling is consistent

---

## Prompt FE-PDF-8: Type Definitions

### Context
Create comprehensive TypeScript type definitions for PDF audit data.

### Prerequisites
- Backend API response shapes are defined

### Objective
Create type-safe definitions for all PDF audit-related data.

### Technical Requirements

**Create file: `src/types/pdf-audit.ts`**

```typescript
import type { AccessibilityIssue, IssueSummary, ScoreBreakdown } from './audit';

export interface PdfMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: string;
  modificationDate?: string;
  language?: string;
  isTagged: boolean;
  hasMarkedContent: boolean;
  pdfVersion: string;
  pageCount: number;
}

export interface ValidationSection {
  passed: number;
  failed: number;
  issues: AccessibilityIssue[];
}

export interface PdfUaValidationSection extends ValidationSection {
  manual: number;
}

export interface PdfValidationResults {
  structure: ValidationSection;
  altText: ValidationSection;
  contrast: ValidationSection;
  tables: ValidationSection;
  pdfua: PdfUaValidationSection;
}

export interface MatterhornSummary {
  passed: number;
  failed: number;
  manual: number;
  notApplicable: number;
}

export interface PdfAuditResult {
  jobId: string;
  fileName: string;
  documentType: 'pdf';
  pdfVersion: string;
  isTagged: boolean;
  pageCount: number;
  metadata: PdfMetadata;
  isValid: boolean;
  isAccessible: boolean;
  score: number;
  scoreBreakdown: ScoreBreakdown;
  combinedIssues: AccessibilityIssue[];
  summary: IssueSummary;
  summaryBySource: Record<string, IssueSummary>;
  validationResults: PdfValidationResults;
  matterhornSummary: MatterhornSummary;
  auditedAt: string;
}

// Type guard
export function isPdfAuditResult(result: unknown): result is PdfAuditResult {
  return (
    typeof result === 'object' &&
    result !== null &&
    'documentType' in result &&
    (result as PdfAuditResult).documentType === 'pdf'
  );
}
```

**Update file: `src/types/audit.ts`**

```typescript
// Add to existing file

export type DocumentType = 'epub' | 'pdf';

export type IssueSeverity = 'critical' | 'serious' | 'moderate' | 'minor';

export type IssueSource = 
  | 'epubcheck' | 'ace' | 'js-auditor'  // EPUB sources
  | 'pdf-structure' | 'pdf-ua' | 'pdf-contrast' | 'pdf-tables' | 'pdf-alttext';  // PDF sources

export interface AccessibilityIssue {
  id: string;
  source: IssueSource;
  documentType: DocumentType;
  severity: IssueSeverity;
  code: string;
  message: string;
  wcagCriteria?: string[];
  location?: string;       // EPUB: file path
  page?: number;           // PDF: page number
  suggestion?: string;
  category?: string;
  element?: string;
  context?: string;
  htmlSnippet?: string;
  aiSuggestion?: string;   // AI-generated suggestion
  confidence?: number;     // AI confidence score
}

export interface IssueSummary {
  critical: number;
  serious: number;
  moderate: number;
  minor: number;
  total: number;
}

export interface ScoreBreakdown {
  score: number;
  formula: string;
  weights: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
  };
  deductions: {
    critical: { count: number; points: number };
    serious: { count: number; points: number };
    moderate: { count: number; points: number };
    minor: { count: number; points: number };
  };
  totalDeduction: number;
  maxScore: number;
}
```

### Acceptance Criteria

- [ ] All PDF types are defined
- [ ] Types match backend API responses
- [ ] Type guards help with runtime validation
- [ ] Shared types work for both EPUB and PDF
- [ ] All issue sources are enumerated

---

## Component Reusability Matrix

| Component | EPUB | PDF | Shared |
|-----------|------|-----|--------|
| FileUpload | ✅ | ✅ | ✅ 95% |
| AuditHeader | ✅ | ✅ | ✅ 100% |
| ScoreDisplay | ✅ | ✅ | ✅ 100% |
| IssueSummaryCard | ✅ | ✅ | ✅ 100% |
| IssueCard | ✅ | ✅ | ✅ 85% |
| IssuesList | ✅ | ✅ | ✅ 90% |
| AcrGenerationPanel | ✅ | ✅ | ✅ 100% |
| MatterhornSummary | ❌ | ✅ | PDF only |
| PdfPageNavigator | ❌ | ✅ | PDF only |
| PdfPreviewPanel | ❌ | ✅ | PDF only |
| EpubTocViewer | ✅ | ❌ | EPUB only |

**Total new components for PDF:** 4  
**Total shared components:** 7  
**Code reuse percentage:** ~80%

## WCAG Rule Mappings for PDF

Complete reference of PDF rule codes to WCAG criteria:

| Rule Code | WCAG Criteria | Category |
|-----------|---------------|----------|
| PDF-STRUCT-UNTAGGED | 1.3.1, 4.1.2 | Structure |
| PDF-STRUCT-NO-HEADINGS | 1.3.1, 2.4.6 | Structure |
| PDF-STRUCT-HEADING-SKIP | 1.3.1, 2.4.6 | Structure |
| PDF-STRUCT-NO-LANGUAGE | 3.1.1 | Structure |
| PDF-STRUCT-NO-TITLE | 2.4.2 | Structure |
| PDF-ALT-MISSING | 1.1.1 | Images |
| PDF-ALT-GENERIC | 1.1.1 | Images |
| PDF-CONTRAST-FAIL | 1.4.3 | Color |
| PDF-TABLE-NO-HEADERS | 1.3.1 | Tables |
| PDF-TABLE-NO-SCOPE | 1.3.1 | Tables |
| PDF-UA-02-001 | 1.3.1, 4.1.2 | PDF/UA |
| PDF-UA-06-001 | 1.3.1, 2.4.6 | PDF/UA |
| PDF-UA-13-001 | 1.1.1 | PDF/UA |
| PDF-UA-14-002 | 3.1.1 | PDF/UA |

---

## Testing Strategy

### Unit Tests

Each validator should have comprehensive unit tests:

```typescript
// Example: pdf-structure.validator.test.ts
describe('PdfStructureValidator', () => {
  describe('validateHeadingHierarchy', () => {
    it('should flag missing H1', async () => {
      const parsed = createMockParsedPdf({
        headingHierarchy: [{ level: 2, text: 'Section', page: 1 }],
      });

      const issues = await pdfStructureValidator.validate(parsed);

      expect(issues).toContainEqual(
        expect.objectContaining({ code: 'PDF-STRUCT-MISSING-H1' })
      );
    });

    it('should flag heading level skip', async () => {
      const parsed = createMockParsedPdf({
        headingHierarchy: [
          { level: 1, text: 'Title', page: 1 },
          { level: 3, text: 'Section', page: 1 },  // Skipped H2
        ],
      });

      const issues = await pdfStructureValidator.validate(parsed);

      expect(issues).toContainEqual(
        expect.objectContaining({ code: 'PDF-STRUCT-HEADING-SKIP' })
      );
    });
  });
});
```

### Integration Tests

Test end-to-end flow:

```typescript
describe('PDF Audit Integration', () => {
  it('should audit PDF and generate ACR', async () => {
    // Upload test PDF
    const uploadRes = await request(app)
      .post('/api/v1/files/upload')
      .attach('file', 'tests/fixtures/test-tagged.pdf');

    const { fileKey, fileName } = uploadRes.body.data;

    // Create audit job
    const jobRes = await request(app)
      .post('/api/v1/pdf/jobs')
      .send({ fileKey, fileName });

    const jobId = jobRes.body.data.jobId;

    // Wait for completion
    await waitForJob(jobId);

    // Get result
    const resultRes = await request(app)
      .get(`/api/v1/pdf/jobs/${jobId}`);

    expect(resultRes.body.data.status).toBe('COMPLETED');
    expect(resultRes.body.data.result.documentType).toBe('pdf');

    // Generate ACR
    const acrRes = await request(app)
      .post(`/api/v1/pdf/jobs/${jobId}/acr`)
      .send({
        edition: 'VPAT2.5-INT',
        productInfo: { /* ... */ },
      });

    expect(acrRes.body.data.acr.edition).toBe('VPAT2.5-INT');
  });
});
```

---

## Acceptance Criteria Summary

### Must Have (MVP)
- [ ] PDF files can be uploaded and parsed
- [ ] Untagged PDFs flagged with critical error
- [ ] Heading hierarchy validated (WCAG 1.3.1)
- [ ] Alt text validated with AI suggestions (WCAG 1.1.1)
- [ ] Key Matterhorn Protocol checkpoints validated
- [ ] ACR/VPAT generation works with PDF results
- [ ] Frontend displays PDF audit results

### Should Have
- [ ] Color contrast analysis (WCAG 1.4.3)
- [ ] Table structure validation (WCAG 1.3.1)
- [ ] Reading order validation (WCAG 1.3.2)
- [ ] Language validation (WCAG 3.1.1)

### Nice to Have
- [ ] PDF preview with issue highlighting
- [ ] Page-by-page navigation in results
- [ ] Batch PDF processing
- [ ] PDF remediation features

---

## Appendix: File Structure

After implementation, the new file structure will be:

```
src/services/
├── audit/
│   └── base-audit.service.ts          # NEW: Abstract base class
├── epub/
│   ├── epub-audit.service.ts          # UPDATED: Extends BaseAuditService
│   └── ... (existing files)
├── pdf/
│   ├── pdf-parser.service.ts          # NEW
│   ├── pdf-audit.service.ts           # NEW
│   └── validators/
│       ├── pdf-structure.validator.ts  # NEW
│       ├── pdf-alttext.validator.ts    # NEW
│       ├── pdf-contrast.validator.ts   # NEW
│       ├── pdf-table.validator.ts      # NEW
│       └── pdfua.validator.ts          # NEW
├── acr/
│   ├── acr-generator.service.ts       # UNCHANGED
│   └── wcag-issue-mapper.service.ts   # UPDATED: Add PDF mappings
└── ...

src/controllers/
├── pdf-audit.controller.ts            # NEW
└── ...

src/routes/
├── pdf-audit.routes.ts                # NEW
└── index.ts                           # UPDATED: Add PDF routes
```

---

*Document created: January 28, 2026*  
*For: Ninja Platform - S4Carlisle*
