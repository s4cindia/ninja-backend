/**
 * AI-powered zone annotation service.
 * Classifies zones using Gemini Flash (cheap, fast) with batched page-level prompts.
 * Falls back to Claude Haiku if Gemini is unreachable (e.g. Google blocks cloud IPs).
 * Confidence-gated: >= 0.97 auto-apply, 0.80-0.97 flag, < 0.80 skip.
 */
import prisma from '../../lib/prisma';
import { geminiService } from '../ai/gemini.service';
import { claudeService } from '../ai/claude.service';
import {
  buildPageClassificationPrompt,
  PROMPT_VERSION,
  type ZoneInput,
  type PageClassificationResponse,
  type HeadingContext,
  VALID_ZONE_TYPES,
} from '../ai/prompts/zone-classification.prompts';
import { logger } from '../../lib/logger';

// Cost per 1M tokens (approximate)
const GEMINI_FLASH_INPUT_COST_PER_M = 0.075;
const GEMINI_FLASH_OUTPUT_COST_PER_M = 0.30;
const CLAUDE_HAIKU_INPUT_COST_PER_M = 1.00;
const CLAUDE_HAIKU_OUTPUT_COST_PER_M = 5.00;

type AiProvider = 'gemini' | 'claude';

// Label normalization map: raw extractor labels → canonical VALID_ZONE_TYPES values.
// Used to detect case-only "corrections" (e.g. H3→h3, P→paragraph) that should be CONFIRMED.
const LABEL_ALIASES: Record<string, string> = {
  'p': 'paragraph',
  'li': 'list-item',
  'h1': 'h1', 'h2': 'h2', 'h3': 'h3', 'h4': 'h4', 'h5': 'h5', 'h6': 'h6',
  'section_header': 'section-header',
  'section-header': 'section-header',
  'list_item': 'list-item',
  'table_of_contents': 'toci',
  'picture': 'figure',
  'text': 'paragraph',
  'page_header': 'header',
  'page_footer': 'footer',
};

/**
 * Classify a page's zones using Gemini, falling back to Claude on network failure.
 * Returns the structured response, token usage, and which provider was used.
 */
async function classifyPageWithFallback(
  prompt: string,
  preferredProvider: AiProvider,
): Promise<{
  data: PageClassificationResponse;
  usage?: { promptTokens: number; completionTokens: number };
  provider: AiProvider;
}> {
  // Try preferred provider first
  if (preferredProvider === 'gemini') {
    try {
      const { data, usage } = await geminiService.generateStructuredOutput<PageClassificationResponse>(
        prompt,
        { temperature: 0.1 },
      );
      return { data, usage: usage ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens } : undefined, provider: 'gemini' };
    } catch (err) {
      const msg = (err as Error).message || '';
      // Only fall back on network/fetch errors, not on auth or quota errors
      if (msg.includes('fetch failed') || msg.includes('ECONNREFUSED') || msg.includes('ETIMEDOUT') || msg.includes('ENOTFOUND')) {
        logger.warn(`[ai-annotation] Gemini unreachable (${msg}), falling back to Claude Haiku`);
      } else {
        // Non-network error — don't fall back, re-throw
        throw err;
      }
    }
  }

  // Claude fallback (or primary if preferred)
  if (!claudeService.isAvailable()) {
    throw new Error('Both Gemini and Claude are unavailable — check API key configuration');
  }

  const { data, usage } = await claudeService.generateJSONWithUsage<PageClassificationResponse>(prompt, {
    model: 'haiku',
    temperature: 0.1,
    systemPrompt: 'You are an expert PDF accessibility analyst. Always respond with valid JSON only, no markdown or explanations.',
  });
  return {
    data,
    usage: usage ? { promptTokens: usage.promptTokens, completionTokens: usage.completionTokens } : undefined,
    provider: 'claude',
  };
}

