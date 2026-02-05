import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { geminiService } from '../ai/gemini.service';
import { crossRefService, EnrichedMetadata } from './crossref.service';
import { styleRulesService } from './style-rules.service';
import { citationParsingService } from './citation-parsing.service';
import { AppError } from '../../utils/app-error';

export interface ReferenceEntry {
  id: string;
  citationIds: string[];
  sortKey: string;
  authors: { firstName?: string; lastName: string; suffix?: string }[];
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
  formattedEntry?: string;
  formattedApa?: string | null;
  formattedMla?: string | null;
  formattedChicago?: string | null;
  isEdited: boolean;
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
  async generateReferenceList(
    documentId: string,
    styleCode: string,
    tenantId: string,
    options: { regenerate?: boolean } = {}
  ): Promise<GeneratedReferenceList> {
    const document = await prisma.editorialDocument.findFirst({
      where: { id: documentId, tenantId }
    });

    const citations = await prisma.citation.findMany({
      where: { documentId },
      include: {
        components: true
      }
    });

    if (!document) {
      throw AppError.notFound('Document not found');
    }

    if (citations.length === 0) {
      throw AppError.badRequest('No citations found in document. Please detect citations first.');
    }

    // Auto-parse citations that don't have components
    const unparsedCitations = citations.filter(c => !c.components || c.components.length === 0);
    if (unparsedCitations.length > 0) {
      logger.info(`[Reference List] Auto-parsing ${unparsedCitations.length} citations without components`);
      for (const citation of unparsedCitations) {
        try {
          await citationParsingService.parseCitation(citation.id, tenantId);
        } catch (err) {
          logger.warn(`[Reference List] Failed to parse citation ${citation.id}: ${err}`);
        }
      }
      
      // Re-fetch citations with newly parsed components
      const updatedCitations = await prisma.citation.findMany({
        where: { documentId },
        include: { components: true }
      });
      citations.length = 0;
      citations.push(...updatedCitations);
    }

    if (!options.regenerate) {
      const existingEntries = await prisma.referenceListEntry.findMany({
        where: { documentId }
      });

      if (existingEntries.length > 0) {
        return this.buildReferenceListResult(documentId, styleCode, existingEntries);
      }
    }

    await prisma.referenceListEntry.deleteMany({ where: { documentId } });

    const groupedCitations = this.groupCitationsByReference(citations);

    const entries: ReferenceEntry[] = [];
    let enrichedCount = 0;
    let manualCount = 0;

    for (const group of groupedCitations) {
      let metadata: EnrichedMetadata | null = null;
      let enrichmentSource = 'ai';

      const doi = this.extractDoi(group.citations);
      if (doi) {
        metadata = await crossRefService.lookupByDoi(doi);
        if (metadata) {
          enrichmentSource = 'crossref';
          enrichedCount++;
        }
      }

      if (!metadata) {
        metadata = this.extractMetadataFromParsed(group.citations);
        manualCount++;
      }

      const sortKey = this.generateSortKey(metadata);

      const entry = await prisma.referenceListEntry.create({
        data: {
          documentId,
          citationIds: group.citationIds,
          sortKey,
          authors: metadata.authors as any,
          year: metadata.year,
          title: metadata.title,
          sourceType: metadata.sourceType,
          journalName: metadata.journalName,
          volume: metadata.volume,
          issue: metadata.issue,
          pages: metadata.pages,
          publisher: metadata.publisher,
          doi: metadata.doi,
          url: metadata.url,
          enrichmentSource,
          enrichmentConfidence: metadata.confidence
        }
      });

      entries.push({
        ...entry,
        authors: metadata.authors
      });
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
      const response = await geminiService.generateText(prompt, {
        model: 'flash',
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

  groupCitationsByReference(citations: any[]): { citationIds: string[]; citations: any[] }[] {
    const groups = new Map<string, { citationIds: string[]; citations: any[] }>();

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

  generateSortKey(metadata: EnrichedMetadata | { authors: any[]; year?: string; title: string }): string {
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

    const updated = await prisma.referenceListEntry.update({
      where: { id: entryId },
      data: {
        ...updates,
        authors: updates.authors as any,
        isEdited: true,
        editedAt: new Date()
      }
    });

    return {
      ...updated,
      authors: updated.authors as any
    };
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

    for (const entry of entries) {
      const existingFormatted = (entry as any)[formattedColumn];
      if (!existingFormatted) {
        const formatted = await this.formatReference(entry as any, styleCode);
        await prisma.referenceListEntry.update({
          where: { id: entry.id },
          data: { [formattedColumn]: formatted.formatted }
        });
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

    return this.buildReferenceListResult(documentId, styleCode, finalEntries);
  }

  private async buildReferenceListResult(
    documentId: string,
    styleCode: string,
    entries: any[],
    stats?: { totalEntries: number; enrichedCount: number; manualCount: number }
  ): Promise<GeneratedReferenceList> {
    const formattedColumn = this.getFormattedColumn(styleCode);
    const sortedEntries = [...entries].sort((a, b) =>
      a.sortKey.localeCompare(b.sortKey)
    );

    const entriesWithFormatted = sortedEntries.map((e) => {
      const existingFormatted = (e as any)[formattedColumn];
      const formatted = existingFormatted || this.fallbackFormat(e, styleCode);
      return {
        ...e,
        authors: e.authors as any,
        formattedEntry: formatted,
        [formattedColumn]: formatted
      };
    });

    const formattedList = entriesWithFormatted
      .map((e) => e.formattedEntry)
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

  private generateGroupKey(citation: any): string {
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

  private extractDoi(citations: any[]): string | null {
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

  private extractMetadataFromParsed(citations: any[]): EnrichedMetadata {
    const primary = citations[0];
    const components = primary?.components || [];
    const parsed = components[0] || {};

    return {
      authors: (parsed.authors || []).map((a: any) => ({
        firstName: a.firstName,
        lastName: a.lastName,
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
      sourceType: parsed.sourceType || 'unknown',
      source: 'ai',
      confidence: 0.7
    };
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
      chicago17: 'formattedChicago'
    };
    return columns[styleCode] || 'formattedApa';
  }

  private fallbackFormat(entry: any, styleCode: string): string {
    const authors = entry.authors || [];
    const authorStr =
      authors.length > 0
        ? authors.map((a: any) => `${a.lastName}, ${a.firstName?.charAt(0) || ''}.`).join(', ')
        : 'Unknown Author';

    const year = entry.year ? ` (${entry.year}).` : '.';
    const title = entry.title ? ` ${entry.title}.` : '';
    const journal = entry.journalName ? ` *${entry.journalName}*` : '';
    const volume = entry.volume ? `, ${entry.volume}` : '';
    const issue = entry.issue ? `(${entry.issue})` : '';
    const pages = entry.pages ? `, ${entry.pages}` : '';
    const doi = entry.doi ? ` https://doi.org/${entry.doi}` : '';

    return `${authorStr}${year}${title}${journal}${volume}${issue}${pages}.${doi}`;
  }

  private parseAiResponse<T>(text: string): T {
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('No JSON found in AI response');
    }
    return JSON.parse(jsonMatch[0]) as T;
  }
}

export const referenceListService = new ReferenceListService();
