/**
 * AI-powered annotation analysis service.
 * Generates rich per-title analysis reports (lineage + timesheet combined)
 * and cross-title corpus summaries using Claude Haiku.
 */
import prisma from '../../lib/prisma';
import type { Prisma } from '@prisma/client';
import { claudeService } from '../ai/claude.service';
import { annotationReportService } from './annotation-report.service';
import { annotationTimesheetService } from './annotation-timesheet.service';
import { logger } from '../../lib/logger';
import type { LineageRow, CorrectionLogRow, AnnotationReport } from './annotation-report.service';
import type { TimesheetReport } from './annotation-timesheet.service';

// ── Types ───────────────────────────────────────────────────────────

export interface AnalysisReport {
  markdown: string;
  generatedAt: string;
  model: string;
  tokenUsage: { promptTokens: number; completionTokens: number };
}

export interface CostBreakdown {
  aiAnnotationCostUsd: number;
  aiReportCostUsd: number;
  annotatorActiveHours: number;
  annotatorCostInr: number;
  totalCostInr: number;
}

export interface PerTitleAnalysisResult {
  report: AnalysisReport;
  costBreakdown: CostBreakdown;
}

export interface CorpusSummaryResult {
  summaryReport: AnalysisReport;
  costSummary: {
    titles: Array<{
      documentName: string;
      runId: string;
      pages: number;
      zones: number;
      aiAnnotationCostInr: number;
      aiReportCostInr: number;
      annotatorCostInr: number;
      totalCostInr: number;
    }>;
    totals: {
      documents: number;
      pages: number;
      zones: number;
      aiAnnotationCostInr: number;
      aiReportCostInr: number;
      annotatorCostInr: number;
      totalCostInr: number;
    };
  };
}

// ── Constants ───────────────────────────────────────────────────────

const USD_TO_INR = 85;
const ANNOTATOR_RATE_INR_PER_HOUR = 400;
const HAIKU_INPUT_COST_PER_M = 1.0;
const HAIKU_OUTPUT_COST_PER_M = 5.0;

// ── Aggregation helpers ─────────────────────────────────────────────

