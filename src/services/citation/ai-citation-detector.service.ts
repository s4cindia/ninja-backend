/**
 * AI-Powered Citation Detection Service
 * Uses Claude AI to detect citations without regex
 */

import { claudeService } from '../ai/claude.service';
import { logger } from '../../lib/logger';

export interface InTextCitation {
  id: string;
  text: string; // Original citation text (e.g., "[1]", "(Smith, 2020)", "¹")
  position: {
    paragraph: number;
    sentence: number;
    startChar: number;
    endChar: number;
  };
  type: 'numeric' | 'author-year' | 'superscript' | 'footnote';
  format: 'bracket' | 'parenthesis' | 'superscript';
  numbers: number[]; // For numeric citations [1-3] -> [1,2,3]
  linkedRefId?: string; // ID of reference in reference list
  context: string; // Surrounding text for context
}

export interface ReferenceEntry {
  id: string;
  number?: number; // Position in reference list
  rawText: string; // Complete reference text
  components: {
    authors?: string[];
    year?: string;
    title?: string;
    journal?: string;
    volume?: string;
    issue?: string;
    pages?: string;
    doi?: string;
    url?: string;
    publisher?: string;
    editors?: string[];
  };
  detectedStyle?: string; // APA, MLA, Chicago, Vancouver, etc.
  citedBy: string[]; // IDs of in-text citations
}

export interface CitationAnalysis {
  inTextCitations: InTextCitation[];
  references: ReferenceEntry[];
  issues: CitationIssue[];
  detectedStyle: string;
  statistics: {
    totalCitations: number;
    totalReferences: number;
    duplicateReferences: number;
    missingReferences: number;
    unusedReferences: number;
  };
}

export interface CitationIssue {
  type: 'duplicate_reference' | 'missing_reference' | 'unused_reference' |
        'broken_link' | 'style_inconsistency' | 'invalid_doi';
  severity: 'error' | 'warning' | 'info';
  message: string;
  location?: {
    paragraph?: number;
    referenceNumber?: number;
  };
  citationId?: string;
  referenceId?: string;
}

class AICitationDetectorService {
  /**
   * Analyze document for citations using AI
   */
  async analyzeDocument(
    documentText: string,
    options: {
      detectStyle?: boolean;
      linkCitations?: boolean;
    } = {}
  ): Promise<CitationAnalysis> {
    logger.info('[AI Citation Detector] Starting document analysis');

    try {
      // Step 1: Detect in-text citations using AI
      const inTextCitations = await this.detectInTextCitations(documentText);
      logger.info(`[AI Citation Detector] Found ${inTextCitations.length} in-text citations`);

      // Step 2: Extract reference list using AI
      const references = await this.extractReferenceList(documentText);
      logger.info(`[AI Citation Detector] Extracted ${references.length} references`);

      // Step 3: Detect citation style
      let detectedStyle = 'Unknown';
      if (options.detectStyle !== false) {
        detectedStyle = await this.detectCitationStyle(documentText, references);
        logger.info(`[AI Citation Detector] Detected style: ${detectedStyle}`);
      }

      // Step 4: Link in-text citations to references
      if (options.linkCitations !== false) {
        this.linkCitationsToReferences(inTextCitations, references);
      }

      // Step 5: Identify issues
      const issues = this.identifyIssues(inTextCitations, references);
      logger.info(`[AI Citation Detector] Found ${issues.length} issues`);

      // Step 6: Calculate statistics
      const statistics = this.calculateStatistics(inTextCitations, references, issues);

      return {
        inTextCitations,
        references,
        issues,
        detectedStyle,
        statistics
      };
    } catch (error) {
      logger.error('[AI Citation Detector] Analysis failed:', error);
      throw error;
    }
  }

