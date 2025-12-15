import { logger } from '../../lib/logger';
import { ConformanceLevel, WcagValidationResult } from './section508-mapper.service';

export interface FpcCriterion {
  id: string;
  title: string;
  description: string;
  wcagMapping: string[];
  status: ConformanceLevel;
  remarks: string;
  testMethod: string;
}

export interface FpcValidationResult {
  criteria: FpcCriterion[];
  summary: {
    applicable: number;
    supported: number;
    partiallySupported: number;
  };
}

interface FpcDefinition {
  id: string;
  title: string;
  description: string;
  wcagMapping: string[];
  testMethod: string;
}

const FPC_DEFINITIONS: FpcDefinition[] = [
  {
    id: '302.1',
    title: 'Without Vision',
    description: 'Where a visual mode of operation is provided, ICT shall provide at least one mode of operation that does not require user vision.',
    wcagMapping: ['1.1.1', '1.3.1', '1.3.2', '1.4.1', '4.1.2'],
    testMethod: 'Verify all content is available via screen reader; check alt text for images, proper heading structure, and ARIA labels.',
  },
  {
    id: '302.2',
    title: 'With Limited Vision',
    description: 'Where a visual mode of operation is provided, ICT shall provide at least one mode of operation that enables users to make use of limited vision.',
    wcagMapping: ['1.4.3', '1.4.4', '1.4.10', '1.4.12'],
    testMethod: 'Check text resizability up to 200%, adequate color contrast (4.5:1 for normal text), and reflow at 400% zoom.',
  },
  {
    id: '302.3',
    title: 'Without Perception of Color',
    description: 'Where a visual mode of operation is provided, ICT shall provide at least one visual mode of operation that does not require user perception of color.',
    wcagMapping: ['1.4.1'],
    testMethod: 'Verify color is not the sole means of conveying information; check for additional visual indicators (text, patterns, icons).',
  },
  {
    id: '302.4',
    title: 'Without Hearing',
    description: 'Where an audible mode of operation is provided, ICT shall provide at least one mode of operation that does not require user hearing.',
    wcagMapping: ['1.2.1', '1.2.2', '1.2.3'],
    testMethod: 'Verify captions for prerecorded audio, transcripts available, and audio descriptions for video content.',
  },
  {
    id: '302.5',
    title: 'With Limited Hearing',
    description: 'Where an audible mode of operation is provided, ICT shall provide at least one mode of operation that enables users to make use of limited hearing.',
    wcagMapping: ['1.2.1', '1.2.2'],
    testMethod: 'Check audio quality, availability of captions, and volume controls for audio content.',
  },
  {
    id: '302.6',
    title: 'Without Speech',
    description: 'Where speech is used for input, control, or operation, ICT shall provide at least one mode of operation that does not require user speech.',
    wcagMapping: ['2.1.1'],
    testMethod: 'Verify no voice-only input is required; all functionality accessible via keyboard or alternative input methods.',
  },
  {
    id: '302.7',
    title: 'With Limited Manipulation',
    description: 'Where a manual mode of operation is provided, ICT shall provide at least one mode of operation that does not require fine motor control or simultaneous manual operations.',
    wcagMapping: ['2.1.1', '2.4.7'],
    testMethod: 'Verify keyboard accessibility for all interactive elements; check visible focus indicators and no simultaneous key presses required.',
  },
  {
    id: '302.8',
    title: 'With Limited Reach and Strength',
    description: 'Where a manual mode of operation is provided, ICT shall provide at least one mode of operation that is operable with limited reach and limited strength.',
    wcagMapping: ['2.4.1', '2.4.3'],
    testMethod: 'Verify skip navigation links, logical focus order, and no precise timed movements required.',
  },
  {
    id: '302.9',
    title: 'With Limited Language, Cognitive, and Learning Abilities',
    description: 'ICT shall provide features making its use by individuals with limited cognitive, language, and learning abilities simpler and easier.',
    wcagMapping: ['3.1.5', '3.2.3', '3.2.4'],
    testMethod: 'Check reading level, consistent navigation, and predictable component identification across pages.',
  },
];

