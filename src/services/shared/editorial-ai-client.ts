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
    const prompt = `Analyze the following text and extract all citations. Identify each citation's type, style, and section context.

TEXT:
${text.slice(0, 8000)}

DETECTION CATEGORIES:
1. IN-TEXT CITATIONS (type: "parenthetical" or "narrative")
   - Parenthetical: (Smith, 2020), (Smith & Jones, 2019), (Smith et al., 2021)
   - Narrative: Smith (2020), According to Smith and Jones (2019)

2. REFERENCE/BIBLIOGRAPHY ENTRIES (type: "reference")
   - Full citations in References, Bibliography, or Works Cited sections
   - Example: "Smith, J. (2020). Title of the work. Journal Name, 10(3), 234-240."
   - Example: "Jones, A. B., & Williams, C. D. (2019). Book title. Publisher."

SECTION CONTEXT - Identify where each citation appears:
- "body": Main text, introduction, methods, results, discussion
- "references": References, Bibliography, Works Cited section
- "footnotes": Footnote section at bottom of page
- "endnotes": Endnotes section
- "abstract": Abstract section
- "unknown": Cannot determine section

For each citation found, return a JSON array with objects containing:
- text: the full citation text as it appears
- type: one of "parenthetical", "narrative", "footnote", "endnote", "numeric", "reference"
- style: one of "APA", "MLA", "Chicago", "Vancouver", "IEEE", "unknown"
- sectionContext: one of "body", "references", "footnotes", "endnotes", "abstract", "unknown"
- paragraphIndex: approximate paragraph number (0-indexed)
- startOffset: character position where citation starts
- endOffset: character position where citation ends
- confidence: 0-100 confidence score

IMPORTANT RULES:
- Do NOT include figure references like "(see Figure 1)" or "(Table 2)"
- Do NOT include page numbers alone like "(p. 42)"
- DO include footnote/endnote cue markers like [1], [2], ¹, ² (type: "footnote" or "numeric")
- DO include author-date in-text citations like "(Smith, 2020)"
- DO include narrative citations like "According to Smith (2020)"
- DO include full reference entries from bibliography sections
- For reference entries, extract the COMPLETE citation including all components

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
          sectionContext: (raw.sectionContext as ExtractedCitation['sectionContext']) ?? 'unknown',
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
  async generateReferenceEntries(
    fullText: string,
    citationTexts: { id: string; rawText: string; citationType: string; sectionContext?: string }[],
    styleCode: string
  ): Promise<{
    entries: Array<{
      citationIds: string[];
      authors: { firstName?: string; lastName: string }[];
      year?: string;
      title: string;
      sourceType: string;
      journalName?: string;
      volume?: string;
      issue?: string;
      pages?: string;
      publisher?: string;
      doi?: string;
      url?: string;
      formattedEntry: string;
      confidence: number;
    }>;
  }> {
    const styleNames: Record<string, string> = {
      apa7: 'APA 7th Edition',
      mla9: 'MLA 9th Edition',
      chicago17: 'Chicago 17th Edition (Notes-Bibliography)',
      vancouver: 'Vancouver',
      ieee: 'IEEE',
    };
    const styleName = styleNames[styleCode] || styleCode.toUpperCase();

    const citationSummary = citationTexts.map(c =>
      `[ID:${c.id}] (${c.citationType}, section:${c.sectionContext || 'unknown'}) "${c.rawText}"`
    ).join('\n');

    let textForContext: string;
    const maxContext = 24000;
    if (fullText.length <= maxContext) {
      textForContext = fullText;
    } else {
      const refSectionMatch = fullText.match(/\n\s*(REFERENCES|BIBLIOGRAPHY|WORKS?\s+CITED|LITERATURE\s+CITED)\s*\n/i);
      if (refSectionMatch && refSectionMatch.index !== undefined) {
        const refStart = refSectionMatch.index;
        const refContent = fullText.slice(refStart);
        const refAllocation = Math.min(refContent.length, Math.floor(maxContext * 0.75));
        const bodyAllocation = maxContext - refAllocation;
        const bodyPortion = fullText.slice(0, Math.min(bodyAllocation, refStart));
        const refPortion = refContent.slice(0, refAllocation);
        logger.info(`[Editorial AI] Long document (${fullText.length} chars): using ${bodyPortion.length} body + ${refPortion.length} refs for AI context`);
        textForContext = bodyPortion + '\n\n...[body truncated]...\n\n' + refPortion;
      } else {
        const halfContext = Math.floor(maxContext / 2);
        textForContext = fullText.slice(0, halfContext) + '\n\n...[middle truncated]...\n\n' + fullText.slice(-halfContext);
      }
    }

    const prompt = `You are an expert academic reference list generator.

