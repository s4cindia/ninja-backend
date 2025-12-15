import { section508WcagMappings, Section508WcagMapping, getPdfUaRelevantMappings } from '../../data/section508-wcag-mapping';
import { logger } from '../../lib/logger';

export type ConformanceLevel = 
  | 'Supports'
  | 'Partially Supports'
  | 'Does Not Support'
  | 'Not Applicable';

export interface Section508Criterion {
  criterionId: string;
  title: string;
  wcagMapping: string[];
  conformanceLevel: ConformanceLevel;
  remarks: string;
}

export interface BestMeetsGuidance {
  criterionId: string;
  currentStatus: ConformanceLevel;
  bestMeetsLanguage: string;
  improvementPath?: string;
}

export interface CompetitorInfo {
  name?: string;
  knownWeaknesses?: string[];
}

export interface WcagValidationResult {
  criterionId: string;
  passed: boolean;
  score?: number;
  issueCount?: number;
  totalChecked?: number;
  details?: string;
}

export interface Section508MappingResult {
  overallCompliance: number;
  criteriaResults: Section508Criterion[];
  bestMeetsGuidance: BestMeetsGuidance[];
  competitivePositioning: string;
  pdfUaCompliance?: {
    isPdfUaCompliant: boolean;
    version: string | null;
  };
}

class Section508MapperService {
  mapWcagToSection508(
    wcagResults: WcagValidationResult[],
    pdfUaResult?: { isPdfUaCompliant: boolean; pdfUaVersion: string | null },
    competitorContext?: CompetitorInfo
  ): Section508MappingResult {
    logger.info('Starting Section 508 mapping...');

    const criteriaResults: Section508Criterion[] = [];
    const bestMeetsGuidance: BestMeetsGuidance[] = [];

    const wcagResultsMap = new Map<string, WcagValidationResult>();
    wcagResults.forEach(r => wcagResultsMap.set(r.criterionId, r));

    for (const mapping of section508WcagMappings) {
      const result = this.evaluateCriterion(mapping, wcagResultsMap, pdfUaResult);
      criteriaResults.push(result);

      if (result.conformanceLevel === 'Partially Supports' || result.conformanceLevel === 'Does Not Support') {
        const guidance = this.generateBestMeetsGuidance(
          mapping.section508Id,
          mapping,
          wcagResultsMap,
          competitorContext
        );
        bestMeetsGuidance.push(guidance);
      }
    }

    const overallCompliance = this.calculateOverallCompliance(criteriaResults);
    const competitivePositioning = this.generateCompetitivePositioning(
      overallCompliance,
      criteriaResults,
      bestMeetsGuidance,
      pdfUaResult,
      competitorContext
    );

    logger.info(`Section 508 mapping completed - Overall compliance: ${overallCompliance}%`);

    return {
      overallCompliance,
      criteriaResults,
      bestMeetsGuidance,
      competitivePositioning,
      pdfUaCompliance: pdfUaResult ? {
        isPdfUaCompliant: pdfUaResult.isPdfUaCompliant,
        version: pdfUaResult.pdfUaVersion,
      } : undefined,
    };
  }

  private evaluateCriterion(
    mapping: Section508WcagMapping,
    wcagResultsMap: Map<string, WcagValidationResult>,
    pdfUaResult?: { isPdfUaCompliant: boolean; pdfUaVersion: string | null }
  ): Section508Criterion {
    if (mapping.wcagCriteria.length === 0) {
      return {
        criterionId: mapping.section508Id,
        title: mapping.section508Title,
        wcagMapping: mapping.wcagCriteria,
        conformanceLevel: 'Not Applicable',
        remarks: 'No WCAG criteria mapped; requires manual documentation review.',
      };
    }

    let passedCount = 0;
    let partialCount = 0;
    let failedCount = 0;
    let notTestedCount = 0;
    const remarks: string[] = [];

    for (const wcagId of mapping.wcagCriteria) {
      const result = wcagResultsMap.get(wcagId);
      if (!result) {
        notTestedCount++;
        continue;
      }

      if (result.passed) {
        passedCount++;
      } else if (result.score !== undefined && result.score > 0) {
        partialCount++;
        if (result.totalChecked !== undefined && result.issueCount !== undefined) {
          const passRate = ((result.totalChecked - result.issueCount) / result.totalChecked * 100).toFixed(0);
          remarks.push(`WCAG ${wcagId}: ${passRate}% pass rate (${result.issueCount} issues)`);
        }
      } else {
        failedCount++;
        remarks.push(`WCAG ${wcagId}: Does not meet criteria`);
      }
    }

    if (mapping.section508Id === 'E205.4' && pdfUaResult) {
      if (pdfUaResult.isPdfUaCompliant) {
        remarks.unshift(`PDF/UA-1 compliant (version: ${pdfUaResult.pdfUaVersion})`);
        passedCount++;
      } else {
        remarks.unshift('Document does not conform to PDF/UA-1');
        failedCount++;
      }
    }

    const totalEvaluated = passedCount + partialCount + failedCount;
    let conformanceLevel: ConformanceLevel;

    if (totalEvaluated === 0) {
      conformanceLevel = 'Not Applicable';
    } else if (failedCount === 0 && partialCount === 0) {
      conformanceLevel = 'Supports';
    } else if (passedCount > 0 || partialCount > 0) {
      conformanceLevel = 'Partially Supports';
    } else {
      conformanceLevel = 'Does Not Support';
    }

    return {
      criterionId: mapping.section508Id,
      title: mapping.section508Title,
      wcagMapping: mapping.wcagCriteria,
      conformanceLevel,
      remarks: remarks.length > 0 ? remarks.join('; ') : this.getDefaultRemarks(conformanceLevel),
    };
  }

