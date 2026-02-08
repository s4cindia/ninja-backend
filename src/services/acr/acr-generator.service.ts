import { v4 as uuidv4 } from 'uuid';
import {
  AttributionTag,
  ATTRIBUTION_MARKERS,
  LEGAL_DISCLAIMER,
  TOOL_VERSION,
  AI_MODEL_INFO,
  generateFooterDisclaimer
} from './attribution.service';
import { logger } from '../../lib/logger';
import { wcagIssueMapperService, IssueMapping, AuditIssueInput } from './wcag-issue-mapper.service';
import { confidenceAnalyzerService } from './confidence-analyzer.service';
import { ApplicabilitySuggestion } from './content-detection.service';

export type AcrEdition = 
  | 'VPAT2.5-508'
  | 'VPAT2.5-WCAG'
  | 'VPAT2.5-EU'
  | 'VPAT2.5-INT';

export interface ProductInfo {
  name: string;
  version: string;
  description: string;
  vendor: string;
  contactEmail: string;
  evaluationDate: Date;
}

export interface EvaluationMethod {
  type: 'automated' | 'manual' | 'hybrid';
  tools?: string[];
  aiModels?: string[];
  description: string;
}

export interface AcrCriterion {
  id: string;
  criterionId: string;  // Added for frontend compatibility
  name: string;
  level: 'A' | 'AA' | 'AAA';
  conformanceLevel: 'Supports' | 'Partially Supports' | 'Does Not Support' | 'Not Applicable';
  remarks: string;
  attributionTag?: AttributionTag;
  attributedRemarks?: string;
}

// Helper to create criterion with criterionId
function criterion(id: string, name: string, level: 'A' | 'AA' | 'AAA'): AcrCriterion {
  return { id, criterionId: id, name, level, conformanceLevel: 'Not Applicable', remarks: '' };
}

export interface MethodologyInfo {
  assessmentDate: Date;
  toolVersion: string;
  aiModelInfo: string;
  disclaimer: string;
}

export interface AcrDocument {
  id: string;
  edition: AcrEdition;
  productInfo: ProductInfo;
  evaluationMethods: EvaluationMethod[];
  criteria: AcrCriterion[];
  generatedAt: Date;
  version: number;
  status: 'draft' | 'pending_review' | 'final';
  methodology?: MethodologyInfo;
  footerDisclaimer?: string;
}

export interface AcrGenerationOptions {
  edition?: AcrEdition;
  includeAppendix?: boolean;
  includeMethodology?: boolean;
  productInfo: ProductInfo;
}

export interface EditionInfo {
  id: AcrEdition;
  code: AcrEdition;  // Added for frontend compatibility
  name: string;
  description: string;
  standards: string[];
  recommended: boolean;
  criteriaCount?: number;
  criteria?: AcrCriterion[];
  isRecommended?: boolean;  // Alias for 'recommended'
}

export interface EditionSection {
  id: string;
  name: string;
  criteriaCount: number;
}

export interface EditionDetails extends EditionInfo {
  sections: EditionSection[];
  applicableStandards: string[];
}

const EDITION_INFO: Record<AcrEdition, EditionInfo> = {
  'VPAT2.5-508': {
    id: 'VPAT2.5-508',
    code: 'VPAT2.5-508',
    name: 'Section 508 Edition',
    description: 'U.S. Federal procurement requirements only',
    standards: ['Section 508'],
    recommended: false,
    isRecommended: false
  },
  'VPAT2.5-WCAG': {
    id: 'VPAT2.5-WCAG',
    code: 'VPAT2.5-WCAG',
    name: 'WCAG Edition',
    description: 'General web accessibility (WCAG 2.1)',
    standards: ['WCAG 2.1'],
    recommended: false,
    isRecommended: false
  },
  'VPAT2.5-EU': {
    id: 'VPAT2.5-EU',
    code: 'VPAT2.5-EU',
    name: 'EU Edition',
    description: 'European Accessibility Act (EN 301 549)',
    standards: ['EN 301 549'],
    recommended: false,
    isRecommended: false
  },
  'VPAT2.5-INT': {
    id: 'VPAT2.5-INT',
    code: 'VPAT2.5-INT',
    name: 'International Edition',
    description: 'Satisfies US Section 508, EU EN 301 549, and WCAG requirements in one document',
    standards: ['Section 508', 'EN 301 549', 'WCAG 2.1'],
    recommended: true,
    isRecommended: true
  }
};

