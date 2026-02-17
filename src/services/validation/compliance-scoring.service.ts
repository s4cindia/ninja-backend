export interface ValidationResultForScoring {
  passed: boolean;
  ruleId: string;
  severity: 'error' | 'warning' | 'info';
}

export interface ComplianceScore {
  overallScore: number;
  passed: boolean;
  totalRules: number;
  passedRules: number;
  failedRules: number;
  errorCount: number;
  warningCount: number;
  infoCount: number;
  breakdown: {
    errors: { passed: number; failed: number };
    warnings: { passed: number; failed: number };
    info: { passed: number; failed: number };
  };
}

export type ComplianceLevel = 'high' | 'medium' | 'low' | 'non-compliant';

const SEVERITY_WEIGHTS = {
  error: 10,
  warning: 3,
  info: 1
};

const COMPLIANCE_THRESHOLDS = {
  high: 90,
  medium: 70,
  low: 50
};

export class ComplianceScoringService {
  calculateScore(results: ValidationResultForScoring[]): ComplianceScore {
    if (results.length === 0) {
      return {
        overallScore: 100,
        passed: true,
        totalRules: 0,
        passedRules: 0,
        failedRules: 0,
        errorCount: 0,
        warningCount: 0,
        infoCount: 0,
        breakdown: {
          errors: { passed: 0, failed: 0 },
          warnings: { passed: 0, failed: 0 },
          info: { passed: 0, failed: 0 }
        }
      };
    }

    const breakdown = {
      errors: { passed: 0, failed: 0 },
      warnings: { passed: 0, failed: 0 },
      info: { passed: 0, failed: 0 }
    };

    let totalWeight = 0;
    let passedWeight = 0;

    for (const result of results) {
      const weight = SEVERITY_WEIGHTS[result.severity] || 1;
      totalWeight += weight;

      if (result.passed) {
        passedWeight += weight;
        if (result.severity === 'error') breakdown.errors.passed++;
        else if (result.severity === 'warning') breakdown.warnings.passed++;
        else breakdown.info.passed++;
      } else {
        if (result.severity === 'error') breakdown.errors.failed++;
        else if (result.severity === 'warning') breakdown.warnings.failed++;
        else breakdown.info.failed++;
      }
    }

    const overallScore = totalWeight > 0 
      ? Math.round((passedWeight / totalWeight) * 100) 
      : 100;

    const passedRules = results.filter(r => r.passed).length;
    const failedRules = results.filter(r => !r.passed).length;

    return {
      overallScore,
      passed: breakdown.errors.failed === 0,
      totalRules: results.length,
      passedRules,
      failedRules,
      errorCount: breakdown.errors.failed,
      warningCount: breakdown.warnings.failed,
      infoCount: breakdown.info.failed,
      breakdown
    };
  }

  getComplianceLevel(score: number): ComplianceLevel {
    if (score >= COMPLIANCE_THRESHOLDS.high) return 'high';
    if (score >= COMPLIANCE_THRESHOLDS.medium) return 'medium';
    if (score >= COMPLIANCE_THRESHOLDS.low) return 'low';
    return 'non-compliant';
  }

  getComplianceSummary(score: ComplianceScore): string {
    const level = this.getComplianceLevel(score.overallScore);
    const levelLabels = {
      high: 'Highly Compliant',
      medium: 'Partially Compliant',
      low: 'Low Compliance',
      'non-compliant': 'Non-Compliant'
    };

    return `${levelLabels[level]} (${score.overallScore}%) - ${score.passedRules}/${score.totalRules} rules passed`;
  }
}

export const complianceScoringService = new ComplianceScoringService();
