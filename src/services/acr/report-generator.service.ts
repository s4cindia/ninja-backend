/**
 * ACR Analysis Report Generator Service
 *
 * Generates a comprehensive AI Analysis Report for a given job, combining:
 *  - ACR conformance criterion data (confidence, status, WCAG level)
 *  - Remediation explainability (why each fix type, what was changed)
 *  - Before/after diffs from RemediationChange records
 *  - Optional Gemini-generated AI insights (when tenant uses gemini/hybrid source)
 *
 * Results are cached in Redis for 1 hour (TTL: REPORT_CACHE_TTL_S).
 */

import prisma from '../../lib/prisma';
import { getRedisClient, isRedisConfigured } from '../../lib/redis';
import { logger } from '../../lib/logger';
import {
  explanationCatalogService,
  ExplanationSource,
  IssueExplanation,
} from './explanation-catalog.service';
import { geminiService } from '../ai/gemini.service';

const REPORT_CACHE_TTL_S = 3600; // 1 hour
const REPORT_CACHE_PREFIX = 'report:analysis:';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RemediationDiff {
  before: string;
  after: string;
  filePath: string;
  changeType: string;
}

export interface ExplainedAutoFixedItem {
  ruleId: string;
  description: string;
  wcagCriteria?: string;
  explanation: IssueExplanation;
  diff: RemediationDiff | null;
}

export interface ExplainedIssueItem {
  ruleId: string;
  description: string;
  wcagCriteria?: string;
  explanation: IssueExplanation;
}

export interface RemediationExplainability {
  autoFixed: ExplainedAutoFixedItem[];
  quickFixes: ExplainedIssueItem[];
  manualRequired: ExplainedIssueItem[];
}

export interface CriterionSummary {
  criterionId: string;
  criterionNumber: string;
  criterionName: string;
  level: string;
  confidence: number;
  aiStatus: string;
  conformanceLevel?: string;
  isNotApplicable: boolean;
}

export interface ReportStatistics {
  totalCriteria: number;
  automatedPassed: number;
  manualRequired: number;
  notApplicable: number;
  overallConfidence: number;
  highConfidenceCount: number;
  mediumConfidenceCount: number;
  lowConfidenceCount: number;
  autoFixed: number;
  quickFix: number;
  manual: number;
  byWcagLevel: {
    A: { total: number; passed: number; manual: number; na: number };
    AA: { total: number; passed: number; manual: number; na: number };
    AAA: { total: number; passed: number; manual: number; na: number };
  };
}

export interface AiInsights {
  generatedAt: string;
  model: string;
  topPriorities: string[];
  riskAssessment: string;
  specificRecommendations: string[];
}

export interface KeyFinding {
  type: 'success' | 'warning' | 'info';
  text: string;
}

export interface ExecutiveSummary {
  overallConfidence: number;
  totalCriteria: number;
  automatedPassed: number;
  manualRequired: number;
  notApplicable: number;
  keyFindings: KeyFinding[];
  criticalActions: string[];
}

