import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { claudeService } from '../ai/claude.service';
import { editorialAi } from '../shared';
import { crossRefService, EnrichedMetadata } from './crossref.service';
import { styleRulesService } from './style-rules.service';
// citationParsingService reserved for future use
import { AppError } from '../../utils/app-error';
import type { Prisma } from '@prisma/client';

// ============================================================================
// Type Definitions for Citation Data Structures
// ============================================================================

/**
 * Author representation used throughout the citation system
 */
export interface Author {
  firstName?: string;
  lastName: string;
  suffix?: string;
}

/**
 * AI-generated reference entry from editorialAi service
 */
interface AIReferenceEntry {
  citationIds?: string[];
  authors?: Array<{ firstName?: string; lastName?: string }>;
  year?: string;
  title?: string;
  sourceType?: string;
  journalName?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  doi?: string;
  url?: string;
  confidence?: number;
  formattedEntry?: string;
}

/**
 * Result from AI reference generation
 */
interface AIReferenceResult {
  entries?: AIReferenceEntry[];
}

/**
 * Processed entry ready for database insertion
 */
interface ProcessedEntry {
  data: Prisma.ReferenceListEntryCreateInput;
  authors: Author[];
  formattedText: string;
  isEnriched: boolean;
  citationIds: string[];
}

/**
 * Prisma ReferenceListEntry return type
 * Uses 'unknown' for JSON fields that need runtime parsing
 */
interface PrismaReferenceEntry {
  id: string;
  documentId: string;
  sortKey: string;
  authors: Prisma.JsonValue;
  year: string | null;
  title: string;
  sourceType: string;
  journalName: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  publisher: string | null;
  doi: string | null;
  url: string | null;
  enrichmentSource: string;
  enrichmentConfidence: number;
  formattedApa: string | null;
  formattedMla: string | null;
  formattedChicago: string | null;
  isEdited: boolean | null;
  editedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Parsed citation components from AI analysis
 */
interface ParsedCitationComponents {
  authors?: Array<{ firstName?: string; lastName?: string; suffix?: string }>;
  year?: string;
  title?: string;
  journalName?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  doi?: string;
  url?: string;
  sourceType?: string;
}

/**
 * Citation with parsed components for grouping
 */
interface CitationWithComponents {
  id: string;
  rawText: string;
  components?: ParsedCitationComponents[];
  parsedComponents?: ParsedCitationComponents;
}

/**
 * Input for fallback formatting (minimal required fields)
 */
interface FallbackFormatInput {
  authors: Author[];
  year?: string | null;
  title?: string;
  journalName?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  doi?: string | null;
}

/**
 * Fallback entry data structure for batch inserts
 */
interface FallbackEntryData {
  documentId: string;
  sortKey: string;
  authors: Prisma.InputJsonValue;
  year: string | null;
  title: string;
  sourceType: string;
  enrichmentSource: string;
  enrichmentConfidence: number;
  formattedApa?: string;
  formattedMla?: string;
  formattedChicago?: string;
}

// ============================================================================
// Public Interfaces
// ============================================================================

export interface ReferenceEntry {
  id: string;
  sortKey: string;
  authors: Author[];
  year?: string | null;
  title: string;
  sourceType: string;
  journalName?: string | null;
  volume?: string | null;
  issue?: string | null;
  pages?: string | null;
  publisher?: string | null;
  doi?: string | null;
  url?: string | null;
  enrichmentSource: string;
  enrichmentConfidence: number;
  formattedEntry?: string | null;
  formattedApa?: string | null;
  formattedMla?: string | null;
  formattedChicago?: string | null;
  isEdited?: boolean;
}

export interface GeneratedReferenceList {
  documentId: string;
  styleCode: string;
  entries: ReferenceEntry[];
  formattedList: string;
  stats: {
    totalEntries: number;
    enrichedCount: number;
    manualCount: number;
  };
}

interface FormatReferenceResult {
  formatted: string;
  sortKey: string;
  missingFields: string[];
  confidence: number;
}

class ReferenceListService {
  async getReferenceList(
    documentId: string,
    styleCode: string,
    tenantId: string
  ): Promise<GeneratedReferenceList | null> {
    const document = await prisma.editorialDocument.findFirst({
      where: { id: documentId, tenantId }
    });

    if (!document) {
      throw AppError.notFound('Document not found');
    }

    const entries = await prisma.referenceListEntry.findMany({
      where: { documentId }
    });

    if (entries.length === 0) {
      return null;
    }

    // Cast Prisma entries to our interface type
    return this.buildReferenceListResult(documentId, styleCode || document.referenceListStyle || 'apa7', entries as unknown as PrismaReferenceEntry[]);
  }