TASK: Analyze the document below and produce a complete, properly formatted reference list in ${styleName} style.

FULL DOCUMENT TEXT:
---
${textForContext}
---

DETECTED CITATIONS (with IDs):
${citationSummary}

INSTRUCTIONS:
1. Read the ENTIRE document carefully, especially any REFERENCES / BIBLIOGRAPHY / WORKS CITED section
2. For each unique source cited in the document, create exactly ONE reference entry
3. MATCH in-text citations to their full reference entries:
   - "Smith (2020)" in the body matches "[2] Smith, J. (2020). Global Temperature Trends..." in REFERENCES
   - Numeric citations like [1] match the numbered entry in REFERENCES
   - Group ALL citation IDs that refer to the same source into one entry
4. For in-text citations WITHOUT a full reference in the document, reconstruct from context:
   - Use the author name and year from the in-text citation
   - Infer topic from the surrounding sentence context
   - Set confidence low (0.3-0.5) for these reconstructed entries
5. Do NOT create entries for bare numeric references [2,3] or [4-6] that merely reference other numbered entries unless those numbered entries exist in the references section. If [3],[4],[5],[6] have no entries in the REFERENCES section, skip them.
6. Format each entry properly in ${styleName} style

AUTHOR NAME RULES (CRITICAL):
- "lastName" is the family/surname: Smith, Johnson, Brown, Williams, Davis, Martinez, Thompson, IPCC
- "firstName" is the given/first name or initial: J., John, M., etc.
- For "Smith (2020)": authors = [{"lastName": "Smith"}]
- For "Johnson and Lee (2019)": authors = [{"lastName": "Johnson"}, {"lastName": "Lee"}]
- For "Williams & Davis, 2018": authors = [{"lastName": "Williams"}, {"lastName": "Davis"}]
- For "Brown et al. (2021)": authors = [{"lastName": "Brown"}] (et al. means additional unknown co-authors)
- For "Smith, J. (2020)": authors = [{"firstName": "J.", "lastName": "Smith"}]
- For organizations like "IPCC": authors = [{"lastName": "IPCC"}]
- NEVER put the surname/family name in firstName. NEVER use "Unknown" for lastName.

Return a JSON object with this EXACT structure. Use null (not strings like "null") for unknown fields:
{
  "entries": [
    {
      "citationIds": ["id1", "id2"],
      "authors": [{"firstName": "J.", "lastName": "Smith"}],
      "year": "2020",
      "title": "Title of the Work",
      "sourceType": "journal",
      "journalName": null,
      "volume": null,
      "issue": null,
      "pages": null,
      "publisher": null,
      "doi": null,
      "url": null,
      "formattedEntry": "The complete formatted reference in the requested style",
      "confidence": 0.85
    }
  ]
}

CRITICAL:
- Do NOT create duplicate entries for the same source
- Do NOT create entries for references not cited in the document
- Use the REFERENCES section as the primary source of truth for metadata
- For ${styleName}, follow exact formatting rules
- confidence: 1.0 = full reference data available, 0.3-0.5 = reconstructed from in-text only
- For formattedEntry: ONLY include known data. Do NOT include placeholder text like "[Journal Name]" or "[Publisher]" in the formatted output. If journal name is unknown, omit it from the formatted entry entirely.
- Use null for any field where the information is not available. NEVER use strings like "null", "Journal Name or null", etc.

