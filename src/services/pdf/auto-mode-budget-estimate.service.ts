/**
 * Auto Mode Budget Estimate Service
 *
 * Auto Mode's cost limit has always defaulted to a flat, arbitrary $2.00
 * (PdfAutoRemediationRun.autoCostLimitUsd's own schema default) regardless
 * of whether a document has 50 issues or 1,800 -- Test Batch 19's real run
 * showed exactly why that's a problem: round 1 alone cost $2.25 on a large
 * document, blowing through the default before round 2 could finish.
 *
 * This derives a smarter suggested budget from real historical data instead
 * of inventing another hardcoded number: every completed (terminal)
 * PdfAutoRemediationRun already has a real, measured total spend
 * (autoCostSpentUsd, accumulated round-by-round in
 * auto-remediation-loop.service.ts from each round's actual Gemini/Claude
 * token cost) and its job's own audit already knows issuesFound
 * (Job.output.auditReport.issues.length). Nobody had ever paired those two
 * things together across jobs before -- that pairing is what this computes.
 *
 * Deliberately scoped to PdfAutoRemediationRun only, not ComparisonTrial --
 * trial runs are internal research tooling with much looser bounds (up to
 * $1000, see comparison-study.routes.ts's own schema) that could badly skew
 * a production-facing average.
 */

import prisma from '../../lib/prisma';
import type { Prisma } from '@prisma/client';

const DEFAULT_COST_LIMIT_USD = 2.0;
const MIN_COST_LIMIT_USD = 0.1;
const MAX_COST_LIMIT_USD = 10;

/** Below this many historical samples, the estimate is too thin to trust -- return the flat default unchanged rather than a wild guess. */
const LOW_CONFIDENCE_SAMPLE_SIZE = 5;
/** At or above this many samples, call the estimate 'high' confidence. */
const HIGH_CONFIDENCE_SAMPLE_SIZE = 20;

export interface BudgetEstimate {
  estimatedCostUsd: number;
  confidence: 'low' | 'medium' | 'high';
  sampleSize: number;
  /** This job's own issuesFound, when estimating for a specific audited job; null for the pre-audit/tenant-wide case. */
  basedOnIssueCount: number | null;
}

function confidenceFor(sampleSize: number): BudgetEstimate['confidence'] {
  if (sampleSize < LOW_CONFIDENCE_SAMPLE_SIZE) return 'low';
  if (sampleSize < HIGH_CONFIDENCE_SAMPLE_SIZE) return 'medium';
  return 'high';
}

function clamp(value: number): number {
  return Math.min(MAX_COST_LIMIT_USD, Math.max(MIN_COST_LIMIT_USD, value));
}

/** Pulls issuesFound out of a Job.output JSON blob -- null when there's no completed audit report to read yet. */
function issuesFoundFromJobOutput(output: Prisma.JsonValue | null): number | null {
  const obj = output as Prisma.JsonObject | null;
  const auditReport = obj?.auditReport as Prisma.JsonObject | undefined;
  const issues = auditReport?.issues;
  return Array.isArray(issues) ? issues.length : null;
}

interface HistoricalSample {
  costUsd: number;
  issuesFound: number;
}

/**
 * Terminal (stopped) PdfAutoRemediationRun rows paired with their job's own
 * audit issue count. Omitting tenantId returns a GLOBAL (cross-tenant)
 * sample, which is always a superset of any single tenant's own rows --
 * used as a fallback when a tenant doesn't have enough history of its own
 * yet, so a brand-new tenant isn't permanently stuck with zero data.
 */
async function getHistoricalSamples(tenantId?: string): Promise<HistoricalSample[]> {
  const runs = await prisma.pdfAutoRemediationRun.findMany({
    where: {
      autoStatus: 'stopped',
      ...(tenantId && { job: { tenantId } }),
    },
    select: {
      autoCostSpentUsd: true,
      job: { select: { output: true } },
    },
  });

  const samples: HistoricalSample[] = [];
  for (const run of runs) {
    const issuesFound = issuesFoundFromJobOutput(run.job.output);
    if (issuesFound === null || issuesFound === 0 || run.autoCostSpentUsd <= 0) continue;
    samples.push({ costUsd: run.autoCostSpentUsd, issuesFound });
  }
  return samples;
}

/**
 * avgCostPerIssue = sum(cost) / sum(issues) across the sample -- a ratio of
 * sums, not an average of per-job ratios, so one job with very few issues
 * can't single-handedly skew the result the way averaging per-job ratios
 * would. When issuesFound is null (no specific job to scale against -- the
 * batch/tenant-wide case), falls back to the sample's average cost per run.
 */
function estimateFromSamples(
  samples: HistoricalSample[],
  issuesFound: number | null
): { estimatedCostUsd: number; sampleSize: number } {
  if (samples.length === 0) {
    return { estimatedCostUsd: DEFAULT_COST_LIMIT_USD, sampleSize: 0 };
  }

  const totalCost = samples.reduce((sum, s) => sum + s.costUsd, 0);
  const totalIssues = samples.reduce((sum, s) => sum + s.issuesFound, 0);

  const estimatedCostUsd = issuesFound != null
    ? clamp(issuesFound * (totalCost / totalIssues))
    : clamp(totalCost / samples.length);

  return { estimatedCostUsd, sampleSize: samples.length };
}

async function samplesWithGlobalFallback(tenantId: string): Promise<HistoricalSample[]> {
  const tenantSamples = await getHistoricalSamples(tenantId);
  if (tenantSamples.length >= LOW_CONFIDENCE_SAMPLE_SIZE) return tenantSamples;

  const globalSamples = await getHistoricalSamples();
  return globalSamples.length > tenantSamples.length ? globalSamples : tenantSamples;
}

function buildEstimate(
  samples: HistoricalSample[],
  issuesFound: number | null
): BudgetEstimate {
  const { estimatedCostUsd, sampleSize } = estimateFromSamples(samples, issuesFound);
  const confidence = confidenceFor(sampleSize);
  return {
    // A thin sample isn't trustworthy enough to deviate from today's known-safe
    // default -- report it plainly rather than silently guessing.
    estimatedCostUsd: confidence === 'low' ? DEFAULT_COST_LIMIT_USD : estimatedCostUsd,
    confidence,
    sampleSize,
    basedOnIssueCount: issuesFound,
  };
}

/**
 * Estimates a budget for a SPECIFIC job whose audit has already completed --
 * the single-PDF flow, where the operator sees "Start Auto Remediation"
 * only after the audit result is already on screen.
 */
export async function estimateBudgetForJob(jobId: string): Promise<BudgetEstimate> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { tenantId: true, output: true } });
  const issuesFound = job ? issuesFoundFromJobOutput(job.output) : null;

  if (issuesFound === null || !job) {
    // No completed audit to read a real issue count from yet -- same flat
    // default as today, not a guess.
    return { estimatedCostUsd: DEFAULT_COST_LIMIT_USD, confidence: 'low', sampleSize: 0, basedOnIssueCount: null };
  }

  const samples = await samplesWithGlobalFallback(job.tenantId);
  return buildEstimate(samples, issuesFound);
}

/**
 * Estimates a budget for a TENANT with no specific job's issue count to
 * scale against -- the PDF Batch flow, where the operator configures Auto
 * Mode once for the whole batch at "Start Processing" time, before any
 * item's own audit has run.
 */
export async function estimateBudgetForTenant(tenantId: string): Promise<BudgetEstimate> {
  const samples = await samplesWithGlobalFallback(tenantId);
  return buildEstimate(samples, null);
}