  async generateReferenceList(
    documentId: string,
    styleCode: string,
    tenantId: string,
    options: { regenerate?: boolean } = {}
  ): Promise<GeneratedReferenceList> {
    const document = await prisma.editorialDocument.findFirst({
      where: { id: documentId, tenantId },
      include: { documentContent: true }
    });

    if (!document) {
      throw AppError.notFound('Document not found');
    }

    const citations = await prisma.citation.findMany({
      where: { documentId },
    });

    if (citations.length === 0) {
      throw AppError.badRequest('No citations found in document. Please detect citations first.');
    }

    if (!options.regenerate) {
      const existingEntries = await prisma.referenceListEntry.findMany({
        where: { documentId }
      });

      if (existingEntries.length > 0) {
        const hasValidData = existingEntries.some(e => {
          const authors = this.parseAuthorsFromJson(e.authors);
          return authors.some(a => a.lastName && a.lastName !== 'Unknown' && a.lastName !== '');
        });

        if (hasValidData) {
          return this.buildReferenceListResult(documentId, styleCode, existingEntries as unknown as PrismaReferenceEntry[]);
        }
        logger.info(`[Reference List] Existing entries have invalid data (empty authors), forcing regeneration`);
        await prisma.referenceListEntry.deleteMany({ where: { documentId } });
      }
    }

    await prisma.referenceListEntry.deleteMany({ where: { documentId } });

    const fullText = document.documentContent?.fullText || '';
    if (!fullText) {
      logger.warn(`[Reference List] No fullText stored for document ${documentId}, falling back to citation-only generation`);
    }

    const citationInputs = citations.map(c => ({
      id: c.id,
      rawText: c.rawText,
      citationType: c.citationType,
      sectionContext: c.sectionContext || undefined,
    }));

    logger.info(`[Reference List] Generating reference list with full document context. ${citations.length} citations, ${fullText.length} chars of text, style=${styleCode}`);

    const aiResult = await editorialAi.generateReferenceEntriesChunked(fullText, citationInputs, styleCode);

    const entries: ReferenceEntry[] = [];
    let enrichedCount = 0;
    let manualCount = 0;

    // Cast AI result to typed interface
    const typedAiResult = aiResult as AIReferenceResult;

    if (typedAiResult.entries && typedAiResult.entries.length > 0) {
      // Process all entries first, then batch insert (fixes N+1 query pattern)
      const formattedColumn = this.getFormattedColumn(styleCode);
      const processedEntries: ProcessedEntry[] = [];

      // Process entries with CrossRef lookups in parallel batches
      const BATCH_SIZE = 5;
      for (let i = 0; i < typedAiResult.entries.length; i += BATCH_SIZE) {
        const batch = typedAiResult.entries.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(batch.map(async (aiEntry: AIReferenceEntry) => {
          const validCitationIds = (aiEntry.citationIds || []).filter((id: string) =>
            citations.some(c => c.id === id)
          );
          if (validCitationIds.length === 0) {
            validCitationIds.push(citations[0]?.id || 'unknown');
          }

          const authors: Author[] = (aiEntry.authors || []).map((a) => {
            let lastName = a.lastName || '';
            let firstName = a.firstName || undefined;
            if ((!lastName || lastName === 'Unknown') && firstName && firstName !== 'Unknown') {
              lastName = firstName;
              firstName = undefined;
            }
            if (lastName === 'Unknown') {
              lastName = '';
            }
            return { firstName, lastName: lastName || 'Unknown' } as Author;
          }).filter((a) => a.lastName !== '' && a.lastName !== 'Unknown');

          let enrichmentSource = 'ai';
          let enrichmentConfidence = aiEntry.confidence || 0.7;
          let isEnriched = false;

          if (aiEntry.doi) {
            try {
              const crossrefData = await crossRefService.lookupByDoi(aiEntry.doi);
              if (crossrefData) {
                enrichmentSource = 'crossref';
                enrichmentConfidence = Math.max(enrichmentConfidence, crossrefData.confidence);
                isEnriched = true;
                if (crossrefData.authors?.length) {
                  authors.length = 0;
                  authors.push(...crossrefData.authors.map(a => ({
                    firstName: a.firstName || undefined,
                    lastName: a.lastName || 'Unknown',
                  })));
                }
              }
            } catch {
              logger.warn(`[Reference List] CrossRef lookup failed for DOI ${aiEntry.doi}`);
            }
          }

          const sortKey = this.generateSortKey({
            authors,
            year: aiEntry.year,
            title: aiEntry.title || '',
          });

          const formattedText = aiEntry.formattedEntry || this.fallbackFormat({
            authors,
            year: aiEntry.year,
            title: aiEntry.title,
            journalName: aiEntry.journalName,
            volume: aiEntry.volume,
            issue: aiEntry.issue,
            pages: aiEntry.pages,
            doi: aiEntry.doi,
          }, styleCode);

          // Build data object with dynamic formatted column
          // Cast authors to JSON-compatible format for Prisma
          const authorsJson = authors as unknown as Prisma.InputJsonValue;
          const entryData: Prisma.ReferenceListEntryCreateInput = {
            document: { connect: { id: documentId } },
            sortKey,
            authors: authorsJson,
            year: aiEntry.year || null,
            title: aiEntry.title || '',
            sourceType: aiEntry.sourceType || 'unknown',
            journalName: aiEntry.journalName || null,
            volume: aiEntry.volume || null,
            issue: aiEntry.issue || null,
            pages: aiEntry.pages || null,
            publisher: aiEntry.publisher || null,
            doi: aiEntry.doi || null,
            url: aiEntry.url || null,
            enrichmentSource,
            enrichmentConfidence,
          };

          // Set the appropriate formatted column
          if (formattedColumn === 'formattedApa') {
            entryData.formattedApa = formattedText;
          } else if (formattedColumn === 'formattedMla') {
            entryData.formattedMla = formattedText;
          } else if (formattedColumn === 'formattedChicago') {
            entryData.formattedChicago = formattedText;
          }

          return {
            data: entryData,
            authors,
            formattedText,
            isEnriched,
            citationIds: validCitationIds, // Store for creating links after entry creation
          };
        }));

        processedEntries.push(...batchResults);
        enrichedCount += batchResults.filter(r => r.isEnriched).length;
        manualCount += batchResults.filter(r => !r.isEnriched).length;
      }

      // Batch insert all entries using transaction
      const createdEntries = await prisma.$transaction(
        processedEntries.map(pe =>
          prisma.referenceListEntry.create({ data: pe.data })
        )
      );

      // Create citation links in junction table
      const citationLinksToCreate: { referenceListEntryId: string; citationId: string }[] = [];
      createdEntries.forEach((entry, idx) => {
        const citationIds = processedEntries[idx].citationIds;
        for (const citationId of citationIds) {
          citationLinksToCreate.push({
            referenceListEntryId: entry.id,
            citationId,
          });
        }
      });
      if (citationLinksToCreate.length > 0) {
        await prisma.referenceListEntryCitation.createMany({ data: citationLinksToCreate });
      }

      // Map created entries back with formatted data
      entries.push(...createdEntries.map((entry, idx) => ({
        ...entry,
        authors: processedEntries[idx].authors,
        formattedEntry: processedEntries[idx].formattedText,
        [formattedColumn]: processedEntries[idx].formattedText,
      })));
    } else {
      logger.warn(`[Reference List] AI returned no entries, falling back to citation-based generation`);
      const formattedColumn = this.getFormattedColumn(styleCode);

      // Build fallback entries with proper typing
      const fallbackData = citations.map(citation => {
        const entry: Prisma.ReferenceListEntryUncheckedCreateInput = {
          documentId,
          sortKey: citation.rawText.substring(0, 30).toLowerCase(),
          authors: [] as unknown as Prisma.InputJsonValue,
          year: null,
          title: citation.rawText,
          sourceType: 'unknown',
          enrichmentSource: 'none',
          enrichmentConfidence: 0.3,
        };
        // Set the appropriate formatted column
        if (formattedColumn === 'formattedApa') {
          entry.formattedApa = citation.rawText;
        } else if (formattedColumn === 'formattedMla') {
          entry.formattedMla = citation.rawText;
        } else if (formattedColumn === 'formattedChicago') {
          entry.formattedChicago = citation.rawText;
        }
        return entry;
      });

      const createdEntries = await prisma.$transaction(
        fallbackData.map(data =>
          prisma.referenceListEntry.create({ data })
        )
      );

      // Create citation links in junction table
      const fallbackCitationLinks = createdEntries.map((entry, idx) => ({
        referenceListEntryId: entry.id,
        citationId: citations[idx].id,
      }));
      if (fallbackCitationLinks.length > 0) {
        await prisma.referenceListEntryCitation.createMany({ data: fallbackCitationLinks });
      }

      entries.push(...createdEntries.map((entry, idx) => {
        const formattedText = this.getFormattedFromEntry(fallbackData[idx] as unknown as FallbackEntryData, formattedColumn);
        return {
          id: entry.id,
          sortKey: entry.sortKey,
          authors: [] as Author[],
          year: entry.year,
          title: entry.title,
          sourceType: entry.sourceType,
          journalName: entry.journalName,
          volume: entry.volume,
          issue: entry.issue,
          pages: entry.pages,
          publisher: entry.publisher,
          doi: entry.doi,
          url: entry.url,
          enrichmentSource: entry.enrichmentSource,
          enrichmentConfidence: entry.enrichmentConfidence,
          formattedEntry: formattedText,
          formattedApa: entry.formattedApa,
          formattedMla: entry.formattedMla,
          formattedChicago: entry.formattedChicago,
          isEdited: false,
        };
      }));
      manualCount = citations.length;
    }

    await prisma.editorialDocument.update({
      where: { id: documentId },
      data: {
        referenceListStatus: 'draft',
        referenceListStyle: styleCode,
        referenceListGeneratedAt: new Date()
      }
    });

    return this.buildReferenceListResult(documentId, styleCode, entries, {
      totalEntries: entries.length,
      enrichedCount,
      manualCount
    });
  }

