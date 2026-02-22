/**
 * Style Guide Extractor Service
 *
 * Extracts style rules from uploaded PDF/Word documents using AI.
 * Categorizes and structures rules for storage.
 */

import { geminiService } from '../ai/gemini.service';
import { documentExtractor } from '../document/document-extractor.service';
import { logger } from '../../lib/logger';
import type { StyleCategory, StyleSeverity, HouseRuleType } from '@prisma/client';

export interface ExtractedRule {
  name: string;
  description: string;
  category: StyleCategory;
  ruleType: HouseRuleType;
  pattern?: string;
  preferredTerm?: string;
  avoidTerms: string[];
  severity: StyleSeverity;
  sourceSection?: string;
  sourcePageNumber?: number;
  examples?: {
    incorrect: string;
    correct: string;
  }[];
}

export interface ExtractionResult {
  success: boolean;
  documentTitle?: string;
  totalRulesExtracted: number;
  rules: ExtractedRule[];
  categories: Record<string, number>;
  processingTimeMs: number;
  warnings: string[];
  sourceDocument: {
    fileName: string;
    fileType: string;
    pageCount?: number;
  };
}

interface StyleGuideSection {
  title: string;
  content: string;
  pageNumber?: number;
}

const EXTRACTION_PROMPT = `You are an expert editorial style guide analyst. Extract all style rules from the following document section.

For each rule found, provide:
1. name: A short, descriptive name for the rule
2. description: Clear explanation of what the rule requires
3. category: One of: PUNCTUATION, CAPITALIZATION, NUMBERS, ABBREVIATIONS, HYPHENATION, SPELLING, GRAMMAR, TERMINOLOGY, FORMATTING, CITATIONS, OTHER
4. ruleType: One of: TERMINOLOGY (for word/phrase preferences), PATTERN (for regex-detectable patterns), CAPITALIZATION, PUNCTUATION
5. preferredTerm: The preferred word/phrase (if applicable)
6. avoidTerms: Array of terms to avoid (if applicable)
7. severity: ERROR (must fix), WARNING (should fix), or SUGGESTION (consider fixing)
8. examples: Array of {incorrect, correct} pairs showing the rule in action

Return a JSON array of rules. Be thorough - extract EVERY rule mentioned, no matter how small.

Document Section:
---
{content}
---

Return ONLY valid JSON array, no other text.`;

const CATEGORIZATION_PROMPT = `Analyze these extracted rules and improve their categorization.

Rules:
{rules}

For each rule:
1. Verify the category is correct
2. Improve the name if needed (make it concise but descriptive)
3. Enhance the description for clarity
4. Add any missing examples
5. Suggest a regex pattern if the rule can be detected automatically

Return the improved rules as a JSON array.`;

