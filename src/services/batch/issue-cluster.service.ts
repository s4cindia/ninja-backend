import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

/** Map from HITL gate slug (URL) to the WorkflowInstance.currentState value */
const GATE_SLUG_TO_STATE: Record<string, string> = {
  'ai-review': 'AWAITING_AI_REVIEW',
  'remediation-review': 'AWAITING_REMEDIATION_REVIEW',
  'conformance-review': 'AWAITING_CONFORMANCE_REVIEW',
  'acr-signoff': 'AWAITING_ACR_SIGNOFF',
};

/** Map from HITL gate slug to the stateData key that holds the job/item list */
const GATE_SLUG_TO_STATEDATA_KEY: Record<string, string> = {
  'ai-review': 'jobId',
  'remediation-review': 'jobId',
  'conformance-review': 'jobId',
  'acr-signoff': 'jobId',
};

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

/** Extract raw issues from a Job output regardless of audit type */
function extractIssues(output: Record<string, unknown>): RawIssue[] {
  if (Array.isArray(output.combinedIssues)) return output.combinedIssues as RawIssue[];
  if (Array.isArray(output.issues)) return output.issues as RawIssue[];
  if (Array.isArray(output.violations)) return output.violations as RawIssue[];
  return [];
}

class IssueClusterService {
  /**
   * Read issues from all workflows in a batch that are waiting at the given gate,
   * group them by issue code, and upsert BatchHITLItem rows.
   *
   * @param batchId  - The BatchWorkflow.id
   * @param gateSlug - URL slug: 'ai-review' | 'remediation-review' | ...
   * @returns Number of clusters created/updated
   */
  async clusterIssuesForBatch(batchId: string, gateSlug: string): Promise<number> {
    const state = GATE_SLUG_TO_STATE[gateSlug];
    if (!state) {
      throw new Error(`Unknown gate slug: ${gateSlug}`);
    }

    logger.info(`[IssueClusterService] Clustering issues for batch ${batchId} at gate ${gateSlug}`);

    // Find all workflows waiting at this gate
    const workflows = await prisma.workflowInstance.findMany({
      where: { batchId, currentState: state },
      select: { id: true, stateData: true },
    });

    if (workflows.length === 0) {
      logger.info(`[IssueClusterService] No workflows at state ${state} for batch ${batchId}`);
      return 0;
    }

    // Bucket: issueCode → aggregate data
    const buckets = new Map<string, IssueBucket>();

    for (const workflow of workflows) {
      const sd = workflow.stateData as Record<string, unknown> | null;
      const jobId = (sd ?? {})[GATE_SLUG_TO_STATEDATA_KEY[gateSlug] ?? 'jobId'] as string | undefined;

      if (!jobId) {
        logger.warn(`[IssueClusterService] Workflow ${workflow.id} has no jobId in stateData`);
        continue;
      }

      const job = await prisma.job.findUnique({
        where: { id: jobId },
        select: { output: true },
      });

      if (!job?.output) {
        logger.warn(`[IssueClusterService] Job ${jobId} has no output yet`);
        continue;
      }

      const output = job.output as Record<string, unknown>;
      const issues = extractIssues(output);

      // Track which codes appeared in this workflow to increment fileCount once
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
        // Keep up to 3 representative examples
        if (bucket.examples.length < 3) {
          bucket.examples.push(issue);
        }
      }
    }

    // Upsert BatchHITLItem rows
    let upsertCount = 0;
    for (const [code, data] of buckets) {
      await prisma.batchHITLItem.upsert({
        where: { batchId_gate_issueCode: { batchId, gate: gateSlug, issueCode: code } },
        create: {
          batchId,
          gate: gateSlug,
          issueCode: code,
          issueTitle: data.title,
          severity: data.severity,
          fileCount: data.fileCount,
          totalInstances: data.totalInstances,
          representativeIssues: data.examples as unknown as import('@prisma/client').Prisma.InputJsonValue,
        },
        update: {
          issueTitle: data.title,
          severity: data.severity,
          fileCount: data.fileCount,
          totalInstances: data.totalInstances,
          representativeIssues: data.examples as unknown as import('@prisma/client').Prisma.InputJsonValue,
        },
      });
      upsertCount++;
    }

