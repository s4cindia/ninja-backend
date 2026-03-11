/**
 * AI Analysis Service
 *
 * Analyzes PDF accessibility issues using AI models (Claude Haiku + Gemini Flash)
 * and stores confidence-scored suggestions in the AiAnalysis table.
 *
 * Supports 13 issue categories across alt text, tables, lists, reading order,
 * headings, language, color contrast, links, form fields, and bookmarks.
 */

import pLimit from 'p-limit';
import { createCanvas } from '@napi-rs/canvas';
import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { geminiService } from '../ai/gemini.service';
import { getModelPricing } from '../../config/pricing.config';
import { aiConfig } from '../../config/ai.config';
import { fileStorageService } from '../storage/file-storage.service';
import { pdfComprehensiveParserService } from './pdf-comprehensive-parser.service';
import { imageExtractorService, ImageInfo } from './image-extractor.service';
import { pdfParserService } from './pdf-parser.service';
import { AuditIssue } from '../audit/base-audit.service';
import type { PdfParseResult, PdfPage } from './pdf-comprehensive-parser.service';
import type { TableInfo } from './structure-analyzer.service';
import type { ParsedPDF } from './pdf-parser.service';

// ─── Config Types ──────────────────────────────────────────────────────────────

export interface AiRemediationConfig {
  tableFixMode: 'apply-to-pdf' | 'guidance-only' | 'summaries-to-pdf-headers-as-guidance';
  altTextMode: 'apply-to-pdf' | 'guidance-only';
  listMode: 'auto-resolve-decorative' | 'guidance-only';
  languageMode: 'apply-to-pdf' | 'guidance-only';
  colorContrastMode: 'guidance-only' | 'disabled';
  linkTextMode: 'guidance-only' | 'disabled';
  formFieldMode: 'guidance-only' | 'disabled';
  bookmarkMode: 'guidance-only' | 'disabled';
  confidenceThreshold: number;
  autoApplyHighConfidence: boolean;
}

// ─── AI Pricing Constants ─────────────────────────────────────────────────────

// Claude Haiku 3.5 pricing (USD per 1M tokens input/output)
const CLAUDE_HAIKU_INPUT_USD_PER_M = 0.80;
const CLAUDE_HAIKU_OUTPUT_USD_PER_M = 4.00;

const DEFAULT_CONFIG: AiRemediationConfig = {
  tableFixMode: 'summaries-to-pdf-headers-as-guidance',
  altTextMode: 'apply-to-pdf',
  listMode: 'auto-resolve-decorative',
  languageMode: 'apply-to-pdf',
  colorContrastMode: 'guidance-only',
  linkTextMode: 'guidance-only',
  formFieldMode: 'guidance-only',
  bookmarkMode: 'guidance-only',
  confidenceThreshold: 0.75,
  autoApplyHighConfidence: false,
};

// ─── Internal Return Type ─────────────────────────────────────────────────────

interface AiSuggestionResult {
  suggestionType: string;
  value?: string;
  guidance?: string;
  confidence: number;
  rationale: string;
  model: string;
  applyMode: 'apply-to-pdf' | 'guidance-only' | 'auto-resolve';
  requiresManualReview?: boolean;
  usage?: { promptTokens: number; completionTokens: number };
}

// Image types that always require a subject matter expert regardless of complexity
const ALWAYS_MANUAL_IMAGE_TYPES = new Set(['equation', 'circuit']);
// Image types that require manual review only when complex
const MANUAL_IF_COMPLEX_IMAGE_TYPES = new Set(['chart', 'diagram']);

// ─── Issue Code Sets ──────────────────────────────────────────────────────────

const ALT_TEXT_MISSING_CODES = new Set(['MATTERHORN-13-001', 'MATTERHORN-13-002', 'ALT-TEXT-MISSING']);
const ALT_TEXT_IMPROVE_CODES = new Set(['MATTERHORN-13-004', 'MATTERHORN-13-003', 'ALT-TEXT-QUALITY', 'ALT-TEXT-GENERIC']);
const TABLE_SUMMARY_CODES = new Set(['TABLE-MISSING-SUMMARY', 'MATTERHORN-15-003']);
const TABLE_HEADERS_CODES = new Set(['MATTERHORN-15-002', 'TABLE-HEADERS-INCOMPLETE']);
const TABLE_SCOPE_CODES = new Set(['MATTERHORN-15-004', 'TABLE-SCOPE-MISSING']);
const TABLE_LAYOUT_CODES = new Set(['MATTERHORN-15-005', 'TABLE-LAYOUT-UNTAGGED']);
const LIST_CODES = new Set(['LIST-NOT-TAGGED', 'LIST-IMPROPER-MARKUP']);
const READING_ORDER_CODES = new Set(['MATTERHORN-09-004', 'READING-ORDER-SUSPECT', 'READING-ORDER-COLUMN', 'READING-ORDER-RTOL']);
const HEADING_CODES = new Set(['HEADING-SKIP', 'HEADING-MULTIPLE-H1', 'HEADING-NESTING', 'MATTERHORN-06-001']);
const LANGUAGE_CODES = new Set(['MATTERHORN-11-001', 'LANGUAGE-MISSING']);
const CONTRAST_CODES = new Set(['COLOR-CONTRAST', 'CONTRAST-RATIO']);
const LINK_CODES = new Set(['LINK-NOT-DESCRIPTIVE', 'LINK-URL-AS-TEXT', 'LINK-GENERIC-TEXT']);
const FORM_CODES = new Set(['FORM-FIELD-NO-LABEL', 'FORM-FIELD-MISSING-TOOLTIP']);
const BOOKMARK_CODES = new Set(['BOOKMARK-MISSING', 'BOOKMARK-INSUFFICIENT', 'BOOKMARK-GENERIC-TEXT']);

// ─── Service ─────────────────────────────────────────────────────────────────

class AiAnalysisService {
  /** Tracks jobs currently being analyzed — used by getAnalysisStatus() to return 'processing' immediately after trigger */
  private readonly analyzingJobs = new Set<string>();

  isAnalyzing(jobId: string): boolean {
    return this.analyzingJobs.has(jobId);
  }