class StyleGuideExtractorService {
  /**
   * Extract style rules from an uploaded document
   */
  async extractFromDocument(
    filePath: string,
    fileName: string,
    fileType: 'pdf' | 'docx'
  ): Promise<ExtractionResult> {
    const startTime = Date.now();
    const warnings: string[] = [];
    const allRules: ExtractedRule[] = [];

    try {
      // Step 1: Extract text from document
      const extractedContent = await this.extractDocumentContent(filePath, fileType);

      if (!extractedContent.text || extractedContent.text.length < 100) {
        return {
          success: false,
          totalRulesExtracted: 0,
          rules: [],
          categories: {},
          processingTimeMs: Date.now() - startTime,
          warnings: ['Document appears to be empty or contains too little text'],
          sourceDocument: {
            fileName,
            fileType,
            pageCount: extractedContent.pageCount,
          },
        };
      }

      // Step 2: Split into sections for processing
      const sections = this.splitIntoSections(extractedContent.text, extractedContent.pageCount);

      // Step 3: Extract rules from each section using AI
      for (const section of sections) {
        try {
          const sectionRules = await this.extractRulesFromSection(section);
          allRules.push(...sectionRules);
        } catch (error) {
          warnings.push(`Failed to extract rules from section: ${section.title}`);
          logger.error('[StyleGuideExtractor] Section extraction error:', error);
        }
      }

      // Step 4: Deduplicate and categorize rules
      const deduplicatedRules = this.deduplicateRules(allRules);

      // Step 5: Enhance rules with AI categorization
      const enhancedRules = await this.enhanceRules(deduplicatedRules);

      // Step 6: Calculate category distribution
      const categories: Record<string, number> = {};
      for (const rule of enhancedRules) {
        categories[rule.category] = (categories[rule.category] || 0) + 1;
      }

      return {
        success: true,
        documentTitle: extractedContent.title,
        totalRulesExtracted: enhancedRules.length,
        rules: enhancedRules,
        categories,
        processingTimeMs: Date.now() - startTime,
        warnings,
        sourceDocument: {
          fileName,
          fileType,
          pageCount: extractedContent.pageCount,
        },
      };
    } catch (error) {
      logger.error('[StyleGuideExtractor] Extraction failed:', error);
      return {
        success: false,
        totalRulesExtracted: 0,
        rules: [],
        categories: {},
        processingTimeMs: Date.now() - startTime,
        warnings: [`Extraction failed: ${error instanceof Error ? error.message : 'Unknown error'}`],
        sourceDocument: {
          fileName,
          fileType,
        },
      };
    }
  }

  /**
   * Extract text content from document
   */
  private async extractDocumentContent(
    filePath: string,
    fileType: 'pdf' | 'docx'
  ): Promise<{ text: string; title?: string; pageCount?: number }> {
    if (fileType === 'pdf') {
      const result = await documentExtractor.extractFromPdf(filePath);
      return {
        text: result.text,
        title: result.metadata?.title,
        pageCount: result.metadata?.pageCount,
      };
    } else {
      const result = await documentExtractor.extractFromDocx(filePath);
      return {
        text: result.text,
        title: result.metadata?.title,
      };
    }
  }

  /**
   * Split document into logical sections
   */
  private splitIntoSections(text: string, pageCount?: number): StyleGuideSection[] {
    const sections: StyleGuideSection[] = [];

    // Try to split by common section headers
    const sectionPatterns = [
      /^#{1,3}\s+(.+)$/gm,  // Markdown headers
      /^([A-Z][A-Z\s]+)$/gm,  // ALL CAPS headers
      /^\d+\.\s+([A-Z].+)$/gm,  // Numbered sections
      /^([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s*$/gm,  // Title Case headers
    ];

    const headerMatches: { index: number; title: string }[] = [];

    for (const pattern of sectionPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        headerMatches.push({
          index: match.index,
          title: match[1].trim(),
        });
      }
    }

    // Sort by position
    headerMatches.sort((a, b) => a.index - b.index);

    // Deduplicate nearby headers
    const uniqueHeaders = headerMatches.filter((h, i) => {
      if (i === 0) return true;
      return h.index - headerMatches[i - 1].index > 50;
    });

    if (uniqueHeaders.length === 0) {
      // No headers found, split by character count
      const chunkSize = 3000;
      for (let i = 0; i < text.length; i += chunkSize) {
        sections.push({
          title: `Section ${Math.floor(i / chunkSize) + 1}`,
          content: text.slice(i, i + chunkSize),
          pageNumber: pageCount ? Math.floor((i / text.length) * pageCount) + 1 : undefined,
        });
      }
    } else {
      // Split by headers
      for (let i = 0; i < uniqueHeaders.length; i++) {
        const start = uniqueHeaders[i].index;
        const end = i < uniqueHeaders.length - 1 ? uniqueHeaders[i + 1].index : text.length;
        const content = text.slice(start, end);

        if (content.length > 100) {  // Only include substantial sections
          sections.push({
            title: uniqueHeaders[i].title,
            content,
            pageNumber: pageCount ? Math.floor((start / text.length) * pageCount) + 1 : undefined,
          });
        }
      }
    }

    return sections;
  }

  /**
   * Extract rules from a single section using AI
   */
  private async extractRulesFromSection(section: StyleGuideSection): Promise<ExtractedRule[]> {
    const prompt = EXTRACTION_PROMPT.replace('{content}', section.content.slice(0, 8000));

    try {
      const aiResponse = await geminiService.generateText(prompt, {
        maxOutputTokens: 4000,
        temperature: 0.1,
      });
      const response = aiResponse.text;

      // Parse JSON response
      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        logger.warn('[StyleGuideExtractor] No JSON array found in response');
        return [];
      }

      const rules = JSON.parse(jsonMatch[0]) as Partial<ExtractedRule>[];

      // Validate and normalize rules
      return rules
        .filter((r) => r.name && r.description)
        .map((r) => ({
          name: r.name || 'Unnamed Rule',
          description: r.description || '',
          category: this.normalizeCategory(r.category),
          ruleType: this.normalizeRuleType(r.ruleType),
          pattern: r.pattern,
          preferredTerm: r.preferredTerm,
          avoidTerms: Array.isArray(r.avoidTerms) ? r.avoidTerms : [],
          severity: this.normalizeSeverity(r.severity),
          sourceSection: section.title,
          sourcePageNumber: section.pageNumber,
          examples: r.examples,
        }));
    } catch (error) {
      logger.error('[StyleGuideExtractor] AI extraction error:', error);
      return [];
    }
  }