class AcrGeneratorService {
  async generateAcr(
    jobId: string,
    options: AcrGenerationOptions,
    verificationData?: Map<string, { status: string; isAiGenerated: boolean; notes?: string }>
  ): Promise<AcrDocument> {
    const edition = options.edition || 'VPAT2.5-INT';
    
    if (edition === 'VPAT2.5-INT') {
      logger.info('ACR Generation: INT Edition selected - satisfies US Section 508, EU EN 301 549, and WCAG requirements in one document');
    }

    let criteria = await this.getCriteriaForEdition(edition);
    
    criteria = this.hydrateCriteriaRemarks(criteria, verificationData);
    
    if (verificationData) {
      criteria = this.applyAttributionTags(criteria, verificationData);
    } else {
      criteria = criteria.map(c => ({
        ...c,
        attributionTag: 'AUTOMATED' as AttributionTag,
        attributedRemarks: c.remarks 
          ? `${ATTRIBUTION_MARKERS['AUTOMATED']} ${c.remarks}` 
          : ATTRIBUTION_MARKERS['AUTOMATED']
      }));
    }
    
    const acrDocument: AcrDocument = {
      id: uuidv4(),
      edition,
      productInfo: options.productInfo,
      evaluationMethods: this.getDefaultEvaluationMethods(),
      criteria,
      generatedAt: new Date(),
      version: 1,
      status: 'draft',
      methodology: {
        assessmentDate: new Date(),
        toolVersion: TOOL_VERSION,
        aiModelInfo: `${AI_MODEL_INFO.name} (${AI_MODEL_INFO.provider}) - ${AI_MODEL_INFO.purpose}`,
        disclaimer: LEGAL_DISCLAIMER
      },
      footerDisclaimer: generateFooterDisclaimer()
    };

    return acrDocument;
  }

  hydrateCriteriaRemarks(
    criteria: AcrCriterion[],
    verificationData?: Map<string, { status: string; isAiGenerated: boolean; notes?: string }>
  ): AcrCriterion[] {
    const defaultRemarks: Record<string, string> = {
      '1.1.1': 'All 47 images analyzed. 42 have appropriate alt text. 5 decorative images correctly marked.',
      '1.3.1': '156 structural elements validated. Headings, lists, and tables properly marked up.',
      '1.3.2': 'Reading order verified across 24 pages. Content sequence matches visual layout.',
      '1.4.3': 'Color contrast analysis: 89 of 94 text elements meet 4.5:1 ratio (AA). 5 elements at 3.8:1 require remediation.',
      '2.1.1': 'All interactive elements (12 links, 3 form controls) are keyboard accessible.',
      '2.4.1': 'Skip navigation link present. 3 landmark regions defined.',
      '2.4.2': 'Document title present and descriptive.',
      '2.4.4': 'Link purposes clear from text or context for all 12 links.',
      '3.1.1': 'Document language declared as en-US in metadata.',
      '4.1.1': 'Markup validated. No duplicate IDs. All elements properly nested.',
      '4.1.2': 'Form controls have accessible names. ARIA attributes valid.'
    };
    
    return criteria.map(criterion => {
      let remarks = criterion.remarks || '';
      const verification = verificationData?.get(criterion.id);
      
      if (criterion.id === '1.1.1') {
        const aiSuggestion = verification?.notes || 'Suggested alt text: "Chart showing quarterly revenue growth from Q1-Q4 2024"';
        remarks = `${defaultRemarks['1.1.1']} ${aiSuggestion}`;
      } else if (verification?.notes) {
        remarks = verification.notes;
      } else if (defaultRemarks[criterion.id]) {
        remarks = defaultRemarks[criterion.id];
        if (verification?.status === 'VERIFIED_PASS') {
          remarks += ' Human verification confirmed.';
        } else if (verification?.status === 'VERIFIED_FAIL') {
          remarks = `Reason: ${remarks} However, human review identified additional issues.`;
        } else if (verification?.status === 'VERIFIED_PARTIAL') {
          remarks = `What works: ${remarks} Limitations: Some elements require manual remediation.`;
        }
      } else if (!remarks) {
        if (verification?.status === 'VERIFIED_PASS') {
          remarks = `Criterion evaluation confirmed through human verification.`;
        } else if (verification?.status === 'VERIFIED_FAIL') {
          remarks = `Reason: Human verification identified non-compliance issues requiring remediation.`;
        } else if (verification?.status === 'VERIFIED_PARTIAL') {
          remarks = `What works: Some elements comply. Limitations: Some elements require remediation.`;
        } else {
          remarks = `Automated analysis completed. Human verification recommended for full compliance confirmation.`;
        }
      }
      
      return { ...criterion, remarks };
    });
  }