  /**
   * Analyze all eligible issues for a completed audit job and store AI suggestions.
   */
  async analyzeJob(
    jobId: string,
    tenantId: string,
    sessionOverrides?: Partial<AiRemediationConfig>
  ): Promise<{ analyzed: number; skipped: number }> {
    this.analyzingJobs.add(jobId);
    logger.info(`[AiAnalysis] Starting analysis for job ${jobId}`);

    // Load job and verify it's completed
    const job = await prisma.job.findUnique({ where: { id: jobId } });
    if (!job || job.status !== 'COMPLETED') {
      throw new Error(`Job ${jobId} is not completed (status: ${job?.status ?? 'not found'})`);
    }

    // Extract issues from job output
    const output = job.output as Record<string, unknown>;
    const auditReport = output?.auditReport as Record<string, unknown> | undefined;
    const issues = (auditReport?.issues as AuditIssue[] | undefined) ?? [];
    const fileName = (output?.fileName as string | undefined) ?? 'document.pdf';

    if (issues.length === 0) {
      logger.info(`[AiAnalysis] No issues found for job ${jobId}`);
      return { analyzed: 0, skipped: 0 };
    }

    // Build effective config from tenant settings + session overrides
    const tenantSettings = await this.getTenantConfig(tenantId);
    const config: AiRemediationConfig = { ...DEFAULT_CONFIG, ...tenantSettings, ...sessionOverrides };

    // Load PDF from storage — prefer the remediated (Adobe-tagged) file if available
    const remediatedBuffer = await fileStorageService.getRemediatedFile(jobId, fileName);
    const buffer = remediatedBuffer ?? await fileStorageService.getFile(jobId, fileName);
    if (!buffer) {
      throw new Error(`PDF file not found in storage for job ${jobId}`);
    }
    if (remediatedBuffer) {
      logger.info(`[AiAnalysis] Using remediated (tagged) PDF for job ${jobId}`);
    }

    // Parse PDF and leave parsedPdf open; we close in finally
    let parsed: PdfParseResult | null = null;

    try {
      parsed = await pdfComprehensiveParserService.parseBuffer(buffer, fileName);

      // If the PDF has no tagged structure tree, writing /Alt or /Summary is impossible.
      // Downgrade apply modes to guidance-only so the Apply button never appears.
      if (!parsed.isTagged) {
        logger.info(`[AiAnalysis] PDF is untagged — downgrading altTextMode and tableFixMode to guidance-only`);
        config.altTextMode = 'guidance-only';
        config.tableFixMode = 'guidance-only';
      }

      // Build image lookup map (includes base64 data)
      const imageById = new Map<string, ImageInfo>();
      if (parsed.parsedPdf) {
        const docImages = await imageExtractorService.extractImages(parsed.parsedPdf, { includeBase64: true });
        for (const page of docImages.pages) {
          for (const img of page.images) {
            imageById.set(img.id, img);
          }
        }
      }

      // Build table lookup map
      const tableById = new Map<string, TableInfo>();
      for (const page of parsed.pages) {
        for (const table of page.tables) {
          tableById.set(table.id, table);
        }
      }

      // Page render cache — stores Promises to avoid duplicate renders under concurrency
      const pageRenderCache = new Map<number, Promise<string | null>>();

      // Suggestion cache — avoids duplicate AI calls for the same (code, element/page) pair.
      // Document-level codes always produce the same result for the whole document,
      // so they are keyed by code alone. Element/page-level codes include the element id.
      const DOC_LEVEL_CODES = new Set([
        'HEADING-SKIP', 'HEADING-MULTIPLE-H1', 'HEADING-NESTING', 'MATTERHORN-06-001',
        'MATTERHORN-11-001', 'LANGUAGE-MISSING',
        'BOOKMARK-MISSING', 'BOOKMARK-INSUFFICIENT',
      ]);
      const suggestionCache = new Map<string, Promise<AiSuggestionResult | null>>();

      // Capture as non-null const — parseBuffer succeeded so parsed is guaranteed non-null here
      const parsedDoc = parsed;

      let analyzed = 0;
      let skipped = 0;

      // Token stats accumulator — keyed so cached results are counted exactly once
      const statsAcc = { geminiPrompt: 0, geminiCompletion: 0, claudePrompt: 0, claudeCompletion: 0 };
      const countedCacheKeys = new Set<string>();

      // Process up to 10 issues concurrently
      const limit = pLimit(10);

      await Promise.all(issues.map(issue => limit(async () => {
        try {
          // Build cache key: document-level codes share one result across all instances;
          // element/page-level codes are keyed by (code, element or pageNumber).
          const cacheKey = DOC_LEVEL_CODES.has(issue.code)
            ? issue.code
            : `${issue.code}:${issue.element ?? issue.pageNumber ?? ''}`;

          let suggestionPromise = suggestionCache.get(cacheKey);
          if (!suggestionPromise) {
            suggestionPromise = this.dispatchIssue(
              issue,
              parsedDoc,
              config,
              imageById,
              tableById,
              pageRenderCache
            );
            suggestionCache.set(cacheKey, suggestionPromise);
          }

          const suggestion = await suggestionPromise;

          // Accumulate token usage per unique cacheKey (avoid double-counting cached results)
          if (suggestion?.usage && !countedCacheKeys.has(cacheKey)) {
            countedCacheKeys.add(cacheKey);
            const { promptTokens, completionTokens } = suggestion.usage;
            if (suggestion.model === 'gemini-flash') {
              statsAcc.geminiPrompt += promptTokens;
              statsAcc.geminiCompletion += completionTokens;
            } else if (suggestion.model === 'claude-haiku') {
              statsAcc.claudePrompt += promptTokens;
              statsAcc.claudeCompletion += completionTokens;
            }
          }

          // requiresManualReview results are always saved regardless of confidence threshold
          if (!suggestion || (!suggestion.requiresManualReview && suggestion.confidence < config.confidenceThreshold)) {
            skipped++;
            return;
          }

          // Auto-resolve if high confidence and tenant allows it
          let effectiveApplyMode = suggestion.applyMode;
          if (
            config.autoApplyHighConfidence &&
            suggestion.confidence >= 0.90 &&
            suggestion.applyMode === 'apply-to-pdf'
          ) {
            effectiveApplyMode = 'apply-to-pdf';
          }

          await prisma.aiAnalysis.upsert({
            where: { jobId_issueId: { jobId, issueId: issue.id } },
            create: {
              jobId,
              issueId: issue.id,
              suggestionType: suggestion.suggestionType,
              value: suggestion.value,
              guidance: suggestion.guidance,
              confidence: suggestion.confidence,
              rationale: suggestion.rationale,
              model: suggestion.model,
              applyMode: effectiveApplyMode,
              status: effectiveApplyMode === 'auto-resolve' ? 'approved' : 'pending',
              requiresManualReview: suggestion.requiresManualReview ?? false,
              updatedAt: new Date(),
            },
            update: {
              suggestionType: suggestion.suggestionType,
              value: suggestion.value,
              guidance: suggestion.guidance,
              confidence: suggestion.confidence,
              rationale: suggestion.rationale,
              model: suggestion.model,
              applyMode: effectiveApplyMode,
              status: effectiveApplyMode === 'auto-resolve' ? 'approved' : 'pending',
              requiresManualReview: suggestion.requiresManualReview ?? false,
              updatedAt: new Date(),
            },
          });

          analyzed++;
        } catch (err) {
          logger.warn(
            `[AiAnalysis] Failed to analyze issue ${issue.id} (${issue.code}): ${
              err instanceof Error ? err.message : String(err)
            }`
          );
          skipped++;
        }
      })));

      // Compute costs and persist token stats to job output (non-fatal)
      try {
        const geminiPricing = getModelPricing(aiConfig.gemini.model);
        const geminiCostUsd =
          (statsAcc.geminiPrompt * geminiPricing.input + statsAcc.geminiCompletion * geminiPricing.output) / 1_000_000;
        const claudeCostUsd =
          (statsAcc.claudePrompt * CLAUDE_HAIKU_INPUT_USD_PER_M + statsAcc.claudeCompletion * CLAUDE_HAIKU_OUTPUT_USD_PER_M) / 1_000_000;

        const aiAnalysisStats = {
          gemini: {
            promptTokens: statsAcc.geminiPrompt,
            completionTokens: statsAcc.geminiCompletion,
            totalTokens: statsAcc.geminiPrompt + statsAcc.geminiCompletion,
            estimatedCostUsd: Math.round(geminiCostUsd * 1_000_000) / 1_000_000,
          },
          claude: {
            promptTokens: statsAcc.claudePrompt,
            completionTokens: statsAcc.claudeCompletion,
            totalTokens: statsAcc.claudePrompt + statsAcc.claudeCompletion,
            estimatedCostUsd: Math.round(claudeCostUsd * 1_000_000) / 1_000_000,
          },
          totalTokens: statsAcc.geminiPrompt + statsAcc.geminiCompletion + statsAcc.claudePrompt + statsAcc.claudeCompletion,
          totalCostUsd: Math.round((geminiCostUsd + claudeCostUsd) * 1_000_000) / 1_000_000,
          analyzedAt: new Date().toISOString(),
        };

        const latestJob = await prisma.job.findUnique({ where: { id: jobId } });
        const latestOutput = (latestJob?.output ?? {}) as Record<string, unknown>;
        await prisma.job.update({
          where: { id: jobId },
          data: { output: { ...latestOutput, aiAnalysisStats } as Prisma.InputJsonObject },
        });
        logger.info(`[AiAnalysis] Token stats saved for job ${jobId}: ${aiAnalysisStats.totalTokens} tokens, $${aiAnalysisStats.totalCostUsd}`);
      } catch (statsErr) {
        logger.warn(`[AiAnalysis] Failed to save token stats for job ${jobId} (non-fatal): ${statsErr instanceof Error ? statsErr.message : String(statsErr)}`);
      }

      logger.info(`[AiAnalysis] Job ${jobId} complete: ${analyzed} analyzed, ${skipped} skipped`);
      return { analyzed, skipped };
    } finally {
      this.analyzingJobs.delete(jobId);
      if (parsed?.parsedPdf) {
        await pdfParserService.close(parsed.parsedPdf).catch(() => {});
      }
    }
  }