  /**
   * Deduplicate rules by name similarity
   */
  private deduplicateRules(rules: ExtractedRule[]): ExtractedRule[] {
    const seen = new Map<string, ExtractedRule>();

    for (const rule of rules) {
      const key = rule.name.toLowerCase().replace(/\s+/g, ' ').trim();

      if (!seen.has(key)) {
        seen.set(key, rule);
      } else {
        // Merge examples if duplicate
        const existing = seen.get(key)!;
        if (rule.examples && rule.examples.length > 0) {
          existing.examples = [...(existing.examples || []), ...rule.examples];
        }
      }
    }

    return Array.from(seen.values());
  }

  /**
   * Enhance rules with better categorization using AI
   */
  private async enhanceRules(rules: ExtractedRule[]): Promise<ExtractedRule[]> {
    if (rules.length === 0) return rules;
    if (rules.length > 50) {
      // Skip enhancement for large rule sets to save API calls
      return rules;
    }

    try {
      const prompt = CATEGORIZATION_PROMPT.replace('{rules}', JSON.stringify(rules, null, 2));

      const aiResponse = await geminiService.generateText(prompt, {
        maxOutputTokens: 8000,
        temperature: 0.1,
      });
      const response = aiResponse.text;

      const jsonMatch = response.match(/\[[\s\S]*\]/);
      if (!jsonMatch) {
        return rules;
      }

      const enhancedRules = JSON.parse(jsonMatch[0]) as ExtractedRule[];

      // Validate array length matches before merging
      if (enhancedRules.length !== rules.length) {
        logger.warn('[StyleGuideExtractor] AI returned different rule count, skipping enhancement');
        return rules;
      }

      // Validate enhanced rules
      return enhancedRules.map((r, i) => ({
        ...(rules[i] || {}),
        ...(r || {}),
        category: this.normalizeCategory(r.category),
        ruleType: this.normalizeRuleType(r.ruleType),
        severity: this.normalizeSeverity(r.severity),
      }));
    } catch (error) {
      logger.error('[StyleGuideExtractor] Enhancement error:', error);
      return rules;
    }
  }

