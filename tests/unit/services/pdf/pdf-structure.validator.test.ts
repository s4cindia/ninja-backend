/**
 * Tests for PDF Structure Validator
 *
 * Tests validation of PDF structure for accessibility compliance.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFNumber } from 'pdf-lib';
import { pdfStructureValidator } from '../../../../src/services/pdf/validators/pdf-structure.validator';
import { structureAnalyzerService, DocumentStructure, TableCell } from '../../../../src/services/pdf/structure-analyzer.service';
import { pdfParserService, ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';

// Mock dependencies
vi.mock('../../../../src/services/pdf/structure-analyzer.service');
vi.mock('../../../../src/services/pdf/pdf-parser.service');

describe('PDFStructureValidator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('validateFromFile', () => {
    it('should validate a tagged PDF with no issues', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: true,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      // Only the PDFUA-IDENTIFIER-MISSING issue (mock pdfLibDoc has no XMP)
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].code).toBe('PDFUA-IDENTIFIER-MISSING');
      expect(result.metadata.isTaggedPDF).toBe(true);
      expect(result.metadata.hasDocumentLanguage).toBe(true);
      expect(result.metadata.hasDocumentTitle).toBe(true);
      expect(pdfParserService.close).toHaveBeenCalledWith(mockParsedPdf);
    });

    it('should identify critical issue for untagged PDF', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: false,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: false,
        hasProperHeadingHierarchy: true,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.summary.critical).toBe(1);

      const taggedIssue = result.issues.find(i => i.code === 'PDF-UNTAGGED');
      expect(taggedIssue).toBeDefined();
      expect(taggedIssue?.severity).toBe('critical');
      expect(taggedIssue?.message).toContain('not tagged');
      expect(taggedIssue?.wcagCriteria).toContain('1.3.1');
    });

    it('should identify serious issue for missing document language', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: false,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: true,
        hasDocumentLanguage: false,
        hasLogicalReadingOrder: true,
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const languageIssue = result.issues.find(i => i.code === 'MATTERHORN-11-001');
      expect(languageIssue).toBeDefined();
      expect(languageIssue?.severity).toBe('serious');
      expect(languageIssue?.message).toContain('language is not specified');
      expect(languageIssue?.wcagCriteria).toContain('3.1.1');
    });

    it('should identify serious issue for missing document title', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: true,
        hasTitle: false,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: true,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const titleIssue = result.issues.find(i => i.code === 'WCAG-2.4.2');
      expect(titleIssue).toBeDefined();
      expect(titleIssue?.severity).toBe('serious');
      expect(titleIssue?.message).toContain('title is not present');
      expect(titleIssue?.wcagCriteria).toContain('2.4.2');
    });
  });

  describe('untagged content (Matterhorn 01-005)', () => {
    async function validateWithRealPage(content: string): Promise<ParsedPDF['pdfLibDoc']> {
      const doc = await PDFDocument.create();
      doc.addPage([612, 792]);
      writePageContent(doc, 1, content);
      return doc;
    }

    it('flags a page with an untagged painted-path region', async () => {
      const pdfLibDoc = await validateWithRealPage('0 0 m\n10 10 l\nS\n');
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: true, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const issue = result.issues.find(i => i.code === 'UNTAGGED-CONTENT');
      expect(issue).toBeDefined();
      expect(issue?.matterhornCheckpoint).toBe('01-005');
      expect(issue?.matterhornHow).toBe('M');
      expect(issue?.pageNumber).toBe(1);
      expect(issue?.location).toBe('Page 1');
    });

    it('routes a page with a curved untagged path to UNTAGGED-CONTENT-COMPLEX instead of auto-fixable UNTAGGED-CONTENT (may be meaningful graphics, not decoration)', async () => {
      const pdfLibDoc = await validateWithRealPage('0 0 m\n10 10 20 20 30 30 c\nS\n');
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: true, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues.find(i => i.code === 'UNTAGGED-CONTENT')).toBeUndefined();
      const complexIssue = result.issues.find(i => i.code === 'UNTAGGED-CONTENT-COMPLEX');
      expect(complexIssue).toBeDefined();
      expect(complexIssue?.matterhornCheckpoint).toBe('01-005');
    });

    it('routes a page with ANY curved run to UNTAGGED-CONTENT-COMPLEX even when other runs on the same page are simple', async () => {
      const pdfLibDoc = await validateWithRealPage(
        '0 0 m\n10 10 l\nS\n' + 'BT\n(x)Tj\nET\n' + '20 20 m\n5 5 10 10 15 15 c\nS\n'
      );
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: true, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      // The whole page routes to the conservative code -- even the simple
      // straight-line run isn't auto-fixed once ANY run on the page is
      // curve-based (see validateUntaggedContent's own doc comment for why
      // this is deliberately page-level, not per-run).
      expect(result.issues.find(i => i.code === 'UNTAGGED-CONTENT')).toBeUndefined();
      expect(result.issues.find(i => i.code === 'UNTAGGED-CONTENT-COMPLEX')).toBeDefined();
    });

    it('does not flag a page whose painted paths are all already tagged', async () => {
      const pdfLibDoc = await validateWithRealPage('/Artifact BMC\n0 0 m\n10 10 l\nS\nEMC\n');
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: true, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues.find(i => i.code === 'UNTAGGED-CONTENT')).toBeUndefined();
    });

    it('does not run this check on an untagged PDF (Seam-C autotag handles paths for those)', async () => {
      const pdfLibDoc = await validateWithRealPage('0 0 m\n10 10 l\nS\n');
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: false, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: false, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues.find(i => i.code === 'UNTAGGED-CONTENT')).toBeUndefined();
    });

    describe('recurring decorative curve refinement', () => {
      // A byte-identical curve run repeated across `curvePageCount` pages
      // (a decorative page-template shape, e.g. a chapter-tab corner
      // badge), each also carrying an unrelated straight-line run.
      const CURVE = '0 0 m\n5 0 5 5 0 5 c\nS\n';
      const STRAIGHT = '20 20 m\n30 30 l\nS\n';

      async function docWithRepeatedCurvePages(curvePageCount: number, totalPages: number): Promise<ParsedPDF['pdfLibDoc']> {
        const doc = await PDFDocument.create();
        for (let i = 0; i < totalPages; i++) {
          doc.addPage([612, 792]);
          const content = i < curvePageCount ? `${CURVE}${STRAIGHT}` : STRAIGHT;
          writePageContent(doc, i + 1, content);
        }
        return doc;
      }

      function mockSetup(pdfLibDoc: ParsedPDF['pdfLibDoc']) {
        const mockParsedPdf = { ...createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true }), pdfLibDoc };
        const mockStructure = createMockStructure({
          isTaggedPDF: true, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
        });
        vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
        vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
        vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);
      }

      it('still routes to UNTAGGED-CONTENT-COMPLEX when the same curve recurs on fewer than the recurrence threshold', async () => {
        // 2 occurrences -- below RECURRING_SIGNATURE_THRESHOLD (3).
        const pdfLibDoc = await docWithRepeatedCurvePages(2, 2);
        mockSetup(pdfLibDoc);

        const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

        expect(result.issues.filter(i => i.code === 'UNTAGGED-CONTENT-COMPLEX')).toHaveLength(2);
        expect(result.issues.find(i => i.code === 'UNTAGGED-CONTENT')).toBeUndefined();
      });

      it('routes to plain auto-fixable UNTAGGED-CONTENT once the same curve recurs on at least the recurrence threshold -- including its FIRST occurrence', async () => {
        // 3 occurrences -- exactly RECURRING_SIGNATURE_THRESHOLD, confirmed
        // decorative. The two-pass design means even the first page (which
        // alone has no way to know it'll recur) gets the same treatment as
        // the third, not just pages seen after the threshold is reached.
        const pdfLibDoc = await docWithRepeatedCurvePages(3, 3);
        mockSetup(pdfLibDoc);

        const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

        expect(result.issues.filter(i => i.code === 'UNTAGGED-CONTENT-COMPLEX')).toHaveLength(0);
        const plainIssues = result.issues.filter(i => i.code === 'UNTAGGED-CONTENT');
        expect(plainIssues).toHaveLength(3);
        expect(plainIssues.map(i => i.pageNumber).sort()).toEqual([1, 2, 3]);
      });

      it('does not let a recurring curve on some pages exempt a DIFFERENT, only-seen-once curve elsewhere in the same document', async () => {
        const doc = await PDFDocument.create();
        // 3 pages with the recurring decorative curve.
        for (let i = 0; i < 3; i++) {
          doc.addPage([612, 792]);
          writePageContent(doc, i + 1, `${CURVE}${STRAIGHT}`);
        }
        // A 4th page with a DIFFERENT, one-off curve shape.
        doc.addPage([612, 792]);
        writePageContent(doc, 4, '0 0 m\n99 1 99 99 1 99 c\nS\n');
        mockSetup(doc);

        const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

        expect(result.issues.filter(i => i.code === 'UNTAGGED-CONTENT')).toHaveLength(3);
        const complexIssues = result.issues.filter(i => i.code === 'UNTAGGED-CONTENT-COMPLEX');
        expect(complexIssues).toHaveLength(1);
        expect(complexIssues[0].pageNumber).toBe(4);
      });
    });
  });

  describe('tagged content inside an Artifact span (Matterhorn 01-004)', () => {
    async function validateWithRealPage(content: string): Promise<ParsedPDF['pdfLibDoc']> {
      const doc = await PDFDocument.create();
      doc.addPage([612, 792]);
      writePageContent(doc, 1, content);
      return doc;
    }

    it('flags a page with a real tag nested inside an /Artifact span', async () => {
      const pdfLibDoc = await validateWithRealPage('/Artifact BMC\n/Span <</MCID 0 >>BDC\n(x)Tj\nEMC\nEMC\n');
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: true, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const issue = result.issues.find(i => i.code === 'TAGGED-CONTENT-INSIDE-ARTIFACT');
      expect(issue).toBeDefined();
      expect(issue?.matterhornCheckpoint).toBe('01-004');
      expect(issue?.matterhornHow).toBe('M');
      expect(issue?.severity).toBe('serious');
      expect(issue?.pageNumber).toBe(1);
      expect(issue?.location).toBe('Page 1');
      expect(issue?.message).toContain('1 real structure element');
    });

    it('does not flag a page where real content sits beside, not inside, an Artifact', async () => {
      const pdfLibDoc = await validateWithRealPage('/Artifact BMC\n0 0 m\n10 10 l\nS\nEMC\n/P <</MCID 0 >>BDC\n(x)Tj\nEMC\n');
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: true, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues.find(i => i.code === 'TAGGED-CONTENT-INSIDE-ARTIFACT')).toBeUndefined();
    });

    it('does not run this check on an untagged document (no /Artifact spans exist to nest inside)', async () => {
      const pdfLibDoc = await validateWithRealPage('/Artifact BMC\n/Span <</MCID 0 >>BDC\n(x)Tj\nEMC\nEMC\n');
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: false, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: false, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues.find(i => i.code === 'TAGGED-CONTENT-INSIDE-ARTIFACT')).toBeUndefined();
    });

    it('reports one issue per page, counting multiple nested real tags on that page', async () => {
      const content =
        '/Artifact BMC\n/Span <</MCID 0 >>BDC\n(a)Tj\nEMC\n' +
        '/Span <</MCID 1 >>BDC\n(b)Tj\nEMC\n' +
        '/Span <</MCID 2 >>BDC\n(c)Tj\nEMC\nEMC\n';
      const pdfLibDoc = await validateWithRealPage(content);
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: true, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const issues = result.issues.filter(i => i.code === 'TAGGED-CONTENT-INSIDE-ARTIFACT');
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('3 real structure element');
    });
  });

  describe('oversized Artifact spans swallowing real content (ARTIFACT-SWALLOWS-CONTENT)', () => {
    async function validateWithRealPage(content: string): Promise<ParsedPDF['pdfLibDoc']> {
      const doc = await PDFDocument.create();
      doc.addPage([612, 792]);
      writePageContent(doc, 1, content);
      return doc;
    }

    const manyTj = (count: number): string =>
      Array.from({ length: count }, (_, i) => `(line ${i})Tj\n`).join('');

    it('flags a page with a text-only oversized top-level Artifact span', async () => {
      const content = `/Artifact BMC\nBT\n${manyTj(20)}ET\nEMC\n`;
      const pdfLibDoc = await validateWithRealPage(content);
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: true, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const issue = result.issues.find(i => i.code === 'ARTIFACT-SWALLOWS-CONTENT');
      expect(issue).toBeDefined();
      expect(result.issues.find(i => i.code === 'ARTIFACT-SWALLOWS-CONTENT-COMPLEX')).toBeUndefined();
      expect(issue?.matterhornCheckpoint).toBe('01-005');
      expect(issue?.matterhornHow).toBe('M');
      expect(issue?.severity).toBe('serious');
      expect(issue?.pageNumber).toBe(1);
      expect(issue?.location).toBe('Page 1');
      expect(issue?.message).toContain('1 /Artifact span');
    });

    it('flags a span containing path-paint ops (not just text) as the -COMPLEX variant instead', async () => {
      const content = `/Artifact BMC\nBT\n${manyTj(20)}ET\n0 0 m\n10 10 l\nS\nEMC\n`;
      const pdfLibDoc = await validateWithRealPage(content);
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: true, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues.find(i => i.code === 'ARTIFACT-SWALLOWS-CONTENT')).toBeUndefined();
      const issue = result.issues.find(i => i.code === 'ARTIFACT-SWALLOWS-CONTENT-COMPLEX');
      expect(issue).toBeDefined();
      expect(issue?.matterhornCheckpoint).toBe('01-005');
      expect(issue?.message).toContain('vector graphics');
    });

    it('does not flag a small legitimate Artifact span (e.g. a real page number + running head)', async () => {
      const content = `/Artifact BMC\nBT\n(5)Tj\n(Running Head)Tj\nET\nEMC\n`;
      const pdfLibDoc = await validateWithRealPage(content);
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: true, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues.find(i => i.code === 'ARTIFACT-SWALLOWS-CONTENT')).toBeUndefined();
      expect(result.issues.find(i => i.code === 'ARTIFACT-SWALLOWS-CONTENT-COMPLEX')).toBeUndefined();
    });

    it('does not run this check on an untagged document (no /Artifact spans exist to swallow anything)', async () => {
      const content = `/Artifact BMC\nBT\n${manyTj(20)}ET\nEMC\n`;
      const pdfLibDoc = await validateWithRealPage(content);
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: false, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: false, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues.find(i => i.code === 'ARTIFACT-SWALLOWS-CONTENT')).toBeUndefined();
    });

    it('reports one issue per page, counting multiple oversized spans and their total op count', async () => {
      const content = `/Artifact BMC\nBT\n${manyTj(20)}ET\nEMC\n/Artifact BMC\nBT\n${manyTj(20)}ET\nEMC\n`;
      const pdfLibDoc = await validateWithRealPage(content);
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: true, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const issues = result.issues.filter(i => i.code === 'ARTIFACT-SWALLOWS-CONTENT');
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('2 /Artifact span');
      expect(issues[0].message).toContain('40 content operation');
    });
  });

  describe('/PlacedPDF content unreachable from the structure tree (PLACEDPDF-NOT-TAGGED)', () => {
    async function validateWithRealPage(content: string): Promise<ParsedPDF['pdfLibDoc']> {
      const doc = await PDFDocument.create();
      doc.addPage([612, 792]);
      writePageContent(doc, 1, content);
      return doc;
    }

    it('flags a page with a top-level /PlacedPDF span', async () => {
      const content = '/PlacedPDF /MC0 BDC\n0 0 m\n10 10 l\nf\nEMC\n';
      const pdfLibDoc = await validateWithRealPage(content);
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: true, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const issue = result.issues.find(i => i.code === 'PLACEDPDF-NOT-TAGGED');
      expect(issue).toBeDefined();
      expect(issue?.matterhornCheckpoint).toBe('01-005');
      expect(issue?.matterhornHow).toBe('M');
      expect(issue?.severity).toBe('serious');
      expect(issue?.pageNumber).toBe(1);
      expect(issue?.location).toBe('Page 1');
      expect(issue?.message).toContain('1 /PlacedPDF region');
    });

    it('does not flag a page with no /PlacedPDF content at all', async () => {
      const content = '/P <</MCID 0 >>BDC\n(Ordinary paragraph)Tj\nEMC\n';
      const pdfLibDoc = await validateWithRealPage(content);
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: true, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues.find(i => i.code === 'PLACEDPDF-NOT-TAGGED')).toBeUndefined();
    });

    it('does not run this check on an untagged document', async () => {
      const content = '/PlacedPDF /MC0 BDC\n0 0 m\n10 10 l\nf\nEMC\n';
      const pdfLibDoc = await validateWithRealPage(content);
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: false, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: false, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues.find(i => i.code === 'PLACEDPDF-NOT-TAGGED')).toBeUndefined();
    });

    it('reports one issue per page, counting multiple top-level spans', async () => {
      const content = '/PlacedPDF /MC0 BDC\n0 0 m\nf\nEMC\n(between)Tj\n/PlacedPDF /MC1 BDC\n1 1 m\nf\nEMC\n';
      const pdfLibDoc = await validateWithRealPage(content);
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: true, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const issues = result.issues.filter(i => i.code === 'PLACEDPDF-NOT-TAGGED');
      expect(issues).toHaveLength(1);
      expect(issues[0].message).toContain('2 /PlacedPDF region');
    });
  });

  describe('structure-tree reference integrity (STRUCTURE-DANGLING-REFERENCE)', () => {
    // Real incident this check closes a blind spot for: Math_Olszewski_PDF.pdf's
    // remediated output had 3 struct elements silently dropped by pdf-lib's own
    // loader, with the parent's /K array, /ParentTree's Nums entries, and a
    // surviving child's /P all left pointing at objects that no longer existed.
    // Nothing in this file could see it -- an external tool (PAC 2026) had to
    // hard-crash on it first. These fixtures reproduce each of those three
    // reference shapes directly via pdf-lib's low-level object APIs (mirrors
    // this session's own colorspace-test fixture pattern).
    function registerStructElem(doc: PDFDocument, fields: Record<string, unknown>): PDFRef {
      return doc.context.register(doc.context.obj(fields));
    }

    function mockSetup(pdfLibDoc: ParsedPDF['pdfLibDoc']) {
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true }), pdfLibDoc };
      const mockStructure = createMockStructure({
        isTaggedPDF: true, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);
    }

    it('reports no findings for a structure tree with no dangling references', async () => {
      const doc = await PDFDocument.create();
      doc.addPage([612, 792]);
      const childRef = registerStructElem(doc, { Type: 'StructElem', S: 'P' });
      const structTreeRootRef = doc.context.register(
        doc.context.obj({ Type: 'StructTreeRoot', K: [childRef] })
      );
      doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
      mockSetup(doc);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues.filter(i => i.code === 'STRUCTURE-DANGLING-REFERENCE')).toHaveLength(0);
    });

    it('flags a dangling /K (Kids) entry that references a nonexistent object', async () => {
      const doc = await PDFDocument.create();
      doc.addPage([612, 792]);
      const validChildRef = registerStructElem(doc, { Type: 'StructElem', S: 'P' });
      const danglingRef = PDFRef.of(99999, 0); // never registered
      const structTreeRootRef = doc.context.register(
        doc.context.obj({ Type: 'StructTreeRoot', K: [validChildRef, danglingRef] })
      );
      doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
      mockSetup(doc);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const issue = result.issues.find(i => i.code === 'STRUCTURE-DANGLING-REFERENCE' && i.message.includes('Kids array'));
      expect(issue).toBeDefined();
      expect(issue?.severity).toBe('critical');
      expect(issue?.message).toContain(danglingRef.toString());
    });

    it('flags a dangling /P (parent) pointer on a surviving child', async () => {
      const doc = await PDFDocument.create();
      doc.addPage([612, 792]);
      const danglingParentRef = PDFRef.of(77777, 0); // never registered
      const orphanRef = registerStructElem(doc, { Type: 'StructElem', S: 'LI', P: danglingParentRef });
      const structTreeRootRef = doc.context.register(
        doc.context.obj({ Type: 'StructTreeRoot', K: [orphanRef] })
      );
      doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
      mockSetup(doc);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const issue = result.issues.find(i => i.code === 'STRUCTURE-DANGLING-REFERENCE' && i.message.includes('/P (parent)'));
      expect(issue).toBeDefined();
      expect(issue?.message).toContain(danglingParentRef.toString());
    });

    it('flags a dangling /ParentTree Nums entry, attributing it to the real page via /StructParents', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([612, 792]);
      page.node.set(PDFName.of('StructParents'), PDFNumber.of(0));
      const danglingMcidTarget = PDFRef.of(88888, 0); // never registered
      const parentTreeRef = doc.context.register(
        doc.context.obj({ Nums: [0, [danglingMcidTarget]] })
      );
      const structTreeRootRef = doc.context.register(
        doc.context.obj({ Type: 'StructTreeRoot', K: [], ParentTree: parentTreeRef })
      );
      doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
      mockSetup(doc);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const issue = result.issues.find(i => i.code === 'STRUCTURE-DANGLING-REFERENCE' && i.message.includes('/ParentTree'));
      expect(issue).toBeDefined();
      expect(issue?.pageNumber).toBe(1);
      expect(issue?.location).toBe('Page 1');
    });

    it('does not run this check on an untagged PDF (no /StructTreeRoot to speak of)', async () => {
      const doc = await PDFDocument.create();
      doc.addPage([612, 792]);
      // No /StructTreeRoot set at all.
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged: false, hasLanguage: true, hasTitle: true }), pdfLibDoc: doc };
      const mockStructure = createMockStructure({
        isTaggedPDF: false, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues.filter(i => i.code === 'STRUCTURE-DANGLING-REFERENCE')).toHaveLength(0);
    });
  });

  describe('content-stream well-formedness (CONTENT-STREAM-MALFORMED-OPERATOR)', () => {
    // Real incident this check closes a blind spot for: Math_Olszewski_PDF.pdf
    // had a malformed /rg operator (wrong operand count) left behind by an
    // old, failed color-contrast fix -- nothing in this pipeline could see it,
    // it took PAC 2026's own strict parser to catch it.
    async function docWithPageContent(content: string, isTagged: boolean): Promise<{ doc: ParsedPDF['pdfLibDoc']; mockParsedPdf: ParsedPDF }> {
      const doc = await PDFDocument.create();
      doc.addPage([612, 792]);
      writePageContent(doc, 1, content);
      const mockParsedPdf = { ...createMockParsedPdf({ isTagged, hasLanguage: true, hasTitle: true }), pdfLibDoc: doc };
      return { doc, mockParsedPdf };
    }

    function mockStructureFor(isTaggedPDF: boolean) {
      return createMockStructure({
        isTaggedPDF, hasProperHeadingHierarchy: true, hasDocumentLanguage: true, hasLogicalReadingOrder: true,
      });
    }

    it('reports no findings for well-formed color/matrix operators', async () => {
      const { mockParsedPdf } = await docWithPageContent('0 0 0 rg\n1 0 0 1 0 0 cm\n0.5 g\n0 0 0 1 k\n0 0 10 10 re\n', true);
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructureFor(true));

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues.filter(i => i.code === 'CONTENT-STREAM-MALFORMED-OPERATOR')).toHaveLength(0);
    });

    it('flags an rg operator with too few operands', async () => {
      const { mockParsedPdf } = await docWithPageContent('BT\n0.5 0.5 rg\n(x) Tj\nET\n', true);
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructureFor(true));

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const issue = result.issues.find(i => i.code === 'CONTENT-STREAM-MALFORMED-OPERATOR');
      expect(issue).toBeDefined();
      expect(issue?.severity).toBe('critical');
      expect(issue?.message).toContain("'rg' operator has 2 preceding numeric operand(s), expected 3");
      expect(issue?.pageNumber).toBe(1);
    });

    it('flags a cm operator with too few operands', async () => {
      const { mockParsedPdf } = await docWithPageContent('1 0 0 1 cm\n', true);
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructureFor(true));

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const issue = result.issues.find(i => i.code === 'CONTENT-STREAM-MALFORMED-OPERATOR');
      expect(issue).toBeDefined();
      expect(issue?.message).toContain("'cm' operator has 4 preceding numeric operand(s), expected 6");
    });

    it('runs on an UNTAGGED document too, unlike the structure-tree check', async () => {
      const { mockParsedPdf } = await docWithPageContent('0.5 0.5 rg\n', false);
      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructureFor(false));

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.issues.find(i => i.code === 'CONTENT-STREAM-MALFORMED-OPERATOR')).toBeDefined();
    });
  });

  describe('heading validation', () => {
    it('should identify missing H1 heading', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: false,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
        headingIssues: [
          {
            type: 'missing-h1',
            severity: 'major' as const,
            description: 'Document has no H1 heading',
            location: 'Document',
            wcagCriterion: '1.3.1',
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      // No standalone Matterhorn condition matches "no H1 anywhere" -- was
      // previously mismapped to 14-003 (whose real text is "heading levels
      // skip", not this), a bug found and fixed alongside adding 14-002/
      // 14-006/14-007 coverage. See the 'skipped-level' test below for
      // where 14-003 actually belongs now.
      const h1Issue = result.issues.find(i => i.code === 'HEADING-MISSING-H1');
      expect(h1Issue).toBeDefined();
      expect(h1Issue?.severity).toBe('serious');
      expect(h1Issue?.matterhornCheckpoint).toBeUndefined();
      expect(h1Issue?.wcagCriteria).toContain('1.3.1');
      expect(h1Issue?.wcagCriteria).toContain('2.4.6');
    });

    it('should identify skipped heading levels', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: false,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
        headingIssues: [
          {
            type: 'skipped-level',
            severity: 'major' as const,
            description: 'Heading level skipped from H1 to H3',
            location: 'Page 2',
            wcagCriterion: '1.3.1',
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const skipIssue = result.issues.find(i => i.code === 'HEADING-SKIP');
      expect(skipIssue).toBeDefined();
      expect(skipIssue?.severity).toBe('serious');
      expect(skipIssue?.suggestion).toContain('not skipping levels');
      // This is the real Matterhorn 14-003 ("heading levels skip") --
      // previously unmapped entirely, so a genuine skip never showed up as
      // a FAIL in the PAC compliance report at all.
      expect(skipIssue?.matterhornCheckpoint).toBe('14-003');
      expect(skipIssue?.matterhornHow).toBe('M');
    });

    it('identifies Matterhorn 14-002: first heading tag is not H1', async () => {
      const mockParsedPdf = createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true });
      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: false,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
        headingIssues: [
          {
            type: 'first-heading-not-h1',
            severity: 'major' as const,
            description: 'Document uses numbered headings, but the first heading tag is H2, not H1.',
            location: 'Page 1',
            wcagCriterion: '1.3.1',
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const issue = result.issues.find(i => i.code === 'HEADING-FIRST-NOT-H1');
      expect(issue).toBeDefined();
      expect(issue?.severity).toBe('moderate');
      expect(issue?.matterhornCheckpoint).toBe('14-002');
      expect(issue?.matterhornHow).toBe('M');
    });

    it('identifies Matterhorn 14-006: a structure element has more than one direct H tag', async () => {
      const mockParsedPdf = createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true });
      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: false,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
        headingIssues: [
          {
            type: 'multiple-headings-one-node',
            severity: 'minor' as const,
            description: 'A structure element directly contains more than one heading (H) tag.',
            location: 'Page 3',
            wcagCriterion: '1.3.1',
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const issue = result.issues.find(i => i.code === 'HEADING-MULTIPLE-IN-NODE');
      expect(issue).toBeDefined();
      expect(issue?.severity).toBe('minor');
      expect(issue?.matterhornCheckpoint).toBe('14-006');
      expect(issue?.matterhornHow).toBe('M');
    });

    it('identifies Matterhorn 14-007: document mixes the generic H tag with numbered H1-H9 tags', async () => {
      const mockParsedPdf = createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true });
      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: false,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
        headingIssues: [
          {
            type: 'mixed-heading-tag-types',
            severity: 'minor' as const,
            description: 'Document uses both the generic H tag and numbered heading tags (H1-H9).',
            location: 'Document',
            wcagCriterion: '1.3.1',
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const issue = result.issues.find(i => i.code === 'HEADING-MIXED-TAG-TYPES');
      expect(issue).toBeDefined();
      expect(issue?.severity).toBe('minor');
      expect(issue?.matterhornCheckpoint).toBe('14-007');
      expect(issue?.matterhornHow).toBe('M');
    });

    it('should identify multiple H1 headings as moderate issue', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: false,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
        headingIssues: [
          {
            type: 'multiple-h1',
            severity: 'minor' as const,
            description: 'Document has 3 H1 headings',
            location: 'Document',
            wcagCriterion: '1.3.1',
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const multiH1Issue = result.issues.find(i => i.code === 'HEADING-MULTIPLE-H1');
      expect(multiH1Issue).toBeDefined();
      expect(multiH1Issue?.severity).toBe('moderate');
    });
  });

  describe('reading order validation', () => {
    it('should identify illogical reading order', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: true,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: false,
        readingOrderIssues: [
          {
            type: 'column-confusion',
            description: 'Multi-column layout detected without proper tagging',
            pageNumber: 3,
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const readingOrderIssue = result.issues.find(i => i.code === 'MATTERHORN-12-001');
      expect(readingOrderIssue).toBeDefined();
      expect(readingOrderIssue?.severity).toBe('serious');
      expect(readingOrderIssue?.wcagCriteria).toContain('1.3.2');

      const columnIssue = result.issues.find(i => i.code === 'READING-ORDER-COLUMNS');
      expect(columnIssue).toBeDefined();
      expect(columnIssue?.location).toContain('Page 3');
    });
  });

  // Table validation was removed from this validator — pdf-table.validator.ts
  // is now the sole source of table issues (see that validator's own tests).
  // This validator used to independently re-derive TABLE-ACCESSIBILITY/
  // TABLE-INACCESSIBLE from the same structureAnalyzerService table data,
  // which double-reported every real table issue since the two validators'
  // differing source/code/message meant the shared dedup pass never
  // recognized them as the same underlying problem.

  describe('list validation', () => {
    it('should identify lists in untagged PDF', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: false,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: false,
        hasProperHeadingHierarchy: true,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
        lists: [
          {
            id: 'list_p1_0',
            pageNumber: 1,
            type: 'unordered',
            itemCount: 5,
            items: [],
            position: { x: 50, y: 100 },
            isProperlyTagged: false,
          },
          {
            id: 'list_p2_0',
            pageNumber: 2,
            type: 'ordered',
            itemCount: 3,
            items: [],
            position: { x: 50, y: 150 },
            isProperlyTagged: false,
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const listIssue = result.issues.find(i => i.code === 'LIST-NOT-TAGGED');
      expect(listIssue).toBeDefined();
      expect(listIssue?.severity).toBe('moderate');
      expect(listIssue?.message).toContain('2 list(s)');
    });

    it('should identify improperly tagged lists', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: true,
        hasLanguage: true,
        hasTitle: true,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: true,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
        lists: [
          {
            id: 'list_p1_0',
            pageNumber: 1,
            type: 'unordered',
            itemCount: 5,
            items: [],
            position: { x: 50, y: 100 },
            isProperlyTagged: false,
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const listIssue = result.issues.find(i => i.code === 'LIST-IMPROPER-MARKUP');
      expect(listIssue).toBeDefined();
      expect(listIssue?.severity).toBe('moderate');
      expect(listIssue?.location).toContain('Page 1');
      expect(listIssue?.suggestion).toContain('L (list), LI (list item)');
    });
  });

  describe('boundingBox coverage', () => {
    // Table boundingBox coverage now lives entirely in pdf-table.validator.ts's
    // own tests — this validator no longer emits table issues at all.

    it('does not attach a boundingBox to heading issues (no per-element geometry)', async () => {
      const mockParsedPdf = createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true });
      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: false,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
        headingIssues: [
          {
            type: 'missing-h1',
            severity: 'major' as const,
            description: 'Document has no H1 heading',
            location: 'Document',
            wcagCriterion: '1.3.1',
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const heading = result.issues.find(i => i.code === 'HEADING-MISSING-H1');
      expect(heading).toBeDefined();
      expect(heading?.boundingBox).toBeUndefined();
    });

    it('does not attach a boundingBox to list issues (ListInfo has no width/height)', async () => {
      const mockParsedPdf = createMockParsedPdf({ isTagged: true, hasLanguage: true, hasTitle: true });
      const mockStructure = createMockStructure({
        isTaggedPDF: true,
        hasProperHeadingHierarchy: true,
        hasDocumentLanguage: true,
        hasLogicalReadingOrder: true,
        lists: [
          {
            id: 'list_p1_0',
            pageNumber: 1,
            type: 'unordered',
            itemCount: 5,
            items: [],
            position: { x: 50, y: 100 },
            isProperlyTagged: false,
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      const list = result.issues.find(i => i.code === 'LIST-IMPROPER-MARKUP');
      expect(list).toBeDefined();
      expect(list?.boundingBox).toBeUndefined();
    });
  });

  describe('summary calculation', () => {
    it('should correctly calculate issue summary', async () => {
      const mockParsedPdf = createMockParsedPdf({
        isTagged: false,
        hasLanguage: false,
        hasTitle: false,
      });

      const mockStructure = createMockStructure({
        isTaggedPDF: false,
        hasProperHeadingHierarchy: false,
        hasDocumentLanguage: false,
        hasLogicalReadingOrder: false,
        headingIssues: [
          {
            type: 'missing-h1',
            severity: 'major' as const,
            description: 'Document has no H1 heading',
            location: 'Document',
            wcagCriterion: '1.3.1',
          },
        ],
      });

      vi.mocked(pdfParserService.parse).mockResolvedValue(mockParsedPdf);
      vi.mocked(pdfParserService.close).mockResolvedValue(undefined);
      vi.mocked(structureAnalyzerService.analyzeStructure).mockResolvedValue(mockStructure);

      const result = await pdfStructureValidator.validateFromFile('/path/to/test.pdf');

      expect(result.summary.total).toBe(result.issues.length);
      expect(result.summary.total).toBeGreaterThan(0);
      expect(result.summary.critical + result.summary.serious + result.summary.moderate + result.summary.minor)
        .toBe(result.summary.total);
    });
  });
});

// Helper functions to create mock data

function createMockParsedPdf(options: {
  isTagged: boolean;
  hasLanguage: boolean;
  hasTitle: boolean;
}): ParsedPDF {
  return {
    structure: {
      pageCount: 10,
      metadata: {
        isTagged: options.isTagged,
        language: options.hasLanguage ? 'en' : undefined,
        title: options.hasTitle ? 'Test Document' : undefined,
        suspect: false,
        hasAcroForm: false,
      },
      outline: [],
      pages: Array.from({ length: 10 }, (_, i) => ({
        pageNumber: i + 1,
        width: 612,
        height: 792,
        tags: [],
        images: [],
        links: [],
        annotations: [],
      })),
    },
    pdfLibDoc: {} as ParsedPDF['pdfLibDoc'],
    pdfjsDoc: {} as ParsedPDF['pdfjsDoc'],
  };
}

function createMockStructure(options: {
  isTaggedPDF: boolean;
  hasProperHeadingHierarchy: boolean;
  hasDocumentLanguage: boolean;
  hasLogicalReadingOrder: boolean;
  headingIssues?: Array<{
    type:
      | 'missing-h1'
      | 'multiple-h1'
      | 'skipped-level'
      | 'improper-nesting'
      | 'first-heading-not-h1'
      | 'multiple-headings-one-node'
      | 'mixed-heading-tag-types';
    severity: 'critical' | 'major' | 'minor';
    description: string;
    location: string;
    wcagCriterion: string;
  }>;
  readingOrderIssues?: Array<{
    type: 'visual-order' | 'column-confusion' | 'float-interruption' | 'table-reading';
    description: string;
    pageNumber: number;
    location?: string;
  }>;
  tables?: Array<{
    id: string;
    pageNumber: number;
    position: { x: number; y: number; width: number; height: number };
    rowCount: number;
    columnCount: number;
    hasHeaderRow: boolean;
    hasHeaderColumn: boolean;
    hasSummary: boolean;
    cells: TableCell[];
    issues: string[];
    isAccessible: boolean;
  }>;
  lists?: Array<{
    id: string;
    pageNumber: number;
    type: 'ordered' | 'unordered' | 'definition';
    itemCount: number;
    items: unknown[];
    position: { x: number; y: number };
    isProperlyTagged: boolean;
  }>;
}): DocumentStructure {
  return {
    isTaggedPDF: options.isTaggedPDF,
    headings: {
      headings: [],
      hasProperHierarchy: options.hasProperHeadingHierarchy,
      hasH1: true,
      multipleH1: false,
      skippedLevels: [],
      issues: options.headingIssues || [],
    },
    tables: options.tables || [],
    lists: options.lists || [],
    links: [],
    readingOrder: {
      isLogical: options.hasLogicalReadingOrder,
      hasStructureTree: options.isTaggedPDF,
      issues: options.readingOrderIssues || [],
      confidence: options.hasLogicalReadingOrder ? 0.9 : 0.5,
    },
    language: {
      documentLanguage: options.hasDocumentLanguage ? 'en' : undefined,
      hasDocumentLanguage: options.hasDocumentLanguage,
      languageChanges: [],
      issues: [],
    },
    bookmarks: [],
    formFields: [],
    accessibilityScore: 85,
    summary: {
      totalHeadings: 0,
      totalTables: options.tables?.length || 0,
      totalLists: options.lists?.length || 0,
      totalLinks: 0,
      totalImages: 0,
      totalFormFields: 0,
      criticalIssues: 0,
      majorIssues: 0,
      minorIssues: 0,
    },
  };
}