  private getDefaultRemarks(level: ConformanceLevel): string {
    switch (level) {
      case 'Supports':
        return 'All applicable WCAG criteria pass validation.';
      case 'Partially Supports':
        return 'Some WCAG criteria pass; remediation in progress.';
      case 'Does Not Support':
        return 'Criteria do not meet requirements; remediation planned.';
      case 'Not Applicable':
        return 'Criteria not applicable to this content type.';
    }
  }

  private generateBestMeetsGuidance(
    criterionId: string,
    mapping: Section508WcagMapping,
    wcagResultsMap: Map<string, WcagValidationResult>,
    _competitorContext?: CompetitorInfo
  ): BestMeetsGuidance {
    const scores: number[] = [];
    const issues: string[] = [];

    for (const wcagId of mapping.wcagCriteria) {
      const result = wcagResultsMap.get(wcagId);
      if (result) {
        if (result.score !== undefined) {
          scores.push(result.score);
        } else if (result.passed) {
          scores.push(100);
        } else {
          scores.push(0);
        }
        if (!result.passed && result.details) {
          issues.push(result.details);
        }
      }
    }

    const avgScore = scores.length > 0 
      ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length)
      : 0;

    const currentStatus: ConformanceLevel = avgScore >= 90 
      ? 'Supports' 
      : avgScore >= 50 
        ? 'Partially Supports' 
        : 'Does Not Support';

    let bestMeetsLanguage: string;
    let improvementPath: string | undefined;

    if (avgScore >= 85) {
      bestMeetsLanguage = `Product achieves ${avgScore}% compliance with ${criterionId} (${mapping.section508Title}). ` +
        `Validation demonstrates strong alignment with Section 508 requirements, with minor enhancements identified for continuous improvement.`;
      improvementPath = `Address remaining ${100 - avgScore}% of issues through targeted remediation of identified accessibility gaps.`;
    } else if (avgScore >= 70) {
      bestMeetsLanguage = `Product demonstrates ${avgScore}% compliance with ${criterionId} requirements. ` +
        `Active accessibility program in place with documented remediation roadmap for identified issues.`;
      improvementPath = `Remediation plan targets ${100 - avgScore}% compliance gap through: ${this.getSuggestedRemediations(mapping)}`;
    } else if (avgScore >= 50) {
      bestMeetsLanguage = `Product meets ${avgScore}% of ${criterionId} requirements. ` +
        `Comprehensive accessibility review completed with prioritized remediation schedule.`;
      improvementPath = `Priority remediation needed for: ${this.getSuggestedRemediations(mapping)}. Consider phased rollout with accessibility milestones.`;
    } else {
      bestMeetsLanguage = `Product is under active accessibility remediation for ${criterionId}. ` +
        `Accessibility audit completed and improvement roadmap established.`;
      improvementPath = `Significant remediation required. Recommend: 1) Alt text for all images, 2) Proper heading structure, 3) Color contrast fixes, 4) Table accessibility.`;
    }

