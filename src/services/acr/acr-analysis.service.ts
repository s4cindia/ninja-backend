import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import acrEditionsData from '../../data/acrEditions.json';

// Load WCAG criteria from shared JSON (filters out EU-specific criteria)
const WCAG_CRITERIA = acrEditionsData.criteria
  .filter((c: { level: string }) => ['A', 'AA', 'AAA'].includes(c.level))
  .map((c: { number: string; name: string; level: string; section: string }) => ({
    id: c.number,
    name: c.name,
    level: c.level,
    category: c.section,
  }));

logger.info(`[ACR Analysis] Loaded ${WCAG_CRITERIA.length} WCAG 2.1 criteria from documentation`);

// Filter criteria based on edition requirements
function getEditionCriteria(editionCode?: string): typeof WCAG_CRITERIA {
  if (!editionCode) {
    return WCAG_CRITERIA.filter(c => c.level === 'A' || c.level === 'AA');
  }

  switch (editionCode) {
    case 'VPAT2.5-WCAG':
      return WCAG_CRITERIA.filter(c => c.level === 'A' || c.level === 'AA');

    case 'VPAT2.5-INT':
      return WCAG_CRITERIA;

    case 'VPAT2.5-508':
    case 'VPAT2.5-EU':
      return WCAG_CRITERIA.filter(c => c.level === 'A' || c.level === 'AA');

    default:
      return WCAG_CRITERIA.filter(c => c.level === 'A' || c.level === 'AA');
  }
}

const KNOWN_SEVERITIES = ['critical', 'serious', 'moderate', 'minor'];

export interface CriterionAnalysis {
  id: string;
  name: string;
  level: string;
  category: string;
  status: 'supports' | 'partially_supports' | 'does_not_support' | 'not_applicable';
  confidence: number;
  findings: string[];
  recommendation: string;
  issues?: Array<{
    code: string;
    message: string;
    location?: string;
    severity?: string;
    html?: string;
    suggestedFix?: string;
  }>;
  relatedIssues?: Array<{
    issueId: string;
    ruleId: string;
    impact: string;
    message: string;
    filePath?: string;
    location?: string;
    htmlSnippet?: string;
    suggestedFix?: string;
  }>;
  issueCount?: number;
  fixedIssues?: Array<{
    issueId: string;
    ruleId: string;
    impact: string;
    message: string;
    filePath?: string;
    location?: string;
    htmlSnippet?: string;
    suggestedFix?: string;
    fixedAt?: string;
    fixMethod?: 'automated' | 'manual';
  }>;
  fixedCount?: number;
  remainingCount?: number;
}

export interface AcrAnalysis {
  jobId: string;
  criteria: CriterionAnalysis[];
  overallConfidence: number;
  analyzedAt: string;
  summary: {
    supports: number;
    partiallySupports: number;
    doesNotSupport: number;
    notApplicable: number;
  };
  otherIssues?: {
    count: number;
    issues: Array<{
      code: string;
      message: string;
      severity: string;
      location?: string;
    }>;
  };
}

interface AuditIssue {
  id?: string;
  code?: string;
  wcagCriteria?: string[];
  severity?: string;
  message?: string;
  description?: string;
  filePath?: string;
  location?: string;
  html?: string;
  snippet?: string;
  suggestedFix?: string;
}

interface RemediationChange {
  issueCode?: string;
  criterionId?: string;
  status?: string;
  issues?: Array<{ code?: string }>;
  fixedAt?: string;
}

