import { editorialAi, documentParser } from '../shared';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { EditorialDocStatus } from '@prisma/client';
import { s3Service } from '../s3.service';
import { AppError } from '../../utils/app-error';
import { config } from '../../config';
import {
  DetectedCitation,
  StylesheetAnalysisResult,
  SequenceAnalysis,
  CrossReferenceAnalysis,
  ReferenceListSummaryEntry,
  mapToCitationType,
  mapToCitationStyle,
  mapToSectionContext,
} from './citation.types';
// styleRulesService reserved for future use

const STYLE_CODE_MAP: Record<string, { code: string; name: string }> = {
  'numeric-bracket': { code: 'vancouver', name: 'Vancouver' },
  'author-date': { code: 'apa7', name: 'APA 7th Edition' },
  'mixed': { code: 'apa7', name: 'APA 7th Edition (mixed)' },
  'unknown': { code: 'unknown', name: 'Unknown' },
  'numeric-superscript': { code: 'vancouver', name: 'Vancouver (superscript)' },
};

const AVAILABLE_CONVERSIONS = [
  { code: 'apa7', name: 'APA 7th Edition' },
  { code: 'mla9', name: 'MLA 9th Edition' },
  { code: 'chicago17', name: 'Chicago 17th Edition' },
  { code: 'vancouver', name: 'Vancouver' },
  { code: 'ieee', name: 'IEEE' },
];

// Allowlisted S3 hostname patterns (AWS S3 and compatible services)
const ALLOWED_S3_HOSTNAME_PATTERNS = [
  /^[a-z0-9-]+\.s3\.[a-z0-9-]+\.amazonaws\.com$/i,  // bucket.s3.region.amazonaws.com
  /^s3\.[a-z0-9-]+\.amazonaws\.com$/i,               // s3.region.amazonaws.com
  /^[a-z0-9-]+\.s3\.amazonaws\.com$/i,               // bucket.s3.amazonaws.com (legacy)
  /^s3\.amazonaws\.com$/i,                            // s3.amazonaws.com (legacy)
];

// Private/loopback IP ranges to block (SSRF prevention)
const PRIVATE_IP_PATTERNS = [
  /^127\./,                    // Loopback
  /^10\./,                     // Class A private
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,  // Class B private
  /^192\.168\./,               // Class C private
  /^169\.254\./,               // Link-local (AWS metadata endpoint)
  /^0\./,                      // Current network
  /^::1$/,                     // IPv6 loopback
  /^fc00:/i,                   // IPv6 unique local
  /^fe80:/i,                   // IPv6 link-local
  /^fd[0-9a-f]{2}:/i,          // IPv6 unique local
];

export class CitationStylesheetDetectionService {

  /**
   * Validate a presigned URL to prevent SSRF attacks.
   * - Enforces HTTPS protocol
   * - Allowlists S3 hostnames
   * - Rejects private/loopback IPs
   * @throws AppError if URL is invalid or potentially malicious
   */
  private validatePresignedUrl(presignedUrl: string): void {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(presignedUrl);
    } catch {
      throw AppError.badRequest('Invalid URL format', 'INVALID_URL');
    }

    // Enforce HTTPS protocol
    if (parsedUrl.protocol !== 'https:') {
      logger.warn(`[SSRF Prevention] Blocked non-HTTPS URL: ${parsedUrl.protocol}`);
      throw AppError.badRequest('Only HTTPS URLs are allowed', 'HTTPS_REQUIRED');
    }

    const hostname = parsedUrl.hostname.toLowerCase();