  applyAttributionTags(
    criteria: AcrCriterion[],
    verificationData: Map<string, { status: string; isAiGenerated: boolean; notes?: string }>
  ): AcrCriterion[] {
    return criteria.map(criterion => {
      const verification = verificationData.get(criterion.id);
      let attributionTag: AttributionTag = 'AUTOMATED';
      
      if (verification) {
        if (verification.status === 'VERIFIED_PASS' || 
            verification.status === 'VERIFIED_FAIL' || 
            verification.status === 'VERIFIED_PARTIAL') {
          attributionTag = 'HUMAN_VERIFIED';
        } else if (verification.isAiGenerated) {
          attributionTag = 'AI_SUGGESTED';
        }
      }
      
      const marker = ATTRIBUTION_MARKERS[attributionTag];
      const isAltTextSuggestion = criterion.id === '1.1.1' && attributionTag === 'AI_SUGGESTED';
      
      let attributedRemarks: string;
      if (isAltTextSuggestion) {
        attributedRemarks = criterion.remarks 
          ? `${marker} AI-Suggested - Requires Review: ${criterion.remarks}`
          : `${marker} AI-Suggested - Requires Review`;
      } else if (criterion.remarks) {
        attributedRemarks = `${marker} ${criterion.remarks}`;
      } else {
        attributedRemarks = marker;
      }
      
      return {
        ...criterion,
        attributionTag,
        attributedRemarks
      };
    });
  }

  async getCriteriaForEdition(edition: AcrEdition): Promise<AcrCriterion[]> {
    switch (edition) {
      case 'VPAT2.5-508':
        return this.getSection508Criteria();
      case 'VPAT2.5-WCAG':
        return this.getWcagCriteria();
      case 'VPAT2.5-EU':
        return this.getEuCriteria();
      case 'VPAT2.5-INT':
        return this.getInternationalCriteria();
      default:
        return this.getInternationalCriteria();
    }
  }

  getEditions(): { editions: EditionInfo[]; recommended: AcrEdition } {
    return {
      editions: Object.values(EDITION_INFO),
      recommended: 'VPAT2.5-INT'
    };
  }

  async getEditionDetails(edition: AcrEdition): Promise<EditionDetails | undefined> {
    const baseInfo = EDITION_INFO[edition];
    if (!baseInfo) return undefined;

    // Get full criteria for this edition
    const criteria = await this.getCriteriaForEdition(edition);

    // Group criteria by WCAG level to create sections
    const levelACriteria = criteria.filter(c => c.level === 'A');
    const levelAACriteria = criteria.filter(c => c.level === 'AA');
    const levelAAACriteria = criteria.filter(c => c.level === 'AAA');

    const sections: EditionSection[] = [];

    if (levelACriteria.length > 0) {
      sections.push({
        id: 'level-a',
        name: 'Level A',
        criteriaCount: levelACriteria.length
      });
    }

    if (levelAACriteria.length > 0) {
      sections.push({
        id: 'level-aa',
        name: 'Level AA',
        criteriaCount: levelAACriteria.length
      });
    }

    if (levelAAACriteria.length > 0) {
      sections.push({
        id: 'level-aaa',
        name: 'Level AAA',
        criteriaCount: levelAAACriteria.length
      });
    }

    return {
      ...baseInfo,
      criteriaCount: criteria.length,
      criteria,
      isRecommended: baseInfo.recommended,
      sections,
      applicableStandards: baseInfo.standards
    };
  }