function analyzeWcagCriteria(
  issues: AuditIssue[],
  editionCode?: string,
  remediationChanges: RemediationChange[] = []
): CriterionAnalysis[] {
  const criteriaAnalysis: CriterionAnalysis[] = [];
  const editionCriteria = getEditionCriteria(editionCode);

  logger.info(`[ACR Analysis] Analyzing ${editionCriteria.length} criteria for edition: ${editionCode || 'default (A+AA)'}`);
  logger.info(`[ACR Analysis] Tracking ${remediationChanges.length} completed remediation changes`);

  for (const criterion of editionCriteria) {
    const criterionCode = criterion.id.replace(/\./g, '');
    const pattern = criterionCode.toUpperCase();
    
    const relatedIssues = issues.filter(issue => {
      if (issue.wcagCriteria?.includes(criterion.id)) {
        return true;
      }
      
      if (issue.code) {
        const code = issue.code.toUpperCase();
        
        if (code === pattern) return true;
        
        if (code === `WCAG-${pattern}`) return true;
        
        const regex = new RegExp(`(?:^|[-_])${pattern}(?:[-_]|$)`);
        if (regex.test(code)) return true;
      }
      
      return false;
    });

    let status: CriterionAnalysis['status'];
    let confidence: number;
    let findings: string[] = [];
    let recommendation = '';

    if (relatedIssues.length === 0) {
      status = 'supports';
      confidence = 75;
      findings = ['No accessibility issues detected for this criterion'];
      recommendation = 'Continue to maintain compliance with this criterion';
    } else {
      const criticalCount = relatedIssues.filter(i => i.severity === 'critical').length;
      const seriousCount = relatedIssues.filter(i => i.severity === 'serious').length;
      const moderateCount = relatedIssues.filter(i => i.severity === 'moderate').length;
      const minorCount = relatedIssues.filter(i => i.severity === 'minor').length;
      const unknownCount = relatedIssues.filter(i => 
        !i.severity || !KNOWN_SEVERITIES.includes(i.severity)
      ).length;

      if (criticalCount > 0) {
        status = 'does_not_support';
        confidence = 90;
        recommendation = 'Critical issues must be resolved for compliance';
      } else if (seriousCount > 0) {
        status = 'partially_supports';
        confidence = 80;
        recommendation = 'Serious issues should be addressed to improve compliance';
      } else if (moderateCount > 0) {
        status = 'partially_supports';
        confidence = 70;
        recommendation = 'Moderate issues may affect some users';
      } else if (unknownCount > 0) {
        status = 'partially_supports';
        confidence = 60;
        recommendation = 'Issues with unknown severity require manual review';
      } else if (minorCount > 0) {
        status = 'supports';
        confidence = 85;
        recommendation = 'Minor issues detected but overall compliance is maintained';
      } else {
        status = 'supports';
        confidence = 85;
        recommendation = 'Issues detected but overall compliance is maintained';
      }

      findings = relatedIssues.map(issue => 
        `${(issue.severity || 'ISSUE').toUpperCase()}: ${
          issue.message || issue.description || 
          (issue.code ? `Issue code: ${issue.code}` : 'Unspecified accessibility issue')
        }`
      ).slice(0, 5);
    }

    const issueDetails = relatedIssues.slice(0, 10).map(issue => ({
      code: issue.code || 'UNKNOWN',
      message: issue.message || issue.description || 'No description available',
      location: issue.location,
      severity: issue.severity,
      html: issue.html || issue.snippet,
      suggestedFix: issue.suggestedFix,
    }));

    const fixedIssuesList: CriterionAnalysis['fixedIssues'] = [];
    const remainingIssuesList: CriterionAnalysis['relatedIssues'] = [];

    relatedIssues.slice(0, 20).forEach(issue => {
      const issueCode = issue.code || 'unknown';

      const wasFixed = remediationChanges.some(change =>
        change.issueCode === issueCode ||
        change.criterionId === criterion.id ||
        (change.issues && change.issues.some(i => i.code === issueCode))
      );

      const issueData = {
        issueId: issue.id || `issue-${Math.random().toString(36).substr(2, 9)}`,
        ruleId: issueCode,
        impact: issue.severity || 'moderate',
        message: issue.message || issue.description || 'No description available',
        filePath: issue.filePath,
        location: issue.location,
        htmlSnippet: issue.html || issue.snippet,
        suggestedFix: issue.suggestedFix,
      };

      if (wasFixed) {
        const matchingChange = remediationChanges.find(c => c.issueCode === issueCode);
        fixedIssuesList!.push({
          ...issueData,
          fixedAt: matchingChange?.fixedAt || new Date().toISOString(),
          fixMethod: 'automated' as const,
        });
      } else {
        remainingIssuesList!.push(issueData);
      }
    });

    logger.info(`[ACR Analysis] Criterion ${criterion.id}: ${fixedIssuesList!.length} fixed, ${remainingIssuesList!.length} remaining`);

    criteriaAnalysis.push({
      id: criterion.id,
      name: criterion.name,
      level: criterion.level,
      category: criterion.category,
      status,
      confidence,
      findings,
      recommendation,
      issues: issueDetails.length > 0 ? issueDetails : undefined,
      relatedIssues: remainingIssuesList!.length > 0 ? remainingIssuesList : undefined,
      issueCount: remainingIssuesList!.length,
      fixedIssues: fixedIssuesList!.length > 0 ? fixedIssuesList : undefined,
      fixedCount: fixedIssuesList!.length,
      remainingCount: remainingIssuesList!.length,
    });
  }

  return criteriaAnalysis;
}

