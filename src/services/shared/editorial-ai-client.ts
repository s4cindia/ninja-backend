/**
 * Editorial AI Client Service
 * Provides unified interface for Editorial Services AI operations
 * Built on top of existing GeminiService
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { geminiService } from '../ai/gemini.service';
import { claudeService } from '../ai/claude.service';
import { aiConfig } from '../../config/ai.config';
import { logger } from '../../lib/logger';
import { AppError } from '../../utils/app-error';
import type {
  TextChunk,
  EmbeddingResult,
  ClassificationResult,
  ExtractedCitation,
  ParsedCitation,
  StyleViolation,
  ParaphraseResult,
  ExtractedStyleRules,
} from '../../types/editorial.types';

const EMBEDDING_MODEL = 'text-embedding-004';
const EMBEDDING_DIMENSIONS = 768;

// Delay between chunk processing to avoid rate limiting
const CHUNK_PROCESSING_DELAY_MS = 500;

// Structural delimiters for prompt injection protection
// These wrap user content to clearly separate it from instructions
const USER_CONTENT_START = '<<<USER_CONTENT_START>>>';
const USER_CONTENT_END = '<<<USER_CONTENT_END>>>';

export class EditorialAiClient {
  private embeddingClient: GoogleGenerativeAI | null = null;

  private getEmbeddingClient(): GoogleGenerativeAI {
    if (!this.embeddingClient) {
      if (!aiConfig.gemini.apiKey) {
        throw AppError.internal('GEMINI_API_KEY is not configured');
      }
      this.embeddingClient = new GoogleGenerativeAI(aiConfig.gemini.apiKey);
    }
    return this.embeddingClient;
  }

  /**
   * Sanitize text to prevent prompt injection attacks
   * Uses length-preserving replacements to maintain offset accuracy
   */
  private sanitizeForPrompt(text: string): string {
    // Helper to preserve length when replacing
    const preserveLength = (replacement: string, originalLength: number): string => {
      if (replacement.length >= originalLength) {
        return replacement.slice(0, originalLength);
      }
      return replacement.padEnd(originalLength, ' ');
    };

    // Replace control characters with spaces (length-preserving)
    let sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' ');

    // Escape patterns that could be used for prompt injection (length-preserving)
    const injectionPatterns = [
      /\bignore\s+(all\s+)?(previous|above|prior)\s+instructions?\b/gi,
      /\bforget\s+(all\s+)?(previous|above|prior)\s+instructions?\b/gi,
      /\bdisregard\s+(all\s+)?(previous|above|prior)\s+instructions?\b/gi,
      /\bnew\s+instructions?\s*:/gi,
      /\bsystem\s*:\s*/gi,
      /\bassistant\s*:\s*/gi,
      /\bhuman\s*:\s*/gi,
      /\buser\s*:\s*/gi,
      /```\s*(system|assistant|user|human)/gi,
    ];

    for (const pattern of injectionPatterns) {
      sanitized = sanitized.replace(pattern, (match) =>
        preserveLength('[FILTERED]', match.length)
      );
    }

    // Limit consecutive special characters (length-preserving)
    sanitized = sanitized.replace(/[#*`]{10,}/g, (match) =>
      preserveLength(match.substring(0, 5) + '...', match.length)
    );

    return sanitized;
  }

  /**
   * Generate semantic embeddings for text chunks
   * Used by: Plagiarism Detection (US-1.1)
   * @param chunks - Array of text chunks to embed
   * @returns Array of embedding results with 768-dimensional vectors
   */
  async generateEmbeddings(chunks: TextChunk[]): Promise<EmbeddingResult[]> {
    try {
      const client = this.getEmbeddingClient();
      const embeddingModel = client.getGenerativeModel({ model: EMBEDDING_MODEL });
      
      const results: EmbeddingResult[] = [];
      
      for (const chunk of chunks) {
        try {
          const result = await embeddingModel.embedContent(chunk.text);
          const embedding = result.embedding;
          
          results.push({
            chunkId: chunk.id,
            vector: embedding.values.slice(0, EMBEDDING_DIMENSIONS),
            tokenCount: Math.ceil(chunk.text.length / 4), // Approximate token count
          });
        } catch (error) {
          logger.warn(`[Editorial AI] Failed to embed chunk ${chunk.id}`, error instanceof Error ? error : undefined);
          results.push({
            chunkId: chunk.id,
            vector: null as unknown as number[],
            tokenCount: 0,
            success: false,
          } as EmbeddingResult);
        }
      }
      
      return results;
    } catch (error) {
      logger.error('[Editorial AI] Embedding generation failed', error instanceof Error ? error : undefined);
      throw AppError.internal('Failed to generate embeddings');
    }
  }

  /**
   * Detect and extract all citations from text
   * Used by: Citation Management (US-4.1)
   * @param text - Full text to analyze for citations
   * @returns Array of extracted citations with type and location
   */
  async detectCitations(text: string): Promise<ExtractedCitation[]> {
    const prompt = `Analyze the following text and extract all citations. Identify each citation's type and style.

TEXT:
${text.slice(0, 8000)}

For each citation found, return a JSON array with objects containing:
- text: the full citation text as it appears
- type: one of "parenthetical", "narrative", "footnote", "endnote"
- style: one of "APA", "MLA", "Chicago", "Vancouver", "unknown"
- paragraphIndex: approximate paragraph number (0-indexed)
- startOffset: character position where citation starts
- endOffset: character position where citation ends
- confidence: 0-100 confidence score

IMPORTANT RULES:
- Do NOT include figure references like "(see Figure 1)" or "(Table 2)"
- Do NOT include page numbers alone like "(p. 42)"
- DO include author-date citations like "(Smith, 2020)"
- DO include narrative citations like "According to Smith (2020)"
- DO include superscript/footnote markers if the notes are provided

Respond with a JSON array only:`;

    try {
      const response = await geminiService.generateStructuredOutput<ExtractedCitation[]>(prompt, {
        temperature: 0.1,
        maxOutputTokens: 4000,
      });

      return response.data.map((citation) => {
        const raw = citation as unknown as Record<string, unknown>;
        return {
          text: raw.text as string,
          type: raw.type as ExtractedCitation['type'],
          style: raw.style as ExtractedCitation['style'],
          confidence: raw.confidence as number,
          location: {
            pageNumber: undefined,
            paragraphIndex: (raw.paragraphIndex as number) ?? 0,
            startOffset: (raw.startOffset as number) ?? 0,
            endOffset: (raw.endOffset as number) ?? 0,
          },
        };
      });
    } catch (error) {
      logger.error('[Editorial AI] Citation detection failed', error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Parse citation into structured components
   * Used by: Citation Management (US-4.2)
   * @param citationText - Raw citation text to parse
   * @returns Parsed citation with extracted components
   */
  async parseCitation(citationText: string): Promise<ParsedCitation> {
    const prompt = `Parse this citation into structured components:

CITATION:
${citationText}

Extract and return a JSON object with these fields:
- authors: array of author names (Last, First format)
- year: publication year (string or null)
- title: work title (or null)
- source: journal/publisher name (or null)
- volume: volume number (or null)
- issue: issue number (or null)
- pages: page range (or null)
- doi: DOI if present (or null)
- url: URL if present (or null)
- type: one of "journal", "book", "chapter", "website", "conference", "unknown"
- confidence: object with confidence scores (0-100) for each extracted field
- rawText: the original citation text

Respond with JSON only:`;

    try {
      const response = await geminiService.generateStructuredOutput<ParsedCitation>(prompt, {
        temperature: 0.1,
        maxOutputTokens: 1000,
      });

      return {
        ...response.data,
        rawText: citationText,
      };
    } catch (error) {
      logger.error('[Editorial AI] Citation parsing failed', error instanceof Error ? error : undefined);
      return {
        authors: [],
        type: 'unknown',
        confidence: {},
        rawText: citationText,
      };
    }
  }

  /**
   * Classify similarity match type
   * Used by: Plagiarism Detection (US-1.5)
   * @param sourceText - Original source text
   * @param matchedText - Text that potentially matches the source
   * @returns Classification with confidence and reasoning
   */
  async classifyMatch(
    sourceText: string, 
    matchedText: string
  ): Promise<ClassificationResult> {
    const prompt = `Classify this text similarity match.

SOURCE TEXT:
${sourceText.slice(0, 2000)}

MATCHED TEXT:
${matchedText.slice(0, 2000)}

Classify as one of:
- VERBATIM_COPY: Word-for-word copy or near-identical with minor changes
- PARAPHRASED: Same ideas but rewritten significantly
- COMMON_PHRASE: Common expressions, idioms, or standard terminology
- PROPERLY_CITED: Text is quoted and attributed properly
- COINCIDENTAL: Similar wording that appears coincidental

Return JSON with:
- classification: one of the above categories
- confidence: 0-100 confidence score
- reasoning: brief explanation of the classification

Examples:
- "The quick brown fox jumps" vs "The quick brown fox leaps" → VERBATIM_COPY (95%)
- "The mitochondria is the powerhouse of the cell" → COMMON_PHRASE (90%)
- Smith states, "original quote here" (2020, p. 42) → PROPERLY_CITED (85%)

Respond with JSON only:`;

    try {
      const response = await geminiService.generateStructuredOutput<ClassificationResult>(prompt, {
        temperature: 0.2,
        maxOutputTokens: 500,
      });

      return response.data;
    } catch (error) {
      logger.error('[Editorial AI] Match classification failed', error instanceof Error ? error : undefined);
      return {
        classification: 'COINCIDENTAL',
        confidence: 0,
        reasoning: 'Classification failed due to an error',
      };
    }
  }

  /**
   * Analyze text for paraphrase detection
   * Used by: Plagiarism Detection (US-1.2)
   * @param text1 - First text passage
   * @param text2 - Second text passage to compare
   * @returns Paraphrase detection result
   */
  async detectParaphrase(
    text1: string, 
    text2: string
  ): Promise<ParaphraseResult> {
    const prompt = `Analyze whether these two text passages express the same ideas (paraphrase detection).

TEXT 1:
${text1.slice(0, 2000)}

TEXT 2:
${text2.slice(0, 2000)}

Determine if Text 2 is a paraphrase of Text 1 (same meaning, different words).

Return JSON with:
- isParaphrase: boolean (true if same core meaning)
- confidence: 0-100 confidence score
- matchedPhrases: array of objects with "original" and "paraphrased" showing equivalent phrases
- explanation: brief explanation of the analysis

Respond with JSON only:`;

    try {
      const response = await geminiService.generateStructuredOutput<ParaphraseResult>(prompt, {
        temperature: 0.2,
        maxOutputTokens: 1500,
      });

      return response.data;
    } catch (error) {
      logger.error('[Editorial AI] Paraphrase detection failed', error instanceof Error ? error : undefined);
      return {
        isParaphrase: false,
        confidence: 0,
        matchedPhrases: [],
        explanation: 'Analysis failed due to an error',
      };
    }
  }

  /**
   * Validate text against style guide rules
   * Used by: Style Validation (US-7.1, US-7.2)
   * @param text - Full document text to validate
   * @param styleGuide - Style guide to use
   * @param customRules - Optional custom rules to apply
   * @returns Array of style violations found with references
   */
  async validateStyle(
    text: string,
    styleGuide: 'chicago' | 'apa' | 'mla' | 'vancouver' | 'nature' | 'ieee' | 'ap' | 'general' | 'academic' | 'custom',
    customRules?: string[]
  ): Promise<StyleViolation[]> {
    const styleGuideRules = this.getStyleGuideRules(styleGuide);
    const maxChunkSize = 20000; // Process in 20K chunks for full document coverage

    logger.info(`[Editorial AI] Validating ${text.length} chars with ${styleGuide} style`);

    // For small documents, process directly
    if (text.length <= maxChunkSize) {
      return this.validateTextChunk(text, 0, 1, styleGuide, styleGuideRules, customRules);
    }

    // For large documents, split into chunks and process each
    const chunks = this.splitTextIntoChunks(text, maxChunkSize);
    logger.info(`[Editorial AI] Document split into ${chunks.length} chunks for processing`);

    const allViolations: StyleViolation[] = [];

    // Process chunks sequentially to avoid rate limits
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      logger.info(`[Editorial AI] Processing chunk ${i + 1}/${chunks.length} (offset: ${chunk.offset}, lines from: ${chunk.lineOffset})`);

      try {
        const chunkViolations = await this.validateTextChunk(
          chunk.text,
          chunk.offset,
          chunk.lineOffset,
          styleGuide,
          styleGuideRules,
          customRules
        );

        // Adjust offsets for the chunk position in the full document
        const adjustedViolations = chunkViolations.map(v => ({
          ...v,
          location: {
            ...v.location,
            start: v.location.start + chunk.offset,
            end: v.location.end + chunk.offset,
          },
        }));

        allViolations.push(...adjustedViolations);
        logger.info(`[Editorial AI] Chunk ${i + 1} found ${chunkViolations.length} violations`);
      } catch (error) {
        logger.error(`[Editorial AI] Error processing chunk ${i + 1}:`, error);
        // Continue with other chunks even if one fails
      }

      // Small delay between chunks to avoid rate limiting
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, CHUNK_PROCESSING_DELAY_MS));
      }
    }

    logger.info(`[Editorial AI] Total violations found: ${allViolations.length}`);
    return allViolations;
  }

  /**
   * Split text into chunks at paragraph boundaries
   */
  private splitTextIntoChunks(text: string, maxChunkSize: number): Array<{ text: string; offset: number; lineOffset: number }> {
    const chunks: Array<{ text: string; offset: number; lineOffset: number }> = [];
    let currentOffset = 0;
    let currentLineOffset = 1;

    while (currentOffset < text.length) {
      let endOffset = Math.min(currentOffset + maxChunkSize, text.length);

      // Try to break at paragraph boundary
      if (endOffset < text.length) {
        const lastParagraph = text.lastIndexOf('\n\n', endOffset);
        if (lastParagraph > currentOffset + maxChunkSize / 2) {
          endOffset = lastParagraph + 2;
        } else {
          // Fall back to sentence boundary
          const lastSentence = text.lastIndexOf('. ', endOffset);
          if (lastSentence > currentOffset + maxChunkSize / 2) {
            endOffset = lastSentence + 2;
          }
        }
      }

      const chunkText = text.slice(currentOffset, endOffset);
      chunks.push({
        text: chunkText,
        offset: currentOffset,
        lineOffset: currentLineOffset,
      });

      // Count lines in this chunk for next chunk's line offset
      currentLineOffset += (chunkText.match(/\n/g) || []).length;
      currentOffset = endOffset;
    }

    return chunks;
  }

  /**
   * Validate a single chunk of text
   */
  private async validateTextChunk(
    text: string,
    charOffset: number,
    lineOffset: number,
    styleGuide: 'chicago' | 'apa' | 'mla' | 'vancouver' | 'nature' | 'ieee' | 'ap' | 'general' | 'academic' | 'custom',
    styleGuideRules: { name: string; referencePrefix: string; rules: string },
    customRules?: string[]
  ): Promise<StyleViolation[]> {
    // Sanitize text to prevent prompt injection
    const sanitizedText = this.sanitizeForPrompt(text);

    // Add line numbers to text for reference
    const lines = sanitizedText.split('\n');
    const numberedText = lines.map((line, idx) => `[Line ${lineOffset + idx}] ${line}`).join('\n');

    const customRulesText = customRules?.length
      ? `\n\n**PRIORITY: CUSTOM HOUSE RULES (MUST CHECK THESE FIRST)**
These are specific rules from the publisher's style guide that MUST be enforced:
${customRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

For TERMINOLOGY rules with "REQUIRED TERM": Flag ANY text that discusses the same concept but uses different wording.
For PUNCTUATION rules: Check for missing or incorrect punctuation as described.
For CAPITALIZATION rules: Flag text that doesn't follow the capitalization requirements.`
      : '';

    // Use structural delimiters to clearly separate user content from instructions
    // This helps prevent prompt injection attacks
    const prompt = `You are an expert editorial style checker. Thoroughly validate this document against ${styleGuideRules.name}.
${customRulesText}

GENERAL STYLE GUIDE RULES:
${styleGuideRules.rules}

DOCUMENT TEXT (with line numbers for reference):
${USER_CONTENT_START}
${numberedText}
${USER_CONTENT_END}

VALIDATION TASK:
${customRules?.length ? 'IMPORTANT: Check custom house rules FIRST - these are the priority rules from the publisher.' : ''}
Carefully analyze EVERY sentence and paragraph for style violations. Check for:
1. Custom house rule violations (if any custom rules provided above)
2. Punctuation errors (commas, semicolons, colons, dashes)
3. Capitalization issues (titles, proper nouns, sentence starts)
4. Number formatting (when to spell out vs use numerals)
5. Abbreviation usage (first use, formatting)
6. Grammar issues (subject-verb agreement, tense consistency)
7. Word choice and terminology (preferred terms, avoid terms)
8. Citation formatting (if applicable)
9. Quotation formatting
10. Hyphenation rules

For EACH violation found, return:
- rule: Specific rule name (e.g., "Serial Comma Required", "Spell Out Numbers Under 10")
- ruleReference: Style guide reference (e.g., "${styleGuideRules.referencePrefix} 6.28" or "APA 7 Section 6.32")
- lineNumber: The line number where the issue occurs (from [Line X] markers)
- originalText: The EXACT problematic text (copy directly from document)
- suggestedFix: The corrected version of the text
- explanation: Brief explanation of why this is a violation
- severity: "error" (must fix), "warning" (should fix), or "suggestion" (consider fixing)

Return a JSON array. Be thorough - check every sentence. Example format:
[
  {
    "rule": "Serial Comma",
    "ruleReference": "CMOS 6.19",
    "lineNumber": 5,
    "originalText": "red, white and blue",
    "suggestedFix": "red, white, and blue",
    "explanation": "Add comma before 'and' in a series of three or more items",
    "severity": "warning"
  }
]

Return ONLY the JSON array, no other text:`;

    try {
      // Use Claude for better JSON handling and style validation
      logger.info(`[Editorial AI] Using Claude for style validation chunk`);

      const data = await claudeService.generateJSON<Array<{
        rule: string;
        ruleReference: string;
        lineNumber: number;
        originalText: string;
        suggestedFix: string;
        explanation: string;
        severity: string;
      }>>(prompt, {
        model: 'sonnet', // Sonnet supports larger outputs
        temperature: 0.1,
        maxTokens: 8000,
        systemPrompt: 'You are an expert editor. Analyze documents for style violations and return results as a JSON array only. No explanations or markdown.',
      });

      logger.info(`[Editorial AI] Claude returned ${data?.length ?? 0} violations`);

      if (!data || data.length === 0) {
        logger.warn('[Editorial AI] No violations returned from AI for this chunk');
        return [];
      }

      const response = { data };

      // Convert to StyleViolation format with accurate character offsets
      return response.data.map(v => {
        // Strategy: Search for originalText in the chunk, prioritizing near the reported line
        const originalText = v.originalText || '';
        let foundOffset = -1;
        let foundLineNumber = v.lineNumber;

        // First, try to find the exact text in the entire chunk
        const directIndex = sanitizedText.indexOf(originalText);
        if (directIndex >= 0) {
          foundOffset = charOffset + directIndex;
          // Calculate actual line number from found position
          const textBeforeMatch = sanitizedText.substring(0, directIndex);
          foundLineNumber = lineOffset + (textBeforeMatch.match(/\n/g) || []).length;
        } else {
          // Fallback: try case-insensitive search
          const lowerText = sanitizedText.toLowerCase();
          const lowerOriginal = originalText.toLowerCase();
          const caseInsensitiveIndex = lowerText.indexOf(lowerOriginal);
          if (caseInsensitiveIndex >= 0) {
            foundOffset = charOffset + caseInsensitiveIndex;
            const textBeforeMatch = sanitizedText.substring(0, caseInsensitiveIndex);
            foundLineNumber = lineOffset + (textBeforeMatch.match(/\n/g) || []).length;
          } else {
            // Last fallback: use AI-reported line number estimate
            const targetLine = v.lineNumber - lineOffset;
            let estimatedOffset = charOffset;
            for (let i = 0; i < Math.min(targetLine, lines.length); i++) {
              estimatedOffset += lines[i].length + 1;
            }
            foundOffset = estimatedOffset;
            logger.debug(`[Editorial AI] Could not find exact text "${originalText.substring(0, 30)}..." in chunk, using estimated offset`);
          }
        }

        return {
          rule: v.rule,
          ruleReference: v.ruleReference,
          location: {
            start: foundOffset,
            end: foundOffset + originalText.length,
            lineNumber: foundLineNumber,
          },
          originalText: v.originalText,
          suggestedFix: v.suggestedFix,
          explanation: v.explanation,
          severity: v.severity as 'error' | 'warning' | 'suggestion',
        };
      });
    } catch (error) {
      logger.error('[Editorial AI] Style validation chunk failed', error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Get comprehensive style guide rules for AI validation
   */
  private getStyleGuideRules(styleGuide: 'chicago' | 'apa' | 'mla' | 'vancouver' | 'nature' | 'ieee' | 'ap' | 'general' | 'academic' | 'custom'): {
    name: string;
    referencePrefix: string;
    rules: string;
  } {
    switch (styleGuide) {
      case 'apa':
        return {
          name: 'APA Publication Manual 7th Edition',
          referencePrefix: 'APA 7',
          rules: `KEY APA 7TH EDITION RULES:

NUMBERS:
- Use words for numbers zero through nine
- Use numerals for 10 and above
- Never use apostrophe in number plurals (1970s, not 1970's)
- Use % symbol with numerals (50%), spell out with words (fifty percent)
- Use numerals for exact measurements, statistics, and mathematical expressions

CAPITALIZATION:
- Article/chapter titles: Sentence case (capitalize only first word and proper nouns)
- Journal titles: Title case (capitalize major words)
- Capitalize first word after colon in titles if it begins a complete sentence

PUNCTUATION:
- Use the serial (Oxford) comma before "and" in a series
- Use double quotation marks for direct quotes
- Place periods and commas inside quotation marks
- Use en dash (–) for number ranges

CITATIONS:
- Use ampersand (&) in parenthetical citations, "and" in narrative citations
- List up to 20 authors; for 21+, use first 19, ellipsis, then final author
- Use "et al." after first citation for 3+ authors
- DOI format: https://doi.org/xxxxx

LANGUAGE:
- Avoid contractions in formal writing
- Use gender-neutral language (they/them for singular)
- Avoid anthropomorphism (studies don't "argue" or "believe")
- Prefer active voice over passive voice
- Use "e.g.," and "i.e.," with comma following`,
        };

      case 'chicago':
        return {
          name: 'Chicago Manual of Style 17th Edition',
          referencePrefix: 'CMOS',
          rules: `KEY CHICAGO MANUAL OF STYLE RULES:

NUMBERS:
- Spell out numbers one through one hundred
- Spell out round numbers (two hundred, three thousand)
- Use numerals for exact figures in technical contexts
- Use en dash (–) for ranges, not hyphen

PUNCTUATION:
- Use the serial (Oxford) comma before "and" in a series
- Em dashes (—) without spaces around them
- En dashes (–) for number ranges
- Ellipsis: three spaced periods (. . .) in quoted material
- Ibid. is discouraged; use shortened citations

CAPITALIZATION:
- Headline style for titles: Capitalize first, last, and all major words
- Lowercase prepositions, conjunctions, articles unless first/last word
- Capitalize first word after colon if it begins a complete sentence

POSSESSIVES:
- Add 's to singular nouns ending in s (James's, not James')
- Exception: classical and biblical names (Moses', Jesus')

GRAMMAR:
- "That" for restrictive clauses (no comma)
- "Which" for nonrestrictive clauses (with comma)
- American English: "toward" not "towards", "among" not "amongst"

CITATIONS:
- Write out publishers' names in full
- Invert author's name (Last, First)
- Italicize book and journal titles
- Quotation marks for article/chapter titles`,
        };

      case 'mla':
        return {
          name: 'MLA Handbook 9th Edition',
          referencePrefix: 'MLA',
          rules: `KEY MLA 9TH EDITION RULES:

NUMBERS:
- Spell out numbers that can be written in one or two words
- Use numerals for numbers requiring more than two words
- Use numerals for dates, page numbers, addresses

FORMATTING:
- Double-space throughout
- 1-inch margins
- 12-point standard font (Times New Roman or similar)
- Include last name and page number in upper right

CAPITALIZATION:
- Title case for all titles: capitalize all major words
- Lowercase prepositions, conjunctions, articles (unless first word)

DATES:
- Day Month Year format (15 Jan. 2024)
- Abbreviate months longer than four letters: Jan., Feb., Mar., Apr., Aug., Sept., Oct., Nov., Dec.

IN-TEXT CITATIONS:
- Author's last name and page number (Smith 42)
- No comma between author and page
- Block quotes (4+ lines): indent 1/2 inch, no quotation marks

WORKS CITED:
- Alphabetical order by authors' last names
- Hanging indent (first line flush, subsequent indented)
- Only first author's name inverted (Last, First. Second Third.)
- For 3+ authors: First author et al.

TITLES:
- Italicize titles of independently published works (books, journals)
- Quotation marks for shorter works (articles, chapters)`,
        };

      case 'vancouver':
        return {
          name: 'Vancouver Style (ICMJE Recommendations)',
          referencePrefix: 'Vancouver',
          rules: `KEY VANCOUVER STYLE RULES:

CITATIONS:
- Number citations consecutively in order of first mention
- Use Arabic numerals in parentheses (1) or superscript
- Same number for repeated citations
- References numbered in order of appearance (not alphabetical)

AUTHOR NAMES:
- Surname first, then initials (no periods between initials)
- List first 6 authors, then "et al." for 7 or more
- Example: Smith AB, Jones CD, Wilson EF, et al.

JOURNAL TITLES:
- Abbreviate according to NLM/MEDLINE standards
- No periods in abbreviations
- Example: N Engl J Med, JAMA, BMJ

DATES:
- Year Month Day format: 2024 Jan 15
- Three-letter month abbreviations (no period)

PAGE RANGES:
- Use abbreviated form: 123-8 (not 123-128)
- Drop common leading digits

MEASUREMENTS:
- Use SI units (metric)
- kg, m, cm, L (not pounds, feet, gallons)

DOI:
- Include DOI at end when available
- Format: doi:10.xxxx/xxxxx

MEDICAL TERMINOLOGY:
- Use standard medical terms in scientific context
- Drug names: Use generic names, capitalize brand names
- Abbreviate standard medical abbreviations without periods`,
        };

      case 'nature':
        return {
          name: 'Nature Publishing Guidelines',
          referencePrefix: 'Nature',
          rules: `KEY NATURE PUBLISHING RULES:

NUMBERS:
- Use numerals for all numbers except at start of sentence
- Use SI units with proper abbreviations
- Use × (not x) for multiplication
- Use en dash for ranges (10–20)

CITATIONS:
- Numbered superscript citations in order of appearance
- References numbered consecutively
- Up to 5 authors listed, then et al.

FORMATTING:
- Concise titles (no abbreviations)
- Structured abstract for research articles
- No footnotes in main text
- Gene names italicized, proteins not
- Species names italicized

STYLE:
- Active voice preferred
- Third person unless describing author actions
- Avoid jargon and undefined abbreviations
- Define abbreviations at first use`,
        };

      case 'ieee':
        return {
          name: 'IEEE Editorial Style',
          referencePrefix: 'IEEE',
          rules: `KEY IEEE STYLE RULES:

CITATIONS:
- Numbered references in square brackets [1]
- Citations numbered in order of first appearance
- Multiple citations: [1], [2] or [1]–[3]

NUMBERS:
- Spell out numbers zero through nine
- Use numerals for 10 and above
- Always use numerals with units (5 MHz, 3 dB)
- Use × for multiplication in equations

ABBREVIATIONS:
- Define at first use, then use abbreviation
- Common ones need no definition: CPU, RAM, IEEE
- Use "Fig." in running text, "Figure" at sentence start

EQUATIONS:
- Number equations consecutively (1), (2)
- Variables in italics
- Functions and operators in roman (sin, log, max)

UNITS:
- SI units preferred
- Space between number and unit (10 MHz)
- No period after unit abbreviations`,
        };

      case 'ap':
        return {
          name: 'Associated Press Stylebook',
          referencePrefix: 'AP',
          rules: `KEY AP STYLE RULES:

NUMBERS:
- Spell out one through nine
- Use numerals for 10 and above
- Always numerals for ages, percentages, money
- Spell out numbers at start of sentence (or recast)

PUNCTUATION:
- NO serial (Oxford) comma (red, white and blue)
- Single space after periods
- Use quotation marks for composition titles

CAPITALIZATION:
- Lowercase job titles after names
- Capitalize formal titles before names
- Lowercase seasons (spring, summer)
- Capitalize specific regions (the West, the South)

ABBREVIATIONS:
- U.S. (with periods) as adjective
- Spell out United States as noun
- State abbreviations: Use postal codes in datelines only
- Months: Abbreviate Jan., Feb., Aug., Sept., Oct., Nov., Dec.

DATES:
- Month Day, Year (Jan. 15, 2024)
- No "th" or "nd" (Jan. 15, not Jan. 15th)
- Use numerals for years`,
        };

      case 'general':
        return {
          name: 'General Quality Rules',
          referencePrefix: 'Quality',
          rules: `GENERAL QUALITY RULES:

GRAMMAR:
- Subject-verb agreement
- Correct pronoun usage
- Proper tense consistency
- Avoid sentence fragments and run-ons
- Correct use of articles (a, an, the)

PUNCTUATION:
- Serial comma consistency
- Proper comma placement
- Correct apostrophe usage
- Proper quotation mark usage
- Hyphenation of compound modifiers

SPELLING:
- Check common misspellings
- Consistent British/American spelling
- Proper capitalization

CLARITY:
- Avoid redundancy
- Clear pronoun references
- Parallel structure in lists
- Avoid ambiguity`,
        };

      case 'academic':
        return {
          name: 'Academic Writing Standards',
          referencePrefix: 'Academic',
          rules: `ACADEMIC WRITING RULES:

VOICE AND TONE:
- Prefer active voice when possible
- Formal tone, avoid contractions
- Avoid first person unless field-appropriate
- Objective language

STRUCTURE:
- Clear topic sentences
- Logical paragraph flow
- Appropriate transitions
- Proper citation of sources

TERMINOLOGY:
- Define technical terms
- Consistent terminology throughout
- Avoid jargon unless necessary
- Spell out abbreviations on first use

STYLE:
- Avoid hedging language overuse
- Be precise and specific
- Avoid generalizations without support
- Use evidence-based claims`,
        };

      default:
        return {
          name: 'General Academic Style',
          referencePrefix: 'Style',
          rules: `GENERAL ACADEMIC WRITING RULES:

GRAMMAR:
- Ensure subject-verb agreement
- Avoid dangling modifiers
- Use parallel structure in lists
- Prefer active voice over passive voice

PUNCTUATION:
- Use serial comma in lists
- Single space after periods
- Proper use of semicolons and colons
- Hyphenate compound adjectives before nouns

NUMBERS:
- Spell out numbers at start of sentences
- Be consistent with number style throughout

TERMINOLOGY:
- Avoid redundant phrases (advance planning → planning)
- Replace wordy phrases (in order to → to)
- Avoid clichés and jargon
- Define abbreviations on first use

FORMATTING:
- Consistent heading hierarchy
- Proper quotation formatting
- Appropriate use of italics and bold`,
        };
    }
  }

  /**
   * Generate corrected text for a style violation
   * Used by: Style Validation (US-6.1)
   * @param text - Full text containing the violation
   * @param violation - The specific violation to correct
   * @returns Corrected text snippet
   */
  async suggestCorrection(
    text: string,
    violation: StyleViolation
  ): Promise<string> {
    const contextStart = Math.max(0, violation.location.start - 50);
    const contextEnd = Math.min(text.length, violation.location.end + 50);
    const context = text.slice(contextStart, contextEnd);

    const prompt = `Correct this style violation.

CONTEXT:
"${context}"

VIOLATION:
- Rule: ${violation.rule}
- Reference: ${violation.ruleReference}
- Original: "${violation.originalText}"
- Suggested: "${violation.suggestedFix}"

Provide the corrected version of just the problematic text (not the full context).
Return only the corrected text, no explanation:`;

    try {
      const response = await geminiService.generateText(prompt, {
        temperature: 0.1,
        maxOutputTokens: 200,
      });

      return response.text.trim().replace(/^["']|["']$/g, '');
    } catch (error) {
      logger.error('[Editorial AI] Correction suggestion failed', error instanceof Error ? error : undefined);
      return violation.suggestedFix;
    }
  }

  /**
   * Extract rules from uploaded house style document
   * Used by: Style Validation (US-7.4)
   * @param documentText - Full text of the style guide document
   * @returns Extracted rules, preferences, and terminology
   */
  async extractStyleRules(documentText: string): Promise<ExtractedStyleRules> {
    const prompt = `Extract style rules from this house style guide document.

DOCUMENT:
${documentText.slice(0, 10000)}

Analyze the document and extract:

1. explicitRules: Array of clear, actionable rules stated in the document
   Example: "Always use the Oxford comma", "Numbers under 10 should be spelled out"

2. preferences: Array of objects with "preferred" and "avoid" pairs
   Example: { preferred: "ensure", avoid: "make sure" }

3. terminology: Array of objects with "use" and "instead" pairs for terminology
   Example: { use: "email", instead: "e-mail" }

Return JSON with these three arrays. Focus on extracting concrete, enforceable rules.

Respond with JSON only:`;

    try {
      const response = await geminiService.generateStructuredOutput<ExtractedStyleRules>(prompt, {
        temperature: 0.1,
        maxOutputTokens: 4000,
      });

      return response.data;
    } catch (error) {
      logger.error('[Editorial AI] Style rule extraction failed', error instanceof Error ? error : undefined);
      return {
        explicitRules: [],
        preferences: [],
        terminology: [],
      };
    }
  }

  /**
   * Generate reference entries from document text and citations
   * Used by: Citation Management (US-4)
   * @param fullText - Full document text
   * @param citations - Array of citation inputs
   * @param styleCode - Citation style code (e.g., 'APA', 'MLA')
   * @returns Object containing entries array
   */
  async generateReferenceEntriesChunked(
    _fullText: string,
    _citations: Array<{ id: string; rawText: string; citationType: string; sectionContext?: string }>,
    _styleCode: string
  ): Promise<{
    entries: Array<{
      citationIds: string[];
      authors: Array<{ firstName?: string; lastName?: string }>;
      confidence: number;
      doi?: string;
      title?: string;
      year?: string;
      journal?: string;
      journalName?: string;
      volume?: string;
      issue?: string;
      pages?: string;
      url?: string;
      publisher?: string;
      sourceType?: string;
      formattedEntry?: string;
    }>;
  }> {
    // TODO: Implement AI-powered reference entry generation
    logger.warn('[Editorial AI] generateReferenceEntriesChunked not fully implemented - returning empty entries');
    return { entries: [] };
  }

  /**
   * Detect citation style from text
   * Used by: Citation Management (US-4)
   * @param text - Text containing citations
   * @returns Detected style information
   */
  async detectCitationStyleFromText(
    _text: string
  ): Promise<{
    style: string;
    confidence: number;
    evidence: string[];
    hasReferenceSection?: boolean;
    numericCount?: number;
    authorDateCount?: number;
  }> {
    // TODO: Implement AI-powered style detection
    logger.warn('[Editorial AI] detectCitationStyleFromText not fully implemented');
    return {
      style: 'unknown',
      confidence: 0,
      evidence: [],
      hasReferenceSection: false,
      numericCount: 0,
      authorDateCount: 0,
    };
  }
}

export const editorialAi = new EditorialAiClient();