  async formatReference(
    entry: ReferenceEntry,
    styleCode: string
  ): Promise<FormatReferenceResult> {
    const styleGuide = await prisma.citationStyleGuide.findUnique({
      where: { code: styleCode }
    });

    const styleName = styleGuide?.name || this.getStyleName(styleCode);
    const styleRules = styleRulesService.getRulesForStyle(styleCode);

    const prompt = `Format the following reference entry in ${styleName} style.

SOURCE TYPE: ${entry.sourceType}

METADATA:
${JSON.stringify({
  authors: entry.authors,
  year: entry.year,
  title: entry.title,
  journalName: entry.journalName,
  volume: entry.volume,
  issue: entry.issue,
  pages: entry.pages,
  publisher: entry.publisher,
  doi: entry.doi,
  url: entry.url
}, null, 2)}

${styleName} FORMAT RULES:
${styleRules.map(r => `- ${r.name}: ${r.description}`).join('\n')}

Format the complete reference entry. Include:
- All available metadata in correct order
- Proper punctuation and spacing
- Italics marked with *asterisks*
- DOI as URL if available (https://doi.org/...)
- Hanging indent formatting (indicate with "  " two spaces for continuation lines)

Return a JSON object:
{
  "formatted": "the formatted reference entry",
  "sortKey": "key for alphabetical sorting (usually author last name + year)",
  "missingFields": ["list of recommended but missing fields"],
  "confidence": 0.0-1.0
}`;

    try {
      const response = await claudeService.generate(prompt, {
        model: 'haiku',
        temperature: 0.2
      });

      const result = this.parseAiResponse<FormatReferenceResult>(response.text);
      return result;
    } catch (error) {
      logger.error('[ReferenceList] Format reference failed', error instanceof Error ? error : undefined);
      return {
        formatted: this.fallbackFormat(entry, styleCode),
        sortKey: entry.sortKey,
        missingFields: [],
        confidence: 0.5
      };
    }
  }