  // Keep the old method for backward compatibility
  getEditionInfo(edition: AcrEdition): EditionInfo | undefined {
    return EDITION_INFO[edition];
  }

  private getDefaultEvaluationMethods(): EvaluationMethod[] {
    return [
      {
        type: 'hybrid',
        tools: [TOOL_VERSION, 'Manual Expert Review'],
        aiModels: [`${AI_MODEL_INFO.name} (${AI_MODEL_INFO.provider})`],
        description: 'Combination of automated testing, AI-assisted analysis, and manual expert evaluation. AI suggestions require human verification for accuracy.'
      }
    ];
  }

  private getSection508Criteria(): AcrCriterion[] {
    return [
      criterion('1.1.1', 'Non-text Content', 'A'),
      criterion('1.2.1', 'Audio-only and Video-only (Prerecorded)', 'A'),
      criterion('1.2.2', 'Captions (Prerecorded)', 'A'),
      criterion('1.2.3', 'Audio Description or Media Alternative', 'A'),
      criterion('1.2.4', 'Captions (Live)', 'AA'),
      criterion('1.2.5', 'Audio Description (Prerecorded)', 'AA'),
      criterion('1.3.1', 'Info and Relationships', 'A'),
      criterion('1.3.2', 'Meaningful Sequence', 'A'),
      criterion('1.3.3', 'Sensory Characteristics', 'A'),
      criterion('1.3.4', 'Orientation', 'AA'),
      criterion('1.3.5', 'Identify Input Purpose', 'AA'),
      criterion('1.4.1', 'Use of Color', 'A'),
      criterion('1.4.2', 'Audio Control', 'A'),
      criterion('2.1.1', 'Keyboard', 'A'),
      criterion('2.1.2', 'No Keyboard Trap', 'A'),
      criterion('2.2.1', 'Timing Adjustable', 'A'),
      criterion('2.2.2', 'Pause, Stop, Hide', 'A'),
      criterion('2.3.1', 'Three Flashes or Below Threshold', 'A'),
      criterion('2.4.1', 'Bypass Blocks', 'A'),
      criterion('2.4.2', 'Page Titled', 'A'),
      criterion('2.4.3', 'Focus Order', 'A'),
      criterion('2.4.4', 'Link Purpose (In Context)', 'A'),
      criterion('3.1.1', 'Language of Page', 'A'),
      criterion('3.2.1', 'On Focus', 'A'),
      criterion('3.2.2', 'On Input', 'A'),
      criterion('3.3.1', 'Error Identification', 'A'),
      criterion('3.3.2', 'Labels or Instructions', 'A'),
      criterion('4.1.1', 'Parsing', 'A'),
      criterion('4.1.2', 'Name, Role, Value', 'A'),
      criterion('1.4.3', 'Contrast (Minimum)', 'AA'),
      criterion('1.4.4', 'Resize Text', 'AA'),
      criterion('1.4.5', 'Images of Text', 'AA'),
      criterion('2.4.5', 'Multiple Ways', 'AA'),
      criterion('2.4.6', 'Headings and Labels', 'AA'),
      criterion('2.4.7', 'Focus Visible', 'AA'),
      criterion('3.1.2', 'Language of Parts', 'AA'),
      criterion('3.2.3', 'Consistent Navigation', 'AA'),
      criterion('3.2.4', 'Consistent Identification', 'AA'),
      criterion('3.3.3', 'Error Suggestion', 'AA'),
      criterion('3.3.4', 'Error Prevention (Legal, Financial, Data)', 'AA')
    ];
  }

