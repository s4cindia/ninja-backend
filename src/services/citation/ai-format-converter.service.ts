/**
 * AI-Powered Citation Format Converter
 * Converts citations between different styles using AI
 */

import { claudeService } from '../ai/claude.service';
import { logger } from '../../lib/logger';
import { ReferenceEntry, InTextCitation } from './ai-citation-detector.service';

export type CitationStyle = 'APA' | 'MLA' | 'Chicago' | 'Vancouver' | 'IEEE' | 'Harvard' | 'AMA';

export interface CitationConversionInfo {
  oldText: string;       // Original in-text citation, e.g., "(1)"
  newText: string;       // Converted in-text citation, e.g., "(Smith, 2020)"
  referenceNumber: number;
}

export interface ConversionResult {
  convertedReferences: ReferenceEntry[];
  convertedCitations: InTextCitation[];
  citationConversions: CitationConversionInfo[];  // For Track Changes in export
  targetStyle: CitationStyle;
  changes: {
    referenceId: string;
    oldFormat: string;
    newFormat: string;
  }[];
}

class AIFormatConverterService {
  /**
   * Convert citations to target format using AI
   */
  async convertStyle(
    references: ReferenceEntry[],
    citations: InTextCitation[],
    targetStyle: CitationStyle
  ): Promise<ConversionResult> {
    logger.info(`[Format Converter] Converting to ${targetStyle} style`);

    try {
      // Check if converting from author-year to numeric/footnote style
      // Chicago uses footnote numbers which should also be sequential by appearance
      const numericStyles: CitationStyle[] = ['Vancouver', 'IEEE', 'AMA', 'Chicago'];
      const isTargetNumeric = numericStyles.includes(targetStyle);
      const hasAuthorYearCitations = citations.some(c =>
        c.text && this.detectAuthorYearCitation(c.text)
      );

      let refsToConvert = references;
      let citationsToConvert = citations;

      // Special handling: author-year → numeric conversion
      // Need to reorder references by order of first citation appearance
      if (isTargetNumeric && hasAuthorYearCitations) {
        logger.info(`[Format Converter] Detected author-year → numeric conversion, reordering by appearance`);
        const { reorderedRefs, reorderedCitations, authorYearToNumber } =
          this.reorderByAppearance(references, citations);
        refsToConvert = reorderedRefs;
        citationsToConvert = reorderedCitations;
        logger.info(`[Format Converter] Author-year to number mapping: ${JSON.stringify(Object.fromEntries(authorYearToNumber))}`);
      }

      // Convert references
      const convertedRefs = await this.convertReferences(refsToConvert, targetStyle);

      // Convert in-text citations format - now generates actual converted text
      const { convertedCitations, citationConversions } = await this.convertInTextCitations(
        citationsToConvert,
        targetStyle,
        convertedRefs
      );

      // Track changes
      const changes = refsToConvert.map((ref, idx) => ({
        referenceId: ref.id,
        oldFormat: ref.rawText,
        newFormat: convertedRefs[idx]?.rawText || ref.rawText
      }));

      logger.info(`[Format Converter] Generated ${citationConversions.length} in-text citation conversions`);

      return {
        convertedReferences: convertedRefs,
        convertedCitations: convertedCitations,
        citationConversions: citationConversions,
        targetStyle,
        changes
      };
    } catch (error) {
      logger.error('[Format Converter] Conversion failed:', error);
      throw error;
    }
  }

