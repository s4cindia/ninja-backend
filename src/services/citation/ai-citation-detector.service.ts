/**
 * AI-Powered Citation Detection Service
 * Uses Claude AI to detect citations without regex
 *
 * Security measures:
 * - Input size limits (max 100K characters)
 * - Content sanitization before AI processing
 * - Prompt injection pattern detection
 */

import { claudeService } from '../ai/claude.service';
import { logger } from '../../lib/logger';
import { z } from 'zod';

// ============================================
// ZOD SCHEMAS FOR AI RESPONSE VALIDATION
// ============================================

/** Schema for AI-detected in-text citation */
const aiCitationSchema = z.object({
  text: z.string().optional().default(''),
  paragraph: z.number().optional().default(0),
  startChar: z.number().optional().default(0),
  type: z.enum(['numeric', 'author-year', 'footnote', 'superscript']).optional().default('numeric'),
  format: z.enum(['bracket', 'parenthesis', 'superscript']).optional().default('bracket'),
  numbers: z.array(z.number()).optional().default([]),
  context: z.string().optional().default(''),
});

/** Schema for AI-extracted reference entry */
const aiReferenceSchema = z.object({
  number: z.number().optional(),
  rawText: z.string().optional().default(''),
  authors: z.array(z.string()).optional().default([]),
  year: z.string().optional(),
  title: z.string().optional(),
  journal: z.string().optional(),
  volume: z.string().optional(),
  issue: z.string().optional(),
  pages: z.string().optional(),
  doi: z.string().optional(),
  url: z.string().optional(),
  publisher: z.string().optional(),
  editors: z.array(z.string()).optional(),
});

/** Schema for array of citations from AI */
const aiCitationsArraySchema = z.array(aiCitationSchema);

/** Schema for array of references from AI */
const aiReferencesArraySchema = z.array(aiReferenceSchema);

// ============================================
// SECURITY CONSTANTS
// ============================================

/** Maximum document size for AI processing (100KB of text) */
const MAX_DOCUMENT_SIZE = 100_000;

/** Maximum size sent in a single AI prompt (50KB) */
const MAX_PROMPT_CONTENT_SIZE = 50_000;

