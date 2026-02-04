import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import acrEditionsData from '../../data/acrEditions.json';
import { acrVersioningService } from './acr-versioning.service';
import { RULE_TO_CRITERIA_MAP } from './wcag-issue-mapper.service';
import { contentDetectionService, ApplicabilitySuggestion } from './content-detection.service';
import { fileStorageService } from '../storage/file-storage.service';

// Derive WCAG-mapped codes from RULE_TO_CRITERIA_MAP (only rules with non-empty mappings)
const WCAG_MAPPED_CODES = new Set(
  Object.entries(RULE_TO_CRITERIA_MAP)
    .filter(([, criteria]) => criteria && criteria.length > 0)
    .map(([rule]) => rule)
);

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
  naSuggestion?: ApplicabilitySuggestion;
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

/**
 * Helper to check if an issue was fixed based on remediation changes
 * Checks both issue code and criterion ID to handle different remediation scenarios
 */
function isIssueFixed(
  issueCode: string,
  criterionId: string,
  remediationChanges: RemediationChange[]
): boolean {
  return remediationChanges.some(change =>
    change.issueCode === issueCode ||
    change.criterionId === criterionId ||
    (change.issues && change.issues.some(i => i.code === issueCode))
  );
}

function analyzeWcagCriteria(
  issues: AuditIssue[],
  editionCode?: string,
  remediationChanges: RemediationChange[] = [],
  naSuggestions: ApplicabilitySuggestion[] = []
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

    // First, determine which issues are fixed
    const issuesWithFixStatus = relatedIssues.map(issue => {
      const issueCode = issue.code || 'unknown';
      const wasFixed = isIssueFixed(issueCode, criterion.id, remediationChanges);
      return { ...issue, wasFixed };
    });

    const fixedIssues = issuesWithFixStatus.filter(i => i.wasFixed);
    const remainingIssues = issuesWithFixStatus.filter(i => !i.wasFixed);
    const totalIssues = relatedIssues.length;

    logger.info(`[ACR Analysis] Criterion ${criterion.id}: ${fixedIssues.length}/${totalIssues} issues fixed, ${remainingIssues.length} remaining`);

    if (totalIssues === 0) {
      status = 'supports';
      confidence = 75;
      findings = ['No accessibility issues detected for this criterion'];
      recommendation = 'Continue to maintain compliance with this criterion';
    } else if (remainingIssues.length === 0) {
      // All issues were fixed!
      status = 'supports';
      confidence = 95;
      findings = [`All ${totalIssues} issue(s) have been remediated`];
      recommendation = 'All issues have been resolved - excellent work!';
    } else {
      // Determine status based on REMAINING issues only (not all issues)
      const criticalCount = remainingIssues.filter(i => i.severity === 'critical').length;
      const seriousCount = remainingIssues.filter(i => i.severity === 'serious').length;
      const moderateCount = remainingIssues.filter(i => i.severity === 'moderate').length;
      const minorCount = remainingIssues.filter(i => i.severity === 'minor').length;
      const unknownCount = remainingIssues.filter(i =>
        !i.severity || !KNOWN_SEVERITIES.includes(i.severity)
      ).length;

      if (criticalCount > 0) {
        status = 'does_not_support';
        confidence = 90;
        recommendation = `${criticalCount} critical issue(s) must be resolved for compliance`;
      } else if (seriousCount > 0) {
        status = 'partially_supports';
        confidence = 80;
        recommendation = `${seriousCount} serious issue(s) should be addressed to improve compliance`;
      } else if (moderateCount > 0) {
        status = 'partially_supports';
        confidence = 70;
        recommendation = `${moderateCount} moderate issue(s) may affect some users`;
      } else if (unknownCount > 0) {
        status = 'partially_supports';
        confidence = 60;
        recommendation = 'Issues with unknown severity require manual review';
      } else if (minorCount > 0) {
        status = 'supports';
        confidence = 85;
        recommendation = `${minorCount} minor issue(s) detected but overall compliance is maintained`;
      } else {
        status = 'supports';
        confidence = 85;
        recommendation = 'Issues detected but overall compliance is maintained';
      }

      // Include fixed issues in findings
      const fixedFindings = fixedIssues.length > 0
        ? [`✓ ${fixedIssues.length} issue(s) have been fixed`]
        : [];

      const remainingFindings = remainingIssues.map(issue =>
        `${(issue.severity || 'ISSUE').toUpperCase()}: ${
          issue.message || issue.description ||
          (issue.code ? `Issue code: ${issue.code}` : 'Unspecified accessibility issue')
        }`
      ).slice(0, 4);

      findings = [...fixedFindings, ...remainingFindings];
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

      const wasFixed = isIssueFixed(issueCode, criterion.id, remediationChanges);

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

    // Find matching N/A suggestion for this criterion
    const naSuggestion = naSuggestions.find(s => {
      // Match exact criterion ID (e.g., "1.2.1") or group ID (e.g., "1.2.x")
      if (s.criterionId === criterion.id) return true;

      // Match group patterns (e.g., "1.2.x" matches "1.2.1", "1.2.2", etc.)
      if (s.criterionId.endsWith('.x')) {
        const prefix = s.criterionId.slice(0, -2);
        return criterion.id.startsWith(prefix + '.');
      }

      return false;
    });

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
      naSuggestion: naSuggestion || undefined,
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

  // Run content detection to generate N/A suggestions
  let naSuggestions: ApplicabilitySuggestion[] = [];
  try {
    const jobInput = job.input as Record<string, unknown> | null;
    const epubFileName = jobInput?.epubFileName as string | undefined;

    if (epubFileName) {
      logger.info(`[ACR] Running content detection on EPUB: ${epubFileName}`);
      const epubBuffer = await fileStorageService.getFile(jobId, epubFileName);

      if (epubBuffer) {
        naSuggestions = await contentDetectionService.analyzeEPUBContent(epubBuffer);
        logger.info(`[ACR] Content detection generated ${naSuggestions.length} N/A suggestions`);
      } else {
        logger.warn(`[ACR] EPUB file not found in storage: ${epubFileName}`);
      }
    } else {
      logger.warn(`[ACR] No EPUB filename found in job input, skipping content detection`);
    }
  } catch (error) {
    logger.error('[ACR] Content detection failed, continuing without N/A suggestions', error instanceof Error ? error : undefined);
    naSuggestions = [];
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
          logger.info(`[ACR Analysis] Found ${allIssues.length} total issues from source job (combinedIssues path)`);

          // DEBUG: Log source output keys to understand structure
          logger.info(`[ACR DEBUG] Source output keys: ${Object.keys(sourceOutput || {})}`);

          // Check if there's remediation info - can be in remediationPlan.tasks OR autoRemediation.modifications
          const remPlan = sourceOutput?.remediationPlan as { tasks?: Array<{ issueCode?: string; status?: string; completedAt?: string; wcagCriteria?: string | string[] }> } | undefined;
          const autoRem = sourceOutput?.autoRemediation as { modifications?: Array<{ issueCode?: string; success?: boolean; description?: string }> } | undefined;
          
          if (remPlan?.tasks) {
            logger.info(`[ACR DEBUG] Found remediationPlan with ${remPlan.tasks.length} tasks`);
            
            // Build remediationChanges from remediation plan tasks
            const fixedTasks = remPlan.tasks.filter(task =>
              task.status === 'fixed' || task.status === 'completed' || task.status === 'auto-fixed'
            );

            remediationChanges = fixedTasks.map(task => ({
              issueCode: task.issueCode,
              status: task.status,
              fixedAt: task.completedAt || new Date().toISOString(),
            }));

            logger.info(`[ACR Analysis] Found ${remediationChanges.length} fixed tasks from remediationPlan`);
          } else if (autoRem?.modifications) {
            logger.info(`[ACR DEBUG] Found autoRemediation with ${autoRem.modifications.length} modifications`);
            
            // Build remediationChanges from successful auto-remediation modifications
            const successfulMods = autoRem.modifications.filter(mod => mod.success === true);
            
            remediationChanges = successfulMods.map(mod => ({
              issueCode: mod.issueCode,
              status: 'auto-fixed',
              fixedAt: (sourceOutput?.autoRemediation as { completedAt?: string })?.completedAt || new Date().toISOString(),
            }));

            logger.info(`[ACR Analysis] Found ${remediationChanges.length} fixed modifications from autoRemediation`);
          } else {
            logger.info(`[ACR DEBUG] No remediationPlan or autoRemediation found in source output`);
          }

          // NOTE: combinedIssues don't have wcagCriteria property - that mapping happens in analyzeWcagCriteria
          // Pass ALL issues to the analyzer which handles WCAG mapping via issueToWcagMapping
          issues = allIssues;
          
          // Track issues that have no WCAG mapping (derived from RULE_TO_CRITERIA_MAP)
          const otherIssues = allIssues.filter(issue => !WCAG_MAPPED_CODES.has(issue.code || ''));

          otherIssuesData = otherIssues.map(issue => ({
            code: issue.code || 'UNKNOWN',
            message: issue.message || issue.description || 'No description',
            severity: issue.severity || 'unknown',
            location: issue.location,
          }));

          logger.info(`[ACR Analysis] Passing ${issues.length} issues to analyzer, ${otherIssues.length} non-WCAG issues`);
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

  const criteria = analyzeWcagCriteria(issues, editionCode, remediationChanges, naSuggestions);

  const summary = {
    supports: criteria.filter(c => c.status === 'supports').length,
    partiallySupports: criteria.filter(c => c.status === 'partially_supports').length,
    doesNotSupport: criteria.filter(c => c.status === 'does_not_support').length,
    notApplicable: criteria.filter(c => c.status === 'not_applicable').length,
  };

  // Calculate overall confidence with remediation awareness
  const totalFixedIssues = criteria.reduce((sum, c) => sum + (c.fixedCount || 0), 0);
  const totalRemainingIssues = criteria.reduce((sum, c) => sum + (c.remainingCount || 0), 0);
  const totalIssues = totalFixedIssues + totalRemainingIssues;

  let baseConfidence = Math.round(
    criteria.reduce((sum, c) => sum + c.confidence, 0) / criteria.length
  );

  // Add remediation bonus if issues were fixed
  if (totalIssues > 0 && totalFixedIssues > 0) {
    const remediationRate = totalFixedIssues / totalIssues;
    const remediationBonus = Math.min(Math.round(remediationRate * 15), 15);
    baseConfidence = Math.min(100, baseConfidence + remediationBonus);
    logger.info(`[ACR Analysis] Remediation bonus: +${remediationBonus}% (${totalFixedIssues}/${totalIssues} issues fixed)`);
  }

  const overallConfidence = baseConfidence;

  logger.info(`[ACR Analysis] Overall confidence: ${overallConfidence}% (${totalFixedIssues} fixed, ${totalRemainingIssues} remaining of ${totalIssues} total)`);

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

  // Create version after AI analysis completes
  try {
    const acrDocument = {
      id: jobId,
      version: 1,
      status: 'draft' as const,
      edition: (editionCode || 'VPAT2.5-INT') as 'VPAT2.5-508' | 'VPAT2.5-WCAG' | 'VPAT2.5-EU' | 'VPAT2.5-INT',
      productInfo: {
        name: (auditOutput?.epubTitle as string) || 'Unknown Product',
        version: '1.0',
        vendor: '',
        description: '',
        contactEmail: '',
        evaluationDate: new Date(),
      },
      evaluationMethods: [{
        type: 'automated' as const,
        tools: ['Ninja ACR Analyzer'],
        aiModels: ['Gemini 2.0 Flash'],
        description: 'AI-assisted automated accessibility analysis'
      }],
      criteria: criteria.map(c => ({
        id: c.id,
        criterionId: c.id,
        name: c.name,
        level: c.level as 'A' | 'AA' | 'AAA',
        conformanceLevel: c.status === 'supports' ? 'Supports' as const :
                         c.status === 'partially_supports' ? 'Partially Supports' as const :
                         c.status === 'does_not_support' ? 'Does Not Support' as const :
                         'Not Applicable' as const,
        remarks: c.findings.join('. '),
        attributionTag: 'AI_SUGGESTED' as const,
        attributedRemarks: `[AI-SUGGESTED] ${c.findings.join('. ')}`,
      })),
      generatedAt: new Date(),
    };

    await acrVersioningService.createVersion(
      jobId,
      acrDocument,
      'system-ai',
      'AI-generated initial assessment'
    );
    logger.info(`Created version for ACR ${jobId} after AI analysis`);
  } catch (error) {
    logger.error(`Failed to create version for ACR ${jobId}`, error instanceof Error ? error : undefined);
    // Don't throw - version creation failure shouldn't stop ACR workflow
  }

  return analysis;
}

export const acrAnalysisService = {
  getAnalysisForJob,
};
