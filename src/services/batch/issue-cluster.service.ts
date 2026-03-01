import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

/** Map from HITL gate slug (URL) to the WorkflowInstance.currentState value */
const GATE_SLUG_TO_STATE: Record<string, string> = {
  'ai-review': 'AWAITING_AI_REVIEW',
  'remediation-review': 'AWAITING_REMEDIATION_REVIEW',
  'conformance-review': 'AWAITING_CONFORMANCE_REVIEW',
  'acr-signoff': 'AWAITING_ACR_SIGNOFF',
};

// ─── AI-review types ─────────────────────────────────────────────────────────

interface RawIssue {
  id?: string;
  code?: string;
  ruleId?: string;
  message?: string;
  description?: string;
  impact?: string;
  severity?: string;
  // PDF issues
  errorCode?: string;
  detail?: string;
}

interface IssueBucket {
  title: string;
  severity: string;
  fileCount: number;
  totalInstances: number;
  examples: RawIssue[];
}

function normalizeCode(issue: RawIssue): string {
  return (issue.code ?? issue.ruleId ?? issue.errorCode ?? 'UNKNOWN').trim();
}

function normalizeTitle(issue: RawIssue): string {
  return (issue.message ?? issue.description ?? issue.detail ?? normalizeCode(issue)).slice(0, 200);
}

function normalizeSeverity(issue: RawIssue): string {
  const raw = (issue.impact ?? issue.severity ?? 'moderate').toLowerCase();
  if (['critical', 'serious', 'moderate', 'minor'].includes(raw)) return raw;
  return 'moderate';
}

function extractIssues(output: Record<string, unknown>): RawIssue[] {
  if (Array.isArray(output.combinedIssues)) return output.combinedIssues as RawIssue[];
  if (Array.isArray(output.issues)) return output.issues as RawIssue[];
  if (Array.isArray(output.violations)) return output.violations as RawIssue[];
  return [];
}

// ─── Conformance-review types ─────────────────────────────────────────────────

interface ConformanceMapping {
  criterionId: string;
  title: string;
  level: string;
  aiConformance: 'supports' | 'partially_supports' | 'does_not_support' | 'not_applicable';
  confidence: number;
  reasoning: string;
  issueCount: number;
}

/** Map AI conformance assessment to a reviewer-facing severity level. */
function conformanceSeverity(aiConformance: string): string {
  if (aiConformance === 'does_not_support') return 'serious';
  if (aiConformance === 'partially_supports') return 'moderate';
  return 'minor';
}

/** Rank severity for "escalate to worst across files" logic. */
const CONFORMANCE_RANK: Record<string, number> = {
  does_not_support: 3,
  partially_supports: 2,
  supports: 0,
  not_applicable: 0,
};

// ─── Cluster helpers ──────────────────────────────────────────────────────────

type PrismaJsonValue = import('@prisma/client').Prisma.InputJsonValue;