  /**
   * Detect all in-text citations using AI (NO REGEX)
   */
  private async detectInTextCitations(documentText: string): Promise<InTextCitation[]> {
    const prompt = `Find ALL in-text citations in this document. Return ONLY a JSON array.

IGNORE: Superscript numbers immediately after author names (these are affiliations, NOT citations).

Find these citation types:

1. NUMERIC citations (Vancouver, IEEE styles):
   - Brackets: [1], [2], [3-5], [3–5], [1,2,3], [1,2]
   - Parentheses: (1), (2), (3-5)
   - Ranges use hyphen (-) or en-dash (–)

2. SUPERSCRIPT/FOOTNOTE citations (Chicago style):
   - Superscript numbers at end of sentences: ¹ ² ³ ⁴ ⁵ etc.
   - These are footnote markers, type="footnote", format="superscript"

3. AUTHOR-YEAR citations (APA, Harvard, Chicago author-date):
   - Single author: (Smith, 2020), Smith (2020)
   - Two authors: (Smith & Jones, 2020), (Marcus & Davis, 2019)
   - Multiple authors: (Smith et al., 2020), (Brown et al., 2020)
   - Multiple citations separated by semicolon: (Brown et al., 2020; Bommasani et al., 2021)
   - With page: (Smith, 2020, p. 45)

For each citation provide:
- text: the exact citation text including parentheses/brackets/superscript
- paragraph: paragraph number (1-based)
- startChar: character position
- type: "numeric" OR "author-year" OR "footnote"
- format: "bracket" OR "parenthesis" OR "superscript"
- numbers: array of reference numbers (for numeric/footnote citations, empty for author-year)
- context: brief surrounding text (max 30 chars)

Return JSON array ONLY. Examples:
[{"text":"[1,2]","paragraph":1,"startChar":50,"type":"numeric","format":"bracket","numbers":[1,2],"context":"ability [1,2]. However"},
{"text":"[3–5]","paragraph":1,"startChar":100,"type":"numeric","format":"bracket","numbers":[3,4,5],"context":"consistency [3–5]. Editorial"},
{"text":"¹","paragraph":1,"startChar":40,"type":"footnote","format":"superscript","numbers":[1],"context":"trust.¹ Structured"},
{"text":"(Brown et al., 2020; Bommasani et al., 2021)","paragraph":1,"startChar":80,"type":"author-year","format":"parenthesis","numbers":[],"context":"pipelines (Brown et al., 2020; Bommasani et al., 2021). Hybrid"}]

Document:
${documentText.substring(0, 150000)} ${documentText.length > 150000 ? '...[truncated]' : ''}`;

    try {
      const citations = await claudeService.generateJSON(prompt, {
        model: 'sonnet',
        temperature: 0.1,
        maxTokens: 16384
      });
      return citations.map((c: { text?: string; paragraph?: number; startChar?: number; type?: string; format?: string; style?: string; confidence?: number }, idx: number) => ({
        id: `citation-${idx + 1}`,
        text: c.text,
        position: {
          paragraph: c.paragraph || 0,
          sentence: 0,
          startChar: c.startChar || 0,
          endChar: (c.startChar || 0) + (c.text?.length || 0)
        },
        type: c.type || 'numeric',
        format: c.format || 'bracket',
        numbers: c.numbers || [],
        context: c.context || ''
      }));
    } catch (error) {
      logger.error('[AI Citation Detector] Failed to parse in-text citations:', error);
      return [];
    }
  }

  /**
   * Extract reference list using AI (NO REGEX)
   */
  private async extractReferenceList(documentText: string): Promise<ReferenceEntry[]> {
    const prompt = `Extract ALL references from the References/Bibliography section.

CRITICAL: Return ONLY a JSON array. NO explanations, NO markdown.

For EACH reference, extract ALL available fields:
- number: reference number (1, 2, 3...)
- rawText: complete original reference text
- authors: array of ALL author names (e.g., ["Smith J", "Jones A", "Brown K"])
- year: publication year
- title: article/book title
- journal: journal name (for articles)
- volume: journal volume
- issue: journal issue
- pages: page range (e.g., "123-145")
- doi: DOI if present (without "doi:" prefix)
- url: URL if present
- publisher: publisher name (for books)

Extract what's available. If a field is not present, omit it or set to null.

Example:
[
  {
    "number": 1,
    "rawText": "Smith J, Jones A. Article Title. Journal Name. 2020;10(2):123-145. doi:10.1234/example",
    "authors": ["Smith J", "Jones A"],
    "year": "2020",
    "title": "Article Title",
    "journal": "Journal Name",
    "volume": "10",
    "issue": "2",
    "pages": "123-145",
    "doi": "10.1234/example"
  }
]

Document text:
${documentText.substring(0, 150000)} ${documentText.length > 150000 ? '...[truncated]' : ''}`;

    try {
      const refs = await claudeService.generateJSON(prompt, {
        model: 'sonnet',
        temperature: 0.1,
        maxTokens: 16384
      });
      return refs.map((r: { number?: number; rawText?: string; authors?: string[]; year?: string; title?: string; journal?: string; volume?: string; issue?: string; pages?: string; doi?: string; url?: string; publisher?: string }, idx: number) => ({
        id: `ref-${r.number || idx + 1}`,
        number: r.number || idx + 1,
        rawText: r.rawText || '',
        components: {
          authors: r.authors || [],
          year: r.year,
          title: r.title,
          journal: r.journal,
          volume: r.volume,
          issue: r.issue,
          pages: r.pages,
          doi: r.doi,
          url: r.url,
          publisher: r.publisher,
          editors: r.editors
        },
        citedBy: []
      }));
    } catch (error) {
      logger.error('[AI Citation Detector] Failed to parse references:', error);
      return [];
    }
  }