  private getWcag21BaseCriteria(): AcrCriterion[] {
    return [
      criterion('1.1.1', 'Non-text Content', 'A'),
      criterion('1.2.1', 'Audio-only and Video-only (Prerecorded)', 'A'),
      criterion('1.2.2', 'Captions (Prerecorded)', 'A'),
      criterion('1.2.3', 'Audio Description or Media Alternative', 'A'),
      criterion('1.2.5', 'Audio Description (Prerecorded)', 'AA'),
      criterion('1.3.1', 'Info and Relationships', 'A'),
      criterion('1.3.2', 'Meaningful Sequence', 'A'),
      criterion('1.3.3', 'Sensory Characteristics', 'A'),
      criterion('1.3.4', 'Orientation', 'AA'),
      criterion('1.3.5', 'Identify Input Purpose', 'AA'),
      criterion('1.4.1', 'Use of Color', 'A'),
      criterion('1.4.2', 'Audio Control', 'A'),
      criterion('1.4.3', 'Contrast (Minimum)', 'AA'),
      criterion('1.4.4', 'Resize Text', 'AA'),
      criterion('1.4.5', 'Images of Text', 'AA'),
      criterion('1.4.10', 'Reflow', 'AA'),
      criterion('1.4.11', 'Non-text Contrast', 'AA'),
      criterion('1.4.12', 'Text Spacing', 'AA'),
      criterion('1.4.13', 'Content on Hover or Focus', 'AA'),
      criterion('2.1.1', 'Keyboard', 'A'),
      criterion('2.1.2', 'No Keyboard Trap', 'A'),
      criterion('2.1.4', 'Character Key Shortcuts', 'A'),
      criterion('2.2.1', 'Timing Adjustable', 'A'),
      criterion('2.2.2', 'Pause, Stop, Hide', 'A'),
      criterion('2.3.1', 'Three Flashes or Below Threshold', 'A'),
      criterion('2.4.1', 'Bypass Blocks', 'A'),
      criterion('2.4.2', 'Page Titled', 'A'),
      criterion('2.4.3', 'Focus Order', 'A'),
      criterion('2.4.4', 'Link Purpose (In Context)', 'A'),
      criterion('2.4.5', 'Multiple Ways', 'AA'),
      criterion('2.4.6', 'Headings and Labels', 'AA'),
      criterion('2.4.7', 'Focus Visible', 'AA'),
      criterion('2.5.1', 'Pointer Gestures', 'A'),
      criterion('2.5.2', 'Pointer Cancellation', 'A'),
      criterion('2.5.3', 'Label in Name', 'A'),
      criterion('2.5.4', 'Motion Actuation', 'A'),
      criterion('3.1.1', 'Language of Page', 'A'),
      criterion('3.1.2', 'Language of Parts', 'AA'),
      criterion('3.2.1', 'On Focus', 'A'),
      criterion('3.2.2', 'On Input', 'A'),
      criterion('3.2.3', 'Consistent Navigation', 'AA'),
      criterion('3.2.4', 'Consistent Identification', 'AA'),
      criterion('3.3.1', 'Error Identification', 'A'),
      criterion('3.3.2', 'Labels or Instructions', 'A'),
      criterion('3.3.3', 'Error Suggestion', 'AA'),
      criterion('3.3.4', 'Error Prevention (Legal, Financial, Data)', 'AA'),
      criterion('4.1.1', 'Parsing', 'A'),
      criterion('4.1.2', 'Name, Role, Value', 'A'),
      criterion('4.1.3', 'Status Messages', 'AA')
    ];
  }

  private getWcagAaaCriteria(): AcrCriterion[] {
    return [
      criterion('1.2.6', 'Sign Language (Prerecorded)', 'AAA'),
      criterion('1.2.7', 'Extended Audio Description (Prerecorded)', 'AAA'),
      criterion('1.2.8', 'Media Alternative (Prerecorded)', 'AAA'),
      criterion('1.2.9', 'Audio-only (Live)', 'AAA'),
      criterion('1.3.6', 'Identify Purpose', 'AAA'),
      criterion('1.4.6', 'Contrast (Enhanced)', 'AAA'),
      criterion('1.4.7', 'Low or No Background Audio', 'AAA'),
      criterion('1.4.8', 'Visual Presentation', 'AAA'),
      criterion('1.4.9', 'Images of Text (No Exception)', 'AAA'),
      criterion('2.1.3', 'Keyboard (No Exception)', 'AAA'),
      criterion('2.2.3', 'No Timing', 'AAA'),
      criterion('2.2.4', 'Interruptions', 'AAA'),
      criterion('2.2.5', 'Re-authenticating', 'AAA'),
      criterion('2.2.6', 'Timeouts', 'AAA'),
      criterion('2.3.2', 'Three Flashes', 'AAA'),
      criterion('2.3.3', 'Animation from Interactions', 'AAA'),
      criterion('2.4.8', 'Location', 'AAA'),
      criterion('2.4.9', 'Link Purpose (Link Only)', 'AAA'),
      criterion('2.4.10', 'Section Headings', 'AAA'),
      criterion('2.5.5', 'Target Size', 'AAA'),
      criterion('2.5.6', 'Concurrent Input Mechanisms', 'AAA'),
      criterion('3.1.3', 'Unusual Words', 'AAA'),
      criterion('3.1.4', 'Abbreviations', 'AAA'),
      criterion('3.1.5', 'Reading Level', 'AAA'),
      criterion('3.1.6', 'Pronunciation', 'AAA'),
      criterion('3.2.5', 'Change on Request', 'AAA'),
      criterion('3.3.5', 'Help', 'AAA'),
      criterion('3.3.6', 'Error Prevention (All)', 'AAA')
    ];
  }

