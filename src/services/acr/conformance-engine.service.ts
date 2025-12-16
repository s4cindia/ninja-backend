import { humanVerificationService, VerificationRecord } from './human-verification.service';

export type ConformanceLevel = 'Supports' | 'Partially Supports' | 'Does Not Support' | 'Not Applicable';

export interface ConformanceDecision {
  level: ConformanceLevel;
  remarks: string;
  requiresHumanConfirmation: boolean;
  warningFlags: string[];
}

export interface ValidationResult {
  criterionId: string;
  passed: boolean;
  passCount?: number;
  failCount?: number;
  totalCount?: number;
  details?: string;
}

export interface CredibilityWarning {
  type: string;
  message: string;
  recommendation: string;
}

export interface AcrCriterion {
  criterionId: string;
  level: ConformanceLevel;
  remarks: string;
}

export interface AcrDocument {
  jobId: string;
  criteria: AcrCriterion[];
  edition: string;
}

export interface RemarksRequirement {
  level: ConformanceLevel;
  required: boolean;
  minimumLength: number;
  mustInclude: string[];
}

export const REMARKS_REQUIREMENTS: Record<ConformanceLevel, RemarksRequirement> = {
  'Supports': {
    level: 'Supports',
    required: false,
    minimumLength: 0,
    mustInclude: []
  },
  'Partially Supports': {
    level: 'Partially Supports',
    required: true,
    minimumLength: 50,
    mustInclude: ['what works', 'limitations']
  },
  'Does Not Support': {
    level: 'Does Not Support',
    required: true,
    minimumLength: 30,
    mustInclude: ['reason']
  },
  'Not Applicable': {
    level: 'Not Applicable',
    required: true,
    minimumLength: 20,
    mustInclude: ['justification']
  }
};

interface AutomatedAnalysisResult {
  level: ConformanceLevel;
  wouldBeSupports: boolean;
  remarks: string;
  passCount: number;
  failCount: number;
  totalCount: number;
}

function analyzeAutomatedResults(validationResults: ValidationResult[]): AutomatedAnalysisResult {
  if (validationResults.length === 0) {
    return {
      level: 'Not Applicable',
      wouldBeSupports: false,
      remarks: 'No validation data available for this criterion.',
      passCount: 0,
      failCount: 0,
      totalCount: 0
    };
  }

  let totalPass = 0;
  let totalFail = 0;
  let totalItems = 0;

  for (const result of validationResults) {
    if (result.passCount !== undefined && result.totalCount !== undefined) {
      totalPass += result.passCount;
      totalFail += result.failCount || 0;
      totalItems += result.totalCount;
    } else {
      totalItems += 1;
      if (result.passed) {
        totalPass += 1;
      } else {
        totalFail += 1;
      }
    }
  }

  const passRate = totalItems > 0 ? (totalPass / totalItems) * 100 : 0;

  if (passRate === 100 && totalItems > 0) {
    return {
      level: 'Supports',
      wouldBeSupports: true,
      remarks: `All ${totalItems} items passed automated validation.`,
      passCount: totalPass,
      failCount: totalFail,
      totalCount: totalItems
    };
  }

  if (passRate >= 75) {
    return {
      level: 'Partially Supports',
      wouldBeSupports: false,
      remarks: `${totalPass} of ${totalItems} items passed (${passRate.toFixed(1)}%). What works: ${totalPass} items meet requirements. Limitations: ${totalFail} items require remediation.`,
      passCount: totalPass,
      failCount: totalFail,
      totalCount: totalItems
    };
  }

  if (passRate >= 25) {
    return {
      level: 'Partially Supports',
      wouldBeSupports: false,
      remarks: `${totalPass} of ${totalItems} items passed (${passRate.toFixed(1)}%). What works: ${totalPass} items meet requirements. Limitations: ${totalFail} items do not meet requirements and need remediation.`,
      passCount: totalPass,
      failCount: totalFail,
      totalCount: totalItems
    };
  }

  return {
    level: 'Does Not Support',
    wouldBeSupports: false,
    remarks: `Only ${totalPass} of ${totalItems} items passed (${passRate.toFixed(1)}%). Reason: Majority of content does not meet accessibility requirements.`,
    passCount: totalPass,
    failCount: totalFail,
    totalCount: totalItems
  };
}