Respond with JSON only:`;

    try {
      const response = await geminiService.generateText(prompt, {
        temperature: 0.1,
        maxOutputTokens: 8000,
      });

      let text = response.text.trim();
      if (text.startsWith('```json')) {
        text = text.slice(7);
      } else if (text.startsWith('```')) {
        text = text.slice(3);
      }
      if (text.endsWith('```')) {
        text = text.slice(0, -3);
      }
      text = text.trim();

      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        logger.error('[Editorial AI] No JSON object found in AI response');
        return { entries: [] };
      }

      const parsed = JSON.parse(jsonMatch[0]);
      if (!parsed.entries || !Array.isArray(parsed.entries)) {
        logger.error('[Editorial AI] AI response missing entries array');
        return { entries: [] };
      }

      logger.info(`[Editorial AI] Successfully parsed ${parsed.entries.length} reference entries from AI`);
      return parsed;
    } catch (error) {
      logger.error('[Editorial AI] Reference list generation failed', error instanceof Error ? error : undefined);
      return { entries: [] };
    }
  }

  extractReferenceSection(fullText: string): { body: string; references: string; refStart: number } | null {
    const patterns = [
      /(?:\n|<[Hh]\d>)\s*(REFERENCES|References)\s*\n/,
      /\n\s*(REFERENCES|References)\s*\n/,
      /(?:\n|<[Hh]\d>)\s*(BIBLIOGRAPHY|Bibliography)\s*\n/,
      /\n\s*(BIBLIOGRAPHY|Bibliography)\s*\n/,
      /(?:\n|<[Hh]\d>)\s*(WORKS?\s+CITED|Works?\s+Cited)\s*\n/,
      /\n\s*(WORKS?\s+CITED|Works?\s+Cited)\s*\n/,
      /(?:\n|<[Hh]\d>)\s*(LITERATURE\s+CITED|Literature\s+Cited)\s*\n/,
      /\n\s*(LITERATURE\s+CITED|Literature\s+Cited)\s*\n/,
    ];

    for (const pattern of patterns) {
      const match = fullText.match(pattern);
      if (match && match.index !== undefined) {
        const refStart = match.index;
        const body = fullText.slice(0, refStart);
        let references = fullText.slice(refStart + match[0].length);

        const endPatterns = [
          /\n\s*(?:<[Hh]\d>)?\s*(?:Figure|FIGURE|Table|TABLE|Appendix|APPENDIX)\s*[\d.]/,
          /\n\s*(?:<[Hh]\d>)?\s*(?:ACKNOWLEDGMENTS?|Acknowledgments?)\s*\n/,
          /\n\s*(?:<[Hh]\d>)?\s*(?:SUPPLEMENTARY|Supplementary)\s/,
        ];

        for (const endPat of endPatterns) {
          const endMatch = references.match(endPat);
          if (endMatch && endMatch.index !== undefined && endMatch.index > references.length * 0.3) {
            const trimmedLen = endMatch.index;
            logger.info(`[Editorial AI] Trimming reference section at non-reference content: ${references.length} -> ${trimmedLen} chars`);
            references = references.slice(0, trimmedLen);
            break;
          }
        }

        logger.info(`[Editorial AI] Found reference section at position ${refStart}, section length: ${references.length} chars`);
        return { body, references, refStart };
      }
    }
    logger.info(`[Editorial AI] No reference section heading found in document`);
    return null;
  }

  splitReferencesIntoChunks(refText: string, maxChunkSize: number = 14000): string[] {
    if (refText.length <= maxChunkSize) {
      return [refText];
    }

    const chunks: string[] = [];
    let remaining = refText;

    while (remaining.length > 0) {
      if (remaining.length <= maxChunkSize) {
        chunks.push(remaining);
        break;
      }

      let splitPoint = remaining.lastIndexOf('\n', maxChunkSize);
      if (splitPoint <= 0) {
        splitPoint = maxChunkSize;
      }

      chunks.push(remaining.slice(0, splitPoint));
      remaining = remaining.slice(splitPoint).trimStart();
    }

    return chunks;
  }

  private parseAiJsonResponse(text: string): any {
    let cleaned = text.trim();
    if (cleaned.startsWith('```json')) {
      cleaned = cleaned.slice(7);
    } else if (cleaned.startsWith('```')) {
      cleaned = cleaned.slice(3);
    }
    if (cleaned.endsWith('```')) {
      cleaned = cleaned.slice(0, -3);
    }
    cleaned = cleaned.trim();

    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return null;
    }

    try {
      return JSON.parse(jsonMatch[0]);
    } catch (firstError) {
      logger.warn(`[Editorial AI] JSON parse failed, attempting truncated JSON repair`);
      let jsonStr = jsonMatch[0];

      const lastCompleteEntry = jsonStr.lastIndexOf('},');
      if (lastCompleteEntry > 0) {
        jsonStr = jsonStr.slice(0, lastCompleteEntry + 1) + ']}';
        try {
          const repaired = JSON.parse(jsonStr);
          if (repaired.entries && Array.isArray(repaired.entries)) {
            logger.info(`[Editorial AI] Repaired truncated JSON: recovered ${repaired.entries.length} entries`);
            return repaired;
          }
        } catch (_) {}
      }

      const lastCompleteBrace = jsonStr.lastIndexOf('}');
      if (lastCompleteBrace > 0) {
        const beforeBrace = jsonStr.slice(0, lastCompleteBrace + 1);
        const openBrackets = (beforeBrace.match(/\[/g) || []).length;
        const closeBrackets = (beforeBrace.match(/\]/g) || []).length;
        let suffix = ']'.repeat(Math.max(0, openBrackets - closeBrackets));
        const openBraces = (beforeBrace.match(/\{/g) || []).length;
        const closeBraces = (beforeBrace.match(/\}/g) || []).length;
        suffix += '}'.repeat(Math.max(0, openBraces - closeBraces));
        try {
          const repaired = JSON.parse(beforeBrace + suffix);
          if (repaired.entries && Array.isArray(repaired.entries)) {
            logger.info(`[Editorial AI] Repaired truncated JSON (method 2): recovered ${repaired.entries.length} entries`);
            return repaired;
          }
        } catch (_) {}
      }

      throw firstError;
    }
  }

  async generateReferenceEntriesChunked(
    fullText: string,
    citationTexts: Array<{
      id: string;
      rawText: string;
      citationType: string;
      sectionContext?: string;
    }>,
    styleCode: string
  ): Promise<{
    entries: Array<{
      citationIds: string[];
      authors: { firstName?: string; lastName: string }[];
      year?: string;
      title: string;
      sourceType: string;
      journalName?: string;
      volume?: string;
      issue?: string;
      pages?: string;
      publisher?: string;
      doi?: string;
      url?: string;
      formattedEntry: string;
      confidence: number;
    }>;
  }> {
    const refSection = this.extractReferenceSection(fullText);

    if (!refSection || refSection.references.length < 20000) {
      logger.info(`[Editorial AI] Reference section ${refSection ? refSection.references.length + ' chars' : 'not found'}, using single-pass generation`);
      return this.generateReferenceEntries(fullText, citationTexts, styleCode);
    }

    const styleNames: Record<string, string> = {
      apa7: 'APA 7th Edition',
      mla9: 'MLA 9th Edition',
      chicago17: 'Chicago 17th Edition (Notes-Bibliography)',
      vancouver: 'Vancouver',
      ieee: 'IEEE',
    };
    const styleName = styleNames[styleCode] || styleCode.toUpperCase();

    const chunks = this.splitReferencesIntoChunks(refSection.references, 8000);
    logger.info(`[Editorial AI] Large reference section (${refSection.references.length} chars) split into ${chunks.length} chunks for processing`);

    const allEntries: Array<{
      citationIds: string[];
      authors: { firstName?: string; lastName: string }[];
      year?: string;
      title: string;
      sourceType: string;
      journalName?: string;
      volume?: string;
      issue?: string;
      pages?: string;
      publisher?: string;
      doi?: string;
      url?: string;
      formattedEntry: string;
      confidence: number;
    }> = [];

    const processChunk = async (chunk: string, chunkIndex: number): Promise<void> => {
      logger.info(`[Editorial AI] Processing reference chunk ${chunkIndex + 1}/${chunks.length} (${chunk.length} chars)`);

      const prompt = `You are an expert academic reference list parser.

TASK: Parse the following CHUNK of a references section and extract every individual reference entry. Format each in ${styleName} style.

This is chunk ${chunkIndex + 1} of ${chunks.length} from a larger references section. Parse ALL references in this chunk.

REFERENCES TEXT:
---
${chunk}
---

INSTRUCTIONS:
1. Parse EVERY reference entry in this chunk - do not skip any
2. Extract authors, year, title, journal, volume, issue, pages, DOI, and URL from each entry
3. Format each entry properly in ${styleName} style
4. Set confidence to 0.85 for entries with complete metadata

AUTHOR NAME RULES:
- "lastName" = family/surname: Smith, Johnson, Jain, Martin
- "firstName" = given/first name or initial: J., John, R. K.
- For "Martin, J. D.": authors = [{"firstName": "J. D.", "lastName": "Martin"}]
- For "Jain, R. K.": authors = [{"firstName": "R. K.", "lastName": "Jain"}]
- For multiple authors separated by semicolons: parse each author separately
- NEVER put surname in firstName field

Return a JSON object with this EXACT structure (do NOT include formattedEntry - it will be generated later):
{
  "entries": [
    {
      "authors": [{"firstName": "J. D.", "lastName": "Martin"}, {"firstName": "G.", "lastName": "Seano"}, {"firstName": "R. K.", "lastName": "Jain"}],
      "year": "2019",
      "title": "Title of Work",
      "sourceType": "journal",
      "journalName": "Journal Name",
      "volume": "81",
      "issue": null,
      "pages": "505-534",
      "doi": null
    }
  ]
}

CRITICAL:
- Parse EVERY reference in this chunk - do not stop early or summarize
- Use null (not string "null") for unknown fields
- Do NOT include formattedEntry, citationIds, publisher, or url fields - keep output compact
- Each distinct reference is typically separated by a newline
- List ALL authors for each reference, do not abbreviate with "et al."

Respond with JSON only:`;

      try {
        const response = await geminiService.generateText(prompt, {
          temperature: 0.1,
          maxOutputTokens: 8192,
        });

        const parsed = this.parseAiJsonResponse(response.text);
        if (parsed && parsed.entries && Array.isArray(parsed.entries)) {
          logger.info(`[Editorial AI] Chunk ${chunkIndex + 1}/${chunks.length}: parsed ${parsed.entries.length} entries`);
          allEntries.push(...parsed.entries);
        } else {
          logger.warn(`[Editorial AI] Chunk ${chunkIndex + 1}/${chunks.length}: failed to parse entries`);
        }
      } catch (error) {
        logger.error(`[Editorial AI] Chunk ${chunkIndex + 1}/${chunks.length} processing failed`, error instanceof Error ? error : undefined);
      }
    };

    const PARALLEL_BATCH_SIZE = 3;
    for (let batchStart = 0; batchStart < chunks.length; batchStart += PARALLEL_BATCH_SIZE) {
      const batchEnd = Math.min(batchStart + PARALLEL_BATCH_SIZE, chunks.length);
      const batchPromises = [];
      for (let i = batchStart; i < batchEnd; i++) {
        batchPromises.push(processChunk(chunks[i], i));
      }
      logger.info(`[Editorial AI] Processing batch ${Math.floor(batchStart / PARALLEL_BATCH_SIZE) + 1}/${Math.ceil(chunks.length / PARALLEL_BATCH_SIZE)} (chunks ${batchStart + 1}-${batchEnd})`);
      await Promise.all(batchPromises);
    }

    logger.info(`[Editorial AI] Chunked processing complete: ${allEntries.length} total entries from ${chunks.length} chunks`);
    return { entries: allEntries };
  }
}

export const editorialAi = new EditorialAiClient();