  /**
   * Normalize category value
   */
  private normalizeCategory(category?: string): StyleCategory {
    const valid: StyleCategory[] = [
      'PUNCTUATION', 'CAPITALIZATION', 'NUMBERS', 'ABBREVIATIONS',
      'HYPHENATION', 'SPELLING', 'GRAMMAR', 'TERMINOLOGY',
      'FORMATTING', 'CITATIONS', 'OTHER',
    ];
    const upper = (category || '').toUpperCase() as StyleCategory;
    return valid.includes(upper) ? upper : 'OTHER';
  }

  /**
   * Normalize rule type value
   */
  private normalizeRuleType(ruleType?: string): HouseRuleType {
    const valid: HouseRuleType[] = ['TERMINOLOGY', 'PATTERN', 'CAPITALIZATION', 'PUNCTUATION'];
    const upper = (ruleType || '').toUpperCase() as HouseRuleType;
    return valid.includes(upper) ? upper : 'TERMINOLOGY';
  }

  /**
   * Normalize severity value
   */
  private normalizeSeverity(severity?: string): StyleSeverity {
    const valid: StyleSeverity[] = ['ERROR', 'WARNING', 'SUGGESTION'];
    const upper = (severity || '').toUpperCase() as StyleSeverity;
    return valid.includes(upper) ? upper : 'WARNING';
  }