/** Patterns that might indicate prompt injection attempts */
const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|prompts?)/i,
  /disregard\s+(all\s+)?(previous|above|prior)/i,
  /forget\s+(everything|all|your)\s+(instructions?|rules?|training)/i,
  /you\s+are\s+now\s+(a|an|the)/i,
  /new\s+instructions?:/i,
  /system\s*:\s*/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /```\s*(system|assistant|user)\s*\n/i,
];

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
  /** AI token usage for cost tracking */
  tokenUsage?: {
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    estimatedCostUSD: number;
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

// Claude Sonnet 4 pricing (approximate)
const CLAUDE_PRICING = {
  inputPer1K: 0.003,   // $3 per 1M input tokens
  outputPer1K: 0.015,  // $15 per 1M output tokens
};

/** Token usage for a single AI call */
interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
}

class AICitationDetectorService {
  /**
   * Calculate cost from token usage (pure function - no instance state)
   */
  private calculateCost(usage: TokenUsage): number {
    const inputCost = (usage.promptTokens / 1000) * CLAUDE_PRICING.inputPer1K;
    const outputCost = (usage.completionTokens / 1000) * CLAUDE_PRICING.outputPer1K;
    return inputCost + outputCost;
  }

  // ============================================
  // INPUT VALIDATION & SANITIZATION
  // ============================================

  /**
   * Validate document input before processing
   * @throws Error if validation fails
   */
  private validateInput(documentText: string): void {
    if (!documentText || typeof documentText !== 'string') {
      throw new Error('Invalid document: text content is required');
    }

    if (documentText.length > MAX_DOCUMENT_SIZE) {
      throw new Error(`Document exceeds maximum size limit of ${MAX_DOCUMENT_SIZE} characters (got ${documentText.length})`);
    }

    if (documentText.trim().length === 0) {
      throw new Error('Invalid document: content cannot be empty');
    }
  }

  /**
   * Check for potential prompt injection patterns
   * @returns Array of detected suspicious patterns
   */
  private detectInjectionAttempts(text: string): string[] {
    const detected: string[] = [];

    for (const pattern of INJECTION_PATTERNS) {
      const match = text.match(pattern);
      if (match) {
        detected.push(match[0]);
      }
    }

    return detected;
  }

  /**
   * Sanitize document text for safe AI processing
   * - Removes control characters
   * - Escapes potential injection patterns
   * - Truncates to safe size
   */
  private sanitizeForAI(text: string, maxLength: number = MAX_PROMPT_CONTENT_SIZE): string {
    // Check for injection attempts (log but don't block - could be legitimate content)
    const injectionAttempts = this.detectInjectionAttempts(text);
    if (injectionAttempts.length > 0) {
      logger.warn(`[AI Citation Detector] Potential prompt injection patterns detected: ${injectionAttempts.join(', ')}`);
    }

    let sanitized = text;

    // Remove null bytes and control characters (except newlines and tabs)
    sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

    // Normalize whitespace (multiple spaces/tabs to single space, preserve newlines)
    sanitized = sanitized.replace(/[^\S\n]+/g, ' ');

    // Remove excessive consecutive newlines (more than 3)
    sanitized = sanitized.replace(/\n{4,}/g, '\n\n\n');

    // Escape backticks that might break JSON/code fence parsing
    sanitized = sanitized.replace(/```/g, '` ` `');

    // Truncate to maximum length, trying to break at word boundary
    if (sanitized.length > maxLength) {
      let truncateAt = maxLength;
      // Find last space within the limit
      const lastSpace = sanitized.lastIndexOf(' ', maxLength);
      if (lastSpace > maxLength * 0.8) {
        truncateAt = lastSpace;
      }
      sanitized = sanitized.substring(0, truncateAt);
      logger.info(`[AI Citation Detector] Document truncated from ${text.length} to ${truncateAt} characters`);
    }

    return sanitized;
  }

  /**
   * Prepare document content for AI prompt
   * Combines validation, sanitization, and truncation
   */
  private prepareDocumentForAI(documentText: string): string {
    // Validate input
    this.validateInput(documentText);

    // Sanitize content
    const sanitized = this.sanitizeForAI(documentText, MAX_PROMPT_CONTENT_SIZE);

    // Add truncation marker if content was shortened
    const wasTruncated = sanitized.length < documentText.length;

    return wasTruncated ? `${sanitized}\n\n[Document truncated - ${documentText.length - sanitized.length} characters omitted]` : sanitized;
  }

  /**
   * Analyze document for citations using AI
   * @param documentText - The document text to analyze (max 100K characters)
   * @param options - Analysis options
   * @throws Error if document exceeds size limits, fails validation, or AI service unavailable
   */
  async analyzeDocument(
    documentText: string,
    options: {
      detectStyle?: boolean;
      linkCitations?: boolean;
    } = {}
  ): Promise<CitationAnalysis> {
    logger.info('[AI Citation Detector] Starting document analysis');
    logger.info('[AI Citation Detector] Using Claude AI service for citation detection');

    // Fail fast if AI service is not available
    if (!claudeService.isAvailable()) {
      const errorMsg = 'AI service unavailable: ANTHROPIC_API_KEY not configured';
      logger.error(`[AI Citation Detector] ${errorMsg}`);
      throw new Error(errorMsg);
    }

    // Log API key validation status
    const keyValidation = claudeService.validateApiKey();
    logger.info(`[AI Citation Detector] Claude API key validation: ${JSON.stringify(keyValidation)}`);

    // Local accumulator - NOT instance state (safe for concurrent requests)
    const accumulatedUsage: TokenUsage = { promptTokens: 0, completionTokens: 0 };

    try {
      // Validate and sanitize input before processing
      this.validateInput(documentText);
      const sanitizedText = this.prepareDocumentForAI(documentText);
      logger.info(`[AI Citation Detector] Document validated (${documentText.length} chars, sanitized to ${sanitizedText.length} chars)`);

      // Step 1: Detect in-text citations using AI
      const { citations: inTextCitations, usage: citationUsage } = await this.detectInTextCitations(sanitizedText);
      accumulatedUsage.promptTokens += citationUsage.promptTokens;
      accumulatedUsage.completionTokens += citationUsage.completionTokens;
      logger.info(`[AI Citation Detector] Found ${inTextCitations.length} in-text citations`);

      // Step 2: Extract reference list using AI
      const { references, usage: refUsage } = await this.extractReferenceList(sanitizedText);
      accumulatedUsage.promptTokens += refUsage.promptTokens;
      accumulatedUsage.completionTokens += refUsage.completionTokens;
      logger.info(`[AI Citation Detector] Extracted ${references.length} references`);

      // Step 3: Detect citation style
      let detectedStyle = 'Unknown';
      if (options.detectStyle !== false) {
        const { style, usage: styleUsage } = await this.detectCitationStyle(sanitizedText, references);
        accumulatedUsage.promptTokens += styleUsage.promptTokens;
        accumulatedUsage.completionTokens += styleUsage.completionTokens;
        detectedStyle = style;
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

      // Calculate token usage and cost from local accumulator
      const totalTokens = accumulatedUsage.promptTokens + accumulatedUsage.completionTokens;
      const estimatedCostUSD = this.calculateCost(accumulatedUsage);
      logger.info(`[AI Citation Detector] Token usage: ${totalTokens} total (est. $${estimatedCostUSD.toFixed(4)})`);

      return {
        inTextCitations,
        references,
        issues,
        detectedStyle,
        statistics,
        tokenUsage: {
          promptTokens: accumulatedUsage.promptTokens,
          completionTokens: accumulatedUsage.completionTokens,
          totalTokens,
          estimatedCostUSD
        }
      };
    } catch (error) {
      logger.error('[AI Citation Detector] Analysis failed:', error);
      throw error;
    }
  }

  /**
   * Detect all in-text citations using AI (NO REGEX)
   * @param documentText - Pre-sanitized document text
   * @returns Citations array and token usage for this call
   * @throws Error if AI service is unavailable or API call fails
   */
  private async detectInTextCitations(documentText: string): Promise<{
    citations: InTextCitation[];
    usage: TokenUsage;
  }> {
    const emptyUsage: TokenUsage = { promptTokens: 0, completionTokens: 0 };

    // Build prompt with clear boundaries to prevent injection
    const prompt = `TASK: Find ALL in-text citations in the document below.

INSTRUCTIONS:
- IGNORE superscript numbers immediately after author names (these are affiliations, NOT citations)
- Find NUMERIC citations: [1], [2], [3-5], (1), (2)
- Find FOOTNOTE citations: superscript numbers ¹ ² ³ at end of sentences
- Find AUTHOR-YEAR citations: (Smith, 2020), (Smith & Jones, 2020), (Smith et al., 2020)

OUTPUT FORMAT (JSON array only):
[{"text":"[1,2]","paragraph":1,"startChar":50,"type":"numeric","format":"bracket","numbers":[1,2],"context":"ability [1,2]. However"}]

Fields:
- text: exact citation text
- paragraph: paragraph number (1-based)
- startChar: character position
- type: "numeric" | "author-year" | "footnote"
- format: "bracket" | "parenthesis" | "superscript"
- numbers: array of reference numbers (empty for author-year)
- context: brief surrounding text (max 30 chars)

---BEGIN DOCUMENT---
${documentText}
---END DOCUMENT---

Return ONLY the JSON array, no explanations.`;

    // Call AI service - let errors propagate up
    const result = await claudeService.generateJSONWithUsage(prompt, {
      model: 'sonnet',
      temperature: 0.1,
      maxTokens: 16384
    });

    const usage: TokenUsage = result.usage
      ? { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens }
      : emptyUsage;

    // Log raw AI response for debugging
    logger.info(`[AI Citation Detector] Raw citation response type: ${typeof result.data}`);
    logger.info(`[AI Citation Detector] Raw citation response (preview): ${JSON.stringify(result.data).substring(0, 500)}`);

    const rawData = Array.isArray(result.data) ? result.data : [];
    logger.info(`[AI Citation Detector] Citation array length after parsing: ${rawData.length}`);

    // Validate AI response with Zod schema
    const validation = aiCitationsArraySchema.safeParse(rawData);
    if (!validation.success) {
      logger.error('[AI Citation Detector] AI response validation FAILED for citations');
      logger.error('[AI Citation Detector] Validation errors:', JSON.stringify(validation.error.issues, null, 2));
      logger.error('[AI Citation Detector] Raw data that failed validation:', JSON.stringify(rawData).substring(0, 1000));
      // Return empty array on validation failure - don't silently store malformed data
      return { citations: [], usage };
    }
    logger.info(`[AI Citation Detector] Citation validation PASSED with ${validation.data.length} citations`);

    const citations = validation.data.map((c, idx) => ({
      id: `citation-${idx + 1}`,
      text: c.text,
      position: {
        paragraph: c.paragraph,
        sentence: 0,
        startChar: c.startChar,
        endChar: c.startChar + c.text.length
      },
      type: c.type,
      format: c.format,
      numbers: c.numbers,
      context: c.context
    }));

    return { citations, usage };
  }

  /**
   * Extract reference list using AI (NO REGEX)
   * @param documentText - Pre-sanitized document text
   * @returns References array and token usage for this call
   * @throws Error if AI service is unavailable or API call fails
   */
  private async extractReferenceList(documentText: string): Promise<{
    references: ReferenceEntry[];
    usage: TokenUsage;
  }> {
    const emptyUsage: TokenUsage = { promptTokens: 0, completionTokens: 0 };

    // Build prompt with clear boundaries to prevent injection
    const prompt = `TASK: Extract ALL references from the reference section.

INSTRUCTIONS:
- Find the References, Bibliography, Footnotes, Notes, or Works Cited section in the document
- For Chicago/Turabian style: extract references from the Footnotes or Notes section
- Extract each reference with available metadata

OUTPUT FORMAT:
[{"number":1,"rawText":"Smith J. Article Title. Journal. 2020;10:123.","authors":["Smith J"],"year":"2020","title":"Article Title","journal":"Journal","volume":"10","pages":"123","doi":"10.1234/ex"}]

Fields to extract (omit if not present):
- number: reference number
- rawText: complete reference text
- authors: array of author names
- year: publication year
- title: article/book title
- journal: journal name
- volume, issue, pages: publication details
- doi: DOI (without "doi:" prefix)
- url: URL if present
- publisher: publisher name

---BEGIN DOCUMENT---
${documentText}
---END DOCUMENT---

Return ONLY the JSON array.`;

    // Call AI service - let errors propagate up
    const result = await claudeService.generateJSONWithUsage(prompt, {
      model: 'sonnet',
      temperature: 0.1,
      maxTokens: 16384
    });

    const usage: TokenUsage = result.usage
      ? { promptTokens: result.usage.promptTokens, completionTokens: result.usage.completionTokens }
      : emptyUsage;

    // Log raw AI response for debugging reference extraction issues
    logger.info(`[AI Citation Detector] Raw reference extraction response type: ${typeof result.data}`);
    logger.info(`[AI Citation Detector] Raw reference extraction response (preview): ${JSON.stringify(result.data).substring(0, 500)}`);

    const rawData = Array.isArray(result.data) ? result.data : [];
    logger.info(`[AI Citation Detector] Reference array length after parsing: ${rawData.length}`);

    // Validate AI response with Zod schema
    const validation = aiReferencesArraySchema.safeParse(rawData);
    if (!validation.success) {
      logger.error('[AI Citation Detector] AI response validation FAILED for references');
      logger.error('[AI Citation Detector] Validation errors:', JSON.stringify(validation.error.issues, null, 2));
      logger.error('[AI Citation Detector] Raw data that failed validation:', JSON.stringify(rawData).substring(0, 1000));
      // Return empty array on validation failure - don't silently store malformed data
      return { references: [], usage };
    }
    logger.info(`[AI Citation Detector] Reference validation PASSED with ${validation.data.length} references`);

    const references = validation.data.map((r, idx) => ({
      id: `ref-${r.number ?? idx + 1}`,
      number: r.number ?? idx + 1,
      rawText: r.rawText,
      components: {
        authors: r.authors,
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

    return { references, usage };
  }

  /**
   * Detect citation style using AI
   * @param _documentText - Document text (unused, kept for API compatibility)
   * @param references - Extracted references to analyze
   * @returns Detected style and token usage for this call
   */
  private async detectCitationStyle(
    _documentText: string,
    references: ReferenceEntry[]
  ): Promise<{ style: string; usage: TokenUsage }> {
    const emptyUsage: TokenUsage = { promptTokens: 0, completionTokens: 0 };

    if (references.length === 0) {
      return { style: 'Unknown', usage: emptyUsage };
    }

    // Only use reference text, not raw document content
    // Sanitize reference text as well
    const sampleRefs = references
      .slice(0, 3)
      .map(r => this.sanitizeForAI(r.rawText, 500))
      .join('\n');

    const prompt = `TASK: Identify the citation style from these reference entries.

KEY DISTINGUISHING FEATURES:
- Vancouver/IEEE: Numbered refs, author initials after surname (Brown TB), abbreviated journals, volume;pages format (33:1877-1901), NO year in parentheses
- APA: Authors with comma (Brown, T. B.), year in parentheses after authors (2020), full journal names, volume(issue), pages
- MLA: Author. "Title." Journal, vol., no., year, pages. No parentheses around year.
- Chicago: Author. "Title." Journal Volume, no. Issue (Year): pages.
- Harvard: Author (Year) Title. Journal, Volume(Issue), pages.

---BEGIN REFERENCES---
${sampleRefs}
---END REFERENCES---

Based on the formatting patterns above, identify the style.
Return ONLY the style name (one word): APA, MLA, Chicago, Vancouver, IEEE, or Harvard`;

    const response = await claudeService.generate(prompt, {
      model: 'haiku',
      temperature: 0.1,
      maxTokens: 50
    });

    const usage: TokenUsage = response.usage
      ? { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens }
      : emptyUsage;

    // Extract style name from response - AI may return full sentence or just the style
    const validStyles = ['APA', 'MLA', 'Chicago', 'Vancouver', 'IEEE', 'Harvard'];
    const rawResponse = response.text.trim();

    logger.info(`[AI Citation Detector] Style detection raw response: "${rawResponse}"`);

    // Look for any valid style name within the response (case-insensitive)
    let style = 'Unknown';
    for (const validStyle of validStyles) {
      if (rawResponse.toLowerCase().includes(validStyle.toLowerCase())) {
        style = validStyle;
        break;
      }
    }

    logger.info(`[AI Citation Detector] Final detected style: ${style}`);
    return { style, usage };
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
