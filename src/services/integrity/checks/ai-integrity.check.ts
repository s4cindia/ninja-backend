/**
 * AI-based Integrity Check
 *
 * Replaces 13 rule-based check functions with a single Claude AI call.
 * Sends document text with structural context to Claude and lets the AI
 * identify real integrity issues, reducing false positives (e.g. repeated
 * references to the same table/figure are normal in academic writing).
 */

import { claudeService } from '../../ai/claude.service';
import { logger } from '../../../lib/logger';
import { splitTextIntoChunks } from '../../../utils/text-chunker';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Issue returned by the AI, before validation. */
interface AIIssue {
  checkType: string;
  severity: 'ERROR' | 'WARNING' | 'SUGGESTION';
  title: string;
  description: string;
  originalText?: string;
  suggestedFix?: string;
  context?: string;
  expectedValue?: string;
  actualValue?: string;
}

/** Validated issue that matches the existing CheckResult shape. */
export interface CheckIssue {
  checkType: string;
  severity: 'ERROR' | 'WARNING' | 'SUGGESTION';
  title: string;
  description: string;
  startOffset?: number;
  endOffset?: number;
  originalText?: string;
  expectedValue?: string;
  actualValue?: string;
  suggestedFix?: string;
  context?: string;
}

/** Lightweight metadata extracted before calling the AI. */
interface DocumentStructure {
  figureCount: number;
  tableCount: number;
  equationCount: number;
  sectionCount: number;
  hasTOC: boolean;
  hasReferenceList: boolean;
  hasFootnotes: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_CHECK_TYPES = new Set([
  'FIGURE_REF',
  'TABLE_REF',
  'EQUATION_REF',
  'BOX_REF',
  'CITATION_REF',
  'SECTION_NUMBERING',
  'FIGURE_NUMBERING',
  'TABLE_NUMBERING',
  'EQUATION_NUMBERING',
  'UNIT_CONSISTENCY',
  'ABBREVIATION',
  'CROSS_REF',
  'DUPLICATE_CONTENT',
  'HEADING_HIERARCHY',
  'ALT_TEXT',
  'TABLE_STRUCTURE',
  'FOOTNOTE_REF',
  'TOC_CONSISTENCY',
  'ISBN_FORMAT',
  'DOI_FORMAT',
  'TERMINOLOGY',
]);

const CHUNK_DELAY_MS = 500;

// ---------------------------------------------------------------------------
// 1a. Structural pre-pass (no AI, just context for the prompt)
// ---------------------------------------------------------------------------

function extractDocumentStructure(text: string, html: string): DocumentStructure {
  const count = (pattern: RegExp, src: string) => {
    const matches = src.match(pattern);
    return matches ? matches.length : 0;
  };

  // Count captions / definitions (not inline refs) to approximate item counts
  const figureCount = count(/(?:^|\n)\s*(?:Figure|Fig\.?)\s+\d+/gi, text);
  const tableCount = count(/(?:^|\n)\s*Table\s+\d+/gi, text);
  const equationCount = count(/(?:^|\n)\s*(?:Equation|Eq\.?)\s+\d+/gi, text);
  const sectionCount = count(/(?:^|\n)\s*\d{1,2}(?:\.\d+)*\s+[A-Z]/gm, text);

  const lowerText = text.toLowerCase();
  const lowerHtml = html.toLowerCase();

  const hasTOC =
    lowerText.includes('table of contents') ||
    lowerText.includes('contents\n') ||
    lowerHtml.includes('id="toc"') ||
    lowerHtml.includes('class="toc"');

  const hasReferenceList =
    /\b(?:references|bibliography|works cited)\b/i.test(text);

  const hasFootnotes =
    lowerHtml.includes('class="footnote') ||
    lowerHtml.includes('id="fn') ||
    /\bfootnotes?\b/i.test(text);

  return {
    figureCount,
    tableCount,
    equationCount,
    sectionCount,
    hasTOC,
    hasReferenceList,
    hasFootnotes,
  };
}

// ---------------------------------------------------------------------------
// 1c. Prompt construction
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `You are an expert document integrity checker for academic and educational publishers.
Analyze the provided document text for structural integrity issues.
Return ONLY a valid JSON array — no markdown, no explanation, no commentary.
If you find no issues, return an empty array: []`;

function buildUserPrompt(
  chunkText: string,
  chunkIndex: number,
  totalChunks: number,
  contentType: string,
  structure: DocumentStructure
): string {
  return `DOCUMENT TYPE: ${contentType}

DOCUMENT STRUCTURE:
- ${structure.figureCount} figures, ${structure.tableCount} tables, ${structure.equationCount} equations, ${structure.sectionCount} sections
- Reference list: ${structure.hasReferenceList ? 'yes' : 'no'}
- Table of contents: ${structure.hasTOC ? 'yes' : 'no'}
- Footnotes: ${structure.hasFootnotes ? 'yes' : 'no'}

IMPORTANT RULES FOR ACADEMIC PUBLISHING:
- Multiple references to the same figure, table, or equation are NORMAL and must NOT be flagged.
- Only flag issues you can verify from the provided text. Do not guess or speculate.
- A reference like "See Table 1" appearing many times is perfectly fine if Table 1 exists.

WHAT TO CHECK:
- References to non-existent items (e.g., "See Table 5" but Table 5 doesn't exist in the document)
- Items that exist but are never referenced (orphaned figures/tables/equations)
- Gaps or duplicates in numbering sequences (e.g., Table 1, Table 3 — Table 2 missing)
- Broken cross-references ("See Section X" but Section X doesn't exist)
- Heading hierarchy issues (skipped levels like H1 → H3, missing top-level heading)
- Inconsistent abbreviation usage (abbreviation used before it is defined, or never defined)
- Inconsistent terminology (e.g., "email" and "e-mail" in the same document)
- Inconsistent units (e.g., "kg" and "kilograms" mixed without reason)
- Citation references that don't match reference list entries
- Alt text missing or inadequate for images (if detectable from text/HTML)
- Table structure issues (missing headers or captions)
- TOC entries not matching actual headings
- Invalid ISBN or DOI formats
- Footnote/endnote numbering issues (gaps, duplicates, unreferenced)

VALID checkType VALUES (use exactly one per issue):
FIGURE_REF, TABLE_REF, EQUATION_REF, BOX_REF, CITATION_REF, SECTION_NUMBERING,
FIGURE_NUMBERING, TABLE_NUMBERING, EQUATION_NUMBERING, UNIT_CONSISTENCY,
ABBREVIATION, CROSS_REF, DUPLICATE_CONTENT, HEADING_HIERARCHY, ALT_TEXT,
TABLE_STRUCTURE, FOOTNOTE_REF, TOC_CONSISTENCY, ISBN_FORMAT, DOI_FORMAT, TERMINOLOGY

DOCUMENT TEXT (chunk ${chunkIndex + 1} of ${totalChunks}):
<<<CONTENT_START>>>
${chunkText}
<<<CONTENT_END>>>

Return a JSON array. For each issue found:
{
  "checkType": "one of the valid checkType values above",
  "severity": "ERROR" | "WARNING" | "SUGGESTION",
  "title": "short title describing the issue",
  "description": "detailed explanation of what is wrong and why",
  "originalText": "the exact problematic text from the document",
  "suggestedFix": "suggested correction or action",
  "context": "surrounding text (a sentence or two) for locating the issue",
  "expectedValue": "what was expected (optional, omit if not applicable)",
  "actualValue": "what was found (optional, omit if not applicable)"
}

Return [] if no issues are found in this chunk.`;
}

// ---------------------------------------------------------------------------
// 1d. Response validation & mapping
// ---------------------------------------------------------------------------

function validateAndMapIssues(
  rawIssues: AIIssue[],
  chunkOffset: number
): CheckIssue[] {
  const issues: CheckIssue[] = [];

  for (const raw of rawIssues) {
    // Skip unknown check types
    if (!VALID_CHECK_TYPES.has(raw.checkType)) {
      logger.warn(`[AI Integrity] Skipping unknown checkType: ${raw.checkType}`);
      continue;
    }

    // Validate severity
    const severity = (['ERROR', 'WARNING', 'SUGGESTION'] as const).includes(
      raw.severity as 'ERROR' | 'WARNING' | 'SUGGESTION'
    )
      ? raw.severity
      : 'WARNING';

    // Skip if missing required fields
    if (!raw.title || !raw.description) {
      logger.warn('[AI Integrity] Skipping issue with missing title/description');
      continue;
    }

    issues.push({
      checkType: raw.checkType,
      severity,
      title: raw.title,
      description: raw.description,
      originalText: raw.originalText ?? undefined,
      expectedValue: raw.expectedValue ?? undefined,
      actualValue: raw.actualValue ?? undefined,
      suggestedFix: raw.suggestedFix ?? undefined,
      context: raw.context ?? undefined,
      startOffset: chunkOffset,
      endOffset: undefined,
    });
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 1e. Main export
// ---------------------------------------------------------------------------

export async function aiIntegrityCheck(
  text: string,
  html: string,
  contentType: string,
  options: {
    checkTypes: string[];
    onProgress?: (pct: number) => Promise<void>;
  }
): Promise<CheckIssue[]> {
  try {
    logger.info('[AI Integrity] Starting AI-based integrity check');

    // Structural pre-pass
    const structure = extractDocumentStructure(text, html);
    logger.info(`[AI Integrity] Document structure: ${JSON.stringify(structure)}`);

    // Chunk the text
    const chunks = splitTextIntoChunks(text);
    logger.info(`[AI Integrity] Document split into ${chunks.length} chunk(s)`);

    const allIssues: CheckIssue[] = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];

      const prompt = buildUserPrompt(
        chunk.text,
        i,
        chunks.length,
        contentType,
        structure
      );

      try {
        const rawIssues = await claudeService.generateJSON<AIIssue[]>(prompt, {
          model: 'sonnet',
          temperature: 0.1,
          maxTokens: 8000,
          systemPrompt: SYSTEM_PROMPT,
        });

        // Validate that response is an array
        if (Array.isArray(rawIssues)) {
          const mapped = validateAndMapIssues(rawIssues, chunk.offset);
          allIssues.push(...mapped);
          logger.info(
            `[AI Integrity] Chunk ${i + 1}/${chunks.length}: ${mapped.length} issue(s)`
          );
        } else {
          logger.warn(
            `[AI Integrity] Chunk ${i + 1}/${chunks.length}: response was not an array, skipping`
          );
        }
      } catch (chunkError) {
        logger.error(
          `[AI Integrity] Chunk ${i + 1}/${chunks.length} failed:`,
          chunkError
        );
        // Continue with remaining chunks
      }

      // Report progress
      if (options.onProgress) {
        const pct = Math.round(((i + 1) / chunks.length) * 100);
        await options.onProgress(pct);
      }

      // Rate-limit delay between chunks
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, CHUNK_DELAY_MS));
      }
    }

    // Filter to only requested check types
    const filtered = allIssues.filter(issue =>
      options.checkTypes.includes(issue.checkType)
    );

    logger.info(
      `[AI Integrity] Complete: ${allIssues.length} total issues, ${filtered.length} after filtering to requested types`
    );

    return filtered;
  } catch (error) {
    logger.error('[AI Integrity] AI integrity check failed:', error);
    return [];
  }
}