export interface ACRAnalysisReport {
  metadata: {
    jobId: string;
    acrJobId: string;
    contentTitle: string;
    analysisDate: string;
    reportVersion: string;
    explanationSource: ExplanationSource;
  };
  executiveSummary: ExecutiveSummary;
  remediationExplainability: RemediationExplainability;
  aiInsights?: AiInsights;
  statistics: ReportStatistics;
  categorizedCriteria: {
    manualRequired: CriterionSummary[];
    needsReviewHigh: CriterionSummary[];
    needsReviewMedium: CriterionSummary[];
    passed: CriterionSummary[];
    notApplicable: CriterionSummary[];
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PDF_CODE_PREFIXES = ['MATTERHORN-', 'PDF-', 'WCAG-'];

function isPdfCode(code: string): boolean {
  return PDF_CODE_PREFIXES.some(p => code.toUpperCase().startsWith(p));
}

function buildGeminiGenerateFn(source: ExplanationSource) {
  if (source === 'hardcoded') return undefined;

  return async (code: string, fixType: 'auto' | 'quickfix' | 'manual'): Promise<Partial<IssueExplanation>> => {
    const fixLabel = fixType === 'auto' ? 'automatically fixable' : fixType === 'quickfix' ? 'a guided quick-fix' : 'a manual fix';
    const prompt = `You are an EPUB/PDF accessibility expert. Briefly explain why issue code "${code}" is classified as "${fixLabel}". Reply in JSON: { "reason": "...", "whatPlatformDid": null or "...", "whatUserMustDo": null or "...", "wcagGuidance": "...", "estimatedTime": null or "..." }. Be concise (1–2 sentences per field).`;
    try {
      const response = await geminiService.generateText(prompt, { model: 'flash', temperature: 0.2, maxOutputTokens: 300 });
      const match = response.text.match(/\{[\s\S]*\}/);
      if (match) return JSON.parse(match[0]) as Partial<IssueExplanation>;
    } catch {
      // Silently fall through to catalog fallback
    }
    return {};
  };
}

function computeStatistics(
  criteria: CriterionSummary[],
  fixCounts: { autoFixed: number; quickFix: number; manual: number }
): ReportStatistics {
  const total = criteria.length;
  const na = criteria.filter(c => c.isNotApplicable).length;
  const active = criteria.filter(c => !c.isNotApplicable);

  const manualCriteria = active.filter(c => c.aiStatus === 'manual' || c.confidence === 0).length;
  const passed = active.filter(c => c.conformanceLevel === 'Supports' || c.aiStatus === 'pass').length;

  const confidenceValues = active.map(c => c.confidence);
  const avgConfidence = confidenceValues.length > 0
    ? Math.round(confidenceValues.reduce((a, b) => a + b, 0) / confidenceValues.length)
    : 0;

  const high = active.filter(c => c.confidence >= 80).length;
  const medium = active.filter(c => c.confidence >= 60 && c.confidence < 80).length;
  const low = active.filter(c => c.confidence < 60).length;

  const byLevel = { A: { total: 0, passed: 0, manual: 0, na: 0 }, AA: { total: 0, passed: 0, manual: 0, na: 0 }, AAA: { total: 0, passed: 0, manual: 0, na: 0 } };
  for (const c of criteria) {
    const lvl = (c.level?.toUpperCase() ?? 'A') as 'A' | 'AA' | 'AAA';
    if (!byLevel[lvl]) continue;
    byLevel[lvl].total++;
    if (c.isNotApplicable) { byLevel[lvl].na++; continue; }
    if (c.aiStatus === 'manual' || c.confidence === 0) byLevel[lvl].manual++;
    else if (c.conformanceLevel === 'Supports' || c.aiStatus === 'pass') byLevel[lvl].passed++;
  }

  return {
    totalCriteria: total,
    automatedPassed: passed,
    manualRequired: manualCriteria,
    notApplicable: na,
    overallConfidence: avgConfidence,
    highConfidenceCount: high,
    mediumConfidenceCount: medium,
    lowConfidenceCount: low,
    autoFixed: fixCounts.autoFixed,
    quickFix: fixCounts.quickFix,
    manual: fixCounts.manual,
    byWcagLevel: byLevel,
  };
}

function buildExecutiveSummary(stats: ReportStatistics, criteria: CriterionSummary[]): ExecutiveSummary {
  const keyFindings: KeyFinding[] = [];

  if (stats.automatedPassed > 0) {
    keyFindings.push({ type: 'success', text: `${stats.automatedPassed} of ${stats.totalCriteria} criteria passed automated verification` });
  }
  if (stats.manualRequired > 0) {
    keyFindings.push({ type: 'warning', text: `${stats.manualRequired} criteria require manual testing before a conformance claim can be made` });
  }
  if (stats.notApplicable > 0) {
    keyFindings.push({ type: 'info', text: `${stats.notApplicable} criteria are not applicable to this content type` });
  }
  if (stats.overallConfidence >= 80) {
    keyFindings.push({ type: 'success', text: `High automated confidence (${stats.overallConfidence}%) — most verifiable criteria passed` });
  } else if (stats.overallConfidence >= 60) {
    keyFindings.push({ type: 'warning', text: `Moderate automated confidence (${stats.overallConfidence}%) — several criteria need review` });
  }

  const criticalActions = criteria
    .filter(c => !c.isNotApplicable && (c.aiStatus === 'manual' || c.confidence === 0))
    .slice(0, 7)
    .map(c => `${c.criterionNumber} ${c.criterionName} (Level ${c.level})`);

  return {
    overallConfidence: stats.overallConfidence,
    totalCriteria: stats.totalCriteria,
    automatedPassed: stats.automatedPassed,
    manualRequired: stats.manualRequired,
    notApplicable: stats.notApplicable,
    keyFindings,
    criticalActions,
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class ACRReportGeneratorService {
  async generateAnalysisReport(jobId: string, tenantId: string): Promise<ACRAnalysisReport> {
    const cacheKey = `${REPORT_CACHE_PREFIX}${jobId}`;

    // 1. Cache check
    if (isRedisConfigured()) {
      try {
        const cached = await getRedisClient().get(cacheKey);
        if (cached) {
          logger.debug(`[ReportGenerator] Cache hit for job ${jobId}`);
          return JSON.parse(cached) as ACRAnalysisReport;
        }
      } catch (err) {
        logger.warn(`[ReportGenerator] Redis cache read failed: ${err}`);
      }
    }

    // 2. Fetch ACR job and criteria
    const acrJob = await prisma.acrJob.findFirst({
      where: {
        OR: [
          { id: jobId, tenantId },
          { jobId, tenantId },
        ],
      },
      include: { criteria: true },
      orderBy: { createdAt: 'desc' },
    });

    if (!acrJob) {
      throw Object.assign(new Error('ACR job not found for this job'), { statusCode: 404 });
    }

    // 3. Fetch tenant explanation source
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { settings: true },
    });
    const settings = (tenant?.settings && typeof tenant.settings === 'object')
      ? (tenant.settings as Record<string, unknown>) : {};
    const reports = (settings.reports && typeof settings.reports === 'object')
      ? (settings.reports as Record<string, unknown>) : {};
    const source: ExplanationSource = (reports.explanationSource as ExplanationSource) ?? 'hardcoded';

    // 4. Fetch remediation changes for auto-fix diffs
    const remediationChanges = await prisma.remediationChange.findMany({
      where: { jobId, status: 'APPLIED' },
      select: { ruleId: true, description: true, beforeContent: true, afterContent: true, filePath: true, changeType: true, wcagCriteria: true },
    });

    // 5. Build criteria summaries
    const criteriaSummaries: CriterionSummary[] = acrJob.criteria.map(c => ({
      criterionId: c.id,
      criterionNumber: c.criterionNumber,
      criterionName: c.criterionName,
      level: c.level,
      confidence: c.confidence,
      aiStatus: c.aiStatus,
      conformanceLevel: c.conformanceLevel ?? undefined,
      isNotApplicable: c.isNotApplicable,
    }));

    // 6. Build explainability data
    const geminiGenerateFn = buildGeminiGenerateFn(source);

    // Auto-fixed items (from RemediationChange)
    const autoFixedItems: ExplainedAutoFixedItem[] = [];
    const seenAutoRules = new Set<string>();
    for (const change of remediationChanges) {
      if (!change.ruleId || seenAutoRules.has(change.ruleId)) continue;
      seenAutoRules.add(change.ruleId);
      const explanation = await explanationCatalogService.getExplanation(
        change.ruleId, source, isPdfCode(change.ruleId), geminiGenerateFn
      );
      autoFixedItems.push({
        ruleId: change.ruleId,
        description: change.description,
        wcagCriteria: change.wcagCriteria ?? undefined,
        explanation,
        diff: (change.beforeContent && change.afterContent)
          ? { before: change.beforeContent, after: change.afterContent, filePath: change.filePath, changeType: change.changeType }
          : null,
      });
    }

    // Manual/quick-fix items (from criteria where confidence < 60 or aiStatus=manual)
    const quickFixItems: ExplainedIssueItem[] = [];
    const manualItems: ExplainedIssueItem[] = [];
    const processedCriteria = new Set<string>();

    for (const c of criteriaSummaries) {
      if (c.isNotApplicable || processedCriteria.has(c.criterionNumber)) continue;
      processedCriteria.add(c.criterionNumber);

      if (c.aiStatus !== 'manual' && c.confidence >= 60) continue;

      const issueCode = c.criterionNumber; // e.g. "1.1.1"
      const explanation = await explanationCatalogService.getExplanation(
        issueCode, source, false, geminiGenerateFn
      );

      const item: ExplainedIssueItem = {
        ruleId: c.criterionNumber,
        description: c.criterionName,
        explanation,
      };

      if (explanation.fixType === 'quickfix') {
        quickFixItems.push(item);
      } else {
        manualItems.push(item);
      }
    }

    // 7. Statistics & executive summary
    const stats = computeStatistics(criteriaSummaries, {
      autoFixed: autoFixedItems.length,
      quickFix: quickFixItems.length,
      manual: manualItems.length,
    });
    const executiveSummary = buildExecutiveSummary(stats, criteriaSummaries);

    // 8. Categorized criteria
    const categorizedCriteria = {
      manualRequired: criteriaSummaries.filter(c => !c.isNotApplicable && (c.aiStatus === 'manual' || c.confidence === 0)),
      needsReviewHigh: criteriaSummaries.filter(c => !c.isNotApplicable && c.confidence >= 70 && c.aiStatus !== 'manual' && c.confidence < 95),
      needsReviewMedium: criteriaSummaries.filter(c => !c.isNotApplicable && c.confidence >= 40 && c.confidence < 70),
      passed: criteriaSummaries.filter(c => !c.isNotApplicable && c.confidence >= 95),
      notApplicable: criteriaSummaries.filter(c => c.isNotApplicable),
    };

    // 9. AI insights (only when source !== hardcoded)
    let aiInsights: AiInsights | undefined;
    if (source !== 'hardcoded' && stats.manualRequired > 0) {
      try {
        const criteriaList = categorizedCriteria.manualRequired.slice(0, 7)
          .map(c => `${c.criterionNumber} ${c.criterionName}`).join(', ');
        const prompt = `You are an EPUB/PDF accessibility expert. A document has been analyzed. ${stats.manualRequired} criteria require manual testing: ${criteriaList}. Overall automated confidence: ${stats.overallConfidence}%. Provide JSON with: "topPriorities" (array of 3 strings), "riskAssessment" (1 sentence), "specificRecommendations" (array of 3 strings). Be practical and concise.`;
        const response = await geminiService.generateText(prompt, { model: 'flash', temperature: 0.3, maxOutputTokens: 500 });
        const match = response.text.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          aiInsights = {
            generatedAt: new Date().toISOString(),
            model: 'gemini-flash',
            topPriorities: parsed.topPriorities ?? [],
            riskAssessment: parsed.riskAssessment ?? '',
            specificRecommendations: parsed.specificRecommendations ?? [],
          };
        }
      } catch (err) {
        logger.warn(`[ReportGenerator] AI insights generation failed: ${err}`);
      }
    }

    // 10. Assemble report
    const report: ACRAnalysisReport = {
      metadata: {
        jobId,
        acrJobId: acrJob.id,
        contentTitle: acrJob.documentTitle ?? 'Untitled Document',
        analysisDate: new Date().toISOString(),
        reportVersion: '1.0',
        explanationSource: source,
      },
      executiveSummary,
      remediationExplainability: {
        autoFixed: autoFixedItems,
        quickFixes: quickFixItems,
        manualRequired: manualItems,
      },
      aiInsights,
      statistics: stats,
      categorizedCriteria,
    };

    // 11. Cache
    if (isRedisConfigured()) {
      try {
        await getRedisClient().set(cacheKey, JSON.stringify(report), 'EX', REPORT_CACHE_TTL_S);
      } catch (err) {
        logger.warn(`[ReportGenerator] Redis cache write failed: ${err}`);
      }
    }

    return report;
  }

  async invalidateCache(jobId: string): Promise<void> {
    if (!isRedisConfigured()) return;
    try {
      await getRedisClient().del(`${REPORT_CACHE_PREFIX}${jobId}`);
    } catch {
      // Non-critical
    }
  }
}

export const reportGeneratorService = new ACRReportGeneratorService();