  /**
   * Detect citation style using AI
   */
  private async detectCitationStyle(
    documentText: string,
    references: ReferenceEntry[]
  ): Promise<string> {
    if (references.length === 0) return 'Unknown';

    const sampleRefs = references.slice(0, 3).map(r => r.rawText).join('\n');

    const prompt = `Analyze these reference entries and identify the citation style.

References:
${sampleRefs}

Common styles:
- APA (American Psychological Association)
- MLA (Modern Language Association)
- Chicago
- Vancouver (numbered)
- IEEE
- Harvard

Return ONLY the style name (one word).`;

    const response = await claudeService.generate(prompt, {
      model: 'haiku',
      temperature: 0.1,
      maxTokens: 50
    });

    return response.text.trim();
  }

  /**
   * Link in-text citations to reference entries
   */
  private linkCitationsToReferences(
    citations: InTextCitation[],
    references: ReferenceEntry[]
  ): void {
    for (const citation of citations) {
      if ((citation.type === 'numeric' || citation.type === 'footnote') && citation.numbers.length > 0) {
        // Link numeric and footnote citations by number
        for (const num of citation.numbers) {
          const ref = references.find(r => r.number === num);
          if (ref) {
            citation.linkedRefId = ref.id;
            ref.citedBy.push(citation.id);
            logger.info(`[AI Citation Detector] Linked ${citation.type} citation "${citation.text}" to reference #${num}`);
          }
        }
      } else if (citation.type === 'author-year') {
        // Link author-year citations by matching author name and year
        // Handle multiple citations separated by semicolons: (Brown et al., 2020; Bommasani et al., 2021)
        const linkedRefs = this.matchAuthorYearCitations(citation.text, references);
        if (linkedRefs.length > 0) {
          // Use first match as primary link
          citation.linkedRefId = linkedRefs[0].id;
          for (const ref of linkedRefs) {
            ref.citedBy.push(citation.id);
            logger.info(`[AI Citation Detector] Linked author-year citation "${citation.text}" to reference by ${ref.components?.authors?.[0] || 'unknown'}`);
          }
        }
      }
    }
  }

  /**
   * Match author-year citation(s) to references
   * Handles formats like: (Smith, 2020), (Smith & Jones, 2020), (Smith et al., 2020)
   * Also handles multiple citations: (Brown et al., 2020; Bommasani et al., 2021)
   */
  private matchAuthorYearCitations(citationText: string, references: ReferenceEntry[]): ReferenceEntry[] {
    const matchedRefs: ReferenceEntry[] = [];

    // Split by semicolon for multiple citations
    const citationParts = citationText.split(/;\s*/);

    for (const part of citationParts) {
      const ref = this.matchSingleAuthorYearCitation(part, references);
      if (ref && !matchedRefs.includes(ref)) {
        matchedRefs.push(ref);
      }
    }

    return matchedRefs;
  }

