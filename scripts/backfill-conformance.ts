/**
 * Backfill conformance mappings for a workflow stuck at AWAITING_CONFORMANCE_REVIEW
 * without conformanceMappings in stateData.
 *
 * Usage:  npx ts-node scripts/backfill-conformance.ts <workflowId>
 */
import prisma from '../src/lib/prisma';
import { acrGeneratorService } from '../src/services/acr/acr-generator.service';
import type { AuditIssueInput } from '../src/services/acr/wcag-issue-mapper.service';

const WORKFLOW_ID = process.argv[2] ?? '06bb70b6-6c2c-44df-8f77-ade0066db81a';

async function main() {
  const wf = await prisma.workflowInstance.findUnique({ where: { id: WORKFLOW_ID } });
  if (!wf) throw new Error(`Workflow ${WORKFLOW_ID} not found`);

  const stateData = wf.stateData as Record<string, unknown>;
  const jobId = stateData.jobId as string;
  if (!jobId) throw new Error('No jobId in stateData');

  console.log(`[backfill] Workflow: ${WORKFLOW_ID}, jobId: ${jobId}`);

  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { output: true } });
  if (!job?.output) throw new Error('No audit output for job');

  const auditData = job.output as Record<string, unknown>;
  const rawIssues = (
    (auditData.combinedIssues as Array<Record<string, unknown>>) ??
    (auditData.issues as Array<Record<string, unknown>>) ??
    []
  );

  console.log(`[backfill] ${rawIssues.length} audit issues found`);

  const auditIssues: AuditIssueInput[] = rawIssues.map((issue, idx) => ({
    id: (issue.id as string) ?? `issue-${idx}`,
    ruleId: (issue.ruleId as string) ?? (issue.code as string) ?? 'unknown',
    impact: (issue.impact as string) ?? (issue.severity as string) ?? 'moderate',
    message: (issue.message as string) ?? (issue.description as string) ?? '',
    filePath: (issue.filePath as string) ?? (issue.location as string) ?? '',
    htmlSnippet: (issue.htmlSnippet as string) ?? null,
    xpath: (issue.xpath as string) ?? null,
  }));

  console.log('[backfill] Generating conformance analysis...');
  const criteriaResults = await acrGeneratorService.generateConfidenceAnalysis('VPAT2.5-INT', auditIssues);
  console.log(`[backfill] ${criteriaResults.length} criteria generated`);

  const statusToAiConformance = (
    status: string
  ): 'supports' | 'partially_supports' | 'does_not_support' | 'not_applicable' => {
    if (status === 'pass') return 'supports';
    if (status === 'fail') return 'does_not_support';
    if (status === 'needs_review') return 'partially_supports';
    return 'not_applicable';
  };

  const conformanceMappings = criteriaResults.map(c => ({
    criterionId: c.criterionId,
    title: c.name,
    level: c.level,
    aiConformance: statusToAiConformance(c.status),
    confidence: c.confidenceScore / 100,
    reasoning: c.remarks,
    issueCount: c.issueCount ?? 0,
  }));

  await prisma.workflowInstance.update({
    where: { id: WORKFLOW_ID },
    data: {
      stateData: {
        ...stateData,
        conformanceMappings,
      },
    },
  });

  console.log(`[backfill] Done — stored ${conformanceMappings.length} conformance mappings`);
  console.log(`[backfill] Breakdown:`);
  const counts = { supports: 0, partially_supports: 0, does_not_support: 0, not_applicable: 0 };
  conformanceMappings.forEach(m => counts[m.aiConformance]++);
  console.log(counts);
}

main()
  .catch(err => { console.error(err); process.exit(1); })
  .finally(() => prisma.$disconnect());