class IssueClusterService {
  /**
   * Read issues from all workflows in a batch waiting at the given gate,
   * group them into BatchHITLItem rows, and upsert them.
   *
   * Gate-specific data sources:
   *   ai-review          → Job output combinedIssues (EPUBCheck / ACE violations)
   *   conformance-review → stateData.conformanceMappings (WCAG criterion assessments)
   *   remediation-review → single synthetic approval cluster
   *   acr-signoff        → single synthetic approval cluster
   */
  async clusterIssuesForBatch(batchId: string, gateSlug: string): Promise<number> {
    const state = GATE_SLUG_TO_STATE[gateSlug];
    if (!state) throw new Error(`Unknown gate slug: ${gateSlug}`);

    logger.info(`[IssueClusterService] Clustering for batch ${batchId} at gate "${gateSlug}"`);

    switch (gateSlug) {
      case 'ai-review':
        return this.clusterAuditIssues(batchId, gateSlug, state);
      case 'conformance-review':
        return this.clusterConformanceMappings(batchId, state);
      case 'remediation-review':
        return this.clusterSyntheticApproval(batchId, gateSlug, state, 'REMEDIATION_APPROVAL', 'Remediation Results Approval');
      case 'acr-signoff':
        return this.clusterSyntheticApproval(batchId, gateSlug, state, 'ACR_SIGNOFF', 'Accessibility Conformance Report Sign-off');
      default:
        return this.clusterAuditIssues(batchId, gateSlug, state);
    }
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Clustering strategies
  // ──────────────────────────────────────────────────────────────────────────

  /** AI Review: cluster EPUBCheck / ACE violations from Job output. */
  private async clusterAuditIssues(batchId: string, gateSlug: string, state: string): Promise<number> {
    const workflows = await prisma.workflowInstance.findMany({
      where: { batchId, currentState: state },
      select: { id: true, stateData: true },
    });

    if (workflows.length === 0) {
      logger.info(`[IssueClusterService] No workflows at ${state} for batch ${batchId}`);
      return 0;
    }

    const buckets = new Map<string, IssueBucket>();

    for (const workflow of workflows) {
      const sd = workflow.stateData as Record<string, unknown> | null;
      const jobId = (sd ?? {})['jobId'] as string | undefined;

      if (!jobId) {
        logger.warn(`[IssueClusterService] Workflow ${workflow.id} missing jobId`);
        continue;
      }

      const job = await prisma.job.findUnique({ where: { id: jobId }, select: { output: true } });
      if (!job?.output) {
        logger.warn(`[IssueClusterService] Job ${jobId} has no output yet`);
        continue;
      }

      const issues = extractIssues(job.output as Record<string, unknown>);
      const codesInThisWorkflow = new Set<string>();

      for (const issue of issues) {
        const code = normalizeCode(issue);
        if (!buckets.has(code)) {
          buckets.set(code, {
            title: normalizeTitle(issue),
            severity: normalizeSeverity(issue),
            fileCount: 0,
            totalInstances: 0,
            examples: [],
          });
        }

        const bucket = buckets.get(code)!;
        bucket.totalInstances++;
        if (!codesInThisWorkflow.has(code)) {
          bucket.fileCount++;
          codesInThisWorkflow.add(code);
        }
        if (bucket.examples.length < 3) bucket.examples.push(issue);
      }
    }

    let upsertCount = 0;
    for (const [code, data] of buckets) {
      await prisma.batchHITLItem.upsert({
        where: { batchId_gate_issueCode: { batchId, gate: gateSlug, issueCode: code } },
        create: {
          batchId, gate: gateSlug, issueCode: code,
          issueTitle: data.title, severity: data.severity,
          fileCount: data.fileCount, totalInstances: data.totalInstances,
          representativeIssues: data.examples as unknown as PrismaJsonValue,
        },
        update: {
          issueTitle: data.title, severity: data.severity,
          fileCount: data.fileCount, totalInstances: data.totalInstances,
          representativeIssues: data.examples as unknown as PrismaJsonValue,
        },
      });
      upsertCount++;
    }

    logger.info(`[IssueClusterService] Upserted ${upsertCount} audit clusters for batch ${batchId}`);
    return upsertCount;
  }

  /**
   * Conformance Review: cluster by WCAG criterion from stateData.conformanceMappings.
   * Each unique criterionId becomes a cluster; severity escalates to the worst
   * aiConformance seen across all files for that criterion.
   * Only criteria with does_not_support or partially_supports are included — criteria
   * that fully support across all files need no batch review.
   */
  private async clusterConformanceMappings(batchId: string, state: string): Promise<number> {
    const workflows = await prisma.workflowInstance.findMany({
      where: { batchId, currentState: state },
      select: { id: true, stateData: true },
    });

    if (workflows.length === 0) {
      logger.info(`[IssueClusterService] No workflows at ${state} for batch ${batchId}`);
      return 0;
    }

    interface CriterionBucket {
      title: string;
      level: string;
      severity: string;
      worstConformance: string;
      fileCount: number;
      totalInstances: number;
      examples: ConformanceMapping[];
    }

    const buckets = new Map<string, CriterionBucket>();

    for (const workflow of workflows) {
      const sd = workflow.stateData as Record<string, unknown> | null;
      const mappings = ((sd ?? {})['conformanceMappings'] ?? []) as ConformanceMapping[];

      if (!Array.isArray(mappings) || mappings.length === 0) {
        logger.warn(`[IssueClusterService] Workflow ${workflow.id} has no conformanceMappings in stateData`);
        continue;
      }

      for (const mapping of mappings) {
        const { criterionId, title, level, aiConformance, issueCount } = mapping;

        // Skip criteria that fully support — no review needed
        if (aiConformance === 'supports' || aiConformance === 'not_applicable') continue;

        if (!buckets.has(criterionId)) {
          buckets.set(criterionId, {
            title: `${criterionId} ${title}`,
            level,
            severity: conformanceSeverity(aiConformance),
            worstConformance: aiConformance,
            fileCount: 0,
            totalInstances: 0,
            examples: [],
          });
        }

        const bucket = buckets.get(criterionId)!;
        bucket.fileCount++;
        bucket.totalInstances += issueCount;
        if (bucket.examples.length < 3) bucket.examples.push(mapping);

        // Escalate to worst conformance seen across files
        const incomingRank = CONFORMANCE_RANK[aiConformance] ?? 0;
        const existingRank = CONFORMANCE_RANK[bucket.worstConformance] ?? 0;
        if (incomingRank > existingRank) {
          bucket.worstConformance = aiConformance;
          bucket.severity = conformanceSeverity(aiConformance);
        }
      }
    }

    let upsertCount = 0;
    for (const [criterionId, data] of buckets) {
      await prisma.batchHITLItem.upsert({
        where: { batchId_gate_issueCode: { batchId, gate: 'conformance-review', issueCode: criterionId } },
        create: {
          batchId, gate: 'conformance-review', issueCode: criterionId,
          issueTitle: data.title, severity: data.severity,
          fileCount: data.fileCount, totalInstances: data.totalInstances,
          representativeIssues: data.examples as unknown as PrismaJsonValue,
        },
        update: {
          issueTitle: data.title, severity: data.severity,
          fileCount: data.fileCount, totalInstances: data.totalInstances,
          representativeIssues: data.examples as unknown as PrismaJsonValue,
        },
      });
      upsertCount++;
    }

    logger.info(`[IssueClusterService] Upserted ${upsertCount} conformance criterion clusters for batch ${batchId}`);

    // If no failing criteria were found across all workflows, create a synthetic
    // approval cluster so the batch HITL page shows something actionable.
    if (upsertCount === 0) {
      const workflowCount = workflows.length;
      logger.info(`[IssueClusterService] All conformance criteria passed — creating synthetic approval cluster for batch ${batchId}`);
      await prisma.batchHITLItem.upsert({
        where: { batchId_gate_issueCode: { batchId, gate: 'conformance-review', issueCode: 'CONFORMANCE_ALL_PASS' } },
        create: {
          batchId, gate: 'conformance-review', issueCode: 'CONFORMANCE_ALL_PASS',
          issueTitle: 'All WCAG criteria assessed — no failing criteria found',
          severity: 'minor',
          fileCount: workflowCount, totalInstances: workflowCount,
          representativeIssues: [] as unknown as PrismaJsonValue,
        },
        update: { fileCount: workflowCount, totalInstances: workflowCount },
      });
      return 1;
    }

    return upsertCount;
  }

  /**
   * Remediation Review / ACR Sign-off: these are simple all-or-nothing approval gates.
   * Create one synthetic cluster so the batch HITL UI shows a single "approve / reject" card.
   */
  private async clusterSyntheticApproval(
    batchId: string,
    gateSlug: string,
    state: string,
    issueCode: string,
    issueTitle: string
  ): Promise<number> {
    const workflowCount = await prisma.workflowInstance.count({
      where: { batchId, currentState: state },
    });

    if (workflowCount === 0) {
      logger.info(`[IssueClusterService] No workflows at ${state} for batch ${batchId}`);
      return 0;
    }

    await prisma.batchHITLItem.upsert({
      where: { batchId_gate_issueCode: { batchId, gate: gateSlug, issueCode } },
      create: {
        batchId, gate: gateSlug, issueCode, issueTitle,
        severity: 'moderate',
        fileCount: workflowCount, totalInstances: workflowCount,
        representativeIssues: [] as unknown as PrismaJsonValue,
      },
      update: { fileCount: workflowCount, totalInstances: workflowCount },
    });

    logger.info(`[IssueClusterService] Upserted synthetic approval cluster for batch ${batchId} gate "${gateSlug}"`);
    return 1;
  }

  // ──────────────────────────────────────────────────────────────────────────
  // Apply decisions
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Apply batch-level cluster decisions to every workflow waiting at this gate.
   * @returns Number of workflows that had decisions applied
   */
  async applyDecisionsToWorkflows(
    batchId: string,
    gateSlug: string,
    reviewerId: string
  ): Promise<number> {
    const state = GATE_SLUG_TO_STATE[gateSlug];
    if (!state) throw new Error(`Unknown gate slug: ${gateSlug}`);

    const clusters = await prisma.batchHITLItem.findMany({
      where: { batchId, gate: gateSlug },
    });

    const undecided = clusters.filter(c => !c.decision);
    if (undecided.length > 0) {
      throw new Error(`${undecided.length} cluster(s) still have no decision`);
    }

    const workflows = await prisma.workflowInstance.findMany({
      where: { batchId, currentState: state },
      select: { id: true, stateData: true },
    });

    let applied = 0;
    for (const workflow of workflows) {
      try {
        await this.applyToWorkflow(workflow, clusters, gateSlug, reviewerId);
        applied++;
      } catch (err) {
        logger.error(`[IssueClusterService] Failed to apply to workflow ${workflow.id}: ${err}`);
      }
    }

    logger.info(`[IssueClusterService] Applied batch decisions to ${applied}/${workflows.length} workflows`);
    return applied;
  }

  private async applyToWorkflow(
    workflow: { id: string; stateData: unknown },
    clusters: Array<{ issueCode: string; decision: string | null }>,
    gateSlug: string,
    reviewerId: string
  ): Promise<void> {
    const sd = workflow.stateData as Record<string, unknown> | null;
    const { enqueueWorkflowEvent } = await import('../../queues/workflow.queue');

    switch (gateSlug) {
      case 'ai-review':
        return this.applyAiReviewDecisions(workflow.id, sd, clusters, reviewerId, enqueueWorkflowEvent);

      case 'conformance-review':
        return this.applyConformanceDecisions(workflow.id, sd, clusters, reviewerId, enqueueWorkflowEvent);

      case 'remediation-review':
        await prisma.workflowInstance.update({
          where: { id: workflow.id },
          data: {
            stateData: {
              ...(sd as object),
              batchRemediationApprovedBy: reviewerId,
              batchRemediationApprovedAt: new Date().toISOString(),
              batchDecisionApplied: true,
            } as unknown as PrismaJsonValue,
          },
        });
        await enqueueWorkflowEvent(workflow.id, 'REMEDIATION_APPROVED', { batchDecision: true, reviewerId });
        return;

      case 'acr-signoff':
        await prisma.workflowInstance.update({
          where: { id: workflow.id },
          data: {
            stateData: {
              ...(sd as object),
              batchAcrSignedBy: reviewerId,
              batchAcrSignedAt: new Date().toISOString(),
              batchDecisionApplied: true,
            } as unknown as PrismaJsonValue,
          },
        });
        await enqueueWorkflowEvent(workflow.id, 'ACR_SIGNED', { batchDecision: true, reviewerId });
        return;

      default:
        logger.warn(`[IssueClusterService] Unknown gate "${gateSlug}" — skipping workflow ${workflow.id}`);
    }
  }

  /** AI Review: map each issue in the job output to its cluster decision, then transition. */
  private async applyAiReviewDecisions(
    workflowId: string,
    sd: Record<string, unknown> | null,
    clusters: Array<{ issueCode: string; decision: string | null }>,
    reviewerId: string,
    enqueueWorkflowEvent: (id: string, event: string, meta?: unknown) => Promise<void>
  ): Promise<void> {
    const jobId = (sd ?? {})['jobId'] as string | undefined;
    if (!jobId) {
      logger.warn(`[IssueClusterService] Workflow ${workflowId} missing jobId — skipping`);
      return;
    }

    const job = await prisma.job.findUnique({ where: { id: jobId }, select: { output: true } });
    const issues = extractIssues((job?.output ?? {}) as Record<string, unknown>);

    const decisionByCode = new Map(clusters.map(c => [c.issueCode, c.decision as string]));
    const autoFixCodes = clusters.filter(c => c.decision === 'AUTO_FIX').map(c => c.issueCode);

    const decisions = issues.map((issue, idx) => {
      const code = normalizeCode(issue);
      const rawDecision = decisionByCode.get(code) ?? 'ACCEPT';
      const decision = rawDecision === 'AUTO_FIX' ? 'ACCEPT' : rawDecision;
      return {
        itemId: (issue.id as string | undefined) ?? `issue-${idx}`,
        decision,
        justification: rawDecision === 'AUTO_FIX'
          ? `Batch auto-fix approved for issue type ${code}`
          : `Batch decision applied: ${decision} for issue type ${code}`,
      };
    });

    await prisma.workflowInstance.update({
      where: { id: workflowId },
      data: {
        stateData: {
          ...(sd as object),
          aiReviewDecisions: decisions,
          aiReviewDecisionsReviewedBy: reviewerId,
          aiReviewDecisionsReviewedAt: new Date().toISOString(),
          batchDecisionApplied: true,
          batchAutoFixCodes: autoFixCodes,
        } as unknown as PrismaJsonValue,
      },
    });

    const allAccepted = decisions.every(d => d.decision === 'ACCEPT');
    await enqueueWorkflowEvent(workflowId, allAccepted ? 'AI_ACCEPTED' : 'AI_REJECTED', {
      batchDecision: true,
      reviewerId,
      decisionCount: decisions.length,
    });
  }

  /**
   * Conformance Review: store per-criterion decisions in stateData, then approve.
   * The workflow always moves forward with CONFORMANCE_APPROVED regardless of individual
   * criterion Accept/Reject decisions — the decisions are stored for audit purposes.
   */
  private async applyConformanceDecisions(
    workflowId: string,
    sd: Record<string, unknown> | null,
    clusters: Array<{ issueCode: string; decision: string | null }>,
    reviewerId: string,
    enqueueWorkflowEvent: (id: string, event: string, meta?: unknown) => Promise<void>
  ): Promise<void> {
    // Map cluster decisions (keyed by criterionId) to a format matching the conformance stateData
    const criterionDecisions = clusters.map(c => ({
      criterionId: c.issueCode,
      batchDecision: c.decision, // 'ACCEPT' | 'REJECT'
      notes: `Batch decision: ${c.decision}`,
    }));

    await prisma.workflowInstance.update({
      where: { id: workflowId },
      data: {
        stateData: {
          ...(sd as object),
          batchConformanceDecisions: criterionDecisions,
          batchConformanceReviewedBy: reviewerId,
          batchConformanceReviewedAt: new Date().toISOString(),
          batchDecisionApplied: true,
        } as unknown as PrismaJsonValue,
      },
    });

    await enqueueWorkflowEvent(workflowId, 'CONFORMANCE_APPROVED', {
      batchDecision: true,
      reviewerId,
      decisionCount: criterionDecisions.length,
    });
  }
}

export const issueClusterService = new IssueClusterService();