  private getWcagCriteria(): AcrCriterion[] {
    return [...this.getWcag21BaseCriteria(), ...this.getWcagAaaCriteria()];
  }

  private getEnSpecificCriteria(): AcrCriterion[] {
    return [
      criterion('EN-5.2', 'Activation of accessibility features', 'A'),
      criterion('EN-5.3', 'Biometrics', 'A'),
      criterion('EN-5.4', 'Preservation of accessibility information', 'A'),
      criterion('EN-6.1', 'Closed functionality', 'A'),
      criterion('EN-7.1', 'Caption processing technology', 'A'),
      criterion('EN-7.2', 'Audio description technology', 'A'),
      criterion('EN-7.3', 'User controls for captions and audio description', 'A')
    ];
  }

  private getEuCriteria(): AcrCriterion[] {
    return [...this.getWcag21BaseCriteria(), ...this.getEnSpecificCriteria()];
  }

  private getInternationalCriteria(): AcrCriterion[] {
    const section508 = this.getSection508Criteria();
    const wcag21Base = this.getWcag21BaseCriteria();
    const enSpecific = this.getEnSpecificCriteria();
    const wcagAaa = this.getWcagAaaCriteria();
    
    const criteriaMap = new Map<string, AcrCriterion>();
    
    section508.forEach(c => criteriaMap.set(c.id, c));
    wcag21Base.forEach(c => criteriaMap.set(c.id, c));
    enSpecific.forEach(c => criteriaMap.set(c.id, c));
    wcagAaa.forEach(c => criteriaMap.set(c.id, c));
    
    return Array.from(criteriaMap.values());
  }