  // ─── Dispatcher ─────────────────────────────────────────────────────────────

  private async dispatchIssue(
    issue: AuditIssue,
    parsed: PdfParseResult,
    config: AiRemediationConfig,
    imageById: Map<string, ImageInfo>,
    tableById: Map<string, TableInfo>,
    pageRenderCache: Map<number, Promise<string | null>>
  ): Promise<AiSuggestionResult | null> {
    const code = issue.code;
    const page = issue.pageNumber ? parsed.pages[issue.pageNumber - 1] : undefined;

    if (ALT_TEXT_MISSING_CODES.has(code)) {
      const img = issue.element ? imageById.get(issue.element) : undefined;
      const imgWithBase64 = img?.base64 ? img : await this.fallbackToPageRender(img, issue, parsed, pageRenderCache);
      if (!imgWithBase64) return null;
      return this.analyzeAltText(issue, imgWithBase64, config.altTextMode);
    }

    if (ALT_TEXT_IMPROVE_CODES.has(code)) {
      const img = issue.element ? imageById.get(issue.element) : undefined;
      const imgWithBase64 = img?.base64 ? img : await this.fallbackToPageRender(img, issue, parsed, pageRenderCache);
      if (!imgWithBase64) return null;
      return this.analyzeAltTextImprovement(issue, imgWithBase64, config.altTextMode);
    }

    if (TABLE_SUMMARY_CODES.has(code)) {
      const table = issue.element ? tableById.get(issue.element) : undefined;
      if (!table) return null;
      const mode =
        config.tableFixMode === 'apply-to-pdf' ||
        config.tableFixMode === 'summaries-to-pdf-headers-as-guidance'
          ? 'apply-to-pdf'
          : 'guidance-only';
      return this.analyzeTableSummary(issue, table, mode);
    }

    if (TABLE_HEADERS_CODES.has(code) || TABLE_SCOPE_CODES.has(code)) {
      const table = issue.element ? tableById.get(issue.element) : undefined;
      if (!table) return null;
      // Simple tables (≤3 columns, no merges) in tagged PDFs can have first-row TDs promoted to TH
      if (parsed.isTagged && table.columnCount <= 3) {
        return {
          suggestionType: 'table-header-fix',
          guidance: `First-row cells will be promoted to TH with scope="Column" in the PDF structure tree.`,
          confidence: 0.88,
          rationale: `PDF is tagged — simple table (${table.columnCount} columns) first-row cells can be renamed TD→TH algorithmically`,
          model: 'rule-based',
          applyMode: 'apply-to-pdf',
        };
      }
      return this.analyzeTableHeaders(issue, table);
    }

    if (TABLE_LAYOUT_CODES.has(code)) {
      const table = issue.element ? tableById.get(issue.element) : undefined;
      if (!table) return null;
      return this.analyzeTableLayout(issue, table);
    }

    if (LIST_CODES.has(code)) {
      if (!page) return null;
      // For tagged PDFs, LIST-IMPROPER-MARKUP can be fixed by rewrapping LI elements
      if (code === 'LIST-IMPROPER-MARKUP' && parsed.isTagged) {
        return {
          suggestionType: 'list-fix',
          guidance: 'Orphaned list items will be wrapped in a new L container in the PDF structure tree.',
          confidence: 0.90,
          rationale: 'PDF is tagged — LI elements can be wrapped in an L container algorithmically',
          model: 'rule-based',
          applyMode: 'apply-to-pdf',
        };
      }
      return this.analyzeList(issue, page, config.listMode);
    }

    if (READING_ORDER_CODES.has(code)) {
      if (!page) return null;
      return this.analyzeReadingOrder(issue, page);
    }

    if (HEADING_CODES.has(code)) {
      // For tagged PDFs with skipped-level issues, the structure writer can fix directly
      if (code === 'HEADING-SKIP' && parsed.isTagged) {
        return {
          suggestionType: 'heading-fix',
          guidance: 'Heading levels will be renumbered in the PDF structure tree to eliminate skipped levels.',
          confidence: 0.95,
          rationale: 'PDF is tagged — heading hierarchy can be corrected algorithmically (rename /S on structure elements)',
          model: 'rule-based',
          applyMode: 'apply-to-pdf',
        };
      }
      return this.analyzeHeading(issue, parsed);
    }

    if (LANGUAGE_CODES.has(code)) {
      return this.analyzeLanguage(issue, parsed, config.languageMode);
    }

    if (CONTRAST_CODES.has(code)) {
      if (config.colorContrastMode === 'disabled') return null;
      if (!issue.pageNumber || !parsed.parsedPdf) return null;
      return this.analyzeColorContrast(issue, parsed.parsedPdf, pageRenderCache);
    }

    if (LINK_CODES.has(code)) {
      if (config.linkTextMode === 'disabled') return null;
      if (!page) return null;
      return this.analyzeLinkText(issue, page);
    }

    if (FORM_CODES.has(code)) {
      if (config.formFieldMode === 'disabled') return null;
      if (!page) return null;
      return this.analyzeFormField(issue, page);
    }

    if (BOOKMARK_CODES.has(code)) {
      if (config.bookmarkMode === 'disabled') return null;
      return this.analyzeBookmark(issue, parsed);
    }

    return null;
  }