export async function determineConformance(
  criterionId: string,
  validationResults: ValidationResult[],
  humanVerification?: VerificationRecord
): Promise<ConformanceDecision> {
  const autoResult = analyzeAutomatedResults(validationResults);

  if (autoResult.wouldBeSupports && !humanVerification) {
    return {
      level: 'Partially Supports',
      remarks: `Automated testing indicates compliance (${autoResult.passCount} of ${autoResult.totalCount} items passed). Human verification pending to confirm 'Supports' status.`,
      requiresHumanConfirmation: true,
      warningFlags: ['AWAITING_HUMAN_VERIFICATION']
    };
  }

  if (autoResult.wouldBeSupports && humanVerification) {
    if (humanVerification.status === 'VERIFIED_PASS') {
      return {
        level: 'Supports',
        remarks: `${autoResult.passCount} of ${autoResult.totalCount} items passed automated validation. Human verification confirmed compliance on ${humanVerification.verifiedAt.toISOString().split('T')[0]}.`,
        requiresHumanConfirmation: false,
        warningFlags: []
      };
    } else if (humanVerification.status === 'VERIFIED_FAIL') {
      return {
        level: 'Does Not Support',
        remarks: `Automated testing showed compliance, but human verification identified issues. ${humanVerification.notes || 'See detailed findings.'}`,
        requiresHumanConfirmation: false,
        warningFlags: ['HUMAN_OVERRIDE']
      };
    } else if (humanVerification.status === 'VERIFIED_PARTIAL') {
      return {
        level: 'Partially Supports',
        remarks: `${autoResult.passCount} of ${autoResult.totalCount} items passed automated validation. Human verification identified partial compliance. ${humanVerification.notes || ''}`.trim(),
        requiresHumanConfirmation: false,
        warningFlags: []
      };
    }
  }

  if (autoResult.level !== 'Supports' && !autoResult.remarks) {
    throw new Error(`Remarks required for ${autoResult.level} status on criterion ${criterionId}`);
  }

  return {
    level: autoResult.level,
    remarks: autoResult.remarks,
    requiresHumanConfirmation: autoResult.level === 'Supports',
    warningFlags: []
  };
}

export function validateRemarks(
  level: ConformanceLevel,
  remarks: string
): { valid: boolean; errors: string[] } {
  const requirements = REMARKS_REQUIREMENTS[level];
  const errors: string[] = [];

  if (requirements.required && (!remarks || remarks.trim().length === 0)) {
    errors.push(`Remarks required for "${level}" status`);
    return { valid: false, errors };
  }

  if (remarks && remarks.length < requirements.minimumLength) {
    errors.push(`Remarks must be at least ${requirements.minimumLength} characters for "${level}" status (current: ${remarks.length})`);
  }

  const remarksLower = remarks.toLowerCase();
  for (const keyword of requirements.mustInclude) {
    const keywordVariants = getKeywordVariants(keyword);
    const hasKeyword = keywordVariants.some(variant => remarksLower.includes(variant.toLowerCase()));
    if (!hasKeyword) {
      errors.push(`Remarks for "${level}" should address: ${keyword}`);
    }
  }

  return { valid: errors.length === 0, errors };
}

function getKeywordVariants(keyword: string): string[] {
  const variants: Record<string, string[]> = {
    'what works': ['what works', 'working', 'compliant', 'passed', 'supports', 'meets'],
    'limitations': ['limitations', 'limitation', 'issues', 'problems', 'fails', 'does not', 'doesn\'t'],
    'reason': ['reason', 'because', 'due to', 'caused by', 'issue', 'problem'],
    'workaround': ['workaround', 'alternative', 'instead', 'however', 'can use'],
    'justification': ['justification', 'because', 'since', 'as', 'not applicable', 'does not apply', 'n/a']
  };
  return variants[keyword] || [keyword];
}

export function validateAcrCredibility(acr: AcrDocument): CredibilityWarning[] {
  const warnings: CredibilityWarning[] = [];

  if (acr.criteria.length === 0) {
    warnings.push({
      type: 'EMPTY_ACR',
      message: 'ACR contains no criteria evaluations.',
      recommendation: 'Ensure all relevant criteria are evaluated before finalizing.'
    });
    return warnings;
  }

  const supportsCount = acr.criteria.filter(c => c.level === 'Supports').length;
  const supportsPercentage = (supportsCount / acr.criteria.length) * 100;

  if (supportsPercentage > 95) {
    warnings.push({
      type: 'HIGH_COMPLIANCE_WARNING',
      message: `ACR shows ${supportsPercentage.toFixed(1)}% "Supports" ratings (${supportsCount} of ${acr.criteria.length} criteria). Sophisticated procurement teams may view this skeptically.`,
      recommendation: 'Review each criterion carefully. Consider adding detailed remarks even for "Supports" items to demonstrate thorough evaluation.'
    });
  }

  if (supportsPercentage === 100 && acr.criteria.length > 5) {
    warnings.push({
      type: 'PERFECT_COMPLIANCE_RED_FLAG',
      message: '100% "Supports" rating across all criteria is extremely rare and may appear fraudulent.',
      recommendation: 'Verify all automated and manual testing was thorough. Add comprehensive remarks explaining how each criterion was validated.'
    });
  }

  const criteriaWithoutRemarks = acr.criteria.filter(c => 
    c.level !== 'Supports' && (!c.remarks || c.remarks.trim().length < 20)
  );

  if (criteriaWithoutRemarks.length > 0) {
    warnings.push({
      type: 'MISSING_REMARKS',
      message: `${criteriaWithoutRemarks.length} non-"Supports" criteria lack adequate remarks.`,
      recommendation: 'Add detailed remarks explaining the compliance status for each criterion.'
    });
  }

  const notApplicableCount = acr.criteria.filter(c => c.level === 'Not Applicable').length;
  const notApplicablePercentage = (notApplicableCount / acr.criteria.length) * 100;

  if (notApplicablePercentage > 30) {
    warnings.push({
      type: 'HIGH_NOT_APPLICABLE',
      message: `${notApplicablePercentage.toFixed(1)}% of criteria marked "Not Applicable" (${notApplicableCount} of ${acr.criteria.length}).`,
      recommendation: 'Verify that "Not Applicable" designations are justified. Procurement teams may question high N/A rates.'
    });
  }

  return warnings;
}