  /**
   * Get editorial best practices as default rules
   */
  getEditorialBestPractices(): ExtractedRule[] {
    return [
      // Punctuation
      {
        name: 'Serial Comma (Oxford Comma)',
        description: 'Use a comma before the final "and" or "or" in a series of three or more items',
        category: 'PUNCTUATION',
        ruleType: 'PUNCTUATION',
        severity: 'WARNING',
        avoidTerms: [],
        examples: [
          { incorrect: 'red, white and blue', correct: 'red, white, and blue' },
        ],
      },
      {
        name: 'Single Space After Period',
        description: 'Use only one space after a period, not two',
        category: 'PUNCTUATION',
        ruleType: 'PATTERN',
        pattern: '\\.\\s{2,}',
        severity: 'WARNING',
        avoidTerms: [],
        examples: [
          { incorrect: 'End sentence.  Start new.', correct: 'End sentence. Start new.' },
        ],
      },
      {
        name: 'Quotation Marks Punctuation (US)',
        description: 'Place commas and periods inside quotation marks (US style)',
        category: 'PUNCTUATION',
        ruleType: 'PUNCTUATION',
        severity: 'WARNING',
        avoidTerms: [],
        examples: [
          { incorrect: 'He said "hello".', correct: 'He said "hello."' },
        ],
      },
      // Capitalization
      {
        name: 'Title Case for Headings',
        description: 'Capitalize major words in titles and headings',
        category: 'CAPITALIZATION',
        ruleType: 'CAPITALIZATION',
        severity: 'SUGGESTION',
        avoidTerms: [],
      },
      {
        name: 'Lowercase After Colon',
        description: 'Use lowercase after a colon unless it introduces a complete sentence or proper noun',
        category: 'CAPITALIZATION',
        ruleType: 'CAPITALIZATION',
        severity: 'WARNING',
        avoidTerms: [],
      },
      // Numbers
      {
        name: 'Spell Out Numbers Under 10',
        description: 'Spell out numbers zero through nine; use numerals for 10 and above',
        category: 'NUMBERS',
        ruleType: 'TERMINOLOGY',
        preferredTerm: 'one, two, three...',
        avoidTerms: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
        severity: 'WARNING',
      },
      {
        name: 'Consistent Number Format',
        description: 'Use consistent formatting for numbers in lists and comparisons',
        category: 'NUMBERS',
        ruleType: 'TERMINOLOGY',
        severity: 'WARNING',
        avoidTerms: [],
      },
      // Grammar
      {
        name: 'Active Voice Preference',
        description: 'Prefer active voice over passive voice for clearer, more direct writing',
        category: 'GRAMMAR',
        ruleType: 'TERMINOLOGY',
        severity: 'SUGGESTION',
        avoidTerms: [],
        examples: [
          { incorrect: 'The report was written by the team.', correct: 'The team wrote the report.' },
        ],
      },
      {
        name: 'Avoid Split Infinitives',
        description: 'Avoid placing adverbs between "to" and the verb in infinitives when possible',
        category: 'GRAMMAR',
        ruleType: 'PATTERN',
        pattern: '\\bto\\s+\\w+ly\\s+\\w+',
        severity: 'SUGGESTION',
        avoidTerms: [],
        examples: [
          { incorrect: 'to boldly go', correct: 'to go boldly' },
        ],
      },
      // Terminology
      {
        name: 'Gender-Neutral Language',
        description: 'Use gender-neutral terms instead of gendered language',
        category: 'TERMINOLOGY',
        ruleType: 'TERMINOLOGY',
        preferredTerm: 'they/them, chairperson, firefighter',
        avoidTerms: ['mankind', 'manmade', 'chairman', 'fireman', 'policeman'],
        severity: 'WARNING',
      },
      {
        name: 'Avoid Jargon',
        description: 'Use plain language instead of jargon or technical terms when writing for general audiences',
        category: 'TERMINOLOGY',
        ruleType: 'TERMINOLOGY',
        preferredTerm: 'use, help, start',
        avoidTerms: ['utilize', 'facilitate', 'commence', 'leverage'],
        severity: 'SUGGESTION',
      },
      // Abbreviations
      {
        name: 'Define Abbreviations on First Use',
        description: 'Spell out abbreviations on first use, followed by the abbreviation in parentheses',
        category: 'ABBREVIATIONS',
        ruleType: 'TERMINOLOGY',
        severity: 'ERROR',
        avoidTerms: [],
        examples: [
          { incorrect: 'The WHO recommends...', correct: 'The World Health Organization (WHO) recommends...' },
        ],
      },
      {
        name: 'Common Abbreviations Without Definition',
        description: 'Common abbreviations like USA, UK, NASA do not need definition',
        category: 'ABBREVIATIONS',
        ruleType: 'TERMINOLOGY',
        severity: 'SUGGESTION',
        avoidTerms: [],
      },
      // Formatting
      {
        name: 'Consistent Bullet Style',
        description: 'Use consistent bullet points or numbering throughout the document',
        category: 'FORMATTING',
        ruleType: 'TERMINOLOGY',
        severity: 'WARNING',
        avoidTerms: [],
      },
      {
        name: 'Parallel Structure in Lists',
        description: 'Ensure all items in a list follow the same grammatical structure',
        category: 'FORMATTING',
        ruleType: 'TERMINOLOGY',
        severity: 'WARNING',
        avoidTerms: [],
      },
      // Citations
      {
        name: 'Consistent Citation Style',
        description: 'Use a consistent citation style throughout the document',
        category: 'CITATIONS',
        ruleType: 'TERMINOLOGY',
        severity: 'ERROR',
        avoidTerms: [],
      },
      // Spelling
      {
        name: 'American vs British Spelling',
        description: 'Use consistent spelling conventions (American or British) throughout',
        category: 'SPELLING',
        ruleType: 'TERMINOLOGY',
        severity: 'WARNING',
        avoidTerms: [],
        examples: [
          { incorrect: 'color/colour mixed', correct: 'Use one consistently' },
        ],
      },
      // Hyphenation (using PATTERN rule type)
      {
        name: 'Compound Modifiers',
        description: 'Hyphenate compound modifiers before a noun',
        category: 'HYPHENATION',
        ruleType: 'PATTERN',
        pattern: '\\b(well|long|short|high|low|self|full|half)\\s+(known|term|time|level|esteem|length|scale)\\b',
        severity: 'WARNING',
        avoidTerms: [],
        examples: [
          { incorrect: 'well known author', correct: 'well-known author' },
        ],
      },
    ];
  }
}

export const styleGuideExtractor = new StyleGuideExtractorService();