  groupCitationsByReference(citations: CitationWithComponents[]): { citationIds: string[]; citations: CitationWithComponents[] }[] {
    const groups = new Map<string, { citationIds: string[]; citations: CitationWithComponents[] }>();

    for (const citation of citations) {
      const key = this.generateGroupKey(citation);

      if (groups.has(key)) {
        const group = groups.get(key)!;
        group.citationIds.push(citation.id);
        group.citations.push(citation);
      } else {
        groups.set(key, {
          citationIds: [citation.id],
          citations: [citation]
        });
      }
    }

    return Array.from(groups.values());
  }

  generateSortKey(metadata: EnrichedMetadata | { authors: Author[]; year?: string; title: string }): string {
    const authors = metadata.authors || [];
    const firstAuthor = authors[0];
    const lastName = firstAuthor?.lastName || 'Unknown';
    const year = metadata.year || '0000';
    const title = metadata.title?.substring(0, 20) || '';

    return `${lastName.toLowerCase()}_${year}_${title.toLowerCase().replace(/\s+/g, '_')}`;
  }

  async updateEntry(
    entryId: string,
    updates: Partial<ReferenceEntry>,
    tenantId: string
  ): Promise<ReferenceEntry> {
    const entry = await prisma.referenceListEntry.findUnique({
      where: { id: entryId },
      include: { document: true }
    });

    if (!entry) {
      throw AppError.notFound('Reference entry not found');
    }

    if (entry.document.tenantId !== tenantId) {
      throw AppError.forbidden('Access denied');
    }

    const authorsJson = updates.authors as unknown as Prisma.InputJsonValue;
    const updated = await prisma.referenceListEntry.update({
      where: { id: entryId },
      data: {
        ...updates,
        authors: authorsJson,
        isEdited: true,
        editedAt: new Date()
      }
    });

    return this.prismaEntryToReferenceEntry(updated as unknown as PrismaReferenceEntry);
  }