export interface CredibilityValidationResult {
  credible: boolean;
  warnings: CredibilityWarning[];
  summary: {
    totalCriteria: number;
    supportsCount: number;
    partiallySupportsCount: number;
    doesNotSupportCount: number;
    notApplicableCount: number;
    supportsPercentage: number;
  };
}

export function validateAcrCredibilityFull(acr: AcrDocument): CredibilityValidationResult {
  const warnings = validateAcrCredibility(acr);

  const supportsCount = acr.criteria.filter(c => c.level === 'Supports').length;
  const partiallySupportsCount = acr.criteria.filter(c => c.level === 'Partially Supports').length;
  const doesNotSupportCount = acr.criteria.filter(c => c.level === 'Does Not Support').length;
  const notApplicableCount = acr.criteria.filter(c => c.level === 'Not Applicable').length;

  const hasBlockingWarnings = warnings.some(w => 
    w.type === 'PERFECT_COMPLIANCE_RED_FLAG' || 
    w.type === 'MISSING_REMARKS'
  );

  return {
    credible: !hasBlockingWarnings,
    warnings,
    summary: {
      totalCriteria: acr.criteria.length,
      supportsCount,
      partiallySupportsCount,
      doesNotSupportCount,
      notApplicableCount,
      supportsPercentage: acr.criteria.length > 0 
        ? (supportsCount / acr.criteria.length) * 100 
        : 0
    }
  };
}

export async function buildAcrFromJob(jobId: string): Promise<AcrDocument | null> {
  const queue = await humanVerificationService.getQueueFromJob(jobId);

  if (!queue || queue.items.length === 0) {
    return null;
  }

  const criteria: AcrCriterion[] = [];

  for (const item of queue.items) {
    const validationResults: ValidationResult[] = [{
      criterionId: item.criterionId,
      passed: item.automatedResult === 'pass',
      totalCount: 1,
      passCount: item.automatedResult === 'pass' ? 1 : 0,
      failCount: item.automatedResult === 'fail' ? 1 : 0
    }];

    const latestVerification = item.verificationHistory.length > 0 
      ? item.verificationHistory[item.verificationHistory.length - 1] 
      : undefined;

    const decision = await determineConformance(
      item.criterionId,
      validationResults,
      latestVerification
    );

    criteria.push({
      criterionId: item.criterionId,
      level: decision.level,
      remarks: decision.remarks
    });
  }

  return {
    jobId,
    criteria,
    edition: 'VPAT2.5-INT'
  };
}

class ConformanceEngineService {
  async determineConformance(
    criterionId: string,
    validationResults: ValidationResult[],
    humanVerification?: VerificationRecord
  ): Promise<ConformanceDecision> {
    return determineConformance(criterionId, validationResults, humanVerification);
  }

  validateRemarks(level: ConformanceLevel, remarks: string): { valid: boolean; errors: string[] } {
    return validateRemarks(level, remarks);
  }

  validateAcrCredibility(acr: AcrDocument): CredibilityWarning[] {
    return validateAcrCredibility(acr);
  }

  validateAcrCredibilityFull(acr: AcrDocument): CredibilityValidationResult {
    return validateAcrCredibilityFull(acr);
  }

  async buildAcrFromJob(jobId: string): Promise<AcrDocument | null> {
    return buildAcrFromJob(jobId);
  }

  getRemarksRequirements(): Record<ConformanceLevel, RemarksRequirement> {
    return REMARKS_REQUIREMENTS;
  }
}

export const conformanceEngineService = new ConformanceEngineService();