  // ─── Per-Category Analyzers ───────────────────────────────────────────────

  /**
   * Classify an image type and complexity to determine if it requires a subject matter expert.
   * Returns null if the classification call fails (caller treats as non-manual).
   */
  private async classifyImageType(
    base64: string,
    mimeType: string
  ): Promise<{ type: string; complexity: 'simple' | 'complex'; usage?: { promptTokens: number; completionTokens: number } } | null> {
    const prompt =
      'Classify this image. Respond ONLY with JSON:\n' +
      '{"type":"bar-chart"|"line-chart"|"pie-chart"|"equation"|"circuit"|"diagram"|"photo"|"illustration"|"other",' +
      '"complexity":"simple"|"complex"}\n' +
      'complexity=complex means: multi-series charts, compound diagrams, multi-variable equations, detailed circuit schematics.';
    try {
      const response = await geminiService.analyzeImage(base64, mimeType, prompt, {
        model: 'flash',
        maxOutputTokens: 128,
      });
      const parsed = this.parseAiJson<{ type: string; complexity: 'simple' | 'complex' }>(response.text);
      if (!parsed) return null;
      return {
        ...parsed,
        usage: response.usage
          ? { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens }
          : undefined,
      };
    } catch {
      return null;
    }
  }

  private async analyzeAltText(
    _issue: AuditIssue,
    image: ImageInfo,
    mode: 'apply-to-pdf' | 'guidance-only'
  ): Promise<AiSuggestionResult | null> {
    // Check if this image type requires a subject matter expert before attempting AI alt text
    const classification = await this.classifyImageType(image.base64!, image.mimeType);
    if (classification) {
      const needsManual =
        ALWAYS_MANUAL_IMAGE_TYPES.has(classification.type) ||
        (MANUAL_IF_COMPLEX_IMAGE_TYPES.has(classification.type) && classification.complexity === 'complex');
      if (needsManual) {
        return {
          suggestionType: 'alt-text',
          guidance: `This ${classification.type} requires a subject matter expert to write an accurate description.`,
          confidence: 0,
          rationale: `Image classified as ${classification.type} (${classification.complexity}) — automated alt text would be inaccurate`,
          model: 'gemini-flash',
          applyMode: 'guidance-only',
          requiresManualReview: true,
          usage: classification.usage,
        };
      }
    }

    const prompt =
      'You are an accessibility expert. Analyze this image and determine if it is decorative ' +
      '(purely visual, no informational content) or meaningful. If meaningful, write concise ' +
      'alt text (max 125 characters). Respond ONLY with JSON:\n' +
      '{"isDecorative":boolean,"altText":"string (if not decorative)","confidence":0.0-1.0,"rationale":"brief"}';

    try {
      const response = await geminiService.analyzeImage(image.base64!, image.mimeType, prompt, {
        model: 'flash',
        maxOutputTokens: 512,
      });
      const data = this.parseAiJson<{
        isDecorative: boolean;
        altText?: string;
        confidence: number;
        rationale: string;
      }>(response.text);
      if (!data) return null;

      // Accumulate tokens from classify call + alt text call
      const usage = {
        promptTokens: (classification?.usage?.promptTokens ?? 0) + (response.usage?.promptTokens ?? 0),
        completionTokens: (classification?.usage?.completionTokens ?? 0) + (response.usage?.completionTokens ?? 0),
      };

      if (data.isDecorative) {
        return {
          suggestionType: 'alt-text-decorative',
          guidance: 'This image appears decorative. Mark it as an artifact in the PDF structure.',
          confidence: data.confidence,
          rationale: data.rationale,
          model: 'gemini-flash',
          applyMode: 'guidance-only',
          usage,
        };
      }

      return {
        suggestionType: 'alt-text',
        value: data.altText,
        guidance:
          mode === 'guidance-only'
            ? `This PDF is untagged — alt text must be added in your authoring tool (InDesign/Word/Acrobat). Suggested alt text: "${data.altText}"`
            : undefined,
        confidence: data.confidence,
        rationale: data.rationale,
        model: 'gemini-flash',
        applyMode: mode,
        usage,
      };
    } catch (err) {
      logger.warn(`[AiAnalysis] analyzeAltText failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async analyzeAltTextImprovement(
    issue: AuditIssue,
    image: ImageInfo,
    mode: 'apply-to-pdf' | 'guidance-only'
  ): Promise<AiSuggestionResult | null> {
    // Check for manual-review-required image types before attempting improvement
    const classification = await this.classifyImageType(image.base64!, image.mimeType);
    if (classification) {
      const needsManual =
        ALWAYS_MANUAL_IMAGE_TYPES.has(classification.type) ||
        (MANUAL_IF_COMPLEX_IMAGE_TYPES.has(classification.type) && classification.complexity === 'complex');
      if (needsManual) {
        return {
          suggestionType: 'alt-text-improvement',
          guidance: `This ${classification.type} requires a subject matter expert to write an accurate description.`,
          confidence: 0,
          rationale: `Image classified as ${classification.type} (${classification.complexity}) — automated alt text improvement would be inaccurate`,
          model: 'gemini-flash',
          applyMode: 'guidance-only',
          requiresManualReview: true,
          usage: classification.usage,
        };
      }
    }

    const existingAlt =
      image.altText ??
      issue.context?.match(/alt text[:\s]+"?([^"]+)"?/i)?.[1] ??
      '';

    const prompt =
      `You are an accessibility expert. The current alt text for this image is: "${existingAlt}". ` +
      'Evaluate it and write improved alt text (max 125 chars) if needed. ' +
      'Respond ONLY with JSON:\n' +
      '{"improvedAltText":"string","confidence":0.0-1.0,"rationale":"brief"}';

    try {
      const response = await geminiService.analyzeImage(image.base64!, image.mimeType, prompt, {
        model: 'flash',
        maxOutputTokens: 512,
      });
      const data = this.parseAiJson<{
        improvedAltText: string;
        confidence: number;
        rationale: string;
      }>(response.text);
      if (!data?.improvedAltText) return null;

      const usage = {
        promptTokens: (classification?.usage?.promptTokens ?? 0) + (response.usage?.promptTokens ?? 0),
        completionTokens: (classification?.usage?.completionTokens ?? 0) + (response.usage?.completionTokens ?? 0),
      };

      return {
        suggestionType: 'alt-text-improvement',
        value: data.improvedAltText,
        guidance:
          mode === 'guidance-only'
            ? `This PDF is untagged — alt text must be updated in your authoring tool. Suggested replacement: "${data.improvedAltText}"`
            : undefined,
        confidence: data.confidence,
        rationale: data.rationale,
        model: 'gemini-flash',
        applyMode: mode,
        usage,
      };
    } catch (err) {
      logger.warn(`[AiAnalysis] analyzeAltTextImprovement failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async analyzeTableSummary(
    _issue: AuditIssue,
    table: TableInfo,
    mode: 'apply-to-pdf' | 'guidance-only'
  ): Promise<AiSuggestionResult | null> {
    // Nothing to summarize — skip rather than let Claude return an error string as the value
    if (table.cells.length === 0) return null;
    const tableText = this.formatTableAsText(table);
    const prompt =
      'You are an accessibility expert. Write a 1-2 sentence summary (max 150 characters) ' +
      'for this table describing what it contains and its purpose.\n\n' +
      tableText +
      '\n\nRespond ONLY with JSON:\n{"summary":"string","confidence":0.0-1.0,"rationale":"brief"}';

    try {
      const response = await geminiService.generateText(prompt, { model: 'flash', maxOutputTokens: 512 });
      const data = this.parseAiJson<{ summary: string; confidence: number; rationale: string }>(
        response.text
      );
      if (!data?.summary) return null;

      return {
        suggestionType: 'table-summary',
        value: data.summary,
        guidance:
          mode === 'guidance-only' ? `Add table summary: "${data.summary}"` : undefined,
        confidence: data.confidence,
        rationale: data.rationale,
        usage: response.usage ? { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens } : undefined,
        model: 'gemini-flash',
        applyMode: mode,
      };
    } catch (err) {
      logger.warn(`[AiAnalysis] analyzeTableSummary failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async analyzeTableHeaders(
    _issue: AuditIssue,
    table: TableInfo
  ): Promise<AiSuggestionResult | null> {
    const tableText = this.formatTableAsText(table);
    const prompt =
      'You are an accessibility expert. This table is missing accessibility headers. ' +
      'Identify which row or column should be marked as headers.\n\n' +
      tableText +
      '\n\nRespond ONLY with JSON:\n' +
      '{"headerRow":["cell values"],"headerColumn":["cell values or empty"],' +
      '"guidance":"step-by-step fix instruction","confidence":0.0-1.0,"rationale":"brief"}';

    try {
      const response = await geminiService.generateText(prompt, { model: 'flash', maxOutputTokens: 512 });
      const data = this.parseAiJson<{
        headerRow: string[];
        headerColumn: string[];
        guidance: string;
        confidence: number;
        rationale: string;
      }>(response.text);
      if (!data) return null;

      return {
        suggestionType: 'table-headers',
        guidance:
          data.guidance ||
          (data.headerRow.length > 0
            ? `Header row: ${data.headerRow.slice(0, 5).join(', ')}`
            : 'No clear header row detected'),
        confidence: data.confidence,
        rationale: data.rationale,
        model: 'gemini-flash',
        applyMode: 'guidance-only',
        usage: response.usage ? { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens } : undefined,
      };
    } catch (err) {
      logger.warn(`[AiAnalysis] analyzeTableHeaders failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async analyzeTableLayout(
    _issue: AuditIssue,
    table: TableInfo
  ): Promise<AiSuggestionResult | null> {
    const tableText = this.formatTableAsText(table);
    const prompt =
      'You are an accessibility expert. Determine if this table is used for layout ' +
      '(visual arrangement) rather than data presentation.\n\n' +
      tableText +
      `\n\nTable dimensions: ${table.rowCount} rows × ${table.columnCount} columns\n\n` +
      'Respond ONLY with JSON:\n' +
      '{"isLayout":boolean,"confidence":0.0-1.0,"reasoning":"brief","guidance":"fix instruction"}';

    try {
      const response = await geminiService.generateText(prompt, { model: 'flash', maxOutputTokens: 512 });
      const data = this.parseAiJson<{
        isLayout: boolean;
        confidence: number;
        reasoning: string;
        guidance: string;
      }>(response.text);
      if (!data) return null;

      return {
        suggestionType: 'table-layout',
        guidance:
          data.guidance ||
          (data.isLayout
            ? 'Mark this table as a presentation artifact in the PDF structure (Role: Artifact).'
            : 'This appears to be a data table. Ensure it has proper headers and summary.'),
        confidence: data.confidence,
        rationale: data.reasoning,
        model: 'gemini-flash',
        applyMode: 'guidance-only',
        usage: response.usage ? { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens } : undefined,
      };
    } catch (err) {
      logger.warn(`[AiAnalysis] analyzeTableLayout failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async analyzeList(
    _issue: AuditIssue,
    page: PdfPage,
    listMode: 'auto-resolve-decorative' | 'guidance-only'
  ): Promise<AiSuggestionResult | null> {
    if (page.lists.length === 0) return null;

    const listItemsText = page.lists
      .flatMap(l => l.items.map(item => `• ${item.text}`))
      .slice(0, 20)
      .join('\n');

    const prompt =
      'You are an accessibility expert. Classify these list items from a PDF:\n\n' +
      listItemsText +
      '\n\nOptions:\n' +
      '- "decorative": visual only (bullet chars, separators, purely aesthetic)\n' +
      '- "navigation": TOC-like, with page numbers or section references\n' +
      '- "semantic": meaningful content that should be properly tagged as a list\n\n' +
      'Respond ONLY with JSON:\n' +
      '{"classification":"decorative"|"navigation"|"semantic","confidence":0.0-1.0,"guidance":"fix instruction"}';

    try {
      const response = await geminiService.generateText(prompt, { model: 'flash', maxOutputTokens: 512 });
      const data = this.parseAiJson<{
        classification: string;
        confidence: number;
        guidance: string;
      }>(response.text);
      if (!data) return null;

      const listUsage = response.usage ? { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens } : undefined;

      if (
        data.classification === 'decorative' &&
        data.confidence >= 0.85 &&
        listMode === 'auto-resolve-decorative'
      ) {
        return {
          suggestionType: 'list-classify',
          value: 'decorative',
          guidance: 'These list items appear decorative and have been auto-resolved.',
          confidence: data.confidence,
          rationale: data.guidance,
          model: 'gemini-flash',
          applyMode: 'auto-resolve',
          usage: listUsage,
        };
      }

      return {
        suggestionType: 'list-classify',
        guidance:
          data.guidance ||
          (data.classification === 'navigation'
            ? 'Use <TOC>/<TOCI> tags instead of <L>/<LI> tags for navigation lists.'
            : 'Add proper <L>, <LI>, <Lbl>, <LBody> tags in your authoring tool.'),
        confidence: data.confidence,
        rationale: data.guidance,
        model: 'gemini-flash',
        applyMode: 'guidance-only',
        usage: listUsage,
      };
    } catch (err) {
      logger.warn(`[AiAnalysis] analyzeList failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async analyzeReadingOrder(
    issue: AuditIssue,
    page: PdfPage
  ): Promise<AiSuggestionResult | null> {
    const contentSample = page.content
      .slice(0, 30)
      .map(item => `[x:${Math.round(item.position.x)},y:${Math.round(item.position.y)}] "${item.text.slice(0, 50)}"`)
      .join('\n');

    const prompt =
      'You are an accessibility expert. Given these text items and their positions on a PDF page, ' +
      'suggest the correct logical reading order for a screen reader.\n\n' +
      contentSample +
      '\n\nRespond ONLY with JSON:\n' +
      '{"suggestedOrder":["text item 1","text item 2"],"confidence":0.0-1.0,"guidance":"fix instruction"}';

    try {
      const response = await geminiService.generateText(prompt, { model: 'flash', maxOutputTokens: 1024 });
      const data = this.parseAiJson<{
        suggestedOrder: string[];
        confidence: number;
        guidance: string;
      }>(response.text);
      if (!data) return null;

      const orderPreview = data.suggestedOrder
        .slice(0, 5)
        .map((t, i) => `${i + 1}. ${t}`)
        .join('; ');

      return {
        suggestionType: 'reading-order',
        guidance: data.guidance || `Suggested order: ${orderPreview}`,
        confidence: data.confidence,
        rationale: `Analyzed ${page.content.length} text items on page ${issue.pageNumber}`,
        model: 'gemini-flash',
        applyMode: 'guidance-only',
        usage: response.usage ? { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens } : undefined,
      };
    } catch (err) {
      logger.warn(`[AiAnalysis] analyzeReadingOrder failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async analyzeHeading(
    issue: AuditIssue,
    parsed: PdfParseResult
  ): Promise<AiSuggestionResult | null> {
    const allHeadings = parsed.pages.flatMap(p => p.headings);
    const headingList = allHeadings
      .slice(0, 20)
      .map(h => `H${h.level}: "${h.text}" (page ${h.pageNumber})`)
      .join('\n');

    const prompt =
      `You are an accessibility expert. This PDF has a heading structure issue: ${issue.message}\n\n` +
      'Current heading structure:\n' +
      headingList +
      '\n\nSuggest corrections. Respond ONLY with JSON:\n' +
      '{"correctedHeadings":[{"text":"string","currentLevel":1,"suggestedLevel":2}],' +
      '"guidance":"fix instruction","confidence":0.0-1.0,"rationale":"brief"}';

    try {
      const response = await geminiService.generateText(prompt, { model: 'flash', maxOutputTokens: 1024 });
      const data = this.parseAiJson<{
        correctedHeadings: Array<{ text: string; currentLevel: number; suggestedLevel: number }>;
        guidance: string;
        confidence: number;
        rationale: string;
      }>(response.text);
      if (!data) return null;

      const corrections = data.correctedHeadings
        .slice(0, 3)
        .map(h => `"${h.text.slice(0, 40)}": H${h.currentLevel}→H${h.suggestedLevel}`)
        .join('; ');

      return {
        suggestionType: 'heading',
        guidance: data.guidance || corrections,
        confidence: data.confidence,
        rationale: data.rationale,
        model: 'gemini-flash',
        applyMode: 'guidance-only',
        usage: response.usage ? { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens } : undefined,
      };
    } catch (err) {
      logger.warn(`[AiAnalysis] analyzeHeading failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async analyzeLanguage(
    _issue: AuditIssue,
    parsed: PdfParseResult,
    mode: 'apply-to-pdf' | 'guidance-only'
  ): Promise<AiSuggestionResult | null> {
    const sampleText = parsed.pages
      .slice(0, 3)
      .flatMap(p => p.content.map(c => c.text))
      .join(' ')
      .slice(0, 500);

    if (!sampleText.trim()) return null;

    const prompt =
      'Detect the primary language of this document text and return the BCP 47 language code ' +
      '(e.g., "en-US", "fr-FR", "de-DE").\n\n' +
      `Text sample: "${sampleText}"\n\n` +
      'Respond ONLY with JSON:\n{"languageCode":"string","confidence":0.0-1.0,"rationale":"brief"}';

    try {
      const response = await geminiService.generateText(prompt, { model: 'flash', maxOutputTokens: 256 });
      const data = this.parseAiJson<{
        languageCode: string;
        confidence: number;
        rationale: string;
      }>(response.text);
      if (!data?.languageCode) return null;

      return {
        suggestionType: 'language',
        value: data.languageCode,
        guidance:
          mode === 'guidance-only'
            ? `Set document language to "${data.languageCode}" in your authoring tool.`
            : undefined,
        confidence: data.confidence,
        rationale: data.rationale,
        model: 'gemini-flash',
        applyMode: mode,
        usage: response.usage ? { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens } : undefined,
      };
    } catch (err) {
      logger.warn(`[AiAnalysis] analyzeLanguage failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async analyzeColorContrast(
    issue: AuditIssue,
    parsedPdf: ParsedPDF,
    pageRenderCache: Map<number, Promise<string | null>>
  ): Promise<AiSuggestionResult | null> {
    const pageNum = issue.pageNumber!;

    if (!pageRenderCache.has(pageNum)) {
      pageRenderCache.set(pageNum, this.renderPageToBase64(parsedPdf, pageNum));
    }
    const base64 = await pageRenderCache.get(pageNum)!;
    if (!base64) return null;

    const prompt =
      'You are an accessibility expert. Examine this PDF page image for color contrast issues. ' +
      'Identify text where contrast appears insufficient (below 4.5:1 normal, 3:1 large text). ' +
      'Respond ONLY with JSON:\n' +
      '{"issues":[{"description":"string","location":"string","estimatedRatio":"string","severity":"string"}],' +
      '"overallConfidence":0.0-1.0,"guidance":"fix instruction"}';

    try {
      const response = await geminiService.analyzeImage(base64, 'image/png', prompt, {
        model: 'flash',
        maxOutputTokens: 1024,
      });
      const data = this.parseAiJson<{
        issues: Array<{
          description: string;
          location: string;
          estimatedRatio: string;
          severity: string;
        }>;
        overallConfidence: number;
        guidance: string;
      }>(response.text);
      if (!data) return null;

      const issueDesc = data.issues
        .slice(0, 2)
        .map(i => `${i.description} (~${i.estimatedRatio} at ${i.location})`)
        .join('; ');

      return {
        suggestionType: 'color-contrast',
        guidance:
          data.guidance ||
          issueDesc ||
          'Low contrast detected. Fix in authoring tool by increasing foreground/background color difference.',
        confidence: data.overallConfidence,
        rationale: `Detected ${data.issues.length} contrast issue(s) on page ${pageNum}`,
        model: 'gemini-flash',
        applyMode: 'guidance-only',
        usage: response.usage ? { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens } : undefined,
      };
    } catch (err) {
      logger.warn(`[AiAnalysis] analyzeColorContrast failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async analyzeLinkText(
    issue: AuditIssue,
    page: PdfPage
  ): Promise<AiSuggestionResult | null> {
    const linkTextMatch = issue.context?.match(/Link text: "([^"]+)"/);
    const urlMatch = issue.context?.match(/URL: "([^"]+)"/);
    const linkText = linkTextMatch?.[1] ?? '';
    const url = urlMatch?.[1] ?? '';

    const surroundingText = page.content
      .map(c => c.text)
      .join(' ')
      .slice(0, 200);

    const prompt =
      'You are an accessibility expert. This PDF link has non-descriptive text.\n' +
      `Link text: "${linkText}"\nURL: "${url}"\n` +
      `Surrounding context: "${surroundingText}"\n\n` +
      'Write descriptive link text (max 60 characters) that conveys the destination or purpose. ' +
      'Respond ONLY with JSON:\n{"suggestedText":"string","confidence":0.0-1.0,"rationale":"brief"}';

    try {
      const response = await geminiService.generateText(prompt, { model: 'flash', maxOutputTokens: 256 });
      const data = this.parseAiJson<{
        suggestedText: string;
        confidence: number;
        rationale: string;
      }>(response.text);
      if (!data?.suggestedText) return null;

      return {
        suggestionType: 'link-text',
        guidance: `Replace "${linkText || url}" with "${data.suggestedText}" in authoring tool`,
        confidence: data.confidence,
        rationale: data.rationale,
        model: 'gemini-flash',
        applyMode: 'guidance-only',
        usage: response.usage ? { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens } : undefined,
      };
    } catch (err) {
      logger.warn(`[AiAnalysis] analyzeLinkText failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async analyzeFormField(
    issue: AuditIssue,
    page: PdfPage
  ): Promise<AiSuggestionResult | null> {
    const fieldNameMatch = issue.context?.match(/Field name: "([^"]+)"/);
    const fieldTypeMatch = issue.context?.match(/Type: "([^"]+)"/);
    const fieldName = fieldNameMatch?.[1] ?? issue.element ?? '';
    const fieldType = fieldTypeMatch?.[1] ?? 'text';

    const surroundingText = page.content
      .map(c => c.text)
      .join(' ')
      .slice(0, 200);

    const prompt =
      'You are an accessibility expert. This PDF form field has no accessible label.\n' +
      `Field name: "${fieldName}"\nField type: "${fieldType}"\nPage: ${page.pageNumber}\n` +
      `Surrounding text: "${surroundingText}"\n\n` +
      'Suggest an accessible label/tooltip (max 50 characters) describing what to enter. ' +
      'Respond ONLY with JSON:\n{"suggestedLabel":"string","confidence":0.0-1.0,"rationale":"brief"}';

    try {
      const response = await geminiService.generateText(prompt, { model: 'flash', maxOutputTokens: 256 });
      const data = this.parseAiJson<{
        suggestedLabel: string;
        confidence: number;
        rationale: string;
      }>(response.text);
      if (!data?.suggestedLabel) return null;

      return {
        suggestionType: 'form-field-label',
        guidance: `Add tooltip "${data.suggestedLabel}" to field "${fieldName}" in Acrobat Pro: Form Edit mode → field properties → Tooltip`,
        confidence: data.confidence,
        rationale: data.rationale,
        model: 'gemini-flash',
        applyMode: 'guidance-only',
        usage: response.usage ? { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens } : undefined,
      };
    } catch (err) {
      logger.warn(`[AiAnalysis] analyzeFormField failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private async analyzeBookmark(
    issue: AuditIssue,
    parsed: PdfParseResult
  ): Promise<AiSuggestionResult | null> {
    if (issue.code === 'BOOKMARK-GENERIC-TEXT') {
      const titleMatch = issue.context?.match(/Bookmark title: "([^"]*)"/);
      const bookmarkTitle = titleMatch?.[1] ?? '';
      const destPage = issue.pageNumber ? parsed.pages[issue.pageNumber - 1] : undefined;
      const firstText = destPage?.content.slice(0, 5).map(c => c.text).join(' ') ?? '';

      const prompt =
        `You are an accessibility expert. This PDF bookmark has a generic title: "${bookmarkTitle}". ` +
        `The section it links to begins with: "${firstText}".\n\n` +
        'Suggest a descriptive bookmark title (max 60 characters). ' +
        'Respond ONLY with JSON:\n{"suggestedTitle":"string","confidence":0.0-1.0,"rationale":"brief"}';

      try {
        const response = await geminiService.generateText(prompt, { model: 'flash', maxOutputTokens: 256 });
        const data = this.parseAiJson<{
          suggestedTitle: string;
          confidence: number;
          rationale: string;
        }>(response.text);
        if (!data?.suggestedTitle) return null;

        return {
          suggestionType: 'bookmark-title',
          guidance: `Rename bookmark "${bookmarkTitle}" to "${data.suggestedTitle}" in authoring tool`,
          confidence: data.confidence,
          rationale: data.rationale,
          model: 'gemini-flash',
          applyMode: 'guidance-only',
          usage: response.usage ? { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens } : undefined,
        };
      } catch (err) {
        logger.warn(`[AiAnalysis] analyzeBookmark (generic) failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    }

    // BOOKMARK-MISSING or BOOKMARK-INSUFFICIENT: suggest bookmarks from headings
    const allHeadings = parsed.pages.flatMap(p => p.headings);
    if (allHeadings.length === 0) {
      return {
        suggestionType: 'bookmark-missing',
        guidance:
          'No headings detected to auto-generate bookmark suggestions. ' +
          'Add heading structure to your document first, then export with bookmarks enabled.',
        confidence: 0.8,
        rationale: 'No headings found in the document',
        model: 'gemini-flash',
        applyMode: 'guidance-only',
      };
    }

    const headingList = allHeadings
      .slice(0, 20)
      .map(h => `H${h.level} (page ${h.pageNumber}): "${h.text}"`)
      .join('\n');

    const prompt =
      'You are an accessibility expert. This PDF is missing adequate bookmarks. ' +
      'Based on the heading structure, suggest which headings should become bookmarks.\n\n' +
      headingList +
      '\n\nRespond ONLY with JSON:\n' +
      '{"suggestedBookmarks":[{"pageNumber":1,"title":"string","level":1}],' +
      '"guidance":"how to add bookmarks","confidence":0.0-1.0,"rationale":"brief"}';

    try {
      const response = await geminiService.generateText(prompt, { model: 'flash', maxOutputTokens: 1024 });
      const data = this.parseAiJson<{
        suggestedBookmarks: Array<{ pageNumber: number; title: string; level: number }>;
        guidance: string;
        confidence: number;
        rationale: string;
      }>(response.text);
      if (!data) return null;

      const preview = data.suggestedBookmarks
        .slice(0, 3)
        .map(b => `"${b.title}" (p.${b.pageNumber})`)
        .join(', ');
      const more = data.suggestedBookmarks.length > 3 ? ` + ${data.suggestedBookmarks.length - 3} more` : '';

      return {
        suggestionType: 'bookmark-missing',
        guidance: data.guidance || `Add bookmarks: ${preview}${more}`,
        confidence: data.confidence,
        rationale: data.rationale,
        model: 'gemini-flash',
        applyMode: 'guidance-only',
        usage: response.usage ? { promptTokens: response.usage.promptTokens, completionTokens: response.usage.completionTokens } : undefined,
      };
    } catch (err) {
      logger.warn(`[AiAnalysis] analyzeBookmark (missing) failed: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  private formatTableAsText(table: TableInfo): string {
    if (table.cells.length === 0) return '(empty table)';

    const maxRows = Math.min(table.rowCount, 10);
    const maxCols = Math.min(table.columnCount, 8);

    const grid: string[][] = Array.from({ length: maxRows }, () => Array(maxCols).fill(''));
    for (const cell of table.cells) {
      if (cell.row < maxRows && cell.column < maxCols) {
        grid[cell.row][cell.column] = cell.text.slice(0, 30);
      }
    }

    return grid.map(row => `| ${row.join(' | ')} |`).join('\n');
  }

  /**
   * When an image can't be directly extracted (e.g. JPX/JBIG2 format), fall back to a
   * full-page render and return a synthetic ImageInfo with the page PNG as base64.
   */
  private async fallbackToPageRender(
    img: ImageInfo | undefined,
    issue: AuditIssue,
    parsed: PdfParseResult,
    pageRenderCache: Map<number, Promise<string | null>>
  ): Promise<ImageInfo | null> {
    const pageNumber = issue.pageNumber ?? img?.pageNumber;
    if (!pageNumber || !parsed.parsedPdf) return null;

    if (!pageRenderCache.has(pageNumber)) {
      pageRenderCache.set(pageNumber, this.renderPageToBase64(parsed.parsedPdf, pageNumber));
    }
    const pageBase64 = await pageRenderCache.get(pageNumber)!;
    if (!pageBase64) return null;

    logger.info(`[AiAnalysis] Using page render fallback for image on page ${pageNumber} (format: ${img?.format ?? 'unknown'})`);
    return {
      id: img?.id ?? `page_render_p${pageNumber}`,
      pageNumber,
      index: img?.index ?? 0,
      position: img?.position ?? { x: 0, y: 0, width: 0, height: 0 },
      dimensions: img?.dimensions ?? { width: 0, height: 0 },
      format: 'png',
      colorSpace: 'RGB',
      bitsPerComponent: 8,
      hasAlpha: false,
      fileSizeBytes: 0,
      mimeType: 'image/png',
      base64: pageBase64,
    };
  }

  private async renderPageToBase64(parsedPdf: ParsedPDF, pageNumber: number): Promise<string | null> {
    try {
      const page = await parsedPdf.pdfjsDoc.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1.0 });
      const canvas = createCanvas(Math.round(viewport.width), Math.round(viewport.height));
      const context = canvas.getContext('2d');

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await page.render({ canvas: canvas as any, canvasContext: context as any, viewport }).promise;

      return canvas.toBuffer('image/png').toString('base64');
    } catch (err) {
      logger.warn(`[AiAnalysis] Failed to render page ${pageNumber}: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  private parseAiJson<T>(text: string): T | null {
    try {
      let jsonText = text.trim();
      if (jsonText.startsWith('```json')) {
        jsonText = jsonText.replace(/^```json\n?/, '').replace(/\n?```$/, '').trim();
      } else if (jsonText.startsWith('```')) {
        jsonText = jsonText.replace(/^```\n?/, '').replace(/\n?```$/, '').trim();
      }
      return JSON.parse(jsonText) as T;
    } catch {
      const match = text.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]) as T;
        } catch {
          return null;
        }
      }
      return null;
    }
  }

  private async getTenantConfig(tenantId: string): Promise<Partial<AiRemediationConfig>> {
    try {
      const tenant = await prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { settings: true },
      });
      if (!tenant?.settings || typeof tenant.settings !== 'object') return {};
      const settings = tenant.settings as Record<string, unknown>;
      if (!settings.aiRemediation || typeof settings.aiRemediation !== 'object') return {};
      return settings.aiRemediation as Partial<AiRemediationConfig>;
    } catch {
      return {};
    }
  }
}

export const aiAnalysisService = new AiAnalysisService();