  /**
   * Reorder references based on order of first citation appearance in document
   * Used when converting from author-year to numeric style
   */
  private reorderByAppearance(
    references: ReferenceEntry[],
    citations: InTextCitation[]
  ): { reorderedRefs: ReferenceEntry[]; reorderedCitations: InTextCitation[]; authorYearToNumber: Map<string, number> } {
    // Sort citations by position in document
    const sortedCitations = [...citations].sort((a, b) => {
      const posA = a.position?.paragraph ?? 0;
      const posB = b.position?.paragraph ?? 0;
      if (posA !== posB) return posA - posB;
      return (a.position?.startChar ?? 0) - (b.position?.startChar ?? 0);
    });

    // Map author-year key to new number (by first appearance)
    const authorYearToNumber = new Map<string, number>();
    // Map old reference index to new number
    const oldIndexToNewNumber = new Map<number, number>();
    let nextNumber = 1;

    for (const citation of sortedCitations) {
      const citationText = citation.text || '';
      if (!citationText || !this.detectAuthorYearCitation(citationText)) continue;

      // Create a key from author + year for deduplication (using helper)
      const key = this.extractAuthorYearKey(citationText);

      // Skip if already assigned a number or empty key
      if (!key || key === '|' || authorYearToNumber.has(key)) continue;

      // Find matching reference
      const matchedRefIndex = this.findMatchingReferenceIndex(citationText, references);
      if (matchedRefIndex >= 0) {
        authorYearToNumber.set(key, nextNumber);
        oldIndexToNewNumber.set(matchedRefIndex, nextNumber);
        logger.info(`[Format Converter] Appearance order: "${citationText}" (key: ${key}) → ref #${nextNumber} (was index ${matchedRefIndex})`);
        nextNumber++;
      } else {
        logger.warn(`[Format Converter] No matching reference for: "${citationText}" (key: ${key})`);
        // Still assign a number for unmatched citations to maintain sequence
        authorYearToNumber.set(key, nextNumber);
        logger.info(`[Format Converter] Assigned number ${nextNumber} to unmatched citation: "${citationText}"`);
        nextNumber++;
      }
    }

    // Reorder references based on new numbering
    const reorderedRefs: ReferenceEntry[] = [];
    const usedIndices = new Set<number>();

    // First, add references in order of appearance
    for (let newNum = 1; newNum < nextNumber; newNum++) {
      const entries = Array.from(oldIndexToNewNumber.entries());
      for (const [oldIdx, num] of entries) {
        if (num === newNum && !usedIndices.has(oldIdx)) {
          const ref = references[oldIdx];
          reorderedRefs.push({
            ...ref,
            number: newNum
          });
          usedIndices.add(oldIdx);
          break;
        }
      }
    }

    // Add any remaining references that weren't cited
    references.forEach((ref, idx) => {
      if (!usedIndices.has(idx)) {
        reorderedRefs.push({
          ...ref,
          number: nextNumber++
        });
      }
    });

    // Update citations with new reference numbers
    const reorderedCitations = citations.map(citation => {
      const citationText = citation.text || '';
      if (!citationText || !this.detectAuthorYearCitation(citationText)) {
        return citation;
      }

      // Find which number this citation maps to
      const key = this.extractAuthorYearKey(citationText);

      const newNumber = authorYearToNumber.get(key);
      if (newNumber !== undefined) {
        return {
          ...citation,
          numbers: [newNumber]
        };
      }
      return citation;
    });

    return { reorderedRefs, reorderedCitations, authorYearToNumber };
  }