export interface AiAnnotationOptions {
  confidenceThreshold?: number; // minimum confidence to auto-apply (default 0.97)
  model?: string;               // model override
  dryRun?: boolean;             // if true, classify but don't persist
  aiRunId?: string;             // pre-created AiAnnotationRun ID (for async pattern)
  /** Only annotate zones on pages >= pageStart (inclusive). */
  pageStart?: number;
  /** Only annotate zones on pages <= pageEnd (inclusive). */
  pageEnd?: number;
  /**
   * If true, include zones that already have a decision (re-processing pass).
   * AI fields are always overwritten; human decisions are only overwritten when the
   * new confidence exceeds `confidenceThreshold`.
   */
  includeDecided?: boolean;
  /**
   * If true, allow auto-apply to overwrite zones that were last verified by a human
   * (verifiedBy not starting with 'ai:'). Default false — human decisions are sticky.
   */
  forceOverwriteHuman?: boolean;
}

export interface AiAnnotationResult {
  runId: string;
  aiRunId: string;
  totalZones: number;
  annotatedZones: number;
  skippedZones: number;
  confirmedCount: number;
  correctedCount: number;
  rejectedCount: number;
  highConfCount: number;
  medConfCount: number;
  lowConfCount: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCostUsd: number;
  durationMs: number;
}

