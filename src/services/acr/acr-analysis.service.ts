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
  code?: string;
  wcagCriteria?: string[];
  severity?: string;
  message?: string;
  description?: string;
}

function analyzeWcagCriteria(issues: AuditIssue[], editionCode?: string): CriterionAnalysis[] {
  const criteriaAnalysis: CriterionAnalysis[] = [];
  const editionCriteria = getEditionCriteria(editionCode);

  logger.info(`[ACR Analysis] Analyzing ${editionCriteria.length} criteria for edition: ${editionCode || 'default (A+AA)'}`);

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

    criteriaAnalysis.push({
      id: criterion.id,
      name: criterion.name,
      level: criterion.level,
      category: criterion.category,
      status,
      confidence,
      findings,
      recommendation,
    });
  }

  return criteriaAnalysis;
}

export async function getAnalysisForJob(jobId: string, userId?: string): Promise<AcrAnalysis> {
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

  if (auditOutput?.acrAnalysis) {
    logger.info(`[ACR] Returning cached analysis for job: ${jobId}`);
    return auditOutput.acrAnalysis as AcrAnalysis;
  }

  let issues: AuditIssue[] = [];
  let otherIssuesData: Array<{ code: string; message: string; severity: string; location?: string }> = [];

  if (job.type === 'ACR_WORKFLOW') {
    logger.info(`[ACR DEBUG] ACR_WORKFLOW detected`);

    if (auditOutput?.criteria) {
      const criteria = auditOutput.criteria as Array<{
        code?: string;
        description?: string;
        severity?: string;
        location?: string;
        wcagCriteria?: string | null;
      }>;

      logger.info(`[ACR DEBUG] Found ${criteria.length} ACR criteria`);

      const wcagMappedCriteria = criteria.filter(c => c.wcagCriteria);
      const otherCriteria = criteria.filter(c => !c.wcagCriteria);

      logger.info(`[ACR DEBUG] WCAG-mapped: ${wcagMappedCriteria.length}, Other: ${otherCriteria.length}`);

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

      logger.info(`[ACR] Converted ${issues.length} WCAG issues, ${otherCriteria.length} other issues`);
    }
  } else {
    issues = (auditOutput?.combinedIssues || auditOutput?.issues || []) as AuditIssue[];
  }

  logger.info(`[ACR] Analyzing job: ${jobId} with ${issues.length} issues`);

  // Get edition from job output if available
  const editionCode = (auditOutput?.selectedEdition || auditOutput?.editionCode) as string | undefined;

  const criteria = analyzeWcagCriteria(issues, editionCode);

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