  async finalizeReferenceList(
    documentId: string,
    styleCode: string,
    tenantId: string
  ): Promise<GeneratedReferenceList> {
    const document = await prisma.editorialDocument.findFirst({
      where: { id: documentId, tenantId }
    });

    if (!document) {
      throw AppError.notFound('Document not found');
    }

    const entries = await prisma.referenceListEntry.findMany({
      where: { documentId },
      orderBy: { sortKey: 'asc' }
    });

    if (entries.length === 0) {
      throw AppError.badRequest('No reference entries to finalize');
    }

    const formattedColumn = this.getFormattedColumn(styleCode);

    // Collect entries that need formatting (fixes N+1 query pattern)
    // Cast to PrismaReferenceEntry for type compatibility
    const typedEntries = entries as unknown as PrismaReferenceEntry[];
    const entriesToFormat = typedEntries.filter(entry => !this.getFormattedFromEntry(entry, formattedColumn));

    if (entriesToFormat.length > 0) {
      // Format all entries in parallel batches
      const BATCH_SIZE = 5;
      const updates: Array<{ id: string; formatted: string }> = [];

      for (let i = 0; i < entriesToFormat.length; i += BATCH_SIZE) {
        const batch = entriesToFormat.slice(i, i + BATCH_SIZE);
        const batchResults = await Promise.all(
          batch.map(async entry => ({
            id: entry.id,
            formatted: (await this.formatReference(this.prismaEntryToReferenceEntry(entry as unknown as PrismaReferenceEntry), styleCode)).formatted
          }))
        );
        updates.push(...batchResults);
      }

      // Batch update all entries in a single transaction
      if (updates.length > 0) {
        await prisma.$transaction(
          updates.map(u =>
            prisma.referenceListEntry.update({
              where: { id: u.id },
              data: { [formattedColumn]: u.formatted }
            })
          )
        );
      }
    }

    await prisma.editorialDocument.update({
      where: { id: documentId },
      data: {
        referenceListStatus: 'finalized',
        referenceListStyle: styleCode
      }
    });

    const finalEntries = await prisma.referenceListEntry.findMany({
      where: { documentId },
      orderBy: { sortKey: 'asc' }
    });

    return this.buildReferenceListResult(documentId, styleCode, finalEntries as unknown as PrismaReferenceEntry[]);
  }