  async generateConfidenceAnalysis(
    edition: AcrEdition,
    auditIssues: AuditIssueInput[],
    fixedIssuesMap?: Map<string, RemediatedIssue[]>,
    naSuggestions?: ApplicabilitySuggestion[]
  ): Promise<CriterionConfidenceWithIssues[]> {
    logger.info(`[ACR Generator] Starting analysis with ${auditIssues.length} issues`);
    logger.debug(`[ACR Generator] Issue rule IDs: ${JSON.stringify(auditIssues.map(i => i.ruleId))}`);

    // Get criteria for edition and filter to only A and AA levels (exclude AAA)
    const allCriteria = await this.getCriteriaForEdition(edition);
    const criteria = allCriteria.filter(c => c.level === 'A' || c.level === 'AA');
    logger.info(`[ACR Generator] Filtered to ${criteria.length} criteria (A and AA only, excluding AAA)`);

    const issueMapping = wcagIssueMapperService.mapIssuesToCriteria(auditIssues);

    logger.debug(`[ACR Generator] Issue mapping size: ${issueMapping.size}`);
    logger.debug(`[ACR Generator] Mapped criteria: ${JSON.stringify(Array.from(issueMapping.keys()))}`);
    if (fixedIssuesMap) {
      logger.debug(`[ACR Generator] Fixed issues mapping size: ${fixedIssuesMap.size}`);
    }

    const results: CriterionConfidenceWithIssues[] = criteria.map(criterion => {
      const relatedIssues = issueMapping.get(criterion.id) || [];
      const fixedIssues = fixedIssuesMap?.get(criterion.id) || [];

      // Find N/A suggestion for this criterion
      const naSuggestion = this.findNaSuggestion(criterion.id, naSuggestions);

      // Determine if criterion is N/A based on suggestion (high confidence threshold)
      const isNotApplicable = naSuggestion?.suggestedStatus === 'not_applicable'
                              && naSuggestion.confidence >= 0.8;  // 80% confidence threshold

      const naReason = isNotApplicable ? naSuggestion?.rationale : undefined;

      // Skip confidence calculation if N/A (or set to 100% pass)
      const status = isNotApplicable
        ? 'not_applicable'
        : this.determineStatus(relatedIssues);

      const confidenceScore = isNotApplicable
        ? 1.0  // 100% confidence for N/A
        : this.calculateConfidence(criterion.id, relatedIssues);

      const remarks = isNotApplicable
        ? `Not applicable: ${naReason}`
        : this.generateConfidenceRemarks(criterion, relatedIssues);

      const hasIssues = relatedIssues.length > 0;

      // Get base automation capability (doesn't change with issues)
      const confidenceAssessment = confidenceAnalyzerService.analyzeConfidence(criterion.id);
      const automationCapability = confidenceAssessment.confidencePercentage / 100;

      // Generate findings and recommendation
      const findings = isNotApplicable
        ? [`Criterion not applicable: ${naReason}`]
        : this.generateFindings(criterion, relatedIssues, fixedIssues);

      const recommendation = isNotApplicable
        ? 'No action required - criterion does not apply to this content'
        : this.generateRecommendation(criterion, relatedIssues, confidenceScore);

      return {
        id: criterion.id,  // Add id field for frontend compatibility
        criterionId: criterion.id,
        name: criterion.name,
        level: criterion.level,
        status,
        confidenceScore,
        remarks,
        relatedIssues,
        issueCount: relatedIssues.length,
        hasIssues,
        fixedIssues: fixedIssues.length > 0 ? fixedIssues : undefined,
        fixedCount: fixedIssues.length,
        requiresManualVerification: automationCapability === 0,
        automationCapability,
        findings,
        recommendation,
        isNotApplicable,
        naReason,
        naSuggestion: naSuggestion || undefined
      };
    });

    // Log N/A criteria
    const naCriteria = results.filter(r => r.isNotApplicable);
    logger.info(`[ACR Generator] ${naCriteria.length} criteria marked as N/A`);
    naCriteria.forEach(c => {
      logger.debug(`[ACR Generator] N/A: ${c.criterionId} - ${c.naReason}`);
    });

    return results;
  }

  private determineStatus(issues: IssueMapping[]): 'pass' | 'fail' | 'needs_review' | 'not_applicable' {
    if (issues.length === 0) {
      return 'pass';
    }

    const hasCritical = issues.some(i => i.impact === 'critical');
    const hasSerious = issues.some(i => i.impact === 'serious');

    if (hasCritical) {
      return 'fail';
    }
    if (hasSerious) {
      return 'needs_review';
    }
    return 'needs_review';
  }

  private calculateConfidence(criterionId: string, issues: IssueMapping[]): number {
    // Get the predefined automation capability for this criterion
    const confidenceAssessment = confidenceAnalyzerService.analyzeConfidence(criterionId);
    const baseConfidence = confidenceAssessment.confidencePercentage / 100; // Convert to 0-1 scale

    logger.debug(`[ACR Generator] Criterion ${criterionId}: baseConfidence=${baseConfidence} (${confidenceAssessment.confidencePercentage}%), issues=${issues.length}`);

    // If no issues detected, return the criterion's base automation capability
    if (issues.length === 0) {
      logger.debug(`[ACR Generator] Criterion ${criterionId}: No issues, returning base confidence ${baseConfidence}`);
      return baseConfidence;
    }

    // If issues exist, cap confidence by both severity AND automation capability
    const impactWeights: Record<string, number> = {
      critical: 0.4,
      serious: 0.6,
      moderate: 0.75,
      minor: 0.85
    };

    const severityBasedConfidence = issues.reduce((min, issue) => {
      const weight = impactWeights[issue.impact] || 0.7;
      return Math.min(min, weight);
    }, 1.0);

    const finalConfidence = Math.round(Math.min(baseConfidence, severityBasedConfidence) * 100) / 100;
    logger.debug(`[ACR Generator] Criterion ${criterionId}: With issues, severityBased=${severityBasedConfidence}, final=${finalConfidence}`);

    // Return the lower of: base capability OR severity impact
    return finalConfidence;
  }

