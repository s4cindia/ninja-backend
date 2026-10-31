/**
 * PDF Structure Validator
 *
 * Validates PDF document structure for accessibility compliance.
 * Checks tagging, heading hierarchy, reading order, language settings,
 * and content structure (lists, tables, figures).
 *
 * Maps issues to WCAG 2.1 criteria and Matterhorn Protocol checkpoints.
 */

import { v4 as uuidv4 } from 'uuid';
import { PDFName, PDFDict, PDFArray, PDFRef, PDFNumber, type PDFDocument } from 'pdf-lib';
import { AuditIssue, IssueSeverity } from '../../audit/base-audit.service';
import { structureAnalyzerService, DocumentStructure } from '../structure-analyzer.service';
import { pdfParserService, ParsedPDF } from '../pdf-parser.service';
import { decodePageContent } from '../pdf-content-stream-io';
import { findUntaggedPathRuns, type UntaggedPathRun, findTaggedContentInsideArtifact, findOversizedArtifactSpans, findPlacedPdfSpans } from '../pdf-artifact-tagger';
import { logger } from '../../../lib/logger';

// validateUntaggedContent's own recurring-decorative-curve refinement (see
// that method's doc comment for the full reasoning): a curve-containing
// untagged path run whose own normalized content recurs on at least this
// many DISTINCT pages is treated as a confirmed decorative page-template
// element (e.g. a repeated chapter-tab/badge shape), not a genuine one-off
// illustration this check must protect. An absolute count, not a fraction
// of document length -- a genuine recurring template element appears at
// roughly the same rate regardless of how long the document is. Same
// numeric value as pdf-contrast.validator.ts's own SUSPECT_PAGE_THRESHOLD
// (reused for the same reasoning, not literally shared/imported -- the two
// files solve unrelated problems).
const RECURRING_SIGNATURE_THRESHOLD = 3;

// validateContentStreamWellFormedness's own operand-count table -- only the
// operators this codebase's own remediation code writes (see that method's
// doc comment for why this is deliberately narrow, not a general PDF
// content-stream grammar). Per PDF32000-1:2008 Table 51/58/59.
const CONTENT_STREAM_OPERATOR_OPERAND_COUNTS: Record<string, number> = {
  rg: 3, // set RGB fill color
  g: 1,  // set gray fill color
  k: 4,  // set CMYK fill color
  re: 4, // append rectangle to path
  cm: 6, // modify current transformation matrix
};

/**
 * Matterhorn Protocol checkpoint mapping
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface MatterhornCheckpoint {
  checkpoint: string;
  description: string;
}

/**
 * WCAG criterion mapping with level
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
interface WCAGCriterion {
  criterion: string;
  level: 'A' | 'AA' | 'AAA';
}

/**
 * Validation result containing all identified issues
 */
export interface StructureValidationResult {
  issues: AuditIssue[];
  summary: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    total: number;
  };
  metadata: {
    isTaggedPDF: boolean;
    hasDocumentLanguage: boolean;
    hasDocumentTitle: boolean;
    totalHeadings: number;
    totalTables: number;
    totalLists: number;
  };
}

/**
 * PDF Structure Validator Service
 *
 * Validates PDF document structure for accessibility compliance
 * following WCAG 2.1 and Matterhorn Protocol standards.
 */