  private async buildReferenceListResult(
    documentId: string,
    styleCode: string,
    entries: PrismaReferenceEntry[] | ReferenceEntry[],
    stats?: { totalEntries: number; enrichedCount: number; manualCount: number }
  ): Promise<GeneratedReferenceList> {
    const formattedColumn = this.getFormattedColumn(styleCode);
    const sortedEntries = [...entries].sort((a, b) =>
      a.sortKey.localeCompare(b.sortKey)
    );

    const entriesWithFormatted: ReferenceEntry[] = sortedEntries.map((e) => {
      const existingFormatted = this.getFormattedFromEntry(e, formattedColumn);
      const authors = this.isPrismaEntry(e)
        ? this.parseAuthorsFromJson(e.authors)
        : e.authors;
      const entryForFallback: FallbackFormatInput = {
        authors,
        year: e.year,
        title: e.title,
        journalName: e.journalName,
        volume: e.volume,
        issue: e.issue,
        pages: e.pages,
        doi: e.doi,
      };
      const formatted = existingFormatted || this.fallbackFormat(entryForFallback, styleCode);

      return {
        id: e.id,
        sortKey: e.sortKey,
        authors,
        year: e.year,
        title: e.title,
        sourceType: e.sourceType,
        journalName: e.journalName,
        volume: e.volume,
        issue: e.issue,
        pages: e.pages,
        publisher: e.publisher,
        doi: e.doi,
        url: e.url,
        enrichmentSource: e.enrichmentSource,
        enrichmentConfidence: e.enrichmentConfidence,
        formattedEntry: formatted,
        formattedApa: formattedColumn === 'formattedApa' ? formatted : e.formattedApa,
        formattedMla: formattedColumn === 'formattedMla' ? formatted : e.formattedMla,
        formattedChicago: formattedColumn === 'formattedChicago' ? formatted : e.formattedChicago,
        isEdited: Boolean(e.isEdited),
      };
    });

    const formattedList = entriesWithFormatted
      .map((e) => e.formattedEntry || '')
      .join('\n\n');

    return {
      documentId,
      styleCode,
      entries: entriesWithFormatted,
      formattedList,
      stats: stats || {
        totalEntries: entries.length,
        enrichedCount: entries.filter((e) => e.enrichmentSource === 'crossref').length,
        manualCount: entries.filter((e) => e.enrichmentSource !== 'crossref').length
      }
    };
  }

