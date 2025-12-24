import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

interface WcagCriterionAnalysis {
  id: string;
  name: string;
  level: 'A' | 'AA' | 'AAA';
  category: string;
  status: 'pass' | 'fail' | 'partial' | 'not_applicable' | 'not_tested';
  confidence: 'HIGH' | 'MEDIUM' | 'LOW' | 'MANUAL_REQUIRED';
  issueCount: number;
  remarks: string;
}

interface AcrAnalysis {
  jobId: string;
  analyzedAt: Date;
  wcagVersion: string;
  totalCriteria: number;
  passedCriteria: number;
  failedCriteria: number;
  partialCriteria: number;
  notApplicableCriteria: number;
  notTestedCriteria: number;
  overallScore: number;
  criteria: WcagCriterionAnalysis[];
  summary: {
    perceivable: { pass: number; fail: number; total: number };
    operable: { pass: number; fail: number; total: number };
    understandable: { pass: number; fail: number; total: number };
    robust: { pass: number; fail: number; total: number };
  };
}

const WCAG_21_AA_CRITERIA: Array<{ id: string; name: string; level: 'A' | 'AA'; category: string }> = [
  { id: '1.1.1', name: 'Non-text Content', level: 'A', category: 'perceivable' },
  { id: '1.2.1', name: 'Audio-only and Video-only (Prerecorded)', level: 'A', category: 'perceivable' },
  { id: '1.2.2', name: 'Captions (Prerecorded)', level: 'A', category: 'perceivable' },
  { id: '1.2.3', name: 'Audio Description or Media Alternative (Prerecorded)', level: 'A', category: 'perceivable' },
  { id: '1.2.5', name: 'Audio Description (Prerecorded)', level: 'AA', category: 'perceivable' },
  { id: '1.3.1', name: 'Info and Relationships', level: 'A', category: 'perceivable' },
  { id: '1.3.2', name: 'Meaningful Sequence', level: 'A', category: 'perceivable' },
  { id: '1.3.3', name: 'Sensory Characteristics', level: 'A', category: 'perceivable' },
  { id: '1.3.4', name: 'Orientation', level: 'AA', category: 'perceivable' },
  { id: '1.3.5', name: 'Identify Input Purpose', level: 'AA', category: 'perceivable' },
  { id: '1.4.1', name: 'Use of Color', level: 'A', category: 'perceivable' },
  { id: '1.4.2', name: 'Audio Control', level: 'A', category: 'perceivable' },
  { id: '1.4.3', name: 'Contrast (Minimum)', level: 'AA', category: 'perceivable' },
  { id: '1.4.4', name: 'Resize Text', level: 'AA', category: 'perceivable' },
  { id: '1.4.5', name: 'Images of Text', level: 'AA', category: 'perceivable' },
  { id: '1.4.10', name: 'Reflow', level: 'AA', category: 'perceivable' },
  { id: '1.4.11', name: 'Non-text Contrast', level: 'AA', category: 'perceivable' },
  { id: '1.4.12', name: 'Text Spacing', level: 'AA', category: 'perceivable' },
  { id: '1.4.13', name: 'Content on Hover or Focus', level: 'AA', category: 'perceivable' },
  { id: '2.1.1', name: 'Keyboard', level: 'A', category: 'operable' },
  { id: '2.1.2', name: 'No Keyboard Trap', level: 'A', category: 'operable' },
  { id: '2.1.4', name: 'Character Key Shortcuts', level: 'A', category: 'operable' },
  { id: '2.2.1', name: 'Timing Adjustable', level: 'A', category: 'operable' },
  { id: '2.2.2', name: 'Pause, Stop, Hide', level: 'A', category: 'operable' },
  { id: '2.3.1', name: 'Three Flashes or Below Threshold', level: 'A', category: 'operable' },
  { id: '2.4.1', name: 'Bypass Blocks', level: 'A', category: 'operable' },
  { id: '2.4.2', name: 'Page Titled', level: 'A', category: 'operable' },
  { id: '2.4.3', name: 'Focus Order', level: 'A', category: 'operable' },
  { id: '2.4.4', name: 'Link Purpose (In Context)', level: 'A', category: 'operable' },
  { id: '2.4.5', name: 'Multiple Ways', level: 'AA', category: 'operable' },
  { id: '2.4.6', name: 'Headings and Labels', level: 'AA', category: 'operable' },
  { id: '2.4.7', name: 'Focus Visible', level: 'AA', category: 'operable' },
  { id: '2.5.1', name: 'Pointer Gestures', level: 'A', category: 'operable' },
  { id: '2.5.2', name: 'Pointer Cancellation', level: 'A', category: 'operable' },
  { id: '2.5.3', name: 'Label in Name', level: 'A', category: 'operable' },
  { id: '2.5.4', name: 'Motion Actuation', level: 'A', category: 'operable' },
  { id: '3.1.1', name: 'Language of Page', level: 'A', category: 'understandable' },
  { id: '3.1.2', name: 'Language of Parts', level: 'AA', category: 'understandable' },
  { id: '3.2.1', name: 'On Focus', level: 'A', category: 'understandable' },
  { id: '3.2.2', name: 'On Input', level: 'A', category: 'understandable' },
  { id: '3.2.3', name: 'Consistent Navigation', level: 'AA', category: 'understandable' },
  { id: '3.2.4', name: 'Consistent Identification', level: 'AA', category: 'understandable' },
  { id: '3.3.1', name: 'Error Identification', level: 'A', category: 'understandable' },
  { id: '3.3.2', name: 'Labels or Instructions', level: 'A', category: 'understandable' },
  { id: '3.3.3', name: 'Error Suggestion', level: 'AA', category: 'understandable' },
  { id: '3.3.4', name: 'Error Prevention (Legal, Financial, Data)', level: 'AA', category: 'understandable' },
  { id: '4.1.1', name: 'Parsing', level: 'A', category: 'robust' },
  { id: '4.1.2', name: 'Name, Role, Value', level: 'A', category: 'robust' },
  { id: '4.1.3', name: 'Status Messages', level: 'AA', category: 'robust' },
];