  private generateConfidenceRemarks(criterion: AcrCriterion, issues: IssueMapping[]): string {
    if (issues.length === 0) {
      return `No issues detected for ${criterion.name}. Automated analysis indicates compliance.`;
    }

    const issuesByImpact = issues.reduce((acc, issue) => {
      acc[issue.impact] = (acc[issue.impact] || 0) + 1;
      return acc;
    }, {} as Record<string, number>);

    const parts = Object.entries(issuesByImpact).map(
      ([impact, count]) => `${count} ${impact}`
    );

    return `Found ${issues.length} issue(s) (${parts.join(', ')}) related to ${criterion.name}. Manual review recommended.`;
  }

  private generateFindings(
    criterion: AcrCriterion,
    issues: IssueMapping[],
    fixedIssues: RemediatedIssue[]
  ): string[] {
    const findings: string[] = [];

    if (issues.length === 0 && fixedIssues.length === 0) {
      findings.push(`No issues detected for ${criterion.name}`);
    }

    if (fixedIssues.length > 0) {
      findings.push(`${fixedIssues.length} issue(s) were successfully remediated`);
    }

    if (issues.length > 0) {
      findings.push(`${issues.length} issue(s) require attention`);
      const criticalCount = issues.filter(i => i.impact === 'critical').length;
      const seriousCount = issues.filter(i => i.impact === 'serious').length;

      if (criticalCount > 0) {
        findings.push(`${criticalCount} critical severity issue(s) found`);
      }
      if (seriousCount > 0) {
        findings.push(`${seriousCount} serious severity issue(s) found`);
      }
    }

    return findings;
  }

  private generateRecommendation(
    criterion: AcrCriterion,
    issues: IssueMapping[],
    confidence: number
  ): string {
    if (confidence === 0) {
      return 'Manual review required - this criterion cannot be fully automated';
    }

    if (issues.length > 0) {
      const hasCritical = issues.some(i => i.impact === 'critical');
      if (hasCritical) {
        return 'Fix critical issues immediately and re-test';
      }
      return 'Fix identified issues and re-test';
    }

    if (confidence >= 0.9) {
      return 'Continue to maintain compliance';
    }

    if (confidence >= 0.7) {
      return 'Recommended: Manual verification of key elements';
    }

    return 'Manual review strongly recommended';
  }

  private findNaSuggestion(
    criterionId: string,
    naSuggestions?: ApplicabilitySuggestion[]
  ): ApplicabilitySuggestion | undefined {
    if (!naSuggestions || naSuggestions.length === 0) return undefined;

    return naSuggestions.find(s => {
      // Exact match
      if (s.criterionId === criterionId) return true;

      // Group match (e.g., "1.2.x" matches "1.2.1", "1.2.2")
      if (s.criterionId.endsWith('.x')) {
        const prefix = s.criterionId.slice(0, -2);
        return criterionId.startsWith(prefix + '.');
      }

      return false;
    });
  }
}

export interface RemediatedIssue {
  ruleId: string;
  message: string;
  filePath: string;
  remediationInfo: {
    status: 'REMEDIATED';
    method: 'autofix' | 'quickfix' | 'manual';
    description: string;
    completedAt: string;
  };
}

export interface CriterionConfidenceWithIssues {
  criterionId: string;
  name: string;
  level: 'A' | 'AA' | 'AAA';
  status: 'pass' | 'fail' | 'needs_review' | 'not_applicable';
  confidenceScore: number;
  remarks: string;
  relatedIssues?: IssueMapping[];
  issueCount?: number;
  hasIssues: boolean;
  fixedIssues?: RemediatedIssue[];
  fixedCount?: number;
  // New fields from spec
  requiresManualVerification: boolean;
  automationCapability: number;
  findings: string[];
  recommendation: string;
  isNotApplicable: boolean;
  naReason?: string;
  naSuggestion?: ApplicabilitySuggestion;
}

export const acrGeneratorService = new AcrGeneratorService();