  /**
   * Type guard to check if entry is from Prisma (has JsonValue authors)
   */
  private isPrismaEntry(entry: PrismaReferenceEntry | ReferenceEntry): entry is PrismaReferenceEntry {
    // PrismaReferenceEntry has authors as JsonValue, not Author[]
    // Check if it's not already parsed into Author array
    const authors = entry.authors;
    if (!Array.isArray(authors)) return true;
    if (authors.length === 0) return false;
    // If authors is an array of objects with lastName property, it's already parsed
    return !(typeof authors[0] === 'object' && authors[0] !== null && 'lastName' in authors[0]);
  }

  private generateGroupKey(citation: CitationWithComponents): string {
    const components = citation.components || [];
    const parsed = components[0];
    if (!parsed) {
      return citation.rawText.toLowerCase().substring(0, 50);
    }

    const authors = parsed.authors || [];
    const firstAuthor = authors[0]?.lastName || 'unknown';
    const year = parsed.year || '';
    const title = (parsed.title || '').substring(0, 30).toLowerCase();

    return `${firstAuthor.toLowerCase()}_${year}_${title}`;
  }

  private extractDoi(citations: CitationWithComponents[]): string | null {
    for (const citation of citations) {
      const parsed = citation.parsedComponents;
      if (parsed?.doi) {
        return parsed.doi;
      }

      const doiMatch = citation.rawText.match(/10\.\d{4,}\/[^\s]+/);
      if (doiMatch) {
        return doiMatch[0];
      }
    }
    return null;
  }

  private extractMetadataFromParsed(citations: CitationWithComponents[]): EnrichedMetadata {
    const primary = citations[0];
    const components = primary?.components || [];
    const parsed: ParsedCitationComponents = components[0] || {};

    return {
      authors: (parsed.authors || []).map((a) => ({
        firstName: a.firstName,
        lastName: a.lastName || 'Unknown',
        suffix: a.suffix
      })),
      title: parsed.title || '',
      year: parsed.year,
      journalName: parsed.journalName,
      volume: parsed.volume,
      issue: parsed.issue,
      pages: parsed.pages,
      publisher: parsed.publisher,
      doi: parsed.doi,
      url: parsed.url,
      sourceType: this.normalizeSourceType(parsed.sourceType),
      source: 'ai',
      confidence: 0.7
    };
  }

  /**
   * Normalize source type to valid enum value
   */
  private normalizeSourceType(sourceType?: string): 'journal' | 'book' | 'chapter' | 'conference' | 'website' | 'unknown' {
    const validTypes = ['journal', 'book', 'chapter', 'conference', 'website', 'unknown'] as const;
    if (sourceType && validTypes.includes(sourceType as typeof validTypes[number])) {
      return sourceType as typeof validTypes[number];
    }
    return 'unknown';
  }

  private getStyleName(styleCode: string): string {
    const names: Record<string, string> = {
      apa7: 'APA 7th Edition',
      mla9: 'MLA 9th Edition',
      chicago17: 'Chicago 17th Edition',
      vancouver: 'Vancouver',
      ieee: 'IEEE'
    };
    return names[styleCode] || styleCode.toUpperCase();
  }

  private getFormattedColumn(styleCode: string): string {
    const columns: Record<string, string> = {
      apa7: 'formattedApa',
      mla9: 'formattedMla',
      chicago17: 'formattedChicago',
      vancouver: 'formattedApa',
      ieee: 'formattedApa',
    };
    return columns[styleCode] || 'formattedApa';
  }