export async function getAnalysisForJob(jobId: string, userId?: string, forceRefresh = false): Promise<AcrAnalysis> {
  const whereClause: { id: string; userId?: string } = { id: jobId };

  if (userId) {
    whereClause.userId = userId;
  }

  const job = await prisma.job.findFirst({
    where: whereClause,
  });

  if (!job) {
    throw new Error('Job not found');
  }

  const auditOutput = job.output as Record<string, unknown> | null;

  // DEBUG: Log job details
  logger.info(`[ACR DEBUG] Job type: ${job.type}`);
  logger.info(`[ACR DEBUG] Job input: ${JSON.stringify(job.input)}`);
  logger.info(`[ACR DEBUG] Job output keys: ${Object.keys(auditOutput || {})}`);

  if (!forceRefresh && auditOutput?.acrAnalysis) {
    logger.info(`[ACR] Returning cached analysis for job: ${jobId}`);
    return auditOutput.acrAnalysis as AcrAnalysis;
  }

  if (forceRefresh) {
    logger.info(`[ACR] Force refresh requested, regenerating analysis for job: ${jobId}`);
  }

  let issues: AuditIssue[] = [];
  let otherIssuesData: Array<{ code: string; message: string; severity: string; location?: string }> = [];
  let remediationChanges: RemediationChange[] = [];

  if (job.type === 'ACR_WORKFLOW') {
    const jobInput = job.input as Record<string, unknown> | null;
    const sourceJobId = jobInput?.sourceJobId as string | undefined;

    logger.info(`[ACR Analysis] ACR_WORKFLOW job detected, sourceJobId: ${sourceJobId}`);

    if (sourceJobId) {
      const sourceJob = await prisma.job.findFirst({
        where: { id: sourceJobId },
        select: { output: true, type: true }
      });

      if (sourceJob) {
        const sourceOutput = sourceJob.output as Record<string, unknown> | null;

        if (sourceOutput?.remediationPlan) {
          const remediationPlan = sourceOutput?.remediationPlan as { tasks?: Array<{ wcagCriteria?: string | string[]; issueCode?: string; issueMessage?: string; severity?: string; location?: string; status?: string; completedAt?: string }> } | undefined;
          if (remediationPlan?.tasks) {
            const allTasks = remediationPlan.tasks;
            logger.info(`[ACR Analysis] Found ${allTasks.length} remediation tasks from source job`);

            remediationChanges = allTasks
              .filter(task => task.status === 'completed' || task.status === 'auto-fixed' || task.status === 'fixed')
              .map(task => ({
                issueCode: task.issueCode,
                status: task.status,
                fixedAt: task.completedAt,
              }));

            logger.info(`[ACR Analysis] Found ${remediationChanges.length} completed/fixed remediation tasks`);

            issues = allTasks
              .filter(task => task.wcagCriteria)
              .map(task => ({
                code: task.issueCode,
                message: task.issueMessage,
                severity: task.severity,
                location: task.location,
                wcagCriteria: Array.isArray(task.wcagCriteria)
                  ? task.wcagCriteria
                  : task.wcagCriteria ? [task.wcagCriteria] : undefined,
              }));

            const otherTasks = allTasks.filter(task => !task.wcagCriteria);
            otherIssuesData = otherTasks.map(task => ({
              code: task.issueCode || 'UNKNOWN',
              message: task.issueMessage || 'No description',
              severity: task.severity || 'unknown',
              location: task.location,
            }));

            logger.info(`[ACR Analysis] Filtered to ${issues.length} WCAG-mapped issues, ${otherTasks.length} other issues`);
          }
        } else {
          const allIssues = (sourceOutput?.combinedIssues || sourceOutput?.issues || []) as AuditIssue[];
          logger.info(`[ACR Analysis] Found ${allIssues.length} total issues from source job`);

          // DEBUG: Log first issue structure to see available fields
          if (allIssues.length > 0) {
            logger.info(`[ACR DEBUG] First issue structure: ${JSON.stringify(allIssues[0], null, 2)}`);
            logger.info(`[ACR DEBUG] Issue keys: ${Object.keys(allIssues[0] || {})}`);
          }

          // Separate WCAG-mapped issues
          const wcagMappedIssues = allIssues.filter(issue => issue.wcagCriteria && issue.wcagCriteria.length > 0);

          // Build remediationChanges from fixed issues
          interface IssueWithStatus extends AuditIssue {
            status?: string;
          }

          const fixedIssues = wcagMappedIssues.filter((issue: IssueWithStatus) =>
            issue.status === 'fixed' || issue.status === 'completed' || issue.status === 'auto-fixed'
          );

          remediationChanges = fixedIssues.map(issue => ({
            issueCode: issue.code,
            status: (issue as IssueWithStatus).status,
            fixedAt: new Date().toISOString(),
          }));

          logger.info(`[ACR Analysis] Found ${remediationChanges.length} fixed issues from combinedIssues`);

          // All WCAG-mapped issues (both fixed and pending) for analysis
          issues = wcagMappedIssues;

          const otherIssues = allIssues.filter(issue => !issue.wcagCriteria || issue.wcagCriteria.length === 0);

          otherIssuesData = otherIssues.map(issue => ({
            code: issue.code || 'UNKNOWN',
            message: issue.message || issue.description || 'No description',
            severity: issue.severity || 'unknown',
            location: issue.location,
          }));

          logger.info(`[ACR Analysis] Filtered to ${issues.length} WCAG-mapped issues for analysis`);
        }
      } else {
        logger.warn(`[ACR Analysis] Source job ${sourceJobId} not found`);
      }
    } else {
      if (auditOutput?.criteria) {
        const criteria = auditOutput.criteria as Array<{
          code?: string;
          description?: string;
          severity?: string;
          location?: string;
          wcagCriteria?: string | null;
        }>;

        logger.info(`[ACR Analysis] Using ${criteria.length} criteria from ACR workflow output`);

        const wcagMappedCriteria = criteria.filter(c => c.wcagCriteria);
        const otherCriteria = criteria.filter(c => !c.wcagCriteria);

        issues = wcagMappedCriteria.map(c => ({
          code: c.code,
          message: c.description,
          severity: c.severity,
          wcagCriteria: c.wcagCriteria
            ? c.wcagCriteria.split(',').map(s => s.trim()).filter(Boolean)
            : undefined,
        }));

        otherIssuesData = otherCriteria.map(c => ({
          code: c.code || 'UNKNOWN',
          message: c.description || 'No description',
          severity: c.severity || 'unknown',
          location: c.location,
        }));

        logger.info(`[ACR Analysis] Converted ${issues.length} WCAG issues, ${otherCriteria.length} other issues`);
      }
    }
  } else {
    issues = (auditOutput?.combinedIssues || auditOutput?.issues || []) as AuditIssue[];
    logger.info(`[ACR Analysis] Using ${issues.length} issues from job output`);
  }

  logger.info(`[ACR] Analyzing job: ${jobId} with ${issues.length} issues`);

  // Get edition from job output if available
  const editionCode = (auditOutput?.selectedEdition || auditOutput?.editionCode) as string | undefined;

  const criteria = analyzeWcagCriteria(issues, editionCode, remediationChanges);

  const summary = {
    supports: criteria.filter(c => c.status === 'supports').length,
    partiallySupports: criteria.filter(c => c.status === 'partially_supports').length,
    doesNotSupport: criteria.filter(c => c.status === 'does_not_support').length,
    notApplicable: criteria.filter(c => c.status === 'not_applicable').length,
  };

  const overallConfidence = Math.round(
    criteria.reduce((sum, c) => sum + c.confidence, 0) / criteria.length
  );

  const analysis: AcrAnalysis = {
    jobId,
    criteria,
    overallConfidence,
    analyzedAt: new Date().toISOString(),
    summary,
  };

  if (otherIssuesData && otherIssuesData.length > 0) {
    analysis.otherIssues = {
      count: otherIssuesData.length,
      issues: otherIssuesData,
    };
  }

  const updatedOutput = auditOutput
    ? { ...auditOutput, acrAnalysis: JSON.parse(JSON.stringify(analysis)) }
    : { acrAnalysis: JSON.parse(JSON.stringify(analysis)) };

  await prisma.job.update({
    where: { id: jobId },
    data: {
      output: updatedOutput,
    },
  });

  return analysis;
}

export const acrAnalysisService = {
  getAnalysisForJob,
};
