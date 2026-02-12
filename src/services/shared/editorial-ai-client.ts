/**
 * Editorial AI Client Service
 * Provides unified interface for Editorial Services AI operations
 * Built on top of existing GeminiService
 */

import { GoogleGenerativeAI } from '@google/generative-ai';
import { geminiService } from '../ai/gemini.service';
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
   * @param text - Text to validate
   * @param styleGuide - Style guide to use
   * @param customRules - Optional custom rules to apply
   * @returns Array of style violations found
   */
  async validateStyle(
    text: string,
    styleGuide: 'chicago' | 'apa' | 'mla' | 'custom',
    customRules?: string[]
  ): Promise<StyleViolation[]> {
    const styleGuideName = {
      chicago: 'Chicago Manual of Style (CMOS)',
      apa: 'APA Publication Manual 7th Edition',
      mla: 'MLA Handbook 9th Edition',
      custom: 'Custom House Style',
    }[styleGuide];

    const customRulesText = customRules?.length 
      ? `\n\nCUSTOM RULES TO ENFORCE:\n${customRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}`
      : '';

    const prompt = `Validate this text against ${styleGuideName} style guidelines.${customRulesText}

TEXT:
${text.slice(0, 6000)}

Check for violations including:
- Punctuation and comma usage
- Capitalization rules
- Number formatting (spelled out vs. numerals)
- Abbreviation usage
- Quotation formatting
- Hyphenation
- Serial comma usage (if applicable)
- Title capitalization

Return a JSON array of violations, each with:
- rule: name of the violated rule
- ruleReference: specific style guide reference (e.g., "CMOS 6.28")
- location: object with "start" and "end" character positions
- originalText: the problematic text
- suggestedFix: corrected version
- severity: one of "error", "warning", "suggestion"

Respond with JSON array only:`;

    try {
      const response = await geminiService.generateStructuredOutput<StyleViolation[]>(prompt, {
        temperature: 0.1,
        maxOutputTokens: 4000,
      });

      return response.data;
    } catch (error) {
      logger.error('[Editorial AI] Style validation failed', error instanceof Error ? error : undefined);
      return [];
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
}

export const editorialAi = new EditorialAiClient();
