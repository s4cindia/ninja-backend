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
import { createCitationValidationService } from './citation-validation.service';

export class CitationParsingService {
  /**
   * Parse a single citation into structured components
   * Creates a new CitationComponent record
   *
   * @param citationId - ID of the citation to parse
   * @param tenantId - Optional tenant ID for cross-tenant protection
   * @returns Parsed citation result with component ID
   */
  async parseCitation(citationId: string, tenantId?: string): Promise<ParsedCitationResult> {
    logger.info(`[Citation Parsing] Parsing citationId=${citationId}`);

    // 1. Get citation with document for tenant validation
    const citation = await prisma.citation.findUnique({
      where: { id: citationId },
      include: { document: { select: { tenantId: true } } },
    });

    if (!citation) {
      throw new Error(`Citation not found: ${citationId}`);
    }

    // Enforce tenant-scoped access
    if (tenantId && citation.document.tenantId !== tenantId) {
      throw new Error(`Citation not found: ${citationId}`);
    }

    // 2. Parse using AI
    const parsed = await editorialAi.parseCitation(citation.rawText);

    // 3. Determine parse variant from detected style or default to UNKNOWN
    const parseVariant = citation.detectedStyle || 'UNKNOWN';

    // 4. Calculate overall confidence from field confidences (normalize to 0-1)
    const fieldConfidencesRaw = Object.values(parsed.confidence || {}) as number[];
    const fieldConfidences = fieldConfidencesRaw.map(c => c / 100); // Normalize to 0-1
    const avgConfidence = fieldConfidences.length > 0
      ? fieldConfidences.reduce((a, b) => a + b, 0) / fieldConfidences.length
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
        parseVariant,
        confidence: avgConfidence,
        authors: parsed.authors || [],
        year: parsed.year || null,
        title: parsed.title || null,
        source: parsed.source || null,
        volume: parsed.volume || null,
        issue: parsed.issue || null,
        pages: parsed.pages || null,
        doi: parsed.doi || null,
        url: parsed.url || null,
        publisher: null,
        edition: null,
        accessDate: null,
        sourceType: mapToSourceType(parsed.type),
        fieldConfidence: (parsed.confidence || {}) as Record<string, number>,
        doiVerified: null,
        urlValid: null,
        urlCheckedAt: null,
      },
    });

    // 7. Set as primary component
    const validationService = createCitationValidationService(prisma);
    await validationService.setPrimaryComponent(citationId, component.id);

    logger.info(`[Citation Parsing] Created component ${component.id} as primary for citation ${citationId}`);

    return this.mapComponentToResult(citationId, component, needsReview, reviewReasons);
  }

  /**
   * Parse all unparsed citations for a document
   * Skips citations that already have components
   *
   * @param documentId - ID of the editorial document
   * @param tenantId - Optional tenant ID for cross-tenant protection
   * @returns Bulk parse result with statistics
   */
  async parseAllCitations(documentId: string, tenantId?: string): Promise<BulkParseResult> {
    const startTime = Date.now();
    logger.info(`[Citation Parsing] Bulk parsing for documentId=${documentId}`);

    // Verify document exists and belongs to tenant
    const doc = await prisma.editorialDocument.findUnique({
      where: { id: documentId },
    });

    if (!doc) {
      throw new Error(`Document not found: ${documentId}`);
    }

    if (tenantId && doc.tenantId !== tenantId) {
      throw new Error(`Document not found: ${documentId}`);
    }

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
        const result = await this.parseCitation(citation.id, tenantId);
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
   * @param tenantId - Optional tenant ID for cross-tenant protection
   * @returns New parsed component
   */
  async reparseCitation(citationId: string, tenantId?: string): Promise<ParsedCitationResult> {
    logger.info(`[Citation Parsing] Re-parsing citationId=${citationId}`);
    return this.parseCitation(citationId, tenantId);
  }

  /**
   * Get all parsed components for a citation (version history)
   *
   * @param citationId - ID of the citation
   * @returns Array of parsed components, newest first
   */
  async getCitationComponents(citationId: string, tenantId?: string): Promise<ParsedCitationResult[]> {
    // Verify citation exists and belongs to tenant
    const citation = await prisma.citation.findUnique({
      where: { id: citationId },
      include: { document: { select: { tenantId: true } } },
    });

    if (!citation) {
      throw new Error(`Citation not found: ${citationId}`);
    }

    if (tenantId && citation.document.tenantId !== tenantId) {
      throw new Error(`Citation not found: ${citationId}`);
    }

    const components = await prisma.citationComponent.findMany({
      where: { citationId },
      orderBy: { createdAt: 'desc' },
    });

    return components.map(c => {
      // Recompute review state for each component using actual sourceType and per-field confidences
      const fieldConfidenceRecord = (c.fieldConfidence || {}) as Record<string, number>;
      const fieldConfidences = Object.values(fieldConfidenceRecord).map(v => 
        typeof v === 'number' ? (v > 1 ? v / 100 : v) : 0
      );
      const { needsReview, reviewReasons } = this.evaluateReviewNeeded(
        c.confidence,
        {
          authors: c.authors as string[],
          year: c.year,
          title: c.title,
          type: c.sourceType,
          doi: c.doi,
          url: c.url,
        },
        fieldConfidences.length > 0 ? fieldConfidences : [c.confidence]
      );
      return this.mapComponentToResult(citationId, c, needsReview, reviewReasons);
    });
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

    return this.mapComponentToResult(citationId, component, false, []);
  }

  /**
   * Get citation with its latest component
   *
   * @param citationId - ID of the citation
   * @param tenantId - Optional tenant ID for cross-tenant protection
   * @returns Citation with latest component and component count
   */
  async getCitationWithComponent(citationId: string, tenantId?: string): Promise<CitationWithComponent | null> {
    const citation = await prisma.citation.findUnique({
      where: { id: citationId },
      include: {
        document: { select: { tenantId: true } },
        components: {
          orderBy: { createdAt: 'desc' },
        },
      },
    });

    if (!citation) return null;

    // Enforce tenant-scoped access
    if (tenantId && citation.document.tenantId !== tenantId) {
      return null;
    }

    const latestComponent = citation.components[0]
      ? this.mapComponentToResult(citationId, citation.components[0], false, [])
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
      needsReview: latestComponent?.needsReview ?? false,
    };
  }

  /**
   * Get all citations with components for a document
   *
   * @param documentId - ID of the editorial document
   * @param tenantId - Optional tenant ID for cross-tenant protection
   * @returns Array of citations with their latest components
   */
  async getCitationsWithComponents(documentId: string, tenantId?: string): Promise<CitationWithComponent[]> {
    // Verify document exists and belongs to tenant
    const doc = await prisma.editorialDocument.findUnique({
      where: { id: documentId },
    });

    if (!doc) {
      throw new Error(`Document not found: ${documentId}`);
    }

    if (tenantId && doc.tenantId !== tenantId) {
      throw new Error(`Document not found: ${documentId}`);
    }

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
        ? this.mapComponentToResult(citation.id, citation.components[0], false, [])
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

    if (avgConfidence < 0.7) {
      reviewReasons.push(REVIEW_REASONS.LOW_OVERALL_CONFIDENCE);
    }

    if (fieldConfidences.some(c => c < 0.5)) {
      reviewReasons.push(REVIEW_REASONS.LOW_FIELD_CONFIDENCE);
    }

    if (!parsed.authors || parsed.authors.length === 0) {
      reviewReasons.push(REVIEW_REASONS.MISSING_AUTHORS);
    }

    if (!parsed.year) {
      reviewReasons.push(REVIEW_REASONS.MISSING_YEAR);
    }

    if (!parsed.title) {
      reviewReasons.push(REVIEW_REASONS.MISSING_TITLE);
    }

    if (!parsed.type || parsed.type.toLowerCase() === 'unknown') {
      reviewReasons.push(REVIEW_REASONS.AMBIGUOUS_TYPE);
    }

    if (parsed.doi && !this.isValidDoiFormat(parsed.doi)) {
      reviewReasons.push(REVIEW_REASONS.INVALID_DOI);
    }

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
      createdAt: Date;
    },
    needsReview: boolean = false,
    reviewReasons: string[] = []
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
      needsReview,
      reviewReasons,
      createdAt: component.createdAt,
    };
  }
}

// Export singleton instance
export const citationParsingService = new CitationParsingService();
