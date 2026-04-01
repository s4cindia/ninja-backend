/**
 * AI-powered zone annotation service.
 * Classifies zones using Gemini Flash (cheap, fast) with batched page-level prompts.
 * Falls back to Claude Haiku if Gemini is unreachable (e.g. Google blocks cloud IPs).
 * Confidence-gated: >= 0.95 auto-apply, 0.80-0.95 flag, < 0.80 skip.
 */
import prisma from '../../lib/prisma';
import { geminiService } from '../ai/gemini.service';
import { claudeService } from '../ai/claude.service';
import {
  buildPageClassificationPrompt,
  PROMPT_VERSION,
  type ZoneInput,
  type PageClassificationResponse,
  VALID_ZONE_TYPES,
} from '../ai/prompts/zone-classification.prompts';
import { logger } from '../../lib/logger';

// Cost per 1M tokens (approximate)
const GEMINI_FLASH_INPUT_COST_PER_M = 0.075;
const GEMINI_FLASH_OUTPUT_COST_PER_M = 0.30;
const CLAUDE_HAIKU_INPUT_COST_PER_M = 1.00;
const CLAUDE_HAIKU_OUTPUT_COST_PER_M = 5.00;

type AiProvider = 'gemini' | 'claude';

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
  confidenceThreshold?: number; // minimum confidence to auto-apply (default 0.95)
  model?: string;               // model override
  dryRun?: boolean;             // if true, classify but don't persist
  aiRunId?: string;             // pre-created AiAnnotationRun ID (for async pattern)
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
  const confThreshold = options.confidenceThreshold ?? 0.95;
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
    // 2. Fetch unreviewed zones (not yet decided by operator or auto-annotation)
    const zones = await prisma.zone.findMany({
      where: {
        calibrationRunId,
        decision: null,        // only unreviewed zones
        aiDecision: null,      // not already AI-annotated
        isGhost: false,        // skip ghost zones
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

    const sortedPages = [...byPage.keys()].sort((a, b) => a - b);

    for (const pageNum of sortedPages) {
      const pageZones = byPage.get(pageNum)!;
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

      const prompt = buildPageClassificationPrompt(pageNum, totalPages, zoneInputs);

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

            const conf = Math.max(0, Math.min(1, classification.confidence ?? 0));

            // Confidence bucketing
            if (conf >= 0.95) highConf++;
            else if (conf >= 0.80) medConf++;
            else lowConf++;

            // Count decisions
            if (classification.decision === 'CONFIRMED') confirmed++;
            else if (classification.decision === 'CORRECTED') corrected++;
            else if (classification.decision === 'REJECTED') rejected++;

            // Always persist AI fields for transparency
            const effectiveModel = activeProvider === 'claude' ? 'claude-haiku-4.5' : modelName;
            const updateData: Record<string, unknown> = {
              aiLabel: classification.label,
              aiConfidence: conf,
              aiDecision: classification.decision,
              aiReason: classification.reason ?? null,
              aiModel: effectiveModel,
              aiAnnotatedAt: new Date(),
            };

            // Auto-apply if confidence >= threshold and not dry run
            if (!options.dryRun && conf >= confThreshold) {
              if (classification.decision === 'REJECTED') {
                updateData.decision = 'REJECTED';
                updateData.isArtefact = true;
                updateData.verifiedBy = `ai:${effectiveModel}`;
              } else if (classification.decision === 'CORRECTED') {
                updateData.decision = 'CORRECTED';
                updateData.operatorLabel = classification.label;
                updateData.verifiedBy = `ai:${effectiveModel}`;
                updateData.correctionReason = classification.reason ?? 'AI correction';
              } else {
                updateData.decision = 'CONFIRMED';
                updateData.verifiedBy = `ai:${effectiveModel}`;
              }
            }

            await prisma.zone.update({
              where: { id: classification.zoneId },
              data: updateData,
            });

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