  private fallbackFormat(entry: ReferenceEntry | FallbackFormatInput, _styleCode: string): string {
    const rawAuthors = Array.isArray(entry.authors) ? entry.authors : [];
    const validAuthors = rawAuthors.filter((a): a is Author => {
      if (!a || typeof a !== 'object') return false;
      const hasValidLastName = Boolean(a.lastName && a.lastName !== 'Unknown' && a.lastName.trim() !== '');
      const hasValidFirstName = Boolean(a.firstName && a.firstName !== 'Unknown' && a.firstName.trim() !== '');
      return hasValidLastName || hasValidFirstName;
    });

    let authorStr = 'Unknown Author';
    if (validAuthors.length > 0) {
      authorStr = validAuthors.map((a) => {
        let lastName = (a.lastName && a.lastName !== 'Unknown') ? a.lastName.trim() : '';
        let firstName = (a.firstName && a.firstName !== 'Unknown') ? a.firstName.trim() : '';
        if (!lastName && firstName) {
          lastName = firstName;
          firstName = '';
        }
        const firstInitial = firstName ? `${firstName.charAt(0)}.` : '';
        return firstInitial ? `${lastName}, ${firstInitial}` : lastName;
      }).join(', ');
    }

    const year = entry.year ? ` (${entry.year}).` : '.';
    const title = entry.title ? ` ${entry.title}.` : '';
    const journal = entry.journalName ? ` *${entry.journalName}*` : '';
    const volume = entry.volume ? `, ${entry.volume}` : '';
    const issue = entry.issue ? `(${entry.issue})` : '';
    const pages = entry.pages ? `, ${entry.pages}` : '';
    const doi = entry.doi ? ` https://doi.org/${entry.doi}` : '';

    const source = `${journal}${volume}${issue}${pages}`;
    const sourceSuffix = source ? `${source}.` : '';

    return `${authorStr}${year}${title}${sourceSuffix}${doi}`.trim();
  }

  private parseAiResponse<T>(text: string): T {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in AI response');
    }
    return JSON.parse(jsonMatch[0]) as T;
  }

  /**
   * Parse authors from Prisma JSON value to Author array
   */
  private parseAuthorsFromJson(jsonValue: Prisma.JsonValue): Author[] {
    if (!jsonValue || !Array.isArray(jsonValue)) {
      return [];
    }
    return jsonValue.map((a) => {
      if (typeof a === 'object' && a !== null) {
        const obj = a as Record<string, unknown>;
        return {
          firstName: typeof obj.firstName === 'string' ? obj.firstName : undefined,
          lastName: typeof obj.lastName === 'string' ? obj.lastName : 'Unknown',
          suffix: typeof obj.suffix === 'string' ? obj.suffix : undefined,
        };
      }
      return { lastName: 'Unknown' };
    });
  }

  /**
   * Get formatted text from entry by column name
   */
  private getFormattedFromEntry(
    entry: PrismaReferenceEntry | ReferenceEntry | FallbackEntryData,
    columnName: string
  ): string | null {
    switch (columnName) {
      case 'formattedApa':
        return entry.formattedApa ?? null;
      case 'formattedMla':
        return entry.formattedMla ?? null;
      case 'formattedChicago':
        return entry.formattedChicago ?? null;
      default:
        return null;
    }
  }

  /**
   * Convert database record to ReferenceEntry
   */
  private prismaEntryToReferenceEntry(record: PrismaReferenceEntry): ReferenceEntry {
    return {
      id: record.id,
      sortKey: record.sortKey,
      authors: this.parseAuthorsFromJson(record.authors),
      year: record.year,
      title: record.title,
      sourceType: record.sourceType,
      journalName: record.journalName,
      volume: record.volume,
      issue: record.issue,
      pages: record.pages,
      publisher: record.publisher,
      doi: record.doi,
      url: record.url,
      enrichmentSource: record.enrichmentSource,
      enrichmentConfidence: record.enrichmentConfidence,
      formattedApa: record.formattedApa,
      formattedMla: record.formattedMla,
      formattedChicago: record.formattedChicago,
      isEdited: record.isEdited ?? false,
    };
  }
}

export const referenceListService = new ReferenceListService();