    // Check for private/loopback IPs (including when hostname is an IP)
    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(hostname)) {
        logger.warn(`[SSRF Prevention] Blocked private/loopback IP: ${hostname}`);
        throw AppError.badRequest('Access to private network addresses is not allowed', 'PRIVATE_IP_BLOCKED');
      }
    }

    // Block localhost variants
    if (hostname === 'localhost' || hostname === 'localhost.localdomain') {
      logger.warn(`[SSRF Prevention] Blocked localhost: ${hostname}`);
      throw AppError.badRequest('Access to localhost is not allowed', 'LOCALHOST_BLOCKED');
    }

    // Check against allowlisted S3 hostname patterns
    let isAllowed = false;

    for (const pattern of ALLOWED_S3_HOSTNAME_PATTERNS) {
      if (pattern.test(hostname)) {
        isAllowed = true;
        break;
      }
    }

    // Also allow the configured S3 bucket hostname
    if (!isAllowed && config.s3Bucket && config.s3Region) {
      const expectedHostnames = [
        `${config.s3Bucket}.s3.${config.s3Region}.amazonaws.com`,
        `${config.s3Bucket}.s3.amazonaws.com`,
        `s3.${config.s3Region}.amazonaws.com`,
      ];
      if (expectedHostnames.some(h => h.toLowerCase() === hostname)) {
        isAllowed = true;
      }
    }

    if (!isAllowed) {
      logger.warn(`[SSRF Prevention] Blocked non-S3 hostname: ${hostname}`);
      throw AppError.badRequest('URL must point to an allowed S3 endpoint', 'INVALID_S3_HOST');
    }

    logger.debug(`[SSRF Prevention] URL validated: ${hostname}`);
  }

  async analyzeFromBuffer(
    tenantId: string,
    userId: string,
    fileBuffer: Buffer,
    fileName: string
  ): Promise<StylesheetAnalysisResult> {
    const startTime = Date.now();

    logger.info(`[Stylesheet Detection] Starting for file=${fileName}, size=${fileBuffer.length}`);

    const job = await prisma.job.create({
      data: {
        tenantId,
        userId,
        type: 'CITATION_DETECTION',
        status: 'PROCESSING',
        input: { fileName, fileSize: fileBuffer.length },
      },
    });
    const jobId = job.id;

    try {
      const parsed = await documentParser.parse(fileBuffer, fileName);
      logger.info(`[Stylesheet Detection] Parsed: ${parsed.metadata.wordCount} words, ${parsed.chunks.length} chunks`);

      const editorialDoc = await this.createEditorialDocument(jobId, tenantId, fileName, fileBuffer.length, parsed);

      const result = await this.runFullAnalysis(editorialDoc.id, jobId, tenantId, parsed.text, startTime, fileName);

      await prisma.editorialDocument.update({
        where: { id: editorialDoc.id },
        data: { status: EditorialDocStatus.PARSED },
      });

      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          output: { documentId: editorialDoc.id },
        },
      });

      logger.info(`[Stylesheet Detection] Completed in ${result.processingTimeMs}ms`);
      return result;
    } catch (error) {
      // Transition job to FAILED to prevent stuck PROCESSING state
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Stylesheet Detection] Failed for jobId=${jobId}: ${errorMessage}`, error instanceof Error ? error : undefined);

      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          error: errorMessage,
        },
      }).catch(updateError => {
        // Log but don't throw - we want to re-throw the original error
        logger.error(`[Stylesheet Detection] Failed to update job status: ${updateError}`);
      });

      throw error;
    }
  }

  async analyzeFromS3(
    tenantId: string,
    userId: string,
    fileS3Key: string | undefined,
    presignedUrl: string | undefined,
    fileName: string,
    fileSize?: number
  ): Promise<StylesheetAnalysisResult> {
    const startTime = Date.now();

    const job = await prisma.job.create({
      data: {
        tenantId,
        userId,
        type: 'CITATION_DETECTION',
        status: 'PROCESSING',
        input: { fileS3Key, presignedUrl, fileName, fileSize, mode: 's3' },
        startedAt: new Date(),
      },
    });
    const jobId = job.id;

    try {
      let fileBuffer: Buffer;
      if (fileS3Key) {
        fileBuffer = await s3Service.getFileBuffer(fileS3Key);
      } else if (presignedUrl) {
        // SSRF Prevention: Validate URL before fetching
        this.validatePresignedUrl(presignedUrl);

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 10000);
        try {
          const response = await fetch(presignedUrl, { signal: controller.signal });
          if (!response.ok) throw AppError.badRequest(`Failed to fetch: ${response.status}`, 'FETCH_FAILED');
          fileBuffer = Buffer.from(await response.arrayBuffer());
        } finally {
          clearTimeout(timeoutId);
        }
      } else {
        throw AppError.badRequest('Either fileS3Key or presignedUrl is required', 'MISSING_FILE_INPUT');
      }

      const parsed = await documentParser.parse(fileBuffer, fileName);
      const editorialDoc = await this.createEditorialDocument(jobId, tenantId, fileName, fileBuffer.length, parsed);

      const result = await this.runFullAnalysis(editorialDoc.id, jobId, tenantId, parsed.text, startTime, fileName);

      await prisma.editorialDocument.update({
        where: { id: editorialDoc.id },
        data: { status: EditorialDocStatus.PARSED },
      });

      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          output: { documentId: editorialDoc.id },
        },
      });

      return result;
    } catch (error) {
      // Transition job to FAILED to prevent stuck PROCESSING state
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Stylesheet Detection] S3 analysis failed for jobId=${jobId}: ${errorMessage}`, error instanceof Error ? error : undefined);

      await prisma.job.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          completedAt: new Date(),
          error: errorMessage,
        },
      }).catch(updateError => {
        // Log but don't throw - we want to re-throw the original error
        logger.error(`[Stylesheet Detection] Failed to update job status: ${updateError}`);
      });

      throw error;
    }
  }

  async getAnalysisResults(documentId: string, tenantId: string): Promise<StylesheetAnalysisResult | null> {
    const doc = await prisma.editorialDocument.findFirst({
      where: { id: documentId, tenantId },
      include: {
        citations: {
          orderBy: { startOffset: 'asc' },
          include: { primaryComponent: { select: { confidence: true } } },
        },
        documentContent: true,
      },
    });

    if (!doc || !doc.documentContent?.fullText) return null;

    // Use original processing time from document timestamps when available
    const originalProcessingTime = doc.parsedAt && doc.createdAt
      ? doc.parsedAt.getTime() - doc.createdAt.getTime()
      : undefined;

    return this.runFullAnalysis(documentId, doc.jobId, tenantId, doc.documentContent.fullText, Date.now(), doc.originalName || doc.fileName, doc.citations, originalProcessingTime);
  }

  async getAnalysisByJobId(jobId: string, tenantId: string): Promise<StylesheetAnalysisResult | null> {
    const job = await prisma.job.findFirst({
      where: { id: jobId, tenantId },
    });
    if (!job) return null;

    const output = job.output as { documentId?: string } | null;
    const documentId = output?.documentId;
    if (!documentId) return null;

    return this.getAnalysisResults(documentId, tenantId);
  }

  private async runFullAnalysis(
    documentId: string,
    jobId: string,
    _tenantId: string,
    fullText: string,
    startTime: number,
    fileName?: string,
    existingCitations?: Array<{
      id: string;
      rawText: string;
      citationType: string;
      detectedStyle: string | null;
      confidence: number;
      pageNumber: number | null;
      paragraphIndex: number | null;
      startOffset: number;
      endOffset: number;
      sectionContext: string;
      primaryComponentId: string | null;
      primaryComponent: { confidence: number } | null;
    }>,
    originalProcessingTime?: number
  ): Promise<StylesheetAnalysisResult> {

    const styleInfo = await editorialAi.detectCitationStyleFromText(fullText);

    let inferredStyle = styleInfo.style;
    let confidence = 0;
    const evidence: string[] = [];

    if (existingCitations && existingCitations.length > 0 && inferredStyle === 'unknown') {
      const numericCount = existingCitations.filter(c => c.citationType === 'NUMERIC').length;
      const authorDateCount = existingCitations.filter(c =>
        c.citationType === 'PARENTHETICAL' || c.citationType === 'NARRATIVE'
      ).length;

      if (numericCount >= 3 && authorDateCount <= 2) {
        inferredStyle = 'numeric-bracket';
        confidence = Math.min(0.90, 0.5 + numericCount * 0.03);
        evidence.push(`Found ${numericCount} numeric citations from prior analysis`);
      } else if (authorDateCount >= 3) {
        inferredStyle = 'author-date';
        confidence = Math.min(0.85, 0.5 + authorDateCount * 0.03);
        evidence.push(`Found ${authorDateCount} author-date citations from prior analysis`);
      }

      if (styleInfo.hasReferenceSection) {
        evidence.push('Document contains a reference list section');
        confidence = Math.min(0.95, confidence + 0.1);
      }
    }

    if (evidence.length === 0) {
      const numericCount = styleInfo.numericCount || 0;
      const authorDateCount = styleInfo.authorDateCount || 0;
      if (inferredStyle === 'numeric-bracket') {
        confidence = Math.min(0.95, 0.5 + numericCount * 0.03);
        evidence.push(`Found ${numericCount} numeric bracket citations [N]`);
        if (styleInfo.hasReferenceSection) {
          evidence.push('Document contains a numbered reference list');
          confidence = Math.min(0.98, confidence + 0.1);
        }
      } else if (inferredStyle === 'author-date') {
        confidence = Math.min(0.90, 0.5 + authorDateCount * 0.03);
        evidence.push(`Found ${authorDateCount} author-date citations (Author, Year)`);
        if (styleInfo.hasReferenceSection) evidence.push('Document contains an alphabetical reference list');
      } else if (inferredStyle === 'mixed') {
        confidence = 0.5;
        evidence.push(`Found ${numericCount} numeric and ${authorDateCount} author-date citations`);
        evidence.push('Document uses mixed citation styles');
      } else {
        confidence = 0.2;
        evidence.push('No clear citation pattern detected');
      }
    }

    const currentStyleMapping = STYLE_CODE_MAP[inferredStyle] || STYLE_CODE_MAP['unknown'];
    const refStyleInfo = this.detectReferenceListStyle(fullText);
    if (refStyleInfo.styleCode && refStyleInfo.styleCode !== currentStyleMapping.code) {
      evidence.push(`Reference list format suggests ${refStyleInfo.styleName}`);
    }
    const finalStyleCode = refStyleInfo.styleCode || currentStyleMapping.code;
    const finalStyleName = refStyleInfo.styleName || currentStyleMapping.name;
    if (refStyleInfo.confidence > confidence) {
      confidence = refStyleInfo.confidence;
    }

    let citations: DetectedCitation[];
    if (existingCitations && existingCitations.length > 0) {
      citations = existingCitations.map(c => ({
        id: c.id,
        rawText: c.rawText,
        citationType: c.citationType as DetectedCitation['citationType'],
        detectedStyle: c.detectedStyle as DetectedCitation['detectedStyle'],
        pageNumber: c.pageNumber,
        paragraphIndex: c.paragraphIndex,
        startOffset: c.startOffset,
        endOffset: c.endOffset,
        confidence: c.confidence,
        sectionContext: (c.sectionContext || 'BODY') as DetectedCitation['sectionContext'],
        primaryComponentId: c.primaryComponentId,
        isParsed: !!c.primaryComponentId,
        parseConfidence: c.primaryComponent?.confidence ?? null,
      }));
    } else {
      const extractedCitations = await editorialAi.detectCitations(fullText);
      const storeResult = await this.storeCitations(documentId, extractedCitations);
      citations = storeResult.citations;
      // Note: storeResult.failures contains any citations that failed to store
    }

    const bodyCitations = citations.filter(c =>
      c.sectionContext !== 'REFERENCES' && c.citationType !== 'REFERENCE'
    );
    const refCitations = citations.filter(c =>
      c.sectionContext === 'REFERENCES' || c.citationType === 'REFERENCE'
    );

    let referenceEntries: Array<{ number: number | null; text: string; citationIds?: string[] }> = this.extractReferenceEntries(fullText);
    logger.info(`[Citation Analysis] bodyCitations=${bodyCitations.length}, refCitations=${refCitations.length}, extractedReferenceEntries=${referenceEntries.length}`);

    if (referenceEntries.length === 0) {
      const dbEntries = await prisma.referenceListEntry.findMany({
        where: { documentId },
        orderBy: { sortKey: 'asc' },
        select: { sortKey: true, title: true, formattedApa: true, citationLinks: { select: { citationId: true } } },
      });
      if (dbEntries.length > 0) {
        referenceEntries = dbEntries.map((e, idx) => {
          const numMatch = e.sortKey.match(/^(\d+)/);
          return {
            number: numMatch ? parseInt(numMatch[1], 10) : idx + 1,
            text: e.formattedApa || e.title || e.sortKey,
            citationIds: e.citationLinks.map(link => link.citationId),
          };
        });
      }
    }

    const sequenceAnalysis = this.analyzeSequence(bodyCitations);
    const crossReference = this.analyzeCrossReferences(bodyCitations, referenceEntries);

    const unmatchedRefIndices = new Set(
      crossReference.referencesWithoutCitation.map((r: { entryIndex: number }) => r.entryIndex)
    );
    const refListSummary: ReferenceListSummaryEntry[] = referenceEntries.map((entry, index) => {
      const hasMatch = !unmatchedRefIndices.has(index);
      return {
        index,
        number: entry.number,
        text: entry.text,
        matchedCitationIds: [],
        hasMatch,
      };
    });

    const conversionOptions = AVAILABLE_CONVERSIONS
      .filter(opt => opt.code !== finalStyleCode)
      .map(opt => opt.code);

    return {
      documentId,
      jobId,
      filename: fileName,
      processingTimeMs: originalProcessingTime ?? (Date.now() - startTime),
      detectedStyle: {
        styleCode: finalStyleCode,
        styleName: finalStyleName,
        confidence,
        citationFormat: this.deriveCitationFormat(finalStyleCode, inferredStyle),
        evidence,
      },
      sequenceAnalysis,
      crossReference,
      referenceList: {
        totalEntries: referenceEntries.length,
        entries: refListSummary,
      },
      citations: {
        totalCount: citations.length,
        inBody: bodyCitations.length,
        inReferences: refCitations.length,
        items: citations,
      },
      conversionOptions,
    };
  }

  private analyzeSequence(bodyCitations: DetectedCitation[]): SequenceAnalysis {
    const numbers: number[] = [];
    for (const cit of bodyCitations) {
      const nums = this.extractAllCitationNumbers(cit.rawText);
      numbers.push(...nums);
    }

    if (numbers.length === 0) {
      return {
        isSequential: true,
        totalNumbers: 0,
        expectedRange: null,
        missingNumbers: [],
        duplicateNumbers: [],
        outOfOrderNumbers: [],
        gaps: [],
        summary: 'No numeric citations found to analyze sequence.',
      };
    }

    const uniqueNumbers = [...new Set(numbers)].sort((a, b) => a - b);
    const min = uniqueNumbers[0];
    const max = uniqueNumbers[uniqueNumbers.length - 1];

    const missing: number[] = [];
    for (let i = min; i <= max; i++) {
      if (!uniqueNumbers.includes(i)) {
        missing.push(i);
      }
    }

    const countMap = new Map<number, number>();
    for (const n of numbers) {
      countMap.set(n, (countMap.get(n) || 0) + 1);
    }
    const duplicates = [...countMap.entries()]
      .filter(([, count]) => count > 1)
      .map(([num]) => num);

    const firstOccurrenceOrder: number[] = [];
    const seen = new Set<number>();
    for (const cit of bodyCitations) {
      const nums = this.extractAllCitationNumbers(cit.rawText);
      for (const n of nums) {
        if (!seen.has(n)) {
          seen.add(n);
          firstOccurrenceOrder.push(n);
        }
      }
    }

    const outOfOrder: number[] = [];
    let lastSeen = 0;
    for (const n of firstOccurrenceOrder) {
      if (n < lastSeen) {
        outOfOrder.push(n);
      } else {
        lastSeen = n;
      }
    }

    const gaps: Array<{ after: number; before: number }> = [];
    for (let i = 0; i < uniqueNumbers.length - 1; i++) {
      const diff = uniqueNumbers[i + 1] - uniqueNumbers[i];
      if (diff > 1) {
        gaps.push({ after: uniqueNumbers[i], before: uniqueNumbers[i + 1] });
      }
    }

    const isSequential = missing.length === 0 && outOfOrder.length === 0;

    const summaryParts: string[] = [];
    if (isSequential) {
      summaryParts.push(`Citations [${min}]-[${max}] are in correct sequential order.`);
    } else {
      if (missing.length > 0) {
        summaryParts.push(`Missing citation numbers: [${missing.join('], [')}].`);
      }
      if (outOfOrder.length > 0) {
        summaryParts.push(`Citations out of order: [${outOfOrder.join('], [')}].`);
      }
      if (gaps.length > 0) {
        const gapDescs = gaps.map(g => `[${g.after}] to [${g.before}]`);
        summaryParts.push(`Gaps in sequence: ${gapDescs.join(', ')}.`);
      }
    }
    if (duplicates.length > 0) {
      summaryParts.push(`Reused citation numbers (normal): [${duplicates.join('], [')}].`);
    }

    return {
      isSequential,
      totalNumbers: uniqueNumbers.length,
      expectedRange: { start: min, end: max },
      missingNumbers: missing,
      duplicateNumbers: duplicates,
      outOfOrderNumbers: outOfOrder,
      gaps,
      summary: summaryParts.join(' '),
    };
  }

  private analyzeCrossReferences(
    bodyCitations: DetectedCitation[],
    referenceEntries: Array<{ number: number | null; text: string; citationIds?: string[] }>
  ): CrossReferenceAnalysis {
    const entriesWithLinks = referenceEntries.filter(e => e.citationIds && e.citationIds.length > 0);
    if (entriesWithLinks.length > 0) {
      const allLinkedIds = new Set(entriesWithLinks.flatMap(e => e.citationIds || []));
      const ratio = allLinkedIds.size / entriesWithLinks.length;
      if (ratio > 0.1) {
        return this.crossRefByCitationIds(bodyCitations, referenceEntries);
      }
    }

    const bodyNumbers = new Set<number>();
    for (const cit of bodyCitations) {
      const nums = this.extractAllCitationNumbers(cit.rawText);
      nums.forEach(n => bodyNumbers.add(n));
    }

    const refNumbers = new Set<number>();
    for (const entry of referenceEntries) {
      if (entry.number !== null) {
        refNumbers.add(entry.number);
      }
    }

    const citationsWithoutRef: Array<{ number: number | null; text: string; citationId: string }> = [];
    const matchedSet = new Set<number>();

    for (const cit of bodyCitations) {
      const nums = this.extractAllCitationNumbers(cit.rawText);
      if (nums.length === 0) continue;
      for (const n of nums) {
        if (refNumbers.has(n)) {
          matchedSet.add(n);
        } else {
          citationsWithoutRef.push({ number: n, text: cit.rawText, citationId: cit.id });
        }
      }
    }

    const refsWithoutCit: Array<{ number: number | null; text: string; entryIndex: number }> = [];
    referenceEntries.forEach((entry, index) => {
      if (entry.number !== null && !bodyNumbers.has(entry.number)) {
        refsWithoutCit.push({ number: entry.number, text: entry.text.slice(0, 120), entryIndex: index });
      }
    });

    const deduped = new Map<number, { number: number | null; text: string; citationId: string }>();
    for (const item of citationsWithoutRef) {
      if (item.number !== null && !deduped.has(item.number)) {
        deduped.set(item.number, item);
      }
    }

    const summaryParts: string[] = [];
    const matched = matchedSet.size;
    summaryParts.push(`${matched} citation(s) matched to reference entries.`);
    if (deduped.size > 0) {
      summaryParts.push(`${deduped.size} citation(s) have no matching reference entry.`);
    }
    if (refsWithoutCit.length > 0) {
      summaryParts.push(`${refsWithoutCit.length} reference(s) are not cited in the body.`);
    }
    if (deduped.size === 0 && refsWithoutCit.length === 0) {
      summaryParts.push('All citations and references are properly cross-referenced.');
    }

    return {
      totalBodyCitations: bodyNumbers.size,
      totalReferenceEntries: referenceEntries.length,
      matched,
      citationsWithoutReference: [...deduped.values()],
      referencesWithoutCitation: refsWithoutCit,
      summary: summaryParts.join(' '),
    };
  }

  private crossRefByCitationIds(
    bodyCitations: DetectedCitation[],
    referenceEntries: Array<{ number: number | null; text: string; citationIds?: string[] }>
  ): CrossReferenceAnalysis {
    const bodyIds = new Set(bodyCitations.map(c => c.id));
    const linkedCitationIds = new Set<string>();

    for (const entry of referenceEntries) {
      for (const cid of entry.citationIds || []) {
        if (bodyIds.has(cid)) {
          linkedCitationIds.add(cid);
        }
      }
    }

    const citationsWithoutRef = bodyCitations
      .filter(c => !linkedCitationIds.has(c.id))
      .map(c => {
        const num = this.extractCitationNumber(c.rawText);
        return { number: num, text: c.rawText, citationId: c.id };
      });

    const refsWithoutCit: Array<{ number: number | null; text: string; entryIndex: number }> = [];
    referenceEntries.forEach((entry, index) => {
      const hasCitedLink = (entry.citationIds || []).some(cid => bodyIds.has(cid));
      if (!hasCitedLink) {
        refsWithoutCit.push({ number: entry.number, text: entry.text.slice(0, 120), entryIndex: index });
      }
    });

    const matched = linkedCitationIds.size;
    const summaryParts: string[] = [];
    summaryParts.push(`${matched} citation(s) matched to reference entries.`);
    if (citationsWithoutRef.length > 0) {
      summaryParts.push(`${citationsWithoutRef.length} citation(s) have no matching reference entry.`);
    }
    if (refsWithoutCit.length > 0) {
      summaryParts.push(`${refsWithoutCit.length} reference(s) are not cited in the body.`);
    }
    if (citationsWithoutRef.length === 0 && refsWithoutCit.length === 0) {
      summaryParts.push('All citations and references are properly cross-referenced.');
    }

    return {
      totalBodyCitations: bodyCitations.length,
      totalReferenceEntries: referenceEntries.length,
      matched,
      citationsWithoutReference: citationsWithoutRef,
      referencesWithoutCitation: refsWithoutCit,
      summary: summaryParts.join(' '),
    };
  }

  private extractReferenceEntries(fullText: string): Array<{ number: number | null; text: string }> {
    const refSectionMatch = fullText.match(
      /(?:^|\n)\s*(References|Bibliography|Works\s+Cited|Literature\s+Cited)\s*\n([\s\S]*?)(?:\n\s*(?:Appendix|Acknowledgments?|About\s+the\s+Author|Notes)\s*\n|$)/i
    );

    if (!refSectionMatch) {
      const lastRefMatch = fullText.match(
        /(?:^|\n)\s*(References|Bibliography|Works\s+Cited|Literature\s+Cited)\s*\n([\s\S]*)$/i
      );
      if (!lastRefMatch) return [];
      return this.parseReferenceText(lastRefMatch[2]);
    }

    return this.parseReferenceText(refSectionMatch[2]);
  }

  private parseReferenceText(refText: string): Array<{ number: number | null; text: string }> {
    const entries: Array<{ number: number | null; text: string }> = [];

    const numberedPattern = /(?:^|\n)\s*(\d{1,4})[.\)]\s+(.+?)(?=\n\s*\d{1,4}[.\)]\s|\n\s*\n|$)/gs;
    let match: RegExpExecArray | null;
    const numberedEntries: Array<{ number: number; text: string }> = [];

    while ((match = numberedPattern.exec(refText)) !== null) {
      const num = parseInt(match[1], 10);
      const text = match[2].trim().replace(/\n\s+/g, ' ');
      if (text.length > 10) {
        numberedEntries.push({ number: num, text });
      }
    }

    if (numberedEntries.length >= 3) {
      return numberedEntries;
    }

    const lines = refText.split(/\n{2,}|\n(?=[A-Z])/);
    let seqNumber = 1;
    for (const line of lines) {
      const trimmed = line.trim().replace(/\n\s+/g, ' ');
      if (trimmed.length > 15) {
        const numMatch = trimmed.match(/^(\d{1,4})[.\)]\s+/);
        entries.push({
          number: numMatch ? parseInt(numMatch[1], 10) : seqNumber,
          text: trimmed,
        });
        seqNumber++;
      }
    }

    return entries;
  }

  private extractCitationNumber(text: string): number | null {
    const bracketMatch = text.match(/\[(\d{1,4})\]/);
    if (bracketMatch) return parseInt(bracketMatch[1], 10);
    const parenMatch = text.match(/\((\d{1,4})\)/);
    if (parenMatch) return parseInt(parenMatch[1], 10);
    const plainMatch = text.trim().match(/^(\d{1,4})$/);
    if (plainMatch) return parseInt(plainMatch[1], 10);
    return null;
  }

  private extractAllCitationNumbers(text: string): number[] {
    const numbers: number[] = [];

    let inner: string;
    const bracketMatch = text.match(/\[(\d{1,3}(?:\s*[-–,]\s*\d{1,3})*)\]/);
    if (bracketMatch) {
      inner = bracketMatch[1];
    } else {
      const parenMatch = text.match(/\((\d{1,3}(?:\s*[-–,]\s*\d{1,3})*)\)/);
      if (parenMatch) {
        inner = parenMatch[1];
      } else {
        const plainMatch = text.trim().match(/^(\d{1,3}(?:\s*[-–,]\s*\d{1,3})*)$/);
        if (!plainMatch) return numbers;
        inner = plainMatch[1];
      }
    }

    if (inner.includes('-') || inner.includes('–')) {
      const rangeParts = inner.split(/\s*[-–]\s*/);
      if (rangeParts.length === 2) {
        const start = parseInt(rangeParts[0], 10);
        const end = parseInt(rangeParts[1], 10);
        if (!isNaN(start) && !isNaN(end) && end >= start && end - start < 50) {
          for (let i = start; i <= end; i++) numbers.push(i);
          return numbers;
        }
      }
    }

    const parts = inner.split(/\s*,\s*/);
    for (const p of parts) {
      const num = parseInt(p.trim(), 10);
      if (!isNaN(num)) numbers.push(num);
    }

    return numbers;
  }

  private detectReferenceListStyle(fullText: string): { styleCode: string; styleName: string; confidence: number } {
    const refSectionMatch = fullText.match(
      /(?:^|\n)\s*(?:References|Bibliography|Works\s+Cited|Literature\s+Cited)\s*\n([\s\S]{200,2000})/im
    );
    if (!refSectionMatch) return { styleCode: '', styleName: '', confidence: 0 };

    const sample = refSectionMatch[1];

    const numberedRefs = (sample.match(/(?:^|\n)\s*\d{1,4}[.\)]\s+/g) || []).length;
    if (numberedRefs >= 3) {
      const hasMedlineFormat = /[A-Z][a-z]+\s+[A-Z]{1,3}[,;]/.test(sample);
      if (hasMedlineFormat) {
        return { styleCode: 'vancouver', styleName: 'Vancouver', confidence: 0.85 };
      }
      return { styleCode: 'ieee', styleName: 'IEEE', confidence: 0.70 };
    }

    const apaPattern = /[A-Z][a-z]+,\s*[A-Z]\.\s*(?:[A-Z]\.\s*)?\((?:19|20)\d{2}[a-z]?\)/;
    if (apaPattern.test(sample)) {
      return { styleCode: 'apa7', styleName: 'APA 7th Edition', confidence: 0.85 };
    }

    const mlaPattern = /[A-Z][a-z]+,\s*[A-Z][a-z]+\.\s*"[^"]+"/;
    if (mlaPattern.test(sample)) {
      return { styleCode: 'mla9', styleName: 'MLA 9th Edition', confidence: 0.80 };
    }

    const chicagoPattern = /[A-Z][a-z]+,\s*[A-Z][a-z]+\.\s*(?:19|20)\d{2}\.\s*"/;
    if (chicagoPattern.test(sample)) {
      return { styleCode: 'chicago17', styleName: 'Chicago 17th Edition', confidence: 0.75 };
    }

    return { styleCode: '', styleName: '', confidence: 0 };
  }

  /**
   * Derive citation format from resolved style code or inferred style
   */
  private deriveCitationFormat(finalStyleCode: string, inferredStyle: string): string {
    // Numeric styles
    const numericStyles = ['vancouver', 'ieee', 'ama', 'nlm'];
    if (numericStyles.some(s => finalStyleCode.toLowerCase().includes(s))) {
      return 'numeric-bracket';
    }

    // Author-date styles
    const authorDateStyles = ['apa', 'harvard', 'chicago', 'mla'];
    if (authorDateStyles.some(s => finalStyleCode.toLowerCase().includes(s))) {
      return 'author-date';
    }

    // Fall back to inferred style with mapping
    if (inferredStyle === 'numeric-superscript') {
      return 'numeric-bracket';
    }

    return inferredStyle || 'unknown';
  }

  private async storeCitations(
    documentId: string,
    extractedCitations: Awaited<ReturnType<typeof editorialAi.detectCitations>>
  ): Promise<{ citations: DetectedCitation[]; failures: { text: string; error: string }[] }> {
    const citations: DetectedCitation[] = [];
    const failures: { text: string; error: string }[] = [];

    for (const extracted of extractedCitations) {
      try {
        const citation = await prisma.citation.create({
          data: {
            documentId,
            rawText: extracted.text,
            citationType: mapToCitationType(extracted.type),
            detectedStyle: mapToCitationStyle(extracted.style),
            sectionContext: mapToSectionContext(extracted.sectionContext) as 'BODY' | 'REFERENCES' | 'FOOTNOTES' | 'ENDNOTES' | 'ABSTRACT' | 'UNKNOWN',
            pageNumber: extracted.location.pageNumber || null,
            paragraphIndex: extracted.location.paragraphIndex,
            startOffset: extracted.location.startOffset,
            endOffset: extracted.location.endOffset,
            confidence: extracted.confidence <= 1 ? extracted.confidence : extracted.confidence / 100,
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
          primaryComponentId: null,
          isParsed: false,
          parseConfidence: null,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        failures.push({ text: extracted.text.slice(0, 100), error: errorMessage });
        logger.error(`[Stylesheet Detection] Failed to store citation: ${extracted.text.slice(0, 50)}`, error instanceof Error ? error : undefined);
      }
    }

    if (failures.length > 0) {
      logger.warn(`[Stylesheet Detection] ${failures.length} citations failed to store out of ${extractedCitations.length} total`);
    }

    return { citations, failures };
  }

  /**
   * Get MIME type from file extension
   */
  private getMimeTypeFromExtension(fileName: string): string {
    const ext = fileName.toLowerCase().split('.').pop() || '';
    const mimeTypes: Record<string, string> = {
      'docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'doc': 'application/msword',
      'pdf': 'application/pdf',
      'txt': 'text/plain',
      'rtf': 'application/rtf',
      'odt': 'application/vnd.oasis.opendocument.text',
    };
    return mimeTypes[ext] || 'application/octet-stream';
  }

  private async createEditorialDocument(
    jobId: string,
    tenantId: string,
    fileName: string,
    fileSize: number,
    parsed: Awaited<ReturnType<typeof documentParser.parse>>
  ) {
    const existing = await prisma.editorialDocument.findFirst({
      where: { jobId, tenantId },
    });

    if (existing) return existing;

    // Derive MIME type from file extension dynamically
    const mimeType = this.getMimeTypeFromExtension(fileName);

    return prisma.editorialDocument.create({
      data: {
        jobId,
        tenantId,
        fileName,
        originalName: fileName,
        mimeType,
        fileSize,
        storagePath: '',
        wordCount: parsed.metadata.wordCount,
        pageCount: parsed.metadata.pageCount || null,
        chunkCount: parsed.chunks.length,
        title: parsed.metadata.title || null,
        authors: parsed.metadata.authors || [],
        language: parsed.metadata.language || null,
        status: EditorialDocStatus.ANALYZING,
        parsedAt: new Date(),
        documentContent: {
          create: {
            fullText: parsed.text,
            fullHtml: parsed.html || null,
            wordCount: parsed.metadata.wordCount,
            pageCount: parsed.metadata.pageCount || null,
          },
        },
      },
    });
  }
}

export const citationStylesheetDetectionService = new CitationStylesheetDetectionService();