  /**
   * Match a single author-year citation to a reference
   */
  private matchSingleAuthorYearCitation(citationText: string, references: ReferenceEntry[]): ReferenceEntry | null {
    // Extract author name and year from citation
    // IMPORTANT: Order matters - check more specific patterns first (& and et al.) before simple patterns
    const patterns = [
      /([A-Z][a-z]+)\s*(?:&|and)\s*[A-Z][a-z]+,?\s*(\d{4})/i,  // Marcus & Davis, 2019 or Marcus and Davis, 2019
      /([A-Z][a-z]+)\s+et\s+al\.?,?\s*(\d{4})/i,               // Brown et al., 2020
      /([A-Z][a-z]+),?\s*(\d{4})/i,                             // Smith, 2020 - simple pattern last
      /([A-Z][a-z]+(?:\s+et\s+al\.)?)\s*\((\d{4})\)/i,         // Smith (2020) - narrative citation
    ];

    let authorName: string | null = null;
    let year: string | null = null;

    for (const pattern of patterns) {
      const match = citationText.match(pattern);
      if (match) {
        authorName = match[1].replace(/\s+et\s+al\.?/i, '').trim();
        year = match[2];
        break;
      }
    }

    if (!authorName || !year) {
      return null;
    }

    logger.info(`[AI Citation Detector] Looking for author "${authorName}" year "${year}"`);

    // Find matching reference
    for (const ref of references) {
      const refAuthors = ref.components?.authors || [];
      const refYear = ref.components?.year;

      // Check if year matches
      if (refYear !== year) continue;

      // Check if any author's last name matches
      for (const author of refAuthors) {
        const lastName = this.extractLastName(author);
        if (lastName.toLowerCase() === authorName.toLowerCase()) {
          return ref;
        }
      }
    }

    return null;
  }

  /**
   * Extract last name from author string
   * Handles: "Smith, J.", "J. Smith", "Smith"
   */
  private extractLastName(author: string): string {
    if (!author) return '';

    // If contains comma, last name is before comma: "Smith, J." -> "Smith"
    if (author.includes(',')) {
      return author.split(',')[0].trim();
    }

    // Otherwise, last name is the last word (unless it's initials)
    const parts = author.trim().split(/\s+/);
    if (parts.length === 1) return parts[0];

    // If last part looks like initials, first part is last name
    const lastPart = parts[parts.length - 1];
    if (lastPart.length <= 3 && /^[A-Z]\.?$/.test(lastPart.replace(/\./g, ''))) {
      return parts[0];
    }

    return lastPart;
  }

  /**
   * Identify citation issues
   */
  private identifyIssues(
    citations: InTextCitation[],
    references: ReferenceEntry[]
  ): CitationIssue[] {
    const issues: CitationIssue[] = [];

    // Find duplicate references
    const refTexts = new Map<string, ReferenceEntry[]>();
    for (const ref of references) {
      const normalized = ref.rawText.toLowerCase().trim();
      if (!refTexts.has(normalized)) {
        refTexts.set(normalized, []);
      }
      refTexts.get(normalized)!.push(ref);
    }

    for (const refs of refTexts.values()) {
      if (refs.length > 1) {
        issues.push({
          type: 'duplicate_reference',
          severity: 'warning',
          message: `Duplicate reference found: ${refs.map(r => r.number).join(', ')}`,
          referenceId: refs[0].id
        });
      }
    }

    // Find missing references (cited but not in list)
    for (const citation of citations) {
      if (!citation.linkedRefId && citation.type === 'numeric') {
        issues.push({
          type: 'missing_reference',
          severity: 'error',
          message: `Citation ${citation.text} has no corresponding reference`,
          citationId: citation.id,
          location: { paragraph: citation.position.paragraph }
        });
      }
    }

    // Find unused references (in list but not cited)
    for (const ref of references) {
      if (ref.citedBy.length === 0) {
        issues.push({
          type: 'unused_reference',
          severity: 'warning',
          message: `Reference ${ref.number} is not cited in the text`,
          referenceId: ref.id,
          location: { referenceNumber: ref.number }
        });
      }
    }

    return issues;
  }

  /**
   * Calculate statistics
   */
  private calculateStatistics(
    citations: InTextCitation[],
    references: ReferenceEntry[],
    issues: CitationIssue[]
  ) {
    return {
      totalCitations: citations.length,
      totalReferences: references.length,
      duplicateReferences: issues.filter(i => i.type === 'duplicate_reference').length,
      missingReferences: issues.filter(i => i.type === 'missing_reference').length,
      unusedReferences: issues.filter(i => i.type === 'unused_reference').length
    };
  }
}

export const aiCitationDetectorService = new AICitationDetectorService();