  /**
   * Extract a normalized key from an author-year citation for matching
   */
  private extractAuthorYearKey(citationText: string): string {
    const yearMatch = citationText.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? yearMatch[0] : '';

    // Try multiple patterns to extract author name
    let authorText = '';

    // Pattern 1: (Author et al., Year) or (Author, Year) - with optional space after paren
    // Matches: "(Brown et al., 2020)" or "( Brown et al., 2020)"
    const pattern1 = citationText.match(/\(\s*([A-Za-z][A-Za-z\-]+)(?:\s+et\s+al\.?)?(?:,?\s*\d{4}|\s+\d{4})/i);
    if (pattern1) {
      authorText = pattern1[1].trim();
    }

    // Pattern 2: Author et al., Year (no parentheses) or Author et al. (Year)
    // Matches: "Bommasani et al., 2021" or "Brown et al. 2020"
    if (!authorText) {
      const pattern2 = citationText.match(/^([A-Za-z][A-Za-z\-]+)\s+et\s+al\.?,?\s*(?:\(?\d{4}\)?)/i);
      if (pattern2) {
        authorText = pattern2[1].trim();
      }
    }

    // Pattern 3: (Author & Author, Year) - get first author, with optional space after paren
    if (!authorText) {
      const pattern3 = citationText.match(/\(\s*([A-Za-z][A-Za-z\-]+)\s*&/i);
      if (pattern3) {
        authorText = pattern3[1].trim();
      }
    }

    // Pattern 4: Just Author, Year in parentheses - with optional space after paren
    if (!authorText) {
      const pattern4 = citationText.match(/\(\s*([A-Za-z][A-Za-z\-]+),?\s*\d{4}/i);
      if (pattern4) {
        authorText = pattern4[1].trim();
      }
    }

    // Pattern 5: Author Year without parentheses (no "et al.")
    // Matches: "Smith 2020" or "Smith, 2020"
    if (!authorText) {
      const pattern5 = citationText.match(/^([A-Za-z][A-Za-z\-]+)[,\s]+(?:19|20)\d{2}/i);
      if (pattern5) {
        authorText = pattern5[1].trim();
      }
    }

    // Pattern 6: Author & Author, Year without parentheses
    // Matches: "Smith & Jones, 2020"
    if (!authorText) {
      const pattern6 = citationText.match(/^([A-Za-z][A-Za-z\-]+)\s*&/i);
      if (pattern6) {
        authorText = pattern6[1].trim();
      }
    }

    return `${authorText.toLowerCase()}|${year}`;
  }

  /**
   * Find the index of a reference that matches an author-year citation
   */
  private findMatchingReferenceIndex(citationText: string, refs: ReferenceEntry[]): number {
    const yearMatch = citationText.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? yearMatch[0] : null;

    // Extract author name using multiple patterns
    let authorText: string | null = null;

    // Pattern 1: (Author et al., Year) or (Author, Year) - with optional space after paren
    // Matches: "(Brown et al., 2020)" or "( Brown et al., 2020)"
    const pattern1 = citationText.match(/\(\s*([A-Za-z][A-Za-z\-]+)(?:\s+et\s+al\.?)?(?:,?\s*\d{4}|\s+\d{4})/i);
    if (pattern1) authorText = pattern1[1].trim();

    // Pattern 2: Author et al., Year (no parentheses)
    // Matches: "Bommasani et al., 2021"
    if (!authorText) {
      const pattern2 = citationText.match(/^([A-Za-z][A-Za-z\-]+)\s+et\s+al\.?,?\s*(?:\(?\d{4}\)?)/i);
      if (pattern2) authorText = pattern2[1].trim();
    }

    // Pattern 3: (Author & Author, Year) - get first author, with optional space
    if (!authorText) {
      const pattern3 = citationText.match(/\(\s*([A-Za-z][A-Za-z\-]+)\s*&/i);
      if (pattern3) authorText = pattern3[1].trim();
    }

    // Pattern 4: Just Author, Year in parentheses - with optional space
    if (!authorText) {
      const pattern4 = citationText.match(/\(\s*([A-Za-z][A-Za-z\-]+),?\s*\d{4}/i);
      if (pattern4) authorText = pattern4[1].trim();
    }

    // Pattern 5: Author Year without parentheses (no "et al.")
    // Matches: "Smith 2020" or "Smith, 2020"
    if (!authorText) {
      const pattern5 = citationText.match(/^([A-Za-z][A-Za-z\-]+)[,\s]+(?:19|20)\d{2}/i);
      if (pattern5) authorText = pattern5[1].trim();
    }

    // Pattern 6: Author & Author, Year without parentheses
    // Matches: "Smith & Jones, 2020"
    if (!authorText) {
      const pattern6 = citationText.match(/^([A-Za-z][A-Za-z\-]+)\s*&/i);
      if (pattern6) authorText = pattern6[1].trim();
    }

    logger.info(`[Format Converter] findMatchingReferenceIndex: citationText="${citationText}", author="${authorText}", year="${year}"`);

    if (!authorText && !year) return -1;

    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const refYear = ref.components?.year;
      const refAuthors = ref.components?.authors || [];

      const yearMatches = !year || refYear === year;
      if (!yearMatches) continue;

      if (authorText && refAuthors.length > 0) {
        const firstAuthorLastName = this.extractLastName(refAuthors[0] || '');
        if (firstAuthorLastName) {
          const authorMatches =
            authorText.toLowerCase().includes(firstAuthorLastName.toLowerCase()) ||
            firstAuthorLastName.toLowerCase().includes(authorText.toLowerCase());
          if (authorMatches) {
            logger.info(`[Format Converter] Matched "${authorText}" to ref[${i}] author "${firstAuthorLastName}"`);
            return i;
          }
        }
      }
    }

    logger.warn(`[Format Converter] No match found for author="${authorText}", year="${year}"`);
    return -1;
  }

  /**
   * Convert references to target style using AI
   */
  private async convertReferences(
    references: ReferenceEntry[],
    targetStyle: CitationStyle
  ): Promise<ReferenceEntry[]> {
    const styleGuide = this.getStyleGuide(targetStyle);

    const prompt = `You are a citation formatting expert. Convert the following references from their current format to ${targetStyle} format.

IMPORTANT: The references below may be in Vancouver, APA, or another format. You MUST reformat them completely to ${targetStyle} style.

${styleGuide}

References to convert (currently NOT in ${targetStyle} format):
${references.map((r, idx) => `${idx + 1}. ${r.rawText}`).join('\n')}

TASK: Reformat EACH reference to proper ${targetStyle} citation style.

CRITICAL REQUIREMENTS for the "rawText" field:
1. The rawText MUST be the COMPLETE, FINAL citation string ready for the reference list
2. MUST include ALL bibliographic details from the original:
   - Authors (properly formatted for ${targetStyle})
   - Year
   - Article/chapter title
   - FULL journal name (expand abbreviations like "J Med Res" to "Journal of Medical Research")
   - Volume number
   - Issue number (if present in original)
   - Page range (if present in original)
   - DOI (if present in original)
3. Do NOT omit any details that exist in the original reference
4. Do NOT use abbreviated journal names unless ${targetStyle} specifically requires it

Return ONLY a JSON array with NO additional text:
[
  {
    "number": 1,
    "rawText": "COMPLETE reformatted citation with ALL details - journal name, volume, issue, pages, DOI",
    "authors": ["Surname, A.B."],
    "year": "2020",
    "title": "Title of the work",
    "journal": "Full Journal Name",
    "volume": "10",
    "issue": "2",
    "pages": "123-145",
    "doi": "10.1234/example"
  }
]`;

    logger.info(`[Format Converter] Sending ${references.length} references to AI for conversion to ${targetStyle}`);

    const response = await claudeService.generate(prompt, {
      model: 'sonnet',
      temperature: 0.2,
      maxTokens: 16384
    });

    logger.info(`[Format Converter] AI response length: ${response.text.length} chars`);

    try {
      // Extract JSON array from response (handle cases where AI adds extra text)
      let jsonText = response.text.trim();

      // Find JSON array in response
      const arrayStart = jsonText.indexOf('[');
      const arrayEnd = jsonText.lastIndexOf(']');

      if (arrayStart === -1 || arrayEnd === -1) {
        const errorMsg = 'AI conversion failed: No JSON array found in response';
        logger.error(`[Format Converter] ${errorMsg}`);
        logger.error(`[Format Converter] Response was: ${jsonText.substring(0, 500)}...`);
        throw new Error(errorMsg);
      }

      jsonText = jsonText.substring(arrayStart, arrayEnd + 1);
      logger.info(`[Format Converter] Extracted JSON: ${jsonText.substring(0, 200)}...`);

      const converted = JSON.parse(jsonText);

      if (!Array.isArray(converted)) {
        const errorMsg = 'AI conversion failed: Parsed result is not an array';
        logger.error(`[Format Converter] ${errorMsg}`);
        throw new Error(errorMsg);
      }

      logger.info(`[Format Converter] Successfully parsed ${converted.length} converted references`);
      logger.info(`[Format Converter] Original references count: ${references.length}`);

      // Map by index to ensure correct matching (AI should return refs in same order)
      return converted.map((r: { number?: number; rawText?: string; authors?: string[]; year?: string; title?: string; journal?: string; volume?: string; issue?: string; pages?: string; doi?: string; url?: string; publisher?: string; editors?: string[] }, index: number) => {
        // Use index-based matching first (most reliable)
        // Fall back to number-based if AI provides explicit numbers
        const originalRef = references[index] || references[(r.number || index + 1) - 1];

        if (!originalRef) {
          logger.error(`[Format Converter] No original reference found for index ${index}, number ${r.number}`);
        }

        // Log both original and converted for debugging
        logger.info(`[Format Converter] Reference ${index + 1} (id: ${originalRef?.id || 'MISSING'}):`);
        logger.info(`[Format Converter]   BEFORE: "${(originalRef?.rawText || 'N/A').substring(0, 100)}"`);
        logger.info(`[Format Converter]   AFTER:  "${(r.rawText || 'N/A').substring(0, 100)}"`);

        // IMPORTANT: Preserve original ID for database update
        if (!originalRef?.id) {
          logger.error(`[Format Converter] WARNING: Missing ID for reference ${index + 1} - database update will fail!`);
        }

        // IMPORTANT: Preserve original components for in-text citation conversion
        // Only update rawText from AI conversion
        return {
          id: originalRef?.id || `ref-${index + 1}`,
          number: index + 1,  // Use index-based numbering for consistency
          rawText: r.rawText || originalRef?.rawText || '',
          // Preserve original components (author, year, etc.) for in-text citations
          components: originalRef?.components || {
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
          detectedStyle: targetStyle,
          citedBy: originalRef?.citedBy || []
        };
      });
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[Format Converter] Failed to parse converted references: ${errorMessage}`);
      logger.error(`[Format Converter] Response text: ${response.text.substring(0, 500)}`);
      return references;
    }
  }

  /**
   * Convert in-text citation format
   * Generates actual converted text for each citation based on target style
   */
  private async convertInTextCitations(
    citations: InTextCitation[],
    targetStyle: CitationStyle,
    convertedRefs: ReferenceEntry[]
  ): Promise<{ convertedCitations: InTextCitation[]; citationConversions: CitationConversionInfo[] }> {
    const inTextFormat = this.getInTextFormat(targetStyle);
    const citationConversions: CitationConversionInfo[] = [];
    const processedTexts = new Set<string>(); // Avoid duplicate conversions

    logger.info(`[Format Converter] Converting ${citations.length} in-text citations to ${targetStyle} (format: ${inTextFormat})`);

    // Build a map of reference number to reference data
    const refMap = new Map<number, ReferenceEntry>();
    convertedRefs.forEach((ref, index) => {
      const refNum = ref.number || (index + 1);
      refMap.set(refNum, ref);
      logger.info(`[Format Converter] RefMap[${refNum}]: authors=${JSON.stringify(ref.components?.authors)}, year=${ref.components?.year}`);
    });

    const convertedCitations = citations.map(citation => {
      const originalText = citation.text || '';

      // Skip empty citations
      if (!originalText || originalText.trim() === '') {
        logger.warn(`[Format Converter] Skipping empty citation`);
        return citation;
      }

      // Skip if already processed this exact citation text
      if (processedTexts.has(originalText)) {
        return citation;
      }

      // Detect if this is an author-year citation (e.g., "(Floridi, 2014)" or "(Smith & Jones, 2021)")
      const isAuthorYearCitation = this.detectAuthorYearCitation(originalText);

      // Extract reference numbers - different logic for author-year vs numeric citations
      let numbers = [...(citation.numbers || [])];

      if (isAuthorYearCitation) {
        // For author-year citations, find matching references by author name and year
        numbers = this.matchAuthorYearToReferences(originalText, convertedRefs);
        logger.info(`[Format Converter] Author-year citation "${originalText}" matched to refs: [${numbers.join(', ')}]`);
      } else if (numbers.length === 0) {
        // For numeric citations, extract numbers from text
        // Handle ranges like [3-5] or [3–5] (with en-dash) which should expand to 3, 4, 5
        numbers = this.extractAndExpandNumbers(originalText, convertedRefs.length);
        if (numbers.length > 0) {
          logger.info(`[Format Converter] Extracted/expanded numbers from "${originalText}": [${numbers.join(', ')}]`);
        }
      }

      if (numbers.length === 0) {
        logger.warn(`[Format Converter] No reference numbers found for citation: "${originalText}"`);
        return citation;
      }

      let newText = originalText;
      let format: 'bracket' | 'parenthesis' | 'superscript' = 'parenthesis';

      if (inTextFormat === 'author-year') {
        // Convert to author-year format: (1) → (Smith, 2020) or (Smith & Jones, 2020)
        const authorYearParts: string[] = [];

        for (const num of numbers) {
          const ref = refMap.get(num);
          logger.info(`[Format Converter] Looking up ref #${num}: found=${!!ref}, hasComponents=${!!ref?.components}`);

          if (ref && ref.components && ref.components.authors && ref.components.authors.length > 0) {
            const authorText = this.formatAuthorsForInText(ref.components.authors);
            const year = ref.components.year || 'n.d.';

            logger.info(`[Format Converter] Ref #${num}: authors="${authorText}", year="${year}"`);

            if (targetStyle === 'MLA') {
              // MLA uses (Author page) but for articles without page, just (Author)
              authorYearParts.push(authorText);
            } else {
              // APA and Harvard use (Author, Year)
              authorYearParts.push(`${authorText}, ${year}`);
            }
          } else {
            // Fallback: keep original number if no author data
            logger.warn(`[Format Converter] No author data for ref #${num}, keeping number`);
            authorYearParts.push(String(num));
          }
        }

        newText = `(${authorYearParts.join('; ')})`;
        format = 'parenthesis';
        logger.info(`[Format Converter] Author-year conversion: "${originalText}" → "${newText}"`);

      } else if (inTextFormat === 'numeric') {
        // Convert to numeric format using the correct reference numbers
        if (targetStyle === 'IEEE') {
          // IEEE uses [1], [2], [1, 2]
          newText = `[${numbers.join(', ')}]`;
          format = 'bracket';
        } else if (targetStyle === 'Vancouver' || targetStyle === 'AMA') {
          // Vancouver/AMA use (1), (2) or superscript
          newText = `(${numbers.join(', ')})`;
          format = 'parenthesis';
        }
        logger.info(`[Format Converter] Numeric conversion: "${originalText}" → "${newText}"`);

      } else if (inTextFormat === 'footnote') {
        // Chicago footnote style - uses superscript numbers
        newText = numbers.map(n => this.toSuperscript(n)).join(',');
        format = 'superscript';
      }

      // Only add to conversions if text actually changed
      if (newText !== originalText && !processedTexts.has(originalText)) {
        processedTexts.add(originalText);
        citationConversions.push({
          oldText: originalText,
          newText: newText,
          referenceNumber: numbers[0] || 0
        });
        logger.info(`[Format Converter] In-text citation: "${originalText}" → "${newText}"`);
      }

      return {
        ...citation,
        format,
        text: newText
      };
    });

    return { convertedCitations, citationConversions };
  }

  /**
   * Detect if a citation is in author-year format (e.g., "(Floridi, 2014)" or "(Smith & Jones, 2021)")
   */
  private detectAuthorYearCitation(text: string): boolean {
    // Author-year patterns:
    // (Author, Year) or (Author Year) or (Author, Year, p. 123)
    // (Author & Author, Year) or (Author et al., Year)
    // Also handles: "( Brown et al., 2020)" with space after paren
    // Also handles: "Bommasani et al., 2021" without parentheses

    const numericPattern = /^\s*[\(\[]\d{1,3}[\)\]]\s*$/; // Just (1) or [1]

    // If it looks like a simple numeric citation, it's not author-year
    if (numericPattern.test(text)) {
      return false;
    }

    // Pattern 1: In parentheses with optional space after opening paren
    // Matches: (Author..., Year) or ( Author..., Year)
    const parenAuthorYearPattern = /\(\s*[A-Z][a-z]+.*\d{4}/;
    if (parenAuthorYearPattern.test(text)) {
      return true;
    }

    // Pattern 2: Author name followed by year without parentheses
    // Matches: "Bommasani et al., 2021" or "Smith 2020"
    const noParenAuthorYearPattern = /^[A-Z][a-z]+(?:\s+et\s+al\.?)?[,\s]+(?:19|20)\d{2}/;
    if (noParenAuthorYearPattern.test(text.trim())) {
      return true;
    }

    // Pattern 3: Author with & (two authors) without parentheses
    // Matches: "Smith & Jones, 2020"
    const twoAuthorNoParenPattern = /^[A-Z][a-z]+\s*&\s*[A-Z][a-z]+[,\s]+(?:19|20)\d{2}/;
    if (twoAuthorNoParenPattern.test(text.trim())) {
      return true;
    }

    return false;
  }

  /**
   * Match author-year citation text to reference numbers
   * E.g., "(Floridi, 2014)" → [1] if Floridi 2014 is reference #1
   */
  private matchAuthorYearToReferences(citationText: string, refs: ReferenceEntry[]): number[] {
    const matchedNumbers: number[] = [];

    // Extract year from citation
    const yearMatch = citationText.match(/\b(19|20)\d{2}\b/);
    const year = yearMatch ? yearMatch[0] : null;

    // Extract author name(s) from citation using multiple patterns
    let authorText: string | null = null;

    // Pattern 1: In parentheses with optional space after paren
    // Matches: "(Floridi, 2020)" or "( Brown et al., 2020)"
    const parenMatch = citationText.match(/\(\s*([A-Za-z][A-Za-z\s&.,]+?)(?:,?\s*(?:et al\.?)?,?\s*\d{4}|\s+\d{4})/);
    if (parenMatch) {
      authorText = parenMatch[1].trim();
    }

    // Pattern 2: Author et al. without parentheses
    // Matches: "Bommasani et al., 2021"
    if (!authorText) {
      const etAlMatch = citationText.match(/^([A-Za-z][A-Za-z\-]+)\s+et\s+al\.?,?\s*(?:\(?\d{4}\)?)/i);
      if (etAlMatch) {
        authorText = etAlMatch[1].trim();
      }
    }

    // Pattern 3: Simple Author, Year without parentheses
    // Matches: "Smith, 2020" or "Smith 2020"
    if (!authorText) {
      const simpleMatch = citationText.match(/^([A-Za-z][A-Za-z\-]+)[,\s]+(?:19|20)\d{2}/i);
      if (simpleMatch) {
        authorText = simpleMatch[1].trim();
      }
    }

    logger.info(`[Format Converter] Matching citation: authorText="${authorText}", year="${year}"`);

    if (!authorText && !year) {
      return matchedNumbers;
    }

    // Try to find matching reference
    for (const ref of refs) {
      const refNum = ref.number || 0;
      const refYear = ref.components?.year;
      const refAuthors = ref.components?.authors || [];

      // Check year match
      const yearMatches = !year || refYear === year;

      // Check author match
      let authorMatches = false;
      if (authorText) {
        // Get first author's last name from reference
        const firstAuthorLastName = this.extractLastName(refAuthors[0] || '');

        // Check if citation contains this author's name
        if (firstAuthorLastName) {
          // Handle "et al." - just match first author
          const citationFirstAuthor = authorText.replace(/\s*&.*/, '').replace(/\s*et al\.?.*/, '').trim();
          authorMatches = citationFirstAuthor.toLowerCase().includes(firstAuthorLastName.toLowerCase()) ||
                          firstAuthorLastName.toLowerCase().includes(citationFirstAuthor.toLowerCase());
        }
      } else {
        // No author text to match, rely on year only
        authorMatches = true;
      }

      if (yearMatches && authorMatches) {
        logger.info(`[Format Converter] Matched "${authorText}, ${year}" to ref #${refNum}`);
        matchedNumbers.push(refNum);
      }
    }

    return matchedNumbers;
  }

  /**
   * Extract last name from an author string
   */
  private extractLastName(author: string): string {
    if (!author || typeof author !== 'string') {
      return '';
    }

    const trimmed = author.trim();

    if (trimmed.includes(',')) {
      // "Smith, J." → "Smith"
      return trimmed.split(',')[0].trim();
    }

    // "J. Smith" or "John Smith" → "Smith" (last word, unless it's initials)
    const parts = trimmed.split(/\s+/);
    if (parts.length === 1) {
      return parts[0];
    }

    // Return last non-initial part
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i];
      // Skip suffixes and initials
      if (!part.match(/^(Jr\.?|Sr\.?|II|III|IV|[A-Z]\.?)$/i) && part.length > 2) {
        return part;
      }
    }

    return parts[parts.length - 1];
  }

  /**
   * Extract numbers from citation text and expand ranges
   * E.g., "[3-5]" or "[3–5]" becomes [3, 4, 5]
   * E.g., "[1,3,5]" becomes [1, 3, 5]
   * E.g., "[1,3-5]" becomes [1, 3, 4, 5]
   */
  private extractAndExpandNumbers(text: string, maxRef: number): number[] {
    const numbers: number[] = [];
    const seen = new Set<number>();

    // Match ranges like 3-5 or 3–5 (with en-dash or em-dash)
    const rangePattern = /(\d{1,3})\s*[-–—]\s*(\d{1,3})/g;
    let rangeMatch;
    while ((rangeMatch = rangePattern.exec(text)) !== null) {
      const start = parseInt(rangeMatch[1]);
      const end = parseInt(rangeMatch[2]);
      logger.info(`[Format Converter] Found range: ${start}-${end}`);
      for (let i = start; i <= end && i <= maxRef; i++) {
        if (i > 0 && !seen.has(i)) {
          numbers.push(i);
          seen.add(i);
        }
      }
    }

    // Also match standalone numbers (not part of ranges)
    // Remove the ranges first to avoid double-counting
    const textWithoutRanges = text.replace(/\d{1,3}\s*[-–—]\s*\d{1,3}/g, '');
    const singleNumPattern = /\b(\d{1,3})\b/g;
    let singleMatch;
    while ((singleMatch = singleNumPattern.exec(textWithoutRanges)) !== null) {
      const num = parseInt(singleMatch[1]);
      if (num > 0 && num <= maxRef && !seen.has(num)) {
        numbers.push(num);
        seen.add(num);
      }
    }

    // Sort the numbers
    numbers.sort((a, b) => a - b);
    return numbers;
  }

  /**
   * Format authors for in-text citation
   * Returns: "Smith" for 1 author, "Smith & Jones" for 2, "Smith et al." for 3+
   */
  private formatAuthorsForInText(authors: string[]): string {
    if (!authors || authors.length === 0) {
      return 'Unknown';
    }

    logger.info(`[Format Converter] Formatting authors for in-text: ${JSON.stringify(authors)}`);

    // Extract last name from each author
    const lastNames = authors.map(author => {
      if (!author || typeof author !== 'string') {
        return 'Unknown';
      }

      const trimmed = author.trim();

      // Handle various formats:
      // 1. "Smith, J." or "Smith, John" → "Smith"
      // 2. "J. Smith" or "John Smith" → "Smith"
      // 3. "Smith" → "Smith"
      // 4. "A." or single initial → skip or use as-is

      if (trimmed.includes(',')) {
        // Format: "Last, First" - take part before comma
        const lastName = trimmed.split(',')[0].trim();
        logger.info(`[Format Converter] Comma format: "${trimmed}" → "${lastName}"`);
        return lastName;
      }

      // Split by spaces
      const parts = trimmed.split(/\s+/).filter(p => p.length > 0);

      if (parts.length === 0) {
        return 'Unknown';
      }

      if (parts.length === 1) {
        // Single word - could be last name or initial
        // If it's just initials (1-2 chars with period), it's not a full name
        if (parts[0].length <= 3 && parts[0].includes('.')) {
          logger.warn(`[Format Converter] Author appears to be just initials: "${trimmed}"`);
          return parts[0].replace('.', ''); // Return initial without period
        }
        return parts[0];
      }

      // Helper function to check if a string looks like initials
      // Initials are typically: "H", "JK", "H.", "J.K.", "MC" (short uppercase)
      const looksLikeInitials = (str: string): boolean => {
        const cleaned = str.replace(/\./g, '').trim();
        // Short (1-3 chars) and all uppercase, or contains periods
        if (cleaned.length <= 3 && cleaned === cleaned.toUpperCase()) {
          return true;
        }
        // Contains periods and is short (like "J." or "J.K.")
        if (str.includes('.') && str.length <= 5) {
          return true;
        }
        return false;
      };

      // Check if last word looks like initials (e.g., "Henseler H" or "Smith JK")
      const lastPart = parts[parts.length - 1];
      if (looksLikeInitials(lastPart)) {
        // Last name is first: "Henseler H" → "Henseler"
        const lastName = parts[0];
        logger.info(`[Format Converter] LastName-First format: "${trimmed}" → "${lastName}" (last part "${lastPart}" looks like initials)`);
        return lastName;
      }

      // Multiple words - last word is usually the last name (e.g., "John Smith")
      // But skip if it looks like a suffix (Jr., III, etc.)
      let lastNameIndex = parts.length - 1;
      const suffixes = ['jr', 'jr.', 'sr', 'sr.', 'ii', 'iii', 'iv'];
      if (suffixes.includes(parts[lastNameIndex].toLowerCase())) {
        lastNameIndex--;
      }

      const lastName = parts[lastNameIndex] || parts[parts.length - 1];
      logger.info(`[Format Converter] Space format: "${trimmed}" → "${lastName}"`);
      return lastName;
    }).filter(name => name && name !== 'Unknown');

    if (lastNames.length === 1) {
      return lastNames[0];
    } else if (lastNames.length === 2) {
      return `${lastNames[0]} & ${lastNames[1]}`;
    } else {
      return `${lastNames[0]} et al.`;
    }
  }

  /**
   * Get style guide for AI
   * IMPORTANT: These guides must explicitly request ALL bibliographic details
   */
  private getStyleGuide(style: CitationStyle): string {
    const guides: Record<CitationStyle, string> = {
      APA: `APA 7th Edition Format:
CRITICAL: You MUST include ALL of the following details from the original citation:
- Authors (Last, F. M. format, use & before last author)
- Year in parentheses
- Article/chapter title (sentence case, no quotes)
- Journal name (italicized/title case) - MUST INCLUDE FULL JOURNAL NAME
- Volume number (italicized)
- Issue number in parentheses (if available)
- Page range (e.g., 123-145)
- DOI as URL (if available)

Full format: Author, A. A., & Author, B. B. (Year). Title of article in sentence case. Journal Name in Title Case, Volume(Issue), PageStart-PageEnd. https://doi.org/xxxxx

Example conversions:
- Vancouver: "1. Smith JA, Jones BC. Effect of treatment. J Med Res. 2020;45(3):123-145."
- APA: "Smith, J. A., & Jones, B. C. (2020). Effect of treatment. Journal of Medical Research, 45(3), 123-145."

- In-text: (Author, Year) or Author (Year)`,

      MLA: `MLA 9th Edition Format:
CRITICAL: You MUST include ALL bibliographic details:
- Authors (Last, First format)
- Article title in quotation marks
- Journal name (italicized) - FULL NAME required
- Volume, Issue, Year
- Page range with pp. prefix
- DOI or URL

Full format: Author Last, First. "Title of Article." Journal Name, vol. #, no. #, Year, pp. ##-##. DOI.
- In-text: (Author Page) or Author (Page)`,

      Chicago: `Chicago Manual of Style (17th ed) - Notes and Bibliography:
CRITICAL: Include ALL bibliographic details:
- Author(s) full name
- Article title in quotes
- Journal name (italicized) - FULL NAME
- Volume, Issue, Year
- Page range
- DOI

Full format: Author First Last, "Title of Article," Journal Name volume, no. issue (Year): pages, DOI.
- In-text: Superscript numbers with footnotes`,

      Vancouver: `Vancouver Style (Uniform Requirements):
CRITICAL: Include ALL bibliographic details:
- Author(s) initials after surname (no periods)
- Article title
- Journal name (abbreviated per NLM) - include full abbreviated name
- Year
- Volume(Issue)
- Page range
- DOI

Full format: Author AA, Author BB. Title of article. Journal Name. Year;Volume(Issue):Pages. doi:xxxxx
- In-text: Superscript numbers [1] or (1)`,

      IEEE: `IEEE Citation Style:
CRITICAL: Include ALL bibliographic details:
- Authors (initials before surname)
- Article title in quotes
- Journal name (italicized)
- Volume, Issue, Pages
- Month/Year
- DOI

Full format: [#] A. Author and B. Author, "Title of article," Journal Name, vol. #, no. #, pp. ##-##, Month Year. doi: xxxxx
- In-text: [#]`,

      Harvard: `Harvard Referencing Style:
CRITICAL: Convert from Vancouver/numbered format to Harvard format with ALL details:
- Authors: Last name, then initials with periods: "Smith, J.A." NOT "Smith JA"
- Year: Immediately after author name
- Article title
- Journal name: FULL name (not abbreviated)
- Volume(Issue)
- Page range with pp. prefix

Full format: Surname, INITIALS., Year. Title of article. Journal Name, Volume(Issue), pp.pages.

Example conversion:
- Vancouver: "Henseler H. Treatment outcomes in surgery. GMS Surg. 2023;12(3):45-52."
- Harvard: "Henseler, H., 2023. Treatment outcomes in surgery. German Medical Science Surgery, 12(3), pp.45-52."

- In-text: (Author Year) or Author (Year)`,

      AMA: `AMA Manual of Style (11th ed):
CRITICAL: Include ALL bibliographic details:
- Authors (surname then initials, no periods)
- Article title
- Journal name (abbreviated per NLM)
- Year
- Volume(Issue)
- Page range
- DOI

Full format: Author AA, Author BB. Title of article. Journal Name. Year;volume(issue):pages. doi:xxxxx
- In-text: Superscript numbers`
    };

    return guides[style] || guides.APA;
  }

  /**
   * Get in-text citation format for style
   */
  private getInTextFormat(style: CitationStyle): 'numeric' | 'author-year' | 'footnote' {
    const formats: Record<CitationStyle, 'numeric' | 'author-year' | 'footnote'> = {
      APA: 'author-year',
      MLA: 'author-year',
      Chicago: 'footnote',
      Vancouver: 'numeric',
      IEEE: 'numeric',
      Harvard: 'author-year',
      AMA: 'numeric'
    };

    return formats[style];
  }

  /**
   * Convert number to superscript
   */
  private toSuperscript(num: number): string {
    const superscriptMap: Record<string, string> = {
      '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴',
      '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹'
    };
    return num.toString().split('').map(d => superscriptMap[d] || d).join('');
  }

  /**
   * Get list of supported citation styles
   */
  getSupportedStyles(): CitationStyle[] {
    return ['APA', 'MLA', 'Chicago', 'Vancouver', 'IEEE', 'Harvard', 'AMA'];
  }

  /**
   * Validate if a style is supported
   */
  isStyleSupported(style: string): boolean {
    return this.getSupportedStyles().includes(style as CitationStyle);
  }
}

export const aiFormatConverterService = new AIFormatConverterService();