function mapIssueToWcagCriteria(issueCode: string): string[] {
  const mapping: Record<string, string[]> = {
    'EPUB-IMG-001': ['1.1.1'],
    'EPUB-META-001': ['3.1.1'],
    'EPUB-META-002': ['4.1.2'],
    'EPUB-META-003': ['4.1.2'],
    'EPUB-META-004': ['4.1.2'],
    'EPUB-SEM-001': ['3.1.1'],
    'EPUB-SEM-002': ['2.4.4'],
    'EPUB-STRUCT-002': ['1.3.1'],
    'EPUB-STRUCT-003': ['1.3.1', '2.4.6'],
    'EPUB-STRUCT-004': ['2.4.1'],
    'EPUB-NAV-001': ['2.4.1'],
    'EPUB-FIG-001': ['1.1.1', '1.3.1'],
  };

  for (const [pattern, criteria] of Object.entries(mapping)) {
    if (issueCode.includes(pattern) || issueCode.startsWith(pattern.split('-')[0])) {
      return criteria;
    }
  }
  
  return [];
}

export async function getAnalysisForJob(jobId: string, userId: string): Promise<AcrAnalysis> {
  const job = await prisma.job.findFirst({
    where: {
      id: jobId,
      userId: userId
    },
  });

  if (!job) {
    throw new Error('Job not found or access denied');
  }

  if (job.output && typeof job.output === 'object' && 'acrAnalysis' in (job.output as Record<string, unknown>)) {
    const cached = (job.output as Record<string, unknown>).acrAnalysis as AcrAnalysis;
    logger.info(`Returning cached ACR analysis for job ${jobId}`);
    return cached;
  }

  const issues = (job.output as Record<string, unknown>)?.combinedIssues as Array<{
    code: string;
    severity: string;
    message: string;
    wcagCriteria?: string[];
  }> || [];

  const criteriaIssueMap = new Map<string, number>();
  
  for (const issue of issues) {
    const wcagCriteria = issue.wcagCriteria || mapIssueToWcagCriteria(issue.code);
    for (const criterion of wcagCriteria) {
      criteriaIssueMap.set(criterion, (criteriaIssueMap.get(criterion) || 0) + 1);
    }
  }

  const analyzedCriteria: WcagCriterionAnalysis[] = WCAG_21_AA_CRITERIA.map(criterion => {
    const issueCount = criteriaIssueMap.get(criterion.id) || 0;
    let status: WcagCriterionAnalysis['status'];
    let confidence: WcagCriterionAnalysis['confidence'];
    let remarks: string;

    if (issueCount === 0) {
      status = 'pass';
      confidence = 'HIGH';
      remarks = 'No issues detected for this criterion.';
    } else if (issueCount <= 2) {
      status = 'partial';
      confidence = 'MEDIUM';
      remarks = `${issueCount} issue(s) detected. Manual review recommended.`;
    } else {
      status = 'fail';
      confidence = 'LOW';
      remarks = `${issueCount} issues detected. Requires remediation.`;
    }

    return {
      id: criterion.id,
      name: criterion.name,
      level: criterion.level,
      category: criterion.category,
      status,
      confidence,
      issueCount,
      remarks,
    };
  });

  const summary = {
    perceivable: { pass: 0, fail: 0, total: 0 },
    operable: { pass: 0, fail: 0, total: 0 },
    understandable: { pass: 0, fail: 0, total: 0 },
    robust: { pass: 0, fail: 0, total: 0 },
  };

  for (const criterion of analyzedCriteria) {
    const cat = criterion.category as keyof typeof summary;
    summary[cat].total++;
    if (criterion.status === 'pass') {
      summary[cat].pass++;
    } else if (criterion.status === 'fail') {
      summary[cat].fail++;
    }
  }

  const passedCriteria = analyzedCriteria.filter(c => c.status === 'pass').length;
  const failedCriteria = analyzedCriteria.filter(c => c.status === 'fail').length;
  const partialCriteria = analyzedCriteria.filter(c => c.status === 'partial').length;
  const notApplicableCriteria = analyzedCriteria.filter(c => c.status === 'not_applicable').length;
  const notTestedCriteria = analyzedCriteria.filter(c => c.status === 'not_tested').length;

  const overallScore = Math.round((passedCriteria / analyzedCriteria.length) * 100);

  const analysis: AcrAnalysis = {
    jobId,
    analyzedAt: new Date(),
    wcagVersion: '2.1',
    totalCriteria: analyzedCriteria.length,
    passedCriteria,
    failedCriteria,
    partialCriteria,
    notApplicableCriteria,
    notTestedCriteria,
    overallScore,
    criteria: analyzedCriteria,
    summary,
  };

  await prisma.job.update({
    where: { id: jobId },
    data: {
      output: JSON.parse(JSON.stringify({
        ...(job.output as Record<string, unknown> || {}),
        acrAnalysis: analysis,
      })),
    },
  });

  logger.info(`Generated and cached ACR analysis for job ${jobId}`);
  return analysis;
}

export const acrAnalysisService = {
  getAnalysisForJob,
};