class PDFStructureValidator {
  /**
   * Validate PDF structure from file path
   *
   * @param filePath - Path to PDF file
   * @returns Validation result with issues
   */
  async validateFromFile(filePath: string): Promise<StructureValidationResult> {
    logger.info(`[PDFStructureValidator] Starting validation for ${filePath}`);

    const parsedPdf = await pdfParserService.parse(filePath);

    try {
      return await this.validate(parsedPdf);
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  }

  /**
   * Validate PDF structure from parsed PDF
   *
   * @param parsedPdf - Parsed PDF document
   * @returns Validation result with issues
   */
  async validate(parsedPdf: ParsedPDF): Promise<StructureValidationResult> {
    const issues: AuditIssue[] = [];

    logger.info('[PDFStructureValidator] Analyzing document structure...');

    // Analyze document structure
    const structure = await structureAnalyzerService.analyzeStructure(parsedPdf);

    logger.info('[PDFStructureValidator] Running structure validations...');

    // Validate document structure
    issues.push(...this.validateDocumentStructure(structure, parsedPdf));

    // Validate content structure
    issues.push(...this.validateContentStructure(structure));

    // Validate untagged painted-path content (Matterhorn 01-005) — tagged
    // PDFs only. An untagged document goes through Seam-C's from-scratch
    // autotagger first (which already tags every painted path), so this
    // check only ever finds something real on a document that arrived
    // already (partially) tagged by its own original producer.
    if (structure.isTaggedPDF) {
      issues.push(...this.validateUntaggedContent(parsedPdf));
    }

    // Validate tagged content nested inside an /Artifact span (Matterhorn
    // 01-004) -- tagged PDFs only, same reasoning as the untagged-content
    // check above (no /Artifact spans exist to nest inside on an untagged
    // document).
    if (structure.isTaggedPDF) {
      issues.push(...this.validateTaggedContentInsideArtifact(parsedPdf));
    }

    // Validate oversized Artifact spans that swallow real, never-tagged
    // content (a third, distinct Artifact-related defect -- see
    // validateArtifactSwallowsContent's own doc comment) -- tagged PDFs
    // only, same reasoning as the two checks above.
    if (structure.isTaggedPDF) {
      issues.push(...this.validateArtifactSwallowsContent(parsedPdf));
    }

    // Validate /PlacedPDF content -- Adobe InDesign's own non-standard tag
    // for placed vector art whose own properties reference carries
    // provenance /Metadata, never a real /MCID, so it's unreachable from
    // the structure tree despite looking tagged (see
    // validatePlacedPdfContent's own doc comment). Tagged PDFs only, same
    // reasoning as the Artifact-related checks above.
    if (structure.isTaggedPDF) {
      issues.push(...this.validatePlacedPdfContent(parsedPdf));
    }

    // Structure-tree reference integrity -- tagged PDFs only (an untagged
    // document has no /StructTreeRoot to walk at all).
    if (structure.isTaggedPDF) {
      issues.push(...this.validateStructTreeReferenceIntegrity(parsedPdf));
    }

    // Content-stream operator well-formedness -- runs regardless of tagging
    // state (malformed operator syntax can occur on any page).
    issues.push(...this.validateContentStreamWellFormedness(parsedPdf));

    // Calculate summary
    const summary = this.calculateSummary(issues);

    const metadata = {
      isTaggedPDF: structure.isTaggedPDF,
      hasDocumentLanguage: structure.language.hasDocumentLanguage,
      hasDocumentTitle: !!parsedPdf.structure.metadata.title,
      totalHeadings: structure.headings.headings.length,
      totalTables: structure.tables.length,
      totalLists: structure.lists.length,
    };

    logger.info(`[PDFStructureValidator] Validation complete - ${issues.length} issues found`);

    return {
      issues,
      summary,
      metadata,
    };
  }

  /**
   * Validate document-level structure
   *
   * Checks:
   * - PDF tagging
   * - Heading hierarchy
   * - Reading order
   * - Document language
   * - Document title
   *
   * @param structure - Analyzed document structure
   * @param parsedPdf - Parsed PDF document
   * @returns Array of issues
   */
  private validateDocumentStructure(
    structure: DocumentStructure,
    parsedPdf: ParsedPDF
  ): AuditIssue[] {
    const issues: AuditIssue[] = [];

    // Check if PDF is tagged (PDF-UNTAGGED)
    if (!structure.isTaggedPDF) {
      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'critical',
        code: 'PDF-UNTAGGED',
        message: 'PDF is not tagged',
        wcagCriteria: ['1.3.1'],
        location: 'Document',
        suggestion: 'Add structural tags to the PDF document. Tagged PDFs are essential for accessibility as they provide semantic structure for assistive technologies.',
        category: 'structure',
        pageNumber: 1,
      }));
    }

    // Check for suspect tag structure (Matterhorn 01-007 -- "Suspects entry
    // has a value of true". Previously mislabeled 01-004, which is a
    // different condition entirely ("Tagged content is present inside
    // content marked as Artifact", see validateTaggedContentInsideArtifact
    // below for real coverage of that one) -- fixed alongside adding that
    // validator. pdf-audit.service.ts's checkpoint-01 rollup filters by this
    // exact code string and was updated in the same change.)
    if (structure.isTaggedPDF && parsedPdf.structure.metadata.suspect) {
      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'serious',
        code: 'MATTERHORN-01-007',
        message: 'Document has suspect tag structure',
        wcagCriteria: ['1.3.1'],
        location: 'Document',
        suggestion: 'Review and fix the tag structure. The Suspects flag indicates potential tagging problems.',
        category: 'structure',
        pageNumber: 1,
        matterhornCheckpoint: '01-007',
        matterhornHow: 'M',
      }));
    }

    // Check for missing PDF/UA identifier in XMP (Matterhorn 06-002) — tagged PDFs only
    if (structure.isTaggedPDF && !this.hasPdfUaIdentifier(parsedPdf)) {
      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'serious',
        code: 'PDFUA-IDENTIFIER-MISSING',
        message: 'PDF/UA identifier (pdfuaid:part) is missing from document XMP metadata',
        wcagCriteria: ['1.3.1'],
        location: 'Document metadata',
        suggestion: 'Add the PDF/UA identifier (pdfuaid:part=1) to the document XMP metadata to declare PDF/UA-1 conformance.',
        category: 'metadata',
        pageNumber: 1,
        matterhornCheckpoint: '06-002',
        matterhornHow: 'M',
      }));
    }

    // Validate heading hierarchy (Matterhorn 14-003, WCAG 2.4.6)
    issues.push(...this.validateHeadingHierarchy(structure.headings));

    // Validate reading order (Matterhorn 12-001, WCAG 1.3.2)
    issues.push(...this.validateReadingOrder(structure.readingOrder));

    // Check document language (Matterhorn 11-001, WCAG 3.1.1)
    if (!structure.language.hasDocumentLanguage) {
      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'serious',
        code: 'MATTERHORN-11-001',
        message: 'Document language is not specified',
        wcagCriteria: ['3.1.1'],
        location: 'Document metadata',
        suggestion: 'Set the document language in the PDF metadata (e.g., "en" for English, "es" for Spanish).',
        category: 'language',
        pageNumber: 1,
        matterhornCheckpoint: '11-001',
        matterhornHow: 'M',
      }));
    }

    // Check document title (WCAG 2.4.2)
    if (!parsedPdf.structure.metadata.title) {
      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'serious',
        code: 'WCAG-2.4.2',
        message: 'Document title is not present in metadata',
        wcagCriteria: ['2.4.2'],
        location: 'Document metadata',
        suggestion: 'Add a descriptive title to the PDF document metadata.',
        category: 'metadata',
        pageNumber: 1,
      }));
    }

    return issues;
  }

  /**
   * Validate heading hierarchy
   *
   * @param headings - Heading hierarchy information
   * @returns Array of issues
   */
  private validateHeadingHierarchy(headings: DocumentStructure['headings']): AuditIssue[] {
    const issues: AuditIssue[] = [];

    // Map structure analyzer issues to audit issues
    for (const issue of headings.issues) {
      let severity: IssueSeverity;
      let code: string;
      let matterhornCheckpoint: string | undefined;
      let matterhornHow: 'M' | 'H' | '--' | undefined;

      switch (issue.type) {
        case 'missing-h1':
          // No standalone Matterhorn condition matches "no H1 anywhere in
          // the document" -- the closest real one, 14-002, is narrower
          // ("the FIRST heading tag specifically is not H1") and is its own
          // case below. Previously mismapped to 14-003 (whose real text is
          // "heading levels skip", not "no H1") -- a bug found and fixed
          // alongside adding 14-002/14-006/14-007 coverage; see 'skipped-level'
          // below for the checkpoint 14-003 actually belongs to.
          severity = 'serious';
          code = 'HEADING-MISSING-H1';
          break;
        case 'skipped-level':
          severity = 'serious';
          code = 'HEADING-SKIP';
          matterhornCheckpoint = '14-003';
          matterhornHow = 'M';
          break;
        case 'multiple-h1':
          severity = 'moderate';
          code = 'HEADING-MULTIPLE-H1';
          break;
        case 'improper-nesting':
          severity = 'serious';
          code = 'HEADING-NESTING';
          break;
        case 'first-heading-not-h1':
          severity = 'moderate';
          code = 'HEADING-FIRST-NOT-H1';
          matterhornCheckpoint = '14-002';
          matterhornHow = 'M';
          break;
        case 'multiple-headings-one-node':
          severity = 'minor';
          code = 'HEADING-MULTIPLE-IN-NODE';
          matterhornCheckpoint = '14-006';
          matterhornHow = 'M';
          break;
        case 'mixed-heading-tag-types':
          severity = 'minor';
          code = 'HEADING-MIXED-TAG-TYPES';
          matterhornCheckpoint = '14-007';
          matterhornHow = 'M';
          break;
        default:
          severity = 'moderate';
          code = 'HEADING-ISSUE';
      }

      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity,
        code,
        message: issue.description,
        wcagCriteria: ['1.3.1', '2.4.6'],
        location: issue.location,
        suggestion: this.getHeadingSuggestion(issue.type),
        category: 'headings',
        pageNumber: issue.pageNumber || 1,
        matterhornCheckpoint,
        matterhornHow,
      }));
    }

    return issues;
  }

  /**
   * Get suggestion for heading issue
   *
   * @param issueType - Type of heading issue
   * @returns Suggestion text
   */
  private getHeadingSuggestion(issueType: string): string {
    switch (issueType) {
      case 'missing-h1':
        return 'Add a main H1 heading at the start of the document to establish the document hierarchy.';
      case 'skipped-level':
        return 'Fix heading hierarchy by not skipping levels (e.g., H1 → H2 → H3, not H1 → H3).';
      case 'multiple-h1':
        return 'Consider using only one H1 heading for the main document title. Use H2-H6 for subsections.';
      case 'improper-nesting':
        return 'Ensure headings are properly nested according to their hierarchy level.';
      case 'first-heading-not-h1':
        return 'Make the first heading in the document H1, and use H2-H6 for subsequent levels.';
      case 'multiple-headings-one-node':
        return 'Split the structure element so each heading has its own parent, or remove the extra heading tag.';
      case 'mixed-heading-tag-types':
        return 'Use either the generic H tag or numbered H1-H9 tags throughout the document, not both.';
      default:
        return 'Review and fix heading structure to ensure proper hierarchy.';
    }
  }

  /**
   * Validate reading order
   *
   * @param readingOrder - Reading order information
   * @returns Array of issues
   */
  private validateReadingOrder(readingOrder: DocumentStructure['readingOrder']): AuditIssue[] {
    const issues: AuditIssue[] = [];

    if (!readingOrder.isLogical) {
      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'serious',
        code: 'MATTERHORN-12-001',
        message: 'Document reading order may not be logical',
        wcagCriteria: ['1.3.2'],
        location: 'Document',
        suggestion: 'Ensure the document has a logical reading order. Use tagged PDF structure to define the correct reading sequence.',
        category: 'reading-order',
        pageNumber: 1,
        matterhornCheckpoint: '12-001',
        matterhornHow: 'H',
      }));
    }

    // Map reading order issues
    for (const issue of readingOrder.issues) {
      let code: string;
      let suggestion: string;

      switch (issue.type) {
        case 'column-confusion':
          code = 'READING-ORDER-COLUMNS';
          suggestion = 'Tag multi-column layouts properly to ensure correct reading order across columns.';
          break;
        case 'visual-order':
          code = 'READING-ORDER-VISUAL';
          suggestion = 'Ensure reading order matches visual layout. Adjust tag order if needed.';
          break;
        case 'table-reading':
          code = 'READING-ORDER-TABLE';
          suggestion = 'Ensure table content is read in logical order (rows, then columns).';
          break;
        default:
          code = 'READING-ORDER-ISSUE';
          suggestion = 'Review and fix reading order to ensure logical content flow.';
      }

      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'moderate',
        code,
        message: issue.description,
        wcagCriteria: ['1.3.2'],
        location: issue.location || `Page ${issue.pageNumber}`,
        suggestion,
        category: 'reading-order',
        pageNumber: issue.pageNumber,
      }));
    }

    return issues;
  }

  /**
   * Validate content structure
   *
   * Checks:
   * - List markup
   * - Figure elements
   *
   * Table structure is intentionally NOT validated here — pdf-table.validator.ts
   * is the sole owner of table issues (see its own doc comment). This validator
   * used to also emit TABLE-ACCESSIBILITY/TABLE-INACCESSIBLE from the same
   * underlying structureAnalyzerService table data, which meant every table
   * issue was independently double-reported by two validators with no way for
   * the shared dedup pass to recognize them as the same underlying problem
   * (different source/code/message per validator).
   *
   * @param structure - Analyzed document structure
   * @returns Array of issues
   */
  private validateContentStructure(structure: DocumentStructure): AuditIssue[] {
    const issues: AuditIssue[] = [];

    // Validate lists — ListInfo.position only exposes {x,y} (no width/height),
    // so list issues intentionally carry no boundingBox (cannot fabricate size).
    issues.push(...this.validateLists(structure.lists, structure.isTaggedPDF));

    return issues;
  }

  /**
   * Validate list markup
   *
   * @param lists - List information
   * @param isTaggedPDF - Whether PDF is tagged
   * @returns Array of issues
   */
  private validateLists(lists: DocumentStructure['lists'], isTaggedPDF: boolean): AuditIssue[] {
    const issues: AuditIssue[] = [];

    if (lists.length > 0 && !isTaggedPDF) {
      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'moderate',
        code: 'LIST-NOT-TAGGED',
        message: `Found ${lists.length} list(s) in untagged PDF`,
        wcagCriteria: ['1.3.1'],
        location: 'Document',
        suggestion: 'Tag the PDF and mark lists with proper structure tags (L, LI, Lbl, LBody).',
        category: 'lists',
        pageNumber: 1,
      }));
    }

    // Check individual lists for proper tagging
    for (const list of lists) {
      if (!list.isProperlyTagged) {
        issues.push(this.createIssue({
          source: 'pdf-structure',
          severity: 'moderate',
          code: 'LIST-IMPROPER-MARKUP',
          message: `List on page ${list.pageNumber} is not properly tagged`,
          wcagCriteria: ['1.3.1'],
          location: `Page ${list.pageNumber}`,
          suggestion: 'Ensure list is marked with proper tags: L (list), LI (list item), Lbl (label), LBody (body).',
          category: 'lists',
          pageNumber: list.pageNumber,
        }));
      }
    }

    return issues;
  }

  /**
   * Check whether the PDF's XMP metadata stream contains a pdfuaid:part entry.
   * Returns false (not present) on any read error — never throws.
   */
  /**
   * Matterhorn 01-005 ("Content is neither marked as Artifact nor tagged as
   * real content", UA1:7.1-2, machine-testable) — confirmed live via the
   * real PAC/axesPAC desktop tool on a real 377-page document that this
   * codebase's own audit had zero coverage for: ~24,000 untagged vector-
   * graphics path-paint sequences (crop marks, table row/header shading
   * rectangles — see pdf-artifact-tagger.ts's own header for the full
   * finding). One issue per affected page (not per untagged path) — a
   * dense table page can carry hundreds of individually-untagged fill
   * calls that pdf-artifact-tagger.ts's own run-merging collapses into a
   * small number of contiguous decorative regions; surfacing each raw
   * path-paint call as its own issue would be both meaningless to a
   * reviewer and unusable at this codebase's issue-list/DB scale.
   */
  private validateUntaggedContent(parsedPdf: ParsedPDF): AuditIssue[] {
    const issues: AuditIssue[] = [];
    let pageCount: number;
    try {
      pageCount = parsedPdf.pdfLibDoc.getPageCount();
    } catch (err) {
      logger.debug(`[PDFStructureValidator] Could not read page count for untagged-content check: ${err instanceof Error ? err.message : String(err)}`);
      return issues;
    }

    // First pass: decode + detect once per page (runs cached for reuse
    // below), and tally which pages each curve-containing run's own
    // normalized content recurs on -- needed BEFORE classifying any single
    // page, so an early occurrence of a genuinely recurring decorative
    // shape is judged the same as a later one, against the document's full
    // picture rather than only what's been seen so far.
    const perPage: Array<{ pageNumber: number; runs: UntaggedPathRun[] }> = [];
    const signaturePages = new Map<string, Set<number>>();

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      let content: string | null;
      try {
        content = decodePageContent(parsedPdf.pdfLibDoc, pageNumber);
      } catch (err) {
        logger.debug(`[PDFStructureValidator] Could not decode page ${pageNumber} for untagged-content check: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!content) continue;

      const runs = findUntaggedPathRuns(content);
      if (runs.length === 0) continue;
      perPage.push({ pageNumber, runs });

      for (const run of runs) {
        if (!run.hasCurves) continue;
        const signature = content.slice(run.start, run.end).replace(/\s+/g, ' ').trim();
        if (!signaturePages.has(signature)) signaturePages.set(signature, new Set());
        signaturePages.get(signature)!.add(pageNumber);
      }
    }

    // Second pass: classify using the now-complete cross-page signature
    // table. Re-decoding a page is only needed for the subset that has a
    // curve-containing run at all (19 of 377 on the real document this was
    // built against) -- cheap relative to caching every page's full
    // content in memory for the whole document.
    for (const { pageNumber, runs } of perPage) {
      let content: string | null | undefined;
      // CodeRabbit finding, confirmed real: detecting a path is untagged
      // never proves it's decorative -- a tagged PDF can contain a genuine
      // untagged vector chart, map, diagram, or logo, and auto-artifacting
      // one would hide real content from assistive technology. Every real
      // instance confirmed on Math_Weir_PDF.pdf (crop marks, table
      // row/header shading) uses only straight lines/rectangles; route a
      // page containing ANY curve-based run to manual review instead of
      // auto-apply (see UNTAGGED_CONTENT_CODES' dispatch in
      // ai-analysis.service.ts) rather than only gating the specific
      // curved runs -- this keeps the writer's existing "fix every
      // untagged run on this page" contract simple and conservative.
      //
      // Refinement, confirmed real and live: on THIS same document, every
      // single one of the 38 real curve-containing runs (across 19 pages)
      // is the EXACT SAME 110-byte shape -- a small filled rounded-
      // rectangle corner, recurring identically at the same relative
      // position on every affected page. That's the signature of a
      // decorative page-template element (a chapter-tab/badge shape), not
      // a one-off illustration -- yet the blanket "any curve blocks the
      // whole page" rule above was keeping 38 legitimately-decorative
      // straight-line crop-marks stuck in manual review too, just because
      // they shared a page with it. A curve run whose own normalized
      // content recurs on RECURRING_SIGNATURE_THRESHOLD+ DISTINCT pages is
      // a confirmed recurring template element, not "might be a genuine
      // one-off diagram" -- excluded from hasGenuinelyComplexRun below
      // (and thus safe to auto-artifact along with the rest of the page's
      // untagged runs), while a curve seen on fewer pages still keeps the
      // full manual-review protection this whole check exists for.
      const hasGenuinelyComplexRun = runs.some(run => {
        if (!run.hasCurves) return false;
        if (content === undefined) content = decodePageContent(parsedPdf.pdfLibDoc, pageNumber);
        if (!content) return true; // couldn't re-decode -- stay conservative
        const signature = content.slice(run.start, run.end).replace(/\s+/g, ' ').trim();
        const pages = signaturePages.get(signature);
        return !pages || pages.size < RECURRING_SIGNATURE_THRESHOLD;
      });

      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'moderate',
        code: hasGenuinelyComplexRun ? 'UNTAGGED-CONTENT-COMPLEX' : 'UNTAGGED-CONTENT',
        message: `${runs.length} vector-graphics region(s) on this page are neither tagged as real content nor marked as an artifact` +
          (hasGenuinelyComplexRun ? ' (includes curved paths -- may be meaningful graphics, needs manual review)' : ''),
        wcagCriteria: ['1.3.1'],
        location: `Page ${pageNumber}`,
        suggestion: hasGenuinelyComplexRun
          ? 'Review these vector graphics: mark them as PDF artifacts if decorative, or tag them as real content (e.g. Figure with alt text) if they convey information.'
          : 'Mark decorative vector graphics (crop marks, background shading) as PDF artifacts so assistive technology correctly skips them.',
        category: 'structure',
        pageNumber,
        matterhornCheckpoint: '01-005',
        matterhornHow: 'M',
      }));
    }

    return issues;
  }

  /**
   * Matterhorn 01-004 ("Tagged content is present inside content marked as
   * Artifact", UA1:7.1-1, machine-testable) — confirmed live via a real
   * PAC/axesPAC report the user shared on Farrar_2E_Comp_188910.pdf: 76
   * real structure elements (Span/Figure/PlacedPDF/H6) nested inside an
   * /Artifact span, inherited untouched from the document's original
   * (InDesign) producer -- Seam-C's own content-stream tagger produces
   * strictly flat, non-nested marked-content regions by construction, and
   * its own upfront "does this need retagging" gate only checks for an
   * empty/heading-shell structure tree, not nesting validity, so a document
   * with real headings elsewhere (like this one) sails through untouched.
   *
   * One issue per affected page (not per raw nesting occurrence) -- same
   * reviewability-at-scale reasoning as validateUntaggedContent above; a
   * single decorative wrapper can carry dozens of individually-nested real
   * elements (confirmed real: 38 on one page of the document this was found
   * on). No manual-review gate (unlike UNTAGGED-CONTENT-COMPLEX): the
   * nested content already carries its own real structure tag, so there's
   * no "decorative or meaningful?" judgment call -- only whether the
   * enclosing Artifact's own marked-content boundary should exclude it,
   * which splitArtifactAroundTaggedContent resolves as a pure, unambiguous
   * content-stream edit.
   */
  private validateTaggedContentInsideArtifact(parsedPdf: ParsedPDF): AuditIssue[] {
    const issues: AuditIssue[] = [];
    let pageCount: number;
    try {
      pageCount = parsedPdf.pdfLibDoc.getPageCount();
    } catch (err) {
      logger.debug(`[PDFStructureValidator] Could not read page count for artifact-nesting check: ${err instanceof Error ? err.message : String(err)}`);
      return issues;
    }

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      let content: string | null;
      try {
        content = decodePageContent(parsedPdf.pdfLibDoc, pageNumber);
      } catch (err) {
        logger.debug(`[PDFStructureValidator] Could not decode page ${pageNumber} for artifact-nesting check: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!content) continue;

      const violations = findTaggedContentInsideArtifact(content);
      if (violations.length === 0) continue;

      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'serious',
        code: 'TAGGED-CONTENT-INSIDE-ARTIFACT',
        message: `${violations.length} real structure element(s) on this page are nested inside an /Artifact marked-content span -- invisible to assistive technology and compliance checkers despite carrying their own tag`,
        wcagCriteria: ['1.3.1'],
        location: `Page ${pageNumber}`,
        suggestion: 'Split the enclosing Artifact span so it no longer encloses the real tagged content.',
        category: 'structure',
        pageNumber,
        matterhornCheckpoint: '01-004',
        matterhornHow: 'M',
      }));
    }

    return issues;
  }

  /**
   * Third, distinct Artifact-related defect -- a top-level `/Artifact
   * BMC … EMC` span whose own boundary is simply wrong, swallowing real
   * content that was never given its own tag at all. Unlike
   * validateTaggedContentInsideArtifact (01-004), there's no nested real
   * tag here to excise; unlike validateUntaggedContent (01-005), the
   * content isn't bare -- it already sits inside SOME marked-content span,
   * just the wrong one. Confirmed live on Farrar_2E_Comp_188910.pdf: 23 of
   * 124 pages, 1,955 total swallowed text/path operations (see
   * findOversizedArtifactSpans's own doc comment for the full forensic
   * trail). Reported against 01-005 -- PAC/axesPAC itself reports this
   * shape as untagged content, since Artifact-wrapped content is invisible
   * to the structure tree exactly as if bare.
   *
   * Split into two codes, same convention as UNTAGGED-CONTENT /
   * UNTAGGED-CONTENT-COMPLEX: a page where every oversized span is
   * text-only is a real candidate for the AI-assisted boundary-splice fix
   * (ai-analysis.service.ts's analyzeArtifactSwallowsContent); a page where
   * ANY oversized span also contains real path-paint operators is reported
   * as -COMPLEX and never auto-fix-eligible -- this module's boundary
   * detection only has a text-baseline-Y signal to work with (see
   * extractArtifactTextRuns), not a geometry-based one for vector content,
   * and guessing at a path-content boundary without that signal risks
   * silently mis-splicing real graphical content.
   */
  private validateArtifactSwallowsContent(parsedPdf: ParsedPDF): AuditIssue[] {
    const issues: AuditIssue[] = [];
    let pageCount: number;
    try {
      pageCount = parsedPdf.pdfLibDoc.getPageCount();
    } catch (err) {
      logger.debug(`[PDFStructureValidator] Could not read page count for oversized-artifact check: ${err instanceof Error ? err.message : String(err)}`);
      return issues;
    }

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      let content: string | null;
      try {
        content = decodePageContent(parsedPdf.pdfLibDoc, pageNumber);
      } catch (err) {
        logger.debug(`[PDFStructureValidator] Could not decode page ${pageNumber} for oversized-artifact check: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!content) continue;

      const spans = findOversizedArtifactSpans(content);
      if (spans.length === 0) continue;

      const hasPathOps = spans.some((s) => s.hasPathOps);
      const totalOps = spans.reduce((sum, s) => sum + s.opCount, 0);

      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'serious',
        code: hasPathOps ? 'ARTIFACT-SWALLOWS-CONTENT-COMPLEX' : 'ARTIFACT-SWALLOWS-CONTENT',
        message: `${spans.length} /Artifact span(s) on this page are far larger than a legitimate decorative header/footer (${totalOps} content operation(s) total) -- likely swallowing real, never-tagged content` +
          (hasPathOps ? ', including vector graphics (needs manual review to confirm the real-content boundary)' : ''),
        wcagCriteria: ['1.3.1'],
        location: `Page ${pageNumber}`,
        suggestion: hasPathOps
          ? 'Review this page\'s oversized Artifact span(s) manually -- determine where the real content begins and give it its own structure tag.'
          : 'The real content boundary inside this Artifact span will be determined and given its own structure tag.',
        category: 'structure',
        pageNumber,
        matterhornCheckpoint: '01-005',
        matterhornHow: 'M',
      }));
    }

    return issues;
  }

  /**
   * Detects content wrapped in Adobe InDesign's own non-standard
   * `/PlacedPDF` marked-content tag -- used for vector art "placed" into
   * the layout from an external file (Illustrator logos, hand-drawn
   * elements, diagrams). Confirmed live on Farrar_2E_Comp_188910.pdf: 56 of
   * 124 pages, 77 top-level spans, and in EVERY instance the tag's own
   * properties reference (e.g. `/MC0`) resolves to `<< /Metadata ... >>` --
   * InDesign's own provenance metadata for the placed object, never an
   * `/MCID`. With no MCID, this content has no possible path into the
   * structure tree via /ParentTree -- it LOOKS tagged (a real BDC/EMC
   * wrapper exists) to any check that only verifies "is there an existing
   * tag" (which is exactly why findUntaggedPathRuns's own "any existing
   * BDC/BMC counts as already handled" design -- correct for every OTHER
   * untagged-content shape this file checks -- silently misses it), but
   * it's exactly as inaccessible as bare content. PAC correctly reports
   * every path/text object inside it as "not tagged".
   *
   * Reported against 01-005, same checkpoint as the other genuinely-
   * untagged-content shapes in this file -- PAC itself reports this shape
   * identically to bare content, since the root cause (unreachable from
   * the structure tree) is the same.
   */
  private validatePlacedPdfContent(parsedPdf: ParsedPDF): AuditIssue[] {
    const issues: AuditIssue[] = [];
    let pageCount: number;
    try {
      pageCount = parsedPdf.pdfLibDoc.getPageCount();
    } catch (err) {
      logger.debug(`[PDFStructureValidator] Could not read page count for /PlacedPDF check: ${err instanceof Error ? err.message : String(err)}`);
      return issues;
    }

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      let content: string | null;
      try {
        content = decodePageContent(parsedPdf.pdfLibDoc, pageNumber);
      } catch (err) {
        logger.debug(`[PDFStructureValidator] Could not decode page ${pageNumber} for /PlacedPDF check: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!content) continue;

      const spans = findPlacedPdfSpans(content);
      if (spans.length === 0) continue;

      issues.push(this.createIssue({
        source: 'pdf-structure',
        severity: 'serious',
        code: 'PLACEDPDF-NOT-TAGGED',
        message: `${spans.length} /PlacedPDF region(s) on this page carry no real MCID and are unreachable from the structure tree -- producer-authored placed artwork (Adobe InDesign) that was never given accessibility tagging`,
        wcagCriteria: ['1.3.1'],
        location: `Page ${pageNumber}`,
        suggestion: 'Each region will be retagged as a real /Figure structure element, wired into the document flow; alt text follows via the normal missing-alt-text review.',
        category: 'structure',
        pageNumber,
        matterhornCheckpoint: '01-005',
        matterhornHow: 'M',
      }));
    }

    return issues;
  }

  private hasPdfUaIdentifier(parsedPdf: ParsedPDF): boolean {
    try {
      const metadataRef = parsedPdf.pdfLibDoc.catalog.get(PDFName.of('Metadata'));
      if (!metadataRef) return false;
      const stream = parsedPdf.pdfLibDoc.context.lookup(metadataRef) as { contents?: Uint8Array };
      if (!stream?.contents) return false;
      const xmp = Buffer.from(stream.contents).toString('utf8');
      return xmp.includes('pdfuaid:part');
    } catch (err) {
      logger.debug(`[PDFStructureValidator] Could not read XMP for PDF/UA identifier check: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /**
   * Create an audit issue with auto-incremented ID
   *
   * @param data - Issue data without ID
   * @returns Complete audit issue
   */
  /**
   * Structure-tree reference integrity (new, added after a real live
   * incident -- Math_Olszewski_PDF.pdf's remediated output had 3 struct
   * elements silently dropped by pdf-lib's own loader, with the parent's
   * own /K array, /ParentTree's Nums entries, and a surviving child's /P
   * all left pointing at objects that no longer existed. No check anywhere
   * in this file (or anywhere else in the audit pipeline) could see that --
   * it was only caught because an external tool, PAC 2026, hard-crashed on
   * it ("Invalid kid in structure element"). This closes that blind spot.
   *
   * Deliberately scoped to the common case: /ParentTree with a direct
   * top-level /Nums array (confirmed the real shape on the actual incident
   * document). A number tree using intermediate /Kids nodes instead of a
   * flat /Nums is rare in practice for a single-document /ParentTree and is
   * skipped rather than guessed at -- same "bail rather than guess"
   * discipline as the rest of this codebase's structure-tree code.
   */
  private validateStructTreeReferenceIntegrity(parsedPdf: ParsedPDF): AuditIssue[] {
    const issues: AuditIssue[] = [];
    const doc: PDFDocument = parsedPdf.pdfLibDoc;
    const context = doc.context;

    let structTreeRoot: PDFDict | undefined;
    try {
      const catalog = doc.catalog;
      const raw = context.lookup(catalog.get(PDFName.of('StructTreeRoot')));
      if (raw instanceof PDFDict) structTreeRoot = raw;
    } catch (err) {
      logger.debug(`[PDFStructureValidator] Could not resolve /StructTreeRoot for reference-integrity check: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!structTreeRoot) return issues;

    const seen = new Set<string>();

    const describeElement = (dict: PDFDict, fallback: string): string => {
      const s = dict.get(PDFName.of('S'));
      const role = s instanceof PDFName ? s.asString().replace(/^\//, '') : 'element';
      return `${role} structure element (${fallback})`;
    };

    const walkKids = (kRaw: unknown, parentDesc: string, parentPageNumber: number | undefined): void => {
      const resolved = kRaw instanceof PDFRef ? context.lookup(kRaw) : kRaw;
      const entries = resolved instanceof PDFArray
        ? Array.from({ length: resolved.size() }, (_, i) => resolved.get(i))
        : [kRaw];

      for (let idx = 0; idx < entries.length; idx++) {
        const entry = entries[idx];
        if (!(entry instanceof PDFRef)) continue; // bare MCID integers are always leaves, nothing to resolve
        const child = context.lookup(entry);
        if (child === undefined) {
          issues.push(this.createIssue({
            source: 'pdf-structure',
            severity: 'critical',
            code: 'STRUCTURE-DANGLING-REFERENCE',
            message: `${parentDesc}'s Kids array references object ${entry.toString()} at index ${idx}, which does not exist`,
            wcagCriteria: ['1.3.1'],
            location: parentDesc,
            suggestion: 'Remove this dangling reference from the structure element\'s /K array, or restore the missing object. External conformance tools (e.g. PAC) can refuse to open a document with this defect.',
            category: 'structure',
            pageNumber: parentPageNumber ?? 1,
          }));
          continue;
        }
        if (!(child instanceof PDFDict)) continue; // MCR/OBJR leaf dicts -- not walked further

        const childTag = entry.toString();
        if (seen.has(childTag)) continue; // cycle guard
        seen.add(childTag);

        const pgRaw = child.get(PDFName.of('Pg'));
        const pg = pgRaw instanceof PDFRef ? context.lookup(pgRaw) : undefined;
        const pageNumber = pg instanceof PDFDict ? this.resolvePageNumber(doc, pgRaw as PDFRef) : parentPageNumber;

        const parentRaw = child.get(PDFName.of('P'));
        if (parentRaw instanceof PDFRef && context.lookup(parentRaw) === undefined) {
          issues.push(this.createIssue({
            source: 'pdf-structure',
            severity: 'critical',
            code: 'STRUCTURE-DANGLING-REFERENCE',
            message: `${describeElement(child, childTag)}'s /P (parent) points at object ${parentRaw.toString()}, which does not exist`,
            wcagCriteria: ['1.3.1'],
            location: describeElement(child, childTag),
            suggestion: 'This element is orphaned from the structure tree. Re-parent it to a valid ancestor or remove it.',
            category: 'structure',
            pageNumber: pageNumber ?? 1,
          }));
        }

        const childK = child.get(PDFName.of('K'));
        if (childK !== undefined) walkKids(childK, describeElement(child, childTag), pageNumber);
      }
    };

    try {
      const rootK = structTreeRoot.get(PDFName.of('K'));
      if (rootK !== undefined) walkKids(rootK, 'StructTreeRoot', undefined);
    } catch (err) {
      logger.warn(`[PDFStructureValidator] Structure-tree walk failed during reference-integrity check: ${err instanceof Error ? err.message : String(err)}`);
    }

    // /ParentTree: only the common flat-/Nums shape (see this method's own
    // doc comment for why intermediate /Kids nodes are skipped).
    try {
      const parentTreeRaw = structTreeRoot.get(PDFName.of('ParentTree'));
      const parentTree = parentTreeRaw instanceof PDFRef ? context.lookup(parentTreeRaw) : parentTreeRaw;
      if (parentTree instanceof PDFDict) {
        const numsRaw = parentTree.get(PDFName.of('Nums'));
        const nums = numsRaw instanceof PDFRef ? context.lookup(numsRaw) : numsRaw;
        if (nums instanceof PDFArray) {
          for (let i = 0; i + 1 < nums.size(); i += 2) {
            const keyObj = nums.get(i);
            const valueRaw = nums.get(i + 1);
            const value = valueRaw instanceof PDFRef ? context.lookup(valueRaw) : valueRaw;
            const perPageRefs = value instanceof PDFArray
              ? Array.from({ length: value.size() }, (_, j) => value.get(j))
              : [value];
            const structParentsKey = keyObj instanceof PDFNumber ? keyObj.asNumber() : undefined;
            const pageNumber = structParentsKey !== undefined
              ? this.resolvePageByStructParents(doc, structParentsKey)
              : undefined;

            for (const ref of perPageRefs) {
              if (ref instanceof PDFRef && context.lookup(ref) === undefined) {
                issues.push(this.createIssue({
                  source: 'pdf-structure',
                  severity: 'critical',
                  code: 'STRUCTURE-DANGLING-REFERENCE',
                  message: `/ParentTree entry (StructParents ${structParentsKey ?? '?'}) references object ${ref.toString()}, which does not exist`,
                  wcagCriteria: ['1.3.1'],
                  location: pageNumber ? `Page ${pageNumber}` : '/ParentTree',
                  suggestion: 'Content on this page is marked as belonging to a structure element that no longer exists. Remove or re-tag the corresponding marked-content sequence.',
                  category: 'structure',
                  pageNumber: pageNumber ?? 1,
                }));
              }
            }
          }
        }
      }
    } catch (err) {
      logger.warn(`[PDFStructureValidator] /ParentTree walk failed during reference-integrity check: ${err instanceof Error ? err.message : String(err)}`);
    }

    return issues;
  }

  /**
   * Content-stream operator well-formedness -- added after a real live
   * incident: Math_Olszewski_PDF.pdf had a malformed `rg` operator (wrong
   * operand count) on one page, left behind by an old, failed color-
   * contrast fix whose revert never completed. Nothing in this pipeline
   * could see it -- only PAC 2026's own strict content-stream parser
   * caught it ("'rg' operator must have 3 operand(s)"). This closes that
   * same class of blind spot.
   *
   * Deliberately narrow: not a general content-stream grammar validator
   * (that needs real string/array/dict lexing to be correct against
   * arbitrary third-party-authored operators) -- scoped instead to the
   * small, fixed set of operators THIS codebase's own remediation code
   * actually writes (pdf-contrast-writer.service.ts's spliceColorFix,
   * pdf-contrast-backplate.ts's spliceBackplate, pdf-structure-writer.
   * service.ts's element-creation helpers), since that's the real risk
   * surface the incident came from. Checks operand COUNT only, not operand
   * values -- exactly the defect shape PAC flagged and this incident
   * produced. Same tokenization approach hand-verified against the real
   * incident this session (a scratchpad investigation script), promoted
   * here into the real validator.
   */
  private validateContentStreamWellFormedness(parsedPdf: ParsedPDF): AuditIssue[] {
    const issues: AuditIssue[] = [];
    const doc = parsedPdf.pdfLibDoc;
    let pageCount: number;
    try {
      pageCount = doc.getPageCount();
    } catch (err) {
      logger.debug(`[PDFStructureValidator] Could not read page count for content-stream well-formedness check: ${err instanceof Error ? err.message : String(err)}`);
      return issues;
    }

    const numberPattern = /^[-+]?\d*\.?\d+([eE][-+]?\d+)?$/;

    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber++) {
      let content: string | null;
      try {
        content = decodePageContent(doc, pageNumber);
      } catch (err) {
        logger.debug(`[PDFStructureValidator] Could not decode page ${pageNumber} for content-stream well-formedness check: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      if (!content) continue;

      const tokens = content.split(/\s+/);
      for (let i = 0; i < tokens.length; i++) {
        const expected = CONTENT_STREAM_OPERATOR_OPERAND_COUNTS[tokens[i]];
        if (expected === undefined) continue;

        let j = i - 1;
        let actual = 0;
        while (j >= 0 && numberPattern.test(tokens[j])) {
          actual++;
          j--;
        }
        if (actual === expected) continue;

        const snippet = tokens.slice(Math.max(0, i - 6), i + 2).join(' ');
        issues.push(this.createIssue({
          source: 'pdf-structure',
          severity: 'critical',
          code: 'CONTENT-STREAM-MALFORMED-OPERATOR',
          message: `Page ${pageNumber}: '${tokens[i]}' operator has ${actual} preceding numeric operand(s), expected ${expected} -- near "...${snippet}..."`,
          wcagCriteria: ['1.3.1'],
          location: `Page ${pageNumber}`,
          suggestion: 'This content stream has a malformed operator invocation. External conformance tools (e.g. PAC) can refuse to open a document with this defect. Needs manual review and a targeted repair -- no safe automated fix exists for arbitrary malformed syntax.',
          category: 'structure',
          pageNumber,
        }));
      }
    }

    return issues;
  }

  private resolvePageNumber(doc: PDFDocument, pageRef: PDFRef): number | undefined {
    try {
      const pages = doc.getPages();
      for (let i = 0; i < pages.length; i++) {
        if (pages[i].ref.toString() === pageRef.toString()) return i + 1;
      }
    } catch {
      /* fall through */
    }
    return undefined;
  }

  private resolvePageByStructParents(doc: PDFDocument, structParents: number): number | undefined {
    try {
      const pages = doc.getPages();
      for (let i = 0; i < pages.length; i++) {
        const sp = pages[i].node.get(PDFName.of('StructParents'));
        if (sp instanceof PDFNumber && sp.asNumber() === structParents) return i + 1;
      }
    } catch {
      /* fall through */
    }
    return undefined;
  }

  private createIssue(data: Omit<AuditIssue, 'id'>): AuditIssue {
    return {
      id: uuidv4(),
      ...data,
    };
  }

  /**
   * Calculate summary counts by severity
   *
   * @param issues - Array of issues
   * @returns Summary with counts
   */
  private calculateSummary(issues: AuditIssue[]): StructureValidationResult['summary'] {
    return {
      critical: issues.filter(i => i.severity === 'critical').length,
      serious: issues.filter(i => i.severity === 'serious').length,
      moderate: issues.filter(i => i.severity === 'moderate').length,
      minor: issues.filter(i => i.severity === 'minor').length,
      total: issues.length,
    };
  }
}

export const pdfStructureValidator = new PDFStructureValidator();