class FpcValidatorService {
  validateFpc(wcagResults: WcagValidationResult[]): FpcValidationResult {
    logger.info('Starting FPC validation...');

    const wcagResultsMap = new Map<string, WcagValidationResult>();
    wcagResults.forEach(r => wcagResultsMap.set(r.criterionId, r));

    const criteria: FpcCriterion[] = [];
    let supported = 0;
    let partiallySupported = 0;
    let notSupported = 0;

    for (const fpc of FPC_DEFINITIONS) {
      const criterion = this.evaluateFpcCriterion(fpc, wcagResultsMap);
      criteria.push(criterion);

      switch (criterion.status) {
        case 'Supports':
          supported++;
          break;
        case 'Partially Supports':
          partiallySupported++;
          break;
        case 'Does Not Support':
          notSupported++;
          break;
      }
    }

    const applicable = supported + partiallySupported + notSupported;

    logger.info(`FPC validation completed - Supported: ${supported}, Partial: ${partiallySupported}, Not Supported: ${notSupported}`);

    return {
      criteria,
      summary: {
        applicable,
        supported,
        partiallySupported,
      },
    };
  }

  private evaluateFpcCriterion(
    fpc: FpcDefinition,
    wcagResultsMap: Map<string, WcagValidationResult>
  ): FpcCriterion {
    let passedCount = 0;
    let partialCount = 0;
    let failedCount = 0;
    const remarks: string[] = [];

    for (const wcagId of fpc.wcagMapping) {
      const result = wcagResultsMap.get(wcagId);
      if (!result) {
        continue;
      }

      if (result.passed) {
        passedCount++;
      } else if (result.score !== undefined && result.score > 0) {
        partialCount++;
        if (result.totalChecked !== undefined && result.issueCount !== undefined) {
          if (result.totalChecked > 0) {
            const passRate = ((result.totalChecked - result.issueCount) / result.totalChecked * 100).toFixed(0);
            remarks.push(`WCAG ${wcagId}: ${passRate}% pass rate`);
          } else {
            remarks.push(`WCAG ${wcagId}: Partially meets criteria`);
          }
        } else {
          remarks.push(`WCAG ${wcagId}: Partially meets criteria`);
        }
      } else {
        failedCount++;
        remarks.push(`WCAG ${wcagId}: Does not meet criteria`);
      }
    }

    const totalEvaluated = passedCount + partialCount + failedCount;
    let status: ConformanceLevel;

    if (totalEvaluated === 0) {
      status = 'Not Applicable';
      remarks.push('No WCAG results available for mapped criteria');
    } else if (failedCount === 0 && partialCount === 0) {
      status = 'Supports';
    } else if (passedCount > 0 || partialCount > 0) {
      status = 'Partially Supports';
    } else {
      status = 'Does Not Support';
    }

    return {
      id: fpc.id,
      title: fpc.title,
      description: fpc.description,
      wcagMapping: fpc.wcagMapping,
      status,
      remarks: remarks.length > 0 ? remarks.join('; ') : this.getDefaultRemarks(status),
      testMethod: fpc.testMethod,
    };
  }

  private getDefaultRemarks(status: ConformanceLevel): string {
    switch (status) {
      case 'Supports':
        return 'All mapped WCAG criteria pass validation.';
      case 'Partially Supports':
        return 'Some mapped WCAG criteria pass; remediation in progress.';
      case 'Does Not Support':
        return 'Mapped WCAG criteria do not meet requirements.';
      case 'Not Applicable':
        return 'No applicable WCAG criteria found for evaluation.';
    }
  }

  validateSingleCriterion(criterionId: string, wcagResults: WcagValidationResult[]): FpcCriterion | null {
    const definition = FPC_DEFINITIONS.find(d => d.id === criterionId);
    if (!definition) {
      return null;
    }
    const wcagResultsMap = new Map<string, WcagValidationResult>();
    wcagResults.forEach(r => wcagResultsMap.set(r.criterionId, r));
    return this.evaluateFpcCriterion(definition, wcagResultsMap);
  }

  validateWithoutVision(wcagResults: WcagValidationResult[]): FpcCriterion {
    const result = this.validateSingleCriterion('302.1', wcagResults);
    if (!result) throw new Error('FPC criterion 302.1 not found');
    return result;
  }

  validateWithLimitedVision(wcagResults: WcagValidationResult[]): FpcCriterion {
    const result = this.validateSingleCriterion('302.2', wcagResults);
    if (!result) throw new Error('FPC criterion 302.2 not found');
    return result;
  }

  getFpcDefinitions(): FpcDefinition[] {
    return [...FPC_DEFINITIONS];
  }
}

export const fpcValidatorService = new FpcValidatorService();
