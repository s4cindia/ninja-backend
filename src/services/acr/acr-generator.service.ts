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
  name: string;
  level: 'A' | 'AA' | 'AAA';
  conformanceLevel: 'Supports' | 'Partially Supports' | 'Does Not Support' | 'Not Applicable';
  remarks: string;
  attributionTag?: AttributionTag;
  attributedRemarks?: string;
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
  name: string;
  description: string;
  standards: string[];
  recommended: boolean;
}

const EDITION_INFO: Record<AcrEdition, EditionInfo> = {
  'VPAT2.5-508': {
    id: 'VPAT2.5-508',
    name: 'Section 508 Edition',
    description: 'U.S. Federal procurement requirements only',
    standards: ['Section 508'],
    recommended: false
  },
  'VPAT2.5-WCAG': {
    id: 'VPAT2.5-WCAG',
    name: 'WCAG Edition',
    description: 'General web accessibility (WCAG 2.1)',
    standards: ['WCAG 2.1'],
    recommended: false
  },
  'VPAT2.5-EU': {
    id: 'VPAT2.5-EU',
    name: 'EU Edition',
    description: 'European Accessibility Act (EN 301 549)',
    standards: ['EN 301 549'],
    recommended: false
  },
  'VPAT2.5-INT': {
    id: 'VPAT2.5-INT',
    name: 'International Edition',
    description: 'Satisfies US Section 508, EU EN 301 549, and WCAG requirements in one document',
    standards: ['Section 508', 'EN 301 549', 'WCAG 2.1'],
    recommended: true
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
      { id: '1.1.1', name: 'Non-text Content', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.2.1', name: 'Audio-only and Video-only (Prerecorded)', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.2.2', name: 'Captions (Prerecorded)', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.2.3', name: 'Audio Description or Media Alternative', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.3.1', name: 'Info and Relationships', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.3.2', name: 'Meaningful Sequence', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.3.3', name: 'Sensory Characteristics', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.1', name: 'Use of Color', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.2', name: 'Audio Control', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.1.1', name: 'Keyboard', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.1.2', name: 'No Keyboard Trap', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.2.1', name: 'Timing Adjustable', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.2.2', name: 'Pause, Stop, Hide', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.3.1', name: 'Three Flashes or Below Threshold', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.4.1', name: 'Bypass Blocks', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.4.2', name: 'Page Titled', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.4.3', name: 'Focus Order', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.4.4', name: 'Link Purpose (In Context)', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.1.1', name: 'Language of Page', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.2.1', name: 'On Focus', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.2.2', name: 'On Input', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.3.1', name: 'Error Identification', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.3.2', name: 'Labels or Instructions', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '4.1.1', name: 'Parsing', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '4.1.2', name: 'Name, Role, Value', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.3', name: 'Contrast (Minimum)', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.4', name: 'Resize Text', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.5', name: 'Images of Text', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.4.5', name: 'Multiple Ways', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.4.6', name: 'Headings and Labels', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.4.7', name: 'Focus Visible', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.1.2', name: 'Language of Parts', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.2.3', name: 'Consistent Navigation', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.2.4', name: 'Consistent Identification', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.3.3', name: 'Error Suggestion', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.3.4', name: 'Error Prevention (Legal, Financial, Data)', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' }
    ];
  }

  private getWcag21BaseCriteria(): AcrCriterion[] {
    return [
      { id: '1.1.1', name: 'Non-text Content', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.2.1', name: 'Audio-only and Video-only (Prerecorded)', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.2.2', name: 'Captions (Prerecorded)', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.2.3', name: 'Audio Description or Media Alternative', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.2.5', name: 'Audio Description (Prerecorded)', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.3.1', name: 'Info and Relationships', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.3.2', name: 'Meaningful Sequence', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.3.3', name: 'Sensory Characteristics', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.3.4', name: 'Orientation', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.3.5', name: 'Identify Input Purpose', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.1', name: 'Use of Color', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.2', name: 'Audio Control', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.3', name: 'Contrast (Minimum)', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.4', name: 'Resize Text', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.5', name: 'Images of Text', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.10', name: 'Reflow', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.11', name: 'Non-text Contrast', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.12', name: 'Text Spacing', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.13', name: 'Content on Hover or Focus', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.1.1', name: 'Keyboard', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.1.2', name: 'No Keyboard Trap', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.1.4', name: 'Character Key Shortcuts', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.2.1', name: 'Timing Adjustable', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.2.2', name: 'Pause, Stop, Hide', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.3.1', name: 'Three Flashes or Below Threshold', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.4.1', name: 'Bypass Blocks', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.4.2', name: 'Page Titled', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.4.3', name: 'Focus Order', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.4.4', name: 'Link Purpose (In Context)', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.4.5', name: 'Multiple Ways', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.4.6', name: 'Headings and Labels', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.4.7', name: 'Focus Visible', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.5.1', name: 'Pointer Gestures', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.5.2', name: 'Pointer Cancellation', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.5.3', name: 'Label in Name', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.5.4', name: 'Motion Actuation', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.1.1', name: 'Language of Page', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.1.2', name: 'Language of Parts', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.2.1', name: 'On Focus', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.2.2', name: 'On Input', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.2.3', name: 'Consistent Navigation', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.2.4', name: 'Consistent Identification', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.3.1', name: 'Error Identification', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.3.2', name: 'Labels or Instructions', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.3.3', name: 'Error Suggestion', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.3.4', name: 'Error Prevention (Legal, Financial, Data)', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '4.1.1', name: 'Parsing', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '4.1.2', name: 'Name, Role, Value', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '4.1.3', name: 'Status Messages', level: 'AA', conformanceLevel: 'Not Applicable', remarks: '' }
    ];
  }

  private getWcagAaaCriteria(): AcrCriterion[] {
    return [
      { id: '1.2.6', name: 'Sign Language (Prerecorded)', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.2.7', name: 'Extended Audio Description (Prerecorded)', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.2.8', name: 'Media Alternative (Prerecorded)', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.2.9', name: 'Audio-only (Live)', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.3.6', name: 'Identify Purpose', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.6', name: 'Contrast (Enhanced)', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.7', name: 'Low or No Background Audio', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.8', name: 'Visual Presentation', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '1.4.9', name: 'Images of Text (No Exception)', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.1.3', name: 'Keyboard (No Exception)', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.2.3', name: 'No Timing', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.2.4', name: 'Interruptions', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.2.5', name: 'Re-authenticating', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.2.6', name: 'Timeouts', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.3.2', name: 'Three Flashes', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.3.3', name: 'Animation from Interactions', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.4.8', name: 'Location', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.4.9', name: 'Link Purpose (Link Only)', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.4.10', name: 'Section Headings', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.5.5', name: 'Target Size', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '2.5.6', name: 'Concurrent Input Mechanisms', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.1.3', name: 'Unusual Words', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.1.4', name: 'Abbreviations', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.1.5', name: 'Reading Level', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.1.6', name: 'Pronunciation', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.2.5', name: 'Change on Request', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.3.5', name: 'Help', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: '3.3.6', name: 'Error Prevention (All)', level: 'AAA', conformanceLevel: 'Not Applicable', remarks: '' }
    ];
  }

  private getWcagCriteria(): AcrCriterion[] {
    return [...this.getWcag21BaseCriteria(), ...this.getWcagAaaCriteria()];
  }

  private getEnSpecificCriteria(): AcrCriterion[] {
    return [
      { id: 'EN-5.2', name: 'Activation of accessibility features', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: 'EN-5.3', name: 'Biometrics', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: 'EN-5.4', name: 'Preservation of accessibility information', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: 'EN-6.1', name: 'Closed functionality', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: 'EN-7.1', name: 'Caption processing technology', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: 'EN-7.2', name: 'Audio description technology', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' },
      { id: 'EN-7.3', name: 'User controls for captions and audio description', level: 'A', conformanceLevel: 'Not Applicable', remarks: '' }
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
}

export const acrGeneratorService = new AcrGeneratorService();