    return {
      criterionId,
      currentStatus,
      bestMeetsLanguage,
      improvementPath,
    };
  }

  private getSuggestedRemediations(mapping: Section508WcagMapping): string {
    const remediations: string[] = [];

    if (mapping.wcagCriteria.includes('1.1.1')) {
      remediations.push('alt text for images');
    }
    if (mapping.wcagCriteria.includes('1.3.1')) {
      remediations.push('heading structure and table headers');
    }
    if (mapping.wcagCriteria.includes('1.4.3') || mapping.wcagCriteria.includes('1.4.6')) {
      remediations.push('color contrast ratios');
    }
    if (mapping.wcagCriteria.includes('2.4.1') || mapping.wcagCriteria.includes('2.4.2')) {
      remediations.push('navigation and page titles');
    }
    if (mapping.wcagCriteria.includes('3.1.1')) {
      remediations.push('document language declaration');
    }

    return remediations.length > 0 ? remediations.join(', ') : 'general accessibility improvements';
  }

  private calculateOverallCompliance(criteriaResults: Section508Criterion[]): number {
    const applicableCriteria = criteriaResults.filter(c => c.conformanceLevel !== 'Not Applicable');
    
    if (applicableCriteria.length === 0) return 0;

    let totalScore = 0;
    for (const criterion of applicableCriteria) {
      switch (criterion.conformanceLevel) {
        case 'Supports':
          totalScore += 100;
          break;
        case 'Partially Supports':
          totalScore += 50;
          break;
        case 'Does Not Support':
          totalScore += 0;
          break;
      }
    }

    return Math.round(totalScore / applicableCriteria.length);
  }

  private generateCompetitivePositioning(
    overallCompliance: number,
    criteriaResults: Section508Criterion[],
    bestMeetsGuidance: BestMeetsGuidance[],
    pdfUaResult?: { isPdfUaCompliant: boolean; pdfUaVersion: string | null },
    _competitorContext?: CompetitorInfo
  ): string {
    const supportsCount = criteriaResults.filter(c => c.conformanceLevel === 'Supports').length;
    const partialCount = criteriaResults.filter(c => c.conformanceLevel === 'Partially Supports').length;
    const totalApplicable = criteriaResults.filter(c => c.conformanceLevel !== 'Not Applicable').length;

    let positioning = `## Section 508 Compliance Summary\n\n`;
    positioning += `**Overall Compliance Score: ${overallCompliance}%**\n\n`;

    positioning += `### Criteria Status\n`;
    positioning += `- **Supports:** ${supportsCount} of ${totalApplicable} applicable criteria\n`;
    positioning += `- **Partially Supports:** ${partialCount} criteria (remediation in progress)\n\n`;

    if (pdfUaResult) {
      positioning += `### PDF/UA Compliance (E205.4)\n`;
      if (pdfUaResult.isPdfUaCompliant) {
        positioning += `Document conforms to **PDF/UA-1** (ISO 14289-1), meeting the enhanced accessibility requirements for PDF documents specified in Section 508.\n\n`;
      } else {
        positioning += `Document is progressing toward PDF/UA-1 compliance. Current validation identifies specific areas for enhancement.\n\n`;
      }
    }

    if (overallCompliance >= 85) {
      positioning += `### Competitive Advantage\n`;
      positioning += `This product demonstrates **strong Section 508 compliance** with ${overallCompliance}% of applicable criteria fully or partially supported. `;
      positioning += `Detailed accessibility documentation and validation reports are available to support procurement evaluation.\n\n`;
    } else if (overallCompliance >= 70) {
      positioning += `### Accessibility Commitment\n`;
      positioning += `This product demonstrates **substantial progress** toward Section 508 compliance. `;
      positioning += `A documented remediation roadmap addresses identified gaps with targeted completion milestones.\n\n`;
    } else {
      positioning += `### Accessibility Roadmap\n`;
      positioning += `Comprehensive accessibility audit completed. Prioritized remediation plan established with measurable milestones.\n\n`;
    }

    if (bestMeetsGuidance.length > 0) {
      positioning += `### Best Meets Documentation\n`;
      positioning += `The following criteria include detailed "Best Meets" guidance for procurement evaluation:\n\n`;
      for (const guidance of bestMeetsGuidance.slice(0, 5)) {
        positioning += `- **${guidance.criterionId}:** ${guidance.currentStatus}\n`;
      }
      if (bestMeetsGuidance.length > 5) {
        positioning += `- *(${bestMeetsGuidance.length - 5} additional criteria documented)*\n`;
      }
    }

    return positioning;
  }
}

export const section508MapperService = new Section508MapperService();