export async function runAiAnnotation(
  calibrationRunId: string,
  options: AiAnnotationOptions = {},
): Promise<AiAnnotationResult> {
  const startTime = Date.now();
  const confThreshold = options.confidenceThreshold ?? 0.97;
  const modelName = options.model ?? 'gemini-2.0-flash';

  // 1. Use pre-created AI annotation run or create one
  const aiRun = options.aiRunId
    ? await prisma.aiAnnotationRun.findUniqueOrThrow({ where: { id: options.aiRunId } })
    : await prisma.aiAnnotationRun.create({
        data: {
          calibrationRunId,
          model: modelName,
          promptVersion: PROMPT_VERSION,
          confidenceThreshold: confThreshold,
          dryRun: options.dryRun ?? false,
          status: 'RUNNING',
        },
      });

  try {
    // 2. Fetch zones to annotate. By default: unreviewed + not already AI-annotated + not ghost.
    // When re-processing (includeDecided), skip the decision/aiDecision filters so already-seen
    // zones can be re-classified under a new prompt version. Ghost zones are always skipped.
    const pageFilter =
      options.pageStart !== undefined || options.pageEnd !== undefined
        ? {
            pageNumber: {
              ...(options.pageStart !== undefined ? { gte: options.pageStart } : {}),
              ...(options.pageEnd !== undefined ? { lte: options.pageEnd } : {}),
            },
          }
        : {};

    const zones = await prisma.zone.findMany({
      where: {
        calibrationRunId,
        isGhost: false,
        ...(options.includeDecided
          ? {}
          : { decision: null, aiDecision: null }),
        ...pageFilter,
      },
      select: {
        id: true,
        type: true,
        label: true,
        source: true,
        content: true,
        bounds: true,
        pageNumber: true,
        reconciliationBucket: true,
        doclingLabel: true,
        pdfxtLabel: true,
        decision: true,
        verifiedBy: true,
        operatorVerified: true,
        isArtefact: true,
        operatorLabel: true,
        correctionReason: true,
      },
    });

    if (zones.length === 0) {
      await prisma.aiAnnotationRun.update({
        where: { id: aiRun.id },
        data: {
          status: 'COMPLETED',
          totalZones: 0,
          completedAt: new Date(),
          durationMs: Date.now() - startTime,
        },
      });

      return {
        runId: calibrationRunId,
        aiRunId: aiRun.id,
        totalZones: 0,
        annotatedZones: 0,
        skippedZones: 0,
        confirmedCount: 0,
        correctedCount: 0,
        rejectedCount: 0,
        highConfCount: 0,
        medConfCount: 0,
        lowConfCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        durationMs: Date.now() - startTime,
      };
    }

    // 3. Get total page count from the calibration run
    const run = await prisma.calibrationRun.findUnique({
      where: { id: calibrationRunId },
      select: {
        corpusDocument: { select: { pageCount: true } },
      },
    });
    const totalPages = run?.corpusDocument?.pageCount ?? 0;

    // 4. Group zones by page
    const byPage = new Map<number, typeof zones>();
    for (const z of zones) {
      const page = z.pageNumber;
      if (!byPage.has(page)) byPage.set(page, []);
      byPage.get(page)!.push(z);
    }

    // 5. Process pages in batches
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    let annotated = 0;
    let skipped = 0;
    let confirmed = 0;
    let corrected = 0;
    let rejected = 0;
    let highConf = 0;
    let medConf = 0;
    let lowConf = 0;
    // Use Claude as primary — Gemini is unreachable from ECS ap-south-1
    let activeProvider: AiProvider = 'claude';

    // Heading context: track heading decisions across pages so the AI can
    // maintain consistent heading hierarchy throughout the document
    const headingContext: HeadingContext = { stack: [], maxDepth: 0 };
    const HEADING_PATTERN = /^h([1-6])$/;

    const sortedPages = [...byPage.keys()].sort((a, b) => a - b);
    const pagesWithZones = sortedPages.length;

    // Set totalPages on the run so the frontend can show progress
    await prisma.aiAnnotationRun.update({
      where: { id: aiRun.id },
      data: { totalZones: zones.length, totalPages: pagesWithZones },
    });

    for (const pageNum of sortedPages) {
      const pageZones = byPage.get(pageNum)!;

      // Update current page progress (fire-and-forget)
      prisma.aiAnnotationRun.update({
        where: { id: aiRun.id },
        data: { currentPage: pageNum, annotatedZones: annotated, skippedZones: skipped },
      }).catch(() => {});
      const zoneInputs: ZoneInput[] = pageZones.map((z) => ({
        zoneId: z.id,
        type: z.type,
        label: z.label,
        source: z.source,
        content: z.content,
        bbox: z.bounds as ZoneInput['bbox'],
        pageNumber: z.pageNumber,
        reconciliationBucket: z.reconciliationBucket,
        doclingLabel: z.doclingLabel,
        pdfxtLabel: z.pdfxtLabel,
      }));

      const prompt = buildPageClassificationPrompt(pageNum, totalPages, zoneInputs, headingContext);

      try {
        const { data: response, usage, provider } = await classifyPageWithFallback(prompt, activeProvider);

        // Stick with fallback provider for remaining pages to avoid repeated failures
        if (provider !== activeProvider) {
          logger.info(`[ai-annotation] Switched provider: ${activeProvider} → ${provider}`);
          activeProvider = provider;
        }

        if (usage) {
          totalInputTokens += usage.promptTokens ?? 0;
          totalOutputTokens += usage.completionTokens ?? 0;
        }

        // 6. Process classifications
        if (response?.zones && Array.isArray(response.zones)) {
          for (const classification of response.zones) {
            if (!classification.zoneId || !classification.decision) continue;

            // Guard: skip zones the AI hallucinated (not in this page's zone list)
            const zone = pageZones.find(z => z.id === classification.zoneId);
            if (!zone) {
              logger.warn(
                `[ai-annotation] Zone ${classification.zoneId} not found on page ${pageNum}, skipping`,
              );
              skipped++;
              continue;
            }

            // Validate the label
            const validLabel = VALID_ZONE_TYPES.includes(
              classification.label as typeof VALID_ZONE_TYPES[number],
            );
            if (!validLabel) {
              logger.warn(
                `[ai-annotation] Invalid label "${classification.label}" for zone ${classification.zoneId}, skipping`,
              );
              skipped++;
              continue;
            }

            // Prevent false rejections: don't reject zones that have content, bbox,
            // or agreement from both extractors
            if (
              classification.decision === 'REJECTED' &&
              (zone.content || zone.bounds || (zone.pdfxtLabel && zone.doclingLabel))
            ) {
              // Override to CONFIRMED using zone.type directly — it is always a
              // canonical CanonicalZoneType set by zone-matcher during reconciliation.
              // Avoids re-normalizing from zone.label which can disagree with zone.type
              // (e.g. zone.label='list_item' maps to 'list-item' but zone.type='paragraph').
              logger.warn(
                `[ai-annotation] Overriding REJECTED→CONFIRMED for zone ${classification.zoneId} (has content/bbox/both extractor labels)`,
              );
              classification.decision = 'CONFIRMED';
              classification.label = zone.type;
            }

            // Reclassify case-only "corrections" as confirmations
            // e.g. H3→h3, LI→list-item, P→paragraph are not real corrections
            if (classification.decision === 'CORRECTED') {
              const existingLabel = (zone.label ?? zone.type ?? '').toLowerCase();
              const aiLabel = classification.label.toLowerCase();
              const normalizedExisting = LABEL_ALIASES[existingLabel] ?? existingLabel;
              const normalizedAi = LABEL_ALIASES[aiLabel] ?? aiLabel;

              if (normalizedExisting === normalizedAi) {
                classification.decision = 'CONFIRMED';
              }
            }

            // Preserve original model confidence for analytics, cap for auto-apply
            const originalConf = Math.max(0, Math.min(1, classification.confidence ?? 0));
            let conf = originalConf;

            // Hard cap: RED bucket zones must not auto-apply — cap at 0.85
            if (zone.reconciliationBucket === 'RED' && conf > 0.85) {
              conf = 0.85;
            }

            // Confidence bucketing (uses capped value for accurate auto-apply tracking)
            if (conf >= 0.95) highConf++;
            else if (conf >= 0.80) medConf++;
            else lowConf++;

            // Count decisions
            if (classification.decision === 'CONFIRMED') confirmed++;
            else if (classification.decision === 'CORRECTED') corrected++;
            else if (classification.decision === 'REJECTED') rejected++;

            // Always persist AI fields for transparency
            // Store ORIGINAL model confidence (not capped) so model quality can be analyzed
            const effectiveModel = activeProvider === 'claude' ? 'claude-haiku-4.5' : modelName;
            const updateData: Record<string, unknown> = {
              aiLabel: classification.label,
              aiConfidence: originalConf,
              aiDecision: classification.decision,
              aiReason: classification.reason ?? null,
              aiModel: effectiveModel,
              aiAnnotatedAt: new Date(),
            };

            // Auto-apply if capped confidence >= threshold and not dry run.
            // Human decisions are sticky: never overwrite a zone that was last verified by a
            // human (verifiedBy not starting with 'ai:') unless forceOverwriteHuman is set.
            // 'auto-annotation' is the deterministic system verifier, not a human — exclude it
            // so re-runs over auto-annotated pages can still be reclassified.
            const isHumanVerified =
              !!zone.decision &&
              !!zone.verifiedBy &&
              !zone.verifiedBy.startsWith('ai:') &&
              zone.verifiedBy !== 'auto-annotation';
            const canAutoApply =
              !options.dryRun &&
              conf >= confThreshold &&
              (!isHumanVerified || options.forceOverwriteHuman === true);

            if (canAutoApply) {
              if (classification.decision === 'REJECTED') {
                updateData.decision = 'REJECTED';
                updateData.isArtefact = true;
                updateData.operatorLabel = null;
                updateData.correctionReason = classification.reason ?? 'AI rejection';
                updateData.verifiedBy = `ai:${effectiveModel}`;
                updateData.verifiedAt = new Date();
              } else if (classification.decision === 'CORRECTED') {
                updateData.decision = 'CORRECTED';
                updateData.operatorLabel = classification.label;
                updateData.isArtefact = false;
                updateData.correctionReason = classification.reason ?? 'AI correction';
                updateData.verifiedBy = `ai:${effectiveModel}`;
                updateData.verifiedAt = new Date();
              } else {
                updateData.decision = 'CONFIRMED';
                updateData.operatorLabel = null;
                updateData.correctionReason = null;
                updateData.isArtefact = false;
                updateData.verifiedBy = `ai:${effectiveModel}`;
                updateData.verifiedAt = new Date();
              }
            } else if (isHumanVerified && !options.dryRun && conf >= confThreshold) {
              // Skipped auto-apply because the zone was human-verified — log for traceability
              logger.info(
                `[ai-annotation] Skipping auto-apply for human-verified zone ${classification.zoneId} ` +
                `(verifiedBy=${zone.verifiedBy}); only AI fields will be persisted`,
              );
            }

            await prisma.zone.update({
              where: { id: classification.zoneId },
              data: updateData,
            });

            // Accumulate heading context for subsequent pages
            const headingMatch = HEADING_PATTERN.exec(classification.label);
            if (headingMatch && classification.decision !== 'REJECTED') {
              const level = parseInt(headingMatch[1], 10);
              const text = (zone.content ?? '').trim().substring(0, 80);
              headingContext.stack.push({ level, text, page: pageNum });
              if (level > headingContext.maxDepth) {
                headingContext.maxDepth = level;
              }
            }

            annotated++;
          }
        }
      } catch (err) {
        logger.warn(
          `[ai-annotation] Page ${pageNum} classification failed: ${(err as Error).message}`,
        );
        skipped += pageZones.length;
      }
    }

    // 7. Calculate cost (use the active provider's pricing)
    const inputCostPerM = activeProvider === 'claude' ? CLAUDE_HAIKU_INPUT_COST_PER_M : GEMINI_FLASH_INPUT_COST_PER_M;
    const outputCostPerM = activeProvider === 'claude' ? CLAUDE_HAIKU_OUTPUT_COST_PER_M : GEMINI_FLASH_OUTPUT_COST_PER_M;
    const estimatedCost =
      (totalInputTokens / 1_000_000) * inputCostPerM +
      (totalOutputTokens / 1_000_000) * outputCostPerM;

    const durationMs = Date.now() - startTime;

    // 8. Update AI annotation run record
    await prisma.aiAnnotationRun.update({
      where: { id: aiRun.id },
      data: {
        status: 'COMPLETED',
        totalZones: zones.length,
        annotatedZones: annotated,
        skippedZones: skipped,
        confirmedCount: confirmed,
        correctedCount: corrected,
        rejectedCount: rejected,
        highConfCount: highConf,
        medConfCount: medConf,
        lowConfCount: lowConf,
        inputTokens: totalInputTokens,
        outputTokens: totalOutputTokens,
        estimatedCostUsd: estimatedCost,
        durationMs,
        completedAt: new Date(),
      },
    });

    logger.info(
      `[ai-annotation] Run ${aiRun.id} complete: ${annotated} annotated, ${skipped} skipped, ` +
      `${confirmed} confirmed, ${corrected} corrected, ${rejected} rejected ` +
      `(${totalInputTokens}+${totalOutputTokens} tokens, $${estimatedCost.toFixed(4)}, ${durationMs}ms)`,
    );

    return {
      runId: calibrationRunId,
      aiRunId: aiRun.id,
      totalZones: zones.length,
      annotatedZones: annotated,
      skippedZones: skipped,
      confirmedCount: confirmed,
      correctedCount: corrected,
      rejectedCount: rejected,
      highConfCount: highConf,
      medConfCount: medConf,
      lowConfCount: lowConf,
      inputTokens: totalInputTokens,
      outputTokens: totalOutputTokens,
      estimatedCostUsd: estimatedCost,
      durationMs,
    };
  } catch (err) {
    // Mark run as failed
    await prisma.aiAnnotationRun.update({
      where: { id: aiRun.id },
      data: {
        status: 'FAILED',
        error: (err as Error).message,
        durationMs: Date.now() - startTime,
        completedAt: new Date(),
      },
    });
    throw err;
  }
}

/**
 * Get the AI annotation report for a calibration run.
 */
export async function getAiAnnotationReport(calibrationRunId: string) {
  const runs = await prisma.aiAnnotationRun.findMany({
    where: { calibrationRunId },
    orderBy: { createdAt: 'desc' },
  });

  // Get zone-level AI stats
  const aiZones = await prisma.zone.findMany({
    where: {
      calibrationRunId,
      aiDecision: { not: null },
    },
    select: {
      id: true,
      type: true,
      aiLabel: true,
      aiConfidence: true,
      aiDecision: true,
      aiReason: true,
      decision: true,
      operatorLabel: true,
      verifiedBy: true,
      pageNumber: true,
    },
  });

  // Count zones where AI was overridden by human
  const aiOverridden = aiZones.filter(
    (z) => z.verifiedBy && !z.verifiedBy.startsWith('ai:') && z.aiDecision !== null,
  ).length;

  return {
    runs,
    totalAiAnnotatedZones: aiZones.length,
    aiOverriddenByHuman: aiOverridden,
    zones: aiZones,
  };
}