interface LineageAggregates {
  aiCoverage: { withAi: number; withoutAi: number; model: string | null };
  aiDecisionDist: { confirmed: number; corrected: number; rejected: number };
  confidenceDist: Array<{ confidence: number; count: number }>;
  agreement: { sameDecisionAndLabel: number; sameDecisionDiffLabel: number; differentDecision: number };
  confidenceByAgreement: {
    agreed: { count: number; mean: number; median: number };
    overridden: { count: number; mean: number; median: number };
  };
  topDisagreements: Array<{ pattern: string; count: number; detail: string }>;
  zoneTypeTransitions: Record<string, Record<string, number>>;
  perBucket: Record<string, { total: number; rejected: number; aiCoverage: number; headingCorrections: number }>;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function buildLineageAggregates(lineage: LineageRow[]): LineageAggregates {
  // AI coverage
  const withAi = lineage.filter(r => r.aiDecision != null);
  const models = new Set(withAi.map(r => r.aiModel).filter(Boolean));

  // AI decision distribution
  const aiDecisionDist = { confirmed: 0, corrected: 0, rejected: 0 };
  for (const r of withAi) {
    if (r.aiDecision === 'CONFIRMED') aiDecisionDist.confirmed++;
    else if (r.aiDecision === 'CORRECTED') aiDecisionDist.corrected++;
    else if (r.aiDecision === 'REJECTED') aiDecisionDist.rejected++;
  }

  // Confidence distribution
  const confCounts = new Map<number, number>();
  for (const r of withAi) {
    if (r.aiConfidence != null) {
      const rounded = Math.round(r.aiConfidence * 100) / 100;
      confCounts.set(rounded, (confCounts.get(rounded) ?? 0) + 1);
    }
  }
  const confidenceDist = [...confCounts.entries()]
    .sort(([a], [b]) => b - a)
    .map(([confidence, count]) => ({ confidence, count }));

  // AI vs human agreement (only zones with both AI and human decisions)
  const bothReviewed = lineage.filter(r => r.aiDecision != null && r.humanDecision != null);
  let sameDecisionAndLabel = 0;
  let sameDecisionDiffLabel = 0;
  let differentDecision = 0;
  const agreedConf: number[] = [];
  const overriddenConf: number[] = [];

  for (const r of bothReviewed) {
    if (r.aiDecision === r.humanDecision && r.aiLabel === r.humanLabel) {
      sameDecisionAndLabel++;
      if (r.aiConfidence != null) agreedConf.push(r.aiConfidence);
    } else if (r.aiDecision === r.humanDecision) {
      sameDecisionDiffLabel++;
      if (r.aiConfidence != null) overriddenConf.push(r.aiConfidence);
    } else {
      differentDecision++;
      if (r.aiConfidence != null) overriddenConf.push(r.aiConfidence);
    }
  }

  // Top disagreement patterns
  const disagreeMap = new Map<string, number>();
  for (const r of bothReviewed) {
    if (r.aiDecision === r.humanDecision && r.aiLabel === r.humanLabel) continue;
    const key = `${r.aiDecision}:${r.aiLabel} → ${r.humanDecision}:${r.humanLabel}`;
    disagreeMap.set(key, (disagreeMap.get(key) ?? 0) + 1);
  }
  const topDisagreements = [...disagreeMap.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 12)
    .map(([pattern, count]) => ({ pattern, count, detail: '' }));

  // Zone type transitions
  const zoneTypeTransitions: Record<string, Record<string, number>> = {};
  for (const r of lineage) {
    if (!r.humanDecision) continue;
    const origType = r.doclingLabel || r.pdfxtLabel || 'unknown';
    if (!zoneTypeTransitions[origType]) zoneTypeTransitions[origType] = {};
    const finalLabel = r.humanDecision === 'REJECTED' ? 'REJECTED' : (r.humanLabel || r.finalLabel || 'unknown');
    zoneTypeTransitions[origType][finalLabel] = (zoneTypeTransitions[origType][finalLabel] ?? 0) + 1;
  }

  // Per-bucket stats
  const buckets = ['GREEN', 'AMBER', 'RED'];
  const perBucket: Record<string, { total: number; rejected: number; aiCoverage: number; headingCorrections: number }> = {};
  for (const b of buckets) {
    const inBucket = lineage.filter(r => r.reconciliationBucket === b);
    const rejected = inBucket.filter(r => r.humanDecision === 'REJECTED').length;
    const aiCov = inBucket.filter(r => r.aiDecision != null).length;
    const headingCorr = inBucket.filter(r => {
      if (!r.humanLabel || !r.aiLabel) return false;
      const hMatch = /^h([1-6])$/.exec(r.humanLabel);
      const aMatch = /^h([1-6])$/.exec(r.aiLabel);
      return hMatch && aMatch && hMatch[1] !== aMatch[1];
    }).length;
    perBucket[b] = { total: inBucket.length, rejected, aiCoverage: aiCov, headingCorrections: headingCorr };
  }

  return {
    aiCoverage: { withAi: withAi.length, withoutAi: lineage.length - withAi.length, model: [...models][0] ?? null },
    aiDecisionDist,
    confidenceDist,
    agreement: { sameDecisionAndLabel, sameDecisionDiffLabel, differentDecision },
    confidenceByAgreement: {
      agreed: {
        count: agreedConf.length,
        mean: agreedConf.length > 0 ? agreedConf.reduce((s, v) => s + v, 0) / agreedConf.length : 0,
        median: median(agreedConf),
      },
      overridden: {
        count: overriddenConf.length,
        mean: overriddenConf.length > 0 ? overriddenConf.reduce((s, v) => s + v, 0) / overriddenConf.length : 0,
        median: median(overriddenConf),
      },
    },
    topDisagreements,
    zoneTypeTransitions,
    perBucket,
  };
}

function buildCorrectionPatterns(log: CorrectionLogRow[]): Array<{ from: string; to: string; count: number }> {
  const map = new Map<string, number>();
  for (const c of log) {
    const key = `${c.fromLabel}→${c.toLabel ?? 'REJECTED'}`;
    map.set(key, (map.get(key) ?? 0) + 1);
  }
  return [...map.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, 10)
    .map(([k, count]) => {
      const [from, to] = k.split('→');
      return { from, to, count };
    });
}

function computeCost(
  aiRuns: Array<{ estimatedCostUsd: number }>,
  reportTokenUsage: { promptTokens: number; completionTokens: number },
  totalActiveMs: number,
): CostBreakdown {
  const aiAnnotationCostUsd = aiRuns.reduce((s, r) => s + (r.estimatedCostUsd ?? 0), 0);
  const aiReportCostUsd =
    (reportTokenUsage.promptTokens / 1_000_000) * HAIKU_INPUT_COST_PER_M +
    (reportTokenUsage.completionTokens / 1_000_000) * HAIKU_OUTPUT_COST_PER_M;
  const annotatorActiveHours = totalActiveMs / 3_600_000;
  const annotatorCostInr = annotatorActiveHours * ANNOTATOR_RATE_INR_PER_HOUR;
  const totalCostInr =
    aiAnnotationCostUsd * USD_TO_INR +
    aiReportCostUsd * USD_TO_INR +
    annotatorCostInr;

  return {
    aiAnnotationCostUsd: Math.round(aiAnnotationCostUsd * 10000) / 10000,
    aiReportCostUsd: Math.round(aiReportCostUsd * 10000) / 10000,
    annotatorActiveHours: Math.round(annotatorActiveHours * 100) / 100,
    annotatorCostInr: Math.round(annotatorCostInr * 100) / 100,
    totalCostInr: Math.round(totalCostInr * 100) / 100,
  };
}

// ── Prompt builder ──────────────────────────────────────────────────

function fmtPct(n: number, total: number): string {
  return total > 0 ? `${((n / total) * 100).toFixed(1)}%` : '—';
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const remSecs = secs % 60;
  if (mins < 60) return `${mins}m ${remSecs}s`;
  const hours = Math.floor(mins / 60);
  const remMins = mins % 60;
  return `${hours}h ${remMins}m`;
}

function buildPerTitlePrompt(
  annotationReport: AnnotationReport,
  timesheetReport: TimesheetReport,
  lineageAgg: LineageAggregates,
  correctionPatterns: Array<{ from: string; to: string; count: number }>,
  priorRuns: Array<{ documentName: string; pages: number; zones: number; throughput: number | null; correctionRate: number | null; agreementRate: number | null }>,
): string {
  const h = annotationReport.header;
  const s = annotationReport.summary;
  const q = annotationReport.qualityMetrics;
  const t = timesheetReport.timeSummary;
  const ops = timesheetReport.operatorBreakdown;
  const ztb = timesheetReport.zoneTypeBreakdown;
  const pages = timesheetReport.pageBreakdown;
  const eff = timesheetReport.efficiencyMetrics;
  const la = lineageAgg;

  // Page review mode distribution
  const deepPages = pages.filter(p => p.reviewMode === 'deep').length;
  const samplingPages = pages.filter(p => p.reviewMode === 'sampling').length;
  const unreviewedPages = pages.filter(p => p.reviewMode === 'unreviewed').length;
  const reviewedPages = pages.filter(p => p.zoneCount > 0);
  const fastestPage = reviewedPages.length > 0
    ? reviewedPages.reduce((a, b) => (a.zonesPerMin ?? 0) > (b.zonesPerMin ?? 0) ? a : b)
    : null;
  const slowestPage = reviewedPages.filter(p => (p.zonesPerMin ?? 0) > 0).length > 0
    ? reviewedPages.filter(p => (p.zonesPerMin ?? 0) > 0).reduce((a, b) => (a.zonesPerMin ?? 0) < (b.zonesPerMin ?? 0) ? a : b)
    : null;

  // Missing pages
  const allPageNumbers = pages.map(p => p.pageNumber);
  const maxPage = allPageNumbers.length > 0 ? Math.max(...allPageNumbers) : 0;
  const missingPages: number[] = [];
  for (let i = 1; i <= maxPage; i++) {
    if (!allPageNumbers.includes(i)) missingPages.push(i);
  }

  // Zone type transition summary for prompt
  const typeTransitionLines = Object.entries(la.zoneTypeTransitions)
    .sort(([, a], [, b]) => {
      const totalA = Object.values(a).reduce((s, v) => s + v, 0);
      const totalB = Object.values(b).reduce((s, v) => s + v, 0);
      return totalB - totalA;
    })
    .slice(0, 10)
    .map(([origType, finals]) => {
      const total = Object.values(finals).reduce((s, v) => s + v, 0);
      const topFinals = Object.entries(finals).sort(([, a], [, b]) => b - a).slice(0, 5)
        .map(([label, count]) => `${label}:${count}`).join(', ');
      return `  ${origType} (${total}): ${topFinals}`;
    }).join('\n');

  // Prior runs comparison
  const priorRunsBlock = priorRuns.length > 0
    ? `\n## Prior Completed Titles (for cross-document comparison)\n${priorRuns.map(r =>
        `- ${r.documentName}: ${r.pages}p, ${r.zones} zones, ${r.throughput?.toFixed(0) ?? '?'} zones/hr, correction rate ${r.correctionRate != null ? (r.correctionRate * 100).toFixed(1) + '%' : '?'}, agreement ${r.agreementRate != null ? (r.agreementRate * 100).toFixed(1) + '%' : '?'}`
      ).join('\n')}`
    : '';

  return `You are an expert data analyst producing an annotation analysis report for a PDF zone calibration run. Write a comprehensive markdown report with the sections listed below.

## Document Info
- Document: ${h.documentName}
- Calibration Run ID: ${h.calibrationRunId}
- Total Pages: ${h.totalPages}
- Pages with zones: ${allPageNumbers.length} of ${h.totalPages}
- Total Zones: ${s.totalZones}
- Zones per page (avg): ${allPageNumbers.length > 0 ? (s.totalZones / allPageNumbers.length).toFixed(1) : '—'}
- Missing pages (no zones): ${missingPages.length > 0 ? missingPages.slice(0, 15).join(', ') + (missingPages.length > 15 ? '...' : '') : 'none'}
- Annotators: ${h.annotators.join(', ')}

## Annotation Summary
- Confirmed: ${s.confirmed} (${fmtPct(s.confirmed, s.totalZones)})
- Corrected: ${s.corrected} (${fmtPct(s.corrected, s.totalZones)})
- Rejected: ${s.rejected} (${fmtPct(s.rejected, s.totalZones)})
- Unreviewed: ${s.unreviewed}
- Auto-annotated: ${s.autoAnnotated}

## Bucket Distribution
- GREEN: ${s.greenCount} (${fmtPct(s.greenCount, s.totalZones)})
- AMBER: ${s.amberCount} (${fmtPct(s.amberCount, s.totalZones)})
- RED: ${s.redCount} (${fmtPct(s.redCount, s.totalZones)})

## Operator Throughput
${ops.map(o => `- ${o.operatorId}: ${o.zonesReviewed} zones reviewed, ${fmtMs(o.activeMs)} active, ${o.zonesPerHour?.toFixed(1) ?? '—'} zones/hr, confirm ${o.confirmPct != null ? (o.confirmPct * 100).toFixed(1) + '%' : '—'}, correct ${o.correctPct != null ? (o.correctPct * 100).toFixed(1) + '%' : '—'}, reject ${o.rejectPct != null ? (o.rejectPct * 100).toFixed(1) + '%' : '—'}`).join('\n')}

## Time Summary
- Wall-clock: ${fmtMs(t.totalWallClockMs)}, Active: ${fmtMs(t.totalActiveMs)}, Idle: ${fmtMs(t.totalIdleMs)}
- Zones/hr: ${t.zonesPerHour?.toFixed(1) ?? '—'}, Avg secs/zone: ${t.avgSecsPerZone?.toFixed(1) ?? '—'}, Pages/hr: ${t.pagesPerHour?.toFixed(1) ?? '—'}
- Page review modes: deep=${deepPages}, sampling=${samplingPages}, unreviewed=${unreviewedPages}
${fastestPage ? `- Fastest page: p${fastestPage.pageNumber} (${fastestPage.zonesPerMin?.toFixed(1)} zones/min)` : ''}
${slowestPage ? `- Slowest page: p${slowestPage.pageNumber} (${slowestPage.zonesPerMin?.toFixed(1)} zones/min)` : ''}

## AI Annotation Coverage
- Zones with AI annotation: ${la.aiCoverage.withAi} (${fmtPct(la.aiCoverage.withAi, s.totalZones)})
- Zones without AI: ${la.aiCoverage.withoutAi} (${fmtPct(la.aiCoverage.withoutAi, s.totalZones)})
- AI model: ${la.aiCoverage.model ?? 'none'}
- AI decisions: CONFIRMED=${la.aiDecisionDist.confirmed}, CORRECTED=${la.aiDecisionDist.corrected}, REJECTED=${la.aiDecisionDist.rejected}

## AI Confidence Distribution
${la.confidenceDist.map(d => `  ${d.confidence}: ${d.count} zones`).join('\n')}

## AI vs Human Agreement (${la.agreement.sameDecisionAndLabel + la.agreement.sameDecisionDiffLabel + la.agreement.differentDecision} zones with both)
- Same decision AND label: ${la.agreement.sameDecisionAndLabel} (${fmtPct(la.agreement.sameDecisionAndLabel, la.agreement.sameDecisionAndLabel + la.agreement.sameDecisionDiffLabel + la.agreement.differentDecision)})
- Same decision, different label: ${la.agreement.sameDecisionDiffLabel} (${fmtPct(la.agreement.sameDecisionDiffLabel, la.agreement.sameDecisionAndLabel + la.agreement.sameDecisionDiffLabel + la.agreement.differentDecision)})
- Different decision: ${la.agreement.differentDecision} (${fmtPct(la.agreement.differentDecision, la.agreement.sameDecisionAndLabel + la.agreement.sameDecisionDiffLabel + la.agreement.differentDecision)})

## AI Confidence by Agreement
- Agreed zones: n=${la.confidenceByAgreement.agreed.count}, mean=${la.confidenceByAgreement.agreed.mean.toFixed(2)}, median=${la.confidenceByAgreement.agreed.median.toFixed(2)}
- Overridden zones: n=${la.confidenceByAgreement.overridden.count}, mean=${la.confidenceByAgreement.overridden.mean.toFixed(2)}, median=${la.confidenceByAgreement.overridden.median.toFixed(2)}

## Top Disagreement Patterns
${la.topDisagreements.map(d => `  ${d.pattern}: ${d.count}`).join('\n')}

## Top Correction Patterns (from corrections log)
${correctionPatterns.map(c => `  ${c.from} → ${c.to}: ${c.count}`).join('\n')}

## Zone Type Transitions (original extractor type → final labels)
${typeTransitionLines}

## Per-Bucket Stats
${Object.entries(la.perBucket).map(([b, s]) =>
  `- ${b}: ${s.total} zones, ${s.rejected} rejected (${fmtPct(s.rejected, s.total)}), AI coverage ${fmtPct(s.aiCoverage, s.total)}, heading corrections: ${s.headingCorrections}`
).join('\n')}

## Quality Metrics
- Extractor agreement rate: ${q.extractorAgreementRate != null ? (q.extractorAgreementRate * 100).toFixed(1) + '%' : '—'}
- Auto-annotation coverage: ${q.autoAnnotationCoverage != null ? (q.autoAnnotationCoverage * 100).toFixed(1) + '%' : '—'}
- Correction rate: ${q.correctionRate != null ? (q.correctionRate * 100).toFixed(1) + '%' : '—'}
- Rejection rate: ${q.rejectionRate != null ? (q.rejectionRate * 100).toFixed(1) + '%' : '—'}
- Pages with zero corrections: ${q.pagesWithZeroCorrections}
${q.mostCorrectedPage ? `- Most corrected page: p${q.mostCorrectedPage.page} (${q.mostCorrectedPage.corrections} corrections)` : ''}

## Zone Type Correction Rates
${ztb.map(z => `  ${z.zoneType}: ${z.total} total, confirm ${z.confirmPct != null ? (z.confirmPct * 100).toFixed(1) + '%' : '—'}, correct ${z.correctPct != null ? (z.correctPct * 100).toFixed(1) + '%' : '—'}, reject ${z.rejectPct != null ? (z.rejectPct * 100).toFixed(1) + '%' : '—'}`).join('\n')}

## Efficiency
- Auto-annotation savings: ${fmtMs(eff.autoAnnotationSavingsMs)}
- Review queue reduction: ${eff.reviewQueueReductionPct != null ? (eff.reviewQueueReductionPct * 100).toFixed(1) + '%' : '—'}
- Estimated cost: ${eff.estimatedCost != null ? '$' + eff.estimatedCost.toFixed(2) : '—'}
- Complexity score: ${eff.complexityScore?.toFixed(2) ?? '—'}
${priorRunsBlock}

## TASK

Write a comprehensive **Timesheet & Lineage Analysis** report in markdown. Use the format and depth matching this structure:

1. **Document Overview** — key metrics table, missing pages, heaviest pages, bucket distribution
2. **Operator Throughput** — table with all operators. If session-tracked zones differ from lineage total, explain the gap and what it means. Note operators with zero zones (exploratory sessions).
3. **AI Annotation Coverage** — AI decision distribution, confidence distribution table, validate RED bucket cap
4. **AI vs Human Agreement** — agreement matrix, confidence-by-agreement analysis. Flag if overridden zones have equal or higher confidence than agreed zones. List top disagreement patterns with counts and interpretation.
5. **Heading Off-By-1 Analysis** — if section-header zones were frequently relabelled to h2/h3/h4, quantify the off-by-1 pattern and note if it's systematic
6. **Zone Type Analysis** — original extractor type vs final labels. Note stable types (high confirm%), volatile types, and under-detected types
7. **Reconciliation Bucket Validation** — per-bucket rejection rates. Validate whether rejections concentrate in RED.
8. **Comparison with Prior Titles** — if prior runs are provided, compare key metrics in a table. Note notable differences in throughput, correction rates, AI agreement.
9. **Recommendations** — Immediate (3), Medium-term (2-3), Exploratory (1-2). Be specific and reference the data.
10. **Data Quality Summary** — table: Signal | Quality | Notes

Use specific numbers from the data. Use markdown headers (##), bullet points, bold (**text**), and tables (|col|col|). Write the report as if addressed to a project lead overseeing annotation quality. Keep the report thorough but under 2000 words.`;
}

function buildCorpusSummaryPrompt(
  runSummaries: Array<{
    documentName: string;
    runId: string;
    pages: number;
    zones: number;
    annotators: string[];
    confirmed: number;
    corrected: number;
    rejected: number;
    throughput: number | null;
    correctionRate: number | null;
    agreementRate: number | null;
    aiAgreementRate: number | null;
    costBreakdown: CostBreakdown;
  }>,
): string {
  const totalZones = runSummaries.reduce((s, r) => s + r.zones, 0);
  const totalPages = runSummaries.reduce((s, r) => s + r.pages, 0);

  return `You are an expert data analyst producing a cross-title corpus summary report. Write a markdown report synthesising the annotation results across all completed titles.

## Corpus Overview
- Total documents: ${runSummaries.length}
- Total pages: ${totalPages}
- Total zones: ${totalZones}

## Per-Title Metrics
${runSummaries.map(r => `- ${r.documentName}: ${r.pages}p, ${r.zones} zones, annotators: ${r.annotators.join(', ')}, throughput: ${r.throughput?.toFixed(0) ?? '?'} zones/hr, correction rate: ${r.correctionRate != null ? (r.correctionRate * 100).toFixed(1) + '%' : '?'}, AI agreement: ${r.aiAgreementRate != null ? (r.aiAgreementRate * 100).toFixed(1) + '%' : '?'}, confirmed: ${r.confirmed}, corrected: ${r.corrected}, rejected: ${r.rejected}`).join('\n')}

## Per-Title Cost (INR)
${runSummaries.map(r => `- ${r.documentName}: AI annotation ₹${(r.costBreakdown.aiAnnotationCostUsd * USD_TO_INR).toFixed(2)}, AI report ₹${(r.costBreakdown.aiReportCostUsd * USD_TO_INR).toFixed(2)}, Annotator ₹${r.costBreakdown.annotatorCostInr.toFixed(2)} (${r.costBreakdown.annotatorActiveHours.toFixed(2)}h @ ₹400/hr), Total ₹${r.costBreakdown.totalCostInr.toFixed(2)}`).join('\n')}

## TASK

Write a **Corpus Summary Analysis** report in markdown:

1. **Executive Summary** — 3-4 sentences covering overall annotation quality, total cost, and key cross-document finding
2. **Cross-Title Comparison** — table comparing all titles on: pages, zones, throughput, correction rate, AI agreement rate
3. **Systematic Patterns** — patterns that repeat across titles (e.g., heading off-by-1, header/footer rejections). Are they annotator-specific or document-structural?
4. **Cost Analysis** — total cost breakdown with per-title table. Cost per zone. Cost per page. Which cost component dominates?
5. **Corpus Quality Assessment** — overall reliability of the corpus as training data. Flag any titles that may need re-review.
6. **Recommendations** — 3-4 actionable suggestions for the next batch of annotations

Use specific numbers. Keep under 1500 words.`;
}

// ── Public API ──────────────────────────────────────────────────────

export async function generateAnnotationAnalysis(runId: string): Promise<PerTitleAnalysisResult> {
  // 1. Fetch report data and AI run cost data in parallel
  const [annotationReport, timesheetReport, aiRuns] = await Promise.all([
    annotationReportService.getAnnotationReport(runId),
    annotationTimesheetService.getTimesheetReport(runId),
    prisma.aiAnnotationRun.findMany({
      where: { calibrationRunId: runId, status: 'COMPLETED' },
      select: { estimatedCostUsd: true },
    }),
  ]);

  if (!annotationReport || !timesheetReport) {
    throw new Error(`Report data not available for run ${runId}`);
  }

  // 2. Build server-side aggregates from lineage data
  const lineageAgg = buildLineageAggregates(annotationReport.lineageDetails);
  const correctionPatterns = buildCorrectionPatterns(annotationReport.correctionsLog);

  // 3. Fetch prior completed runs for cross-document comparison
  const priorRuns = await prisma.calibrationRun.findMany({
    where: {
      id: { not: runId },
      completedAt: { not: null },
      summary: { not: undefined },
    },
    select: {
      id: true,
      summary: true,
      corpusDocument: { select: { filename: true, pageCount: true } },
      zones: { select: { decision: true }, where: { decision: { not: null } } },
    },
    orderBy: { completedAt: 'desc' },
    take: 10,
  });

  const priorRunSummaries = priorRuns
    .filter(r => {
      const sum = r.summary as Record<string, unknown> | null;
      return sum?.analysisReports != null;
    })
    .map(r => {
      const zones = r.zones;
      const confirmed = zones.filter(z => z.decision === 'CONFIRMED').length;
      const corrected = zones.filter(z => z.decision === 'CORRECTED').length;
      const rejected = zones.filter(z => z.decision === 'REJECTED').length;
      const totalDecided = confirmed + corrected + rejected;
      return {
        documentName: r.corpusDocument.filename,
        pages: r.corpusDocument.pageCount ?? 0,
        zones: totalDecided,
        throughput: null as number | null,
        correctionRate: totalDecided > 0 ? corrected / totalDecided : null,
        agreementRate: totalDecided > 0 ? confirmed / totalDecided : null,
      };
    });

  // 4. Build prompt and call Claude Haiku
  const prompt = buildPerTitlePrompt(annotationReport, timesheetReport, lineageAgg, correctionPatterns, priorRunSummaries);

  logger.info(`[annotation-analysis] Generating per-title report for run ${runId} (prompt ~${prompt.length} chars)`);

  const response = await claudeService.generate(prompt, {
    model: 'haiku',
    temperature: 0.3,
    maxTokens: 8192,
    systemPrompt: 'You are an expert data analyst for the Ninja PDF Accessibility Platform. Write clear, detailed markdown reports with specific numbers, tables, and actionable insights. Use markdown headers (##), bold (**text**), bullet points, and pipe tables (|col|col|).',
  });

  const tokenUsage = {
    promptTokens: response.usage?.promptTokens ?? 0,
    completionTokens: response.usage?.completionTokens ?? 0,
  };

  // 5. Compute cost breakdown
  const costBreakdown = computeCost(aiRuns, tokenUsage, timesheetReport.timeSummary.totalActiveMs);

  // 6. Build result
  const report: AnalysisReport = {
    markdown: response.text,
    generatedAt: new Date().toISOString(),
    model: 'claude-haiku-4.5',
    tokenUsage,
  };

  // 7. Persist in CalibrationRun.summary
  const existingSummary = await prisma.calibrationRun.findUnique({
    where: { id: runId },
    select: { summary: true },
  });

  const mergedSummary = {
    ...((existingSummary?.summary as Record<string, unknown>) ?? {}),
    analysisReports: { report, costBreakdown },
  };

  await prisma.calibrationRun.update({
    where: { id: runId },
    data: {
      completedAt: new Date(),
      summary: mergedSummary as unknown as Prisma.InputJsonValue,
    },
  });

  logger.info(
    `[annotation-analysis] Report generated for ${runId}: ${tokenUsage.promptTokens}+${tokenUsage.completionTokens} tokens, ` +
    `cost: AI annotation $${costBreakdown.aiAnnotationCostUsd}, annotator ₹${costBreakdown.annotatorCostInr}`,
  );

  return { report, costBreakdown };
}

export async function getStoredAnalysis(runId: string): Promise<PerTitleAnalysisResult | null> {
  const run = await prisma.calibrationRun.findUnique({
    where: { id: runId },
    select: { summary: true },
  });

  if (!run?.summary) return null;

  const summary = run.summary as Record<string, unknown>;
  const analysisReports = summary.analysisReports as { report: AnalysisReport; costBreakdown: CostBreakdown } | undefined;

  if (!analysisReports?.report) return null;

  return {
    report: analysisReports.report,
    costBreakdown: analysisReports.costBreakdown,
  };
}

export async function generateCorpusSummary(): Promise<CorpusSummaryResult> {
  // 1. Fetch all completed runs with stored analysis
  const completedRuns = await prisma.calibrationRun.findMany({
    where: { completedAt: { not: null } },
    select: {
      id: true,
      summary: true,
      corpusDocument: { select: { filename: true, pageCount: true } },
      zones: { select: { decision: true }, where: { decision: { not: null } } },
      annotationSessions: { select: { activeMs: true, operatorId: true, zonesReviewed: true } },
      aiAnnotationRuns: { where: { status: 'COMPLETED' }, select: { estimatedCostUsd: true } },
    },
    orderBy: { completedAt: 'asc' },
  });

  // Filter to runs that have at least one reviewed zone
  const analyzedRuns = completedRuns.filter(run => run.zones.length > 0);

  if (analyzedRuns.length === 0) {
    throw new Error('No completed annotation runs with reviewed zones found');
  }

  // 2. Build per-title summaries
  const runSummaries = analyzedRuns.map(run => {
    const sum = (run.summary as Record<string, unknown>) ?? {};
    const analysisReports = sum.analysisReports as { report: AnalysisReport; costBreakdown: CostBreakdown } | undefined;
    const zones = run.zones;
    const confirmed = zones.filter(z => z.decision === 'CONFIRMED').length;
    const corrected = zones.filter(z => z.decision === 'CORRECTED').length;
    const rejected = zones.filter(z => z.decision === 'REJECTED').length;
    const totalDecided = confirmed + corrected + rejected;
    const totalActiveMs = run.annotationSessions.reduce((s, sess) => s + sess.activeMs, 0);
    const totalHours = totalActiveMs / 3_600_000;
    const operatorIds = [...new Set(run.annotationSessions.map(s => s.operatorId))];
    const aiCostUsd = run.aiAnnotationRuns.reduce((s, r) => s + (r.estimatedCostUsd ?? 0), 0);

    const costBreakdown: CostBreakdown = analysisReports?.costBreakdown ?? {
      aiAnnotationCostUsd: aiCostUsd,
      aiReportCostUsd: 0,
      annotatorActiveHours: totalHours,
      annotatorCostInr: totalHours * ANNOTATOR_RATE_INR_PER_HOUR,
      totalCostInr: aiCostUsd * USD_TO_INR + totalHours * ANNOTATOR_RATE_INR_PER_HOUR,
    };

    return {
      documentName: run.corpusDocument.filename,
      runId: run.id,
      pages: run.corpusDocument.pageCount ?? 0,
      zones: zones.length,
      annotators: operatorIds,
      confirmed,
      corrected,
      rejected,
      throughput: totalHours > 0 ? totalDecided / totalHours : null,
      correctionRate: totalDecided > 0 ? corrected / totalDecided : null,
      agreementRate: (sum.agreementRate as number | undefined) ?? null,
      aiAgreementRate: null as number | null,
      costBreakdown,
    };
  });

  // 3. Generate summary report via Claude Haiku
  const prompt = buildCorpusSummaryPrompt(runSummaries);

  logger.info(`[annotation-analysis] Generating corpus summary (${runSummaries.length} titles)`);

  const response = await claudeService.generate(prompt, {
    model: 'haiku',
    temperature: 0.3,
    maxTokens: 6144,
    systemPrompt: 'You are an expert data analyst for the Ninja PDF Accessibility Platform. Write clear, detailed markdown reports with specific numbers, tables, and actionable insights.',
  });

  const tokenUsage = {
    promptTokens: response.usage?.promptTokens ?? 0,
    completionTokens: response.usage?.completionTokens ?? 0,
  };

  // 4. Build cost summary
  const costTitles = runSummaries.map(r => ({
    documentName: r.documentName,
    runId: r.runId,
    pages: r.pages,
    zones: r.zones,
    aiAnnotationCostInr: r.costBreakdown.aiAnnotationCostUsd * USD_TO_INR,
    aiReportCostInr: r.costBreakdown.aiReportCostUsd * USD_TO_INR,
    annotatorCostInr: r.costBreakdown.annotatorCostInr,
    totalCostInr: r.costBreakdown.totalCostInr,
  }));

  const totals = {
    documents: runSummaries.length,
    pages: runSummaries.reduce((s, r) => s + r.pages, 0),
    zones: runSummaries.reduce((s, r) => s + r.zones, 0),
    aiAnnotationCostInr: costTitles.reduce((s, r) => s + r.aiAnnotationCostInr, 0),
    aiReportCostInr: costTitles.reduce((s, r) => s + r.aiReportCostInr, 0),
    annotatorCostInr: costTitles.reduce((s, r) => s + r.annotatorCostInr, 0),
    totalCostInr: costTitles.reduce((s, r) => s + r.totalCostInr, 0),
  };

  return {
    summaryReport: {
      markdown: response.text,
      generatedAt: new Date().toISOString(),
      model: 'claude-haiku-4.5',
      tokenUsage,
    },
    costSummary: { titles: costTitles, totals },
  };
}