    logger.info(
      `[IssueClusterService] Upserted ${upsertCount} clusters for batch ${batchId} gate ${gateSlug}`
    );
    return upsertCount;
  }

  /**
   * Apply batch-level cluster decisions to every workflow at this gate.
   * For each workflow, finds its issues, maps each to a cluster decision,
   * submits all decisions, and transitions the workflow past the gate.
   *
   * @returns Number of workflows that had decisions applied
   */
  async applyDecisionsToWorkflows(
    batchId: string,
    gateSlug: string,
    reviewerId: string
  ): Promise<number> {
    const state = GATE_SLUG_TO_STATE[gateSlug];
    if (!state) throw new Error(`Unknown gate slug: ${gateSlug}`);

    // Fetch all cluster decisions for this batch+gate
    const clusters = await prisma.batchHITLItem.findMany({
      where: { batchId, gate: gateSlug },
    });

    const undecided = clusters.filter(c => !c.decision);
    if (undecided.length > 0) {
      throw new Error(`${undecided.length} clusters still have no decision`);
    }

    // Build code → decision map
    const decisionByCode = new Map<string, string>(
      clusters.map(c => [c.issueCode, c.decision as string])
    );

    // Find all workflows at this gate
    const workflows = await prisma.workflowInstance.findMany({
      where: { batchId, currentState: state },
      select: { id: true, stateData: true },
    });

    let applied = 0;

    for (const workflow of workflows) {
      try {
        await this.applyToWorkflow(workflow, decisionByCode, gateSlug, reviewerId);
        applied++;
      } catch (err) {
        logger.error(
          `[IssueClusterService] Failed to apply decisions to workflow ${workflow.id}: ${err}`
        );
      }
    }

    logger.info(
      `[IssueClusterService] Applied batch decisions to ${applied}/${workflows.length} workflows`
    );
    return applied;
  }

  private async applyToWorkflow(
    workflow: { id: string; stateData: unknown },
    decisionByCode: Map<string, string>,
    gateSlug: string,
    reviewerId: string
  ): Promise<void> {
    const sd = workflow.stateData as Record<string, unknown> | null;
    const jobId = (sd ?? {})['jobId'] as string | undefined;

    if (!jobId) {
      logger.warn(`[IssueClusterService] Workflow ${workflow.id} missing jobId — skipping`);
      return;
    }

    const job = await prisma.job.findUnique({
      where: { id: jobId },
      select: { output: true },
    });

    const output = (job?.output ?? {}) as Record<string, unknown>;
    const issues = extractIssues(output);

    const decisions = issues.map((issue, idx) => {
      const code = normalizeCode(issue);
      const decision = decisionByCode.get(code) ?? 'ACCEPT';
      return {
        itemId: (issue.id as string | undefined) ?? `issue-${idx}`,
        decision,
        justification: `Batch decision applied: ${decision} for issue type ${code}`,
      };
    });

    // Gate-specific transition event
    const transitionEvent = this.getTransitionEvent(gateSlug, decisions);

    // Store decisions in stateData and transition
    const stateKey = this.getDecisionStateKey(gateSlug);
    await prisma.workflowInstance.update({
      where: { id: workflow.id },
      data: {
        stateData: {
          ...(sd as object),
          [stateKey]: decisions,
          [`${stateKey}ReviewedBy`]: reviewerId,
          [`${stateKey}ReviewedAt`]: new Date().toISOString(),
          batchDecisionApplied: true,
        } as unknown as import('@prisma/client').Prisma.InputJsonValue,
      },
    });

    // Enqueue the workflow event to advance the state machine
    const { enqueueWorkflowEvent } = await import('../../queues/workflow.queue');
    await enqueueWorkflowEvent(workflow.id, transitionEvent, {
      batchDecision: true,
      reviewerId,
      decisionCount: decisions.length,
    });
  }

  private getTransitionEvent(gateSlug: string, decisions: { decision: string }[]): string {
    switch (gateSlug) {
      case 'ai-review': {
        const allAccepted = decisions.every(d => d.decision === 'ACCEPT');
        return allAccepted ? 'AI_ACCEPTED' : 'AI_REJECTED';
      }
      case 'remediation-review':
        return 'REMEDIATION_APPROVED';
      case 'conformance-review':
        return 'CONFORMANCE_APPROVED';
      case 'acr-signoff':
        return 'ACR_APPROVED';
      default:
        return 'AI_ACCEPTED';
    }
  }

  private getDecisionStateKey(gateSlug: string): string {
    switch (gateSlug) {
      case 'ai-review':
        return 'aiReviewDecisions';
      case 'remediation-review':
        return 'remediationDecisions';
      case 'conformance-review':
        return 'conformanceDecisions';
      case 'acr-signoff':
        return 'acrSignoffDecisions';
      default:
        return 'hitlDecisions';
    }
  }
}

export const issueClusterService = new IssueClusterService();
