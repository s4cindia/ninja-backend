export type ConfidenceLevel = 
  | 'HIGH'              // 90%+ - automated verification reliable
  | 'MEDIUM'            // 60-89% - automated + spot check recommended
  | 'LOW'               // <60% - automated flagging only, human review required
  | 'MANUAL_REQUIRED';  // Cannot be automated at all

export interface ConfidenceAssessment {
  criterionId: string;
  wcagCriterion: string;
  confidenceLevel: ConfidenceLevel;
  confidencePercentage: number;
  reason: string;
  humanVerificationRequired: boolean;
  automatedChecks: string[];
  manualChecksNeeded: string[];
}

export interface ConfidenceSummary {
  totalCriteria: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  manualRequired: number;
  humanVerificationNeeded: number;
  items: ConfidenceAssessment[];
}

export interface ValidationResultInput {
  criterionId: string;
  wcagCriterion?: string;
  status: 'pass' | 'fail' | 'warning' | 'not_applicable';
  automatedChecksPassed?: number;
  automatedChecksFailed?: number;
  detectionMethod?: 'automated' | 'manual' | 'hybrid';
}

const ALWAYS_MANUAL_CRITERIA: Record<string, { reason: string; manualChecks: string[] }> = {
  '1.1.1': {
    reason: 'Alt text meaningfulness cannot be determined automatically - can detect presence but not quality or context appropriateness',
    manualChecks: ['Verify alt text accurately describes image content', 'Check alt text is concise and meaningful', 'Confirm decorative images are marked correctly']
  },
  '1.3.1': {
    reason: 'Information and relationships require semantic understanding that automation cannot fully assess',
    manualChecks: ['Verify programmatic relationships match visual presentation', 'Check form labels are correctly associated', 'Confirm table structures convey relationships']
  },
  '2.1.1': {
    reason: 'Full keyboard accessibility requires testing complete user workflows which cannot be automated',
    manualChecks: ['Test all interactive elements with keyboard only', 'Verify focus is visible during keyboard navigation', 'Check custom widgets are keyboard operable']
  },
  '2.4.1': {
    reason: 'Bypass blocks effectiveness requires understanding of content structure and user needs',
    manualChecks: ['Verify skip links work and are useful', 'Check landmark regions are meaningful', 'Confirm repeated content can be bypassed']
  },
  '2.4.6': {
    reason: 'Heading and label quality requires semantic understanding of content',
    manualChecks: ['Verify headings describe content that follows', 'Check labels are descriptive and helpful', 'Confirm hierarchy is logical and meaningful']
  },
  '3.1.2': {
    reason: 'Language of parts requires understanding of when language changes occur in content',
    manualChecks: ['Identify foreign language passages', 'Verify lang attributes on language changes', 'Check technical terms and proper nouns']
  },
  '3.3.2': {
    reason: 'Label and instruction quality requires understanding of user expectations and context',
    manualChecks: ['Verify instructions are clear and helpful', 'Check required fields are identified', 'Confirm input format requirements are stated']
  }
};

const HIGH_CONFIDENCE_CRITERIA: Record<string, { percentage: number; reason: string; automatedChecks: string[] }> = {
  '1.4.3': {
    percentage: 95,
    reason: 'Color contrast is formula-based and fully automatable using WCAG luminance calculations',
    automatedChecks: ['Calculate contrast ratio for all text elements', 'Apply 4.5:1 ratio for normal text', 'Apply 3:1 ratio for large text']
  },
  '3.1.1': {
    percentage: 92,
    reason: 'Language of page can be verified by checking for lang attribute presence and validity',
    automatedChecks: ['Check for lang attribute on html element', 'Validate language code format', 'Verify language code is not empty']
  },
  '4.1.1': {
    percentage: 98,
    reason: 'Parsing/validation errors are fully detectable through automated markup validation',
    automatedChecks: ['Validate HTML/XML structure', 'Check for duplicate IDs', 'Verify proper tag nesting']
  }
};

const MEDIUM_CONFIDENCE_CRITERIA: Record<string, { percentage: number; reason: string; automatedChecks: string[]; manualChecks: string[] }> = {
  '1.2.1': {
    percentage: 70,
    reason: 'Can detect media presence and transcript elements but cannot verify quality',
    automatedChecks: ['Detect audio-only and video-only content', 'Check for associated transcript elements'],
    manualChecks: ['Verify transcript accuracy', 'Check transcript is complete']
  },
  '1.4.6': {
    percentage: 89,
    reason: 'Enhanced contrast is formula-based with higher thresholds but edge cases exist',
    automatedChecks: ['Calculate contrast ratio for all text elements', 'Apply 7:1 ratio for normal text', 'Apply 4.5:1 ratio for large text'],
    manualChecks: ['Verify contrast in complex backgrounds', 'Check images of text']
  },
  '4.1.2': {
    percentage: 85,
    reason: 'Name, role, value can be largely automated for standard elements but custom widgets need review',
    automatedChecks: ['Check form elements have accessible names', 'Verify ARIA attributes are valid', 'Check role assignments are appropriate'],
    manualChecks: ['Review custom widget implementations', 'Verify dynamic state changes are announced']
  },
  '1.2.2': {
    percentage: 75,
    reason: 'Can detect caption tracks but cannot verify synchronization and accuracy',
    automatedChecks: ['Check for caption track presence', 'Verify caption format validity'],
    manualChecks: ['Verify caption accuracy', 'Check synchronization with audio']
  },
  '1.2.3': {
    percentage: 65,
    reason: 'Can detect audio description tracks but cannot verify completeness',
    automatedChecks: ['Check for audio description track', 'Verify track format'],
    manualChecks: ['Verify description covers all visual information', 'Check timing appropriateness']
  },
  '1.3.2': {
    percentage: 75,
    reason: 'Reading order can be analyzed but meaningful sequence requires content understanding',
    automatedChecks: ['Analyze DOM order', 'Check CSS affecting visual order', 'Detect reading order markers in PDFs'],
    manualChecks: ['Verify logical reading sequence', 'Check tabindex usage is appropriate']
  },
  '1.3.3': {
    percentage: 70,
    reason: 'Can detect some sensory-only instructions but context understanding is limited',
    automatedChecks: ['Scan for color-only references', 'Detect shape/location-based instructions'],
    manualChecks: ['Verify instructions don\'t rely solely on sensory characteristics']
  },
  '1.4.1': {
    percentage: 75,
    reason: 'Can detect color usage patterns but meaning requires context understanding',
    automatedChecks: ['Identify color-coded content', 'Check for non-color indicators'],
    manualChecks: ['Verify color is not sole means of conveying information']
  },
  '1.4.4': {
    percentage: 80,
    reason: 'Can test text resizing technically but usability at 200% requires visual verification',
    automatedChecks: ['Test viewport at 200% zoom', 'Check for text truncation', 'Verify no horizontal scrolling'],
    manualChecks: ['Verify readability at 200%', 'Check no loss of functionality']
  },
  '1.4.5': {
    percentage: 70,
    reason: 'Can detect images containing text but cannot always determine if essential',
    automatedChecks: ['OCR scan images for text', 'Check for text alternatives'],
    manualChecks: ['Determine if image of text is essential', 'Verify customization options']
  },
  '2.1.2': {
    percentage: 80,
    reason: 'Can detect focus traps in some cases but complex interactions need manual testing',
    automatedChecks: ['Test focus movement through interactive elements', 'Check for focus loops'],
    manualChecks: ['Test modal dialogs', 'Verify custom widgets allow focus escape']
  },
  '2.2.1': {
    percentage: 75,
    reason: 'Can detect timing mechanisms but adjustability requires interaction testing',
    automatedChecks: ['Detect session timeouts', 'Identify auto-updating content'],
    manualChecks: ['Verify timing can be extended', 'Check warnings are provided']
  },
  '2.2.2': {
    percentage: 80,
    reason: 'Can detect moving/blinking content but control mechanisms need verification',
    automatedChecks: ['Detect animations and auto-playing content', 'Check for pause controls'],
    manualChecks: ['Verify pause mechanism works', 'Check content remains accessible when paused']
  },
  '2.3.1': {
    percentage: 85,
    reason: 'Can analyze flash rates but edge cases may need manual review',
    automatedChecks: ['Analyze animation frame rates', 'Calculate flash frequency', 'Check against thresholds'],
    manualChecks: ['Review borderline cases', 'Check red flash specifically']
  },
  '2.4.2': {
    percentage: 89,
    reason: 'Page title presence is fully automatable, descriptiveness needs human judgment',
    automatedChecks: ['Check title element exists', 'Verify title is not empty', 'Check title length'],
    manualChecks: ['Verify title describes page purpose']
  },
  '2.4.3': {
    percentage: 75,
    reason: 'Can analyze focus order programmatically but logical sequence needs verification',
    automatedChecks: ['Map focus order through page', 'Detect focus order changes'],
    manualChecks: ['Verify focus order is logical', 'Check complex widget focus management']
  },
  '2.4.4': {
    percentage: 70,
    reason: 'Can analyze link text but purpose in context requires understanding',
    automatedChecks: ['Check for generic link text', 'Analyze surrounding context'],
    manualChecks: ['Verify link purpose is clear from context', 'Check programmatic context']
  },
  '2.4.5': {
    percentage: 85,
    reason: 'Can detect multiple navigation mechanisms presence',
    automatedChecks: ['Check for site navigation', 'Detect search functionality', 'Find sitemap'],
    manualChecks: ['Verify mechanisms are functional and useful']
  },
  '2.4.7': {
    percentage: 85,
    reason: 'Focus visibility is largely automatable but contrast and clarity need review',
    automatedChecks: ['Check for focus styles', 'Verify focus indicator presence'],
    manualChecks: ['Verify focus indicator is clearly visible', 'Check custom focus styles']
  },
  '3.2.1': {
    percentage: 80,
    reason: 'Can detect context changes on focus but appropriateness needs review',
    automatedChecks: ['Monitor for DOM changes on focus', 'Detect navigation on focus'],
    manualChecks: ['Verify any changes are appropriate', 'Check user expectations']
  },
  '3.2.2': {
    percentage: 80,
    reason: 'Can detect context changes on input but user expectation requires judgment',
    automatedChecks: ['Monitor for auto-submit behavior', 'Detect navigation on input'],
    manualChecks: ['Verify changes are expected', 'Check for advance warning']
  },
  '3.2.3': {
    percentage: 85,
    reason: 'Navigation consistency can be largely automated across pages',
    automatedChecks: ['Compare navigation across pages', 'Check menu order consistency'],
    manualChecks: ['Verify logical consistency', 'Check for appropriate variations']
  },
  '3.2.4': {
    percentage: 85,
    reason: 'Component identification consistency is largely automatable',
    automatedChecks: ['Compare similar components across pages', 'Check icon consistency'],
    manualChecks: ['Verify functional consistency', 'Check labeling patterns']
  },
  '3.3.1': {
    percentage: 75,
    reason: 'Can detect error states but identification quality needs review',
    automatedChecks: ['Check for error message elements', 'Verify error association with inputs'],
    manualChecks: ['Verify error messages are clear', 'Check error identification is helpful']
  },
  '3.3.3': {
    percentage: 70,
    reason: 'Can detect suggestion mechanisms but helpfulness requires judgment',
    automatedChecks: ['Check for correction suggestions', 'Detect input format hints'],
    manualChecks: ['Verify suggestions are helpful', 'Check suggestions are accessible']
  },
  '3.3.4': {
    percentage: 75,
    reason: 'Can detect review mechanisms but effectiveness needs verification',
    automatedChecks: ['Check for confirmation steps', 'Detect reversibility options'],
    manualChecks: ['Verify review process is effective', 'Check legal/financial safeguards']
  },
  '4.1.3': {
    percentage: 80,
    reason: 'Can detect live regions but appropriateness of announcements needs review',
    automatedChecks: ['Check for ARIA live regions', 'Verify role=status usage'],
    manualChecks: ['Verify announcements are appropriate', 'Check timing of updates']
  }
};

class ConfidenceAnalyzerService {
  /**
   * Static method to get the base confidence percentage for a criterion.
   * Returns 0 for manual-required criteria, the defined percentage for high/medium,
   * or 50 (LOW) for criteria without specific definitions.
   */
  static getCriterionConfidence(criterionId: string): number {
    if (ALWAYS_MANUAL_CRITERIA[criterionId]) {
      return 0; // Manual verification required
    }
    if (HIGH_CONFIDENCE_CRITERIA[criterionId]) {
      return HIGH_CONFIDENCE_CRITERIA[criterionId].percentage;
    }
    if (MEDIUM_CONFIDENCE_CRITERIA[criterionId]) {
      return MEDIUM_CONFIDENCE_CRITERIA[criterionId].percentage;
    }
    return 50; // Default LOW confidence
  }

  /**
   * Static method to check if a criterion requires manual verification.
   */
  static requiresManualVerification(criterionId: string): boolean {
    return !!ALWAYS_MANUAL_CRITERIA[criterionId];
  }

  analyzeConfidence(criterionId: string, _validationResult?: ValidationResultInput): ConfidenceAssessment {
    const wcagCriterion = this.getWcagCriterionName(criterionId);

    if (ALWAYS_MANUAL_CRITERIA[criterionId]) {
      const manualInfo = ALWAYS_MANUAL_CRITERIA[criterionId];
      return {
        criterionId,
        wcagCriterion,
        confidenceLevel: 'MANUAL_REQUIRED',
        confidencePercentage: 0,
        reason: manualInfo.reason,
        humanVerificationRequired: true,
        automatedChecks: ['Detection and flagging only'],
        manualChecksNeeded: manualInfo.manualChecks
      };
    }

    if (HIGH_CONFIDENCE_CRITERIA[criterionId]) {
      const highInfo = HIGH_CONFIDENCE_CRITERIA[criterionId];
      return {
        criterionId,
        wcagCriterion,
        confidenceLevel: 'HIGH',
        confidencePercentage: highInfo.percentage,
        reason: highInfo.reason,
        humanVerificationRequired: false,
        automatedChecks: highInfo.automatedChecks,
        manualChecksNeeded: []
      };
    }

    if (MEDIUM_CONFIDENCE_CRITERIA[criterionId]) {
      const mediumInfo = MEDIUM_CONFIDENCE_CRITERIA[criterionId];
      return {
        criterionId,
        wcagCriterion,
        confidenceLevel: 'MEDIUM',
        confidencePercentage: mediumInfo.percentage,
        reason: mediumInfo.reason,
        humanVerificationRequired: true,
        automatedChecks: mediumInfo.automatedChecks,
        manualChecksNeeded: mediumInfo.manualChecks
      };
    }

    return {
      criterionId,
      wcagCriterion,
      confidenceLevel: 'LOW',
      confidencePercentage: 50,
      reason: 'Limited automated detection capability - human review strongly recommended',
      humanVerificationRequired: true,
      automatedChecks: ['Basic presence/absence detection'],
      manualChecksNeeded: ['Full manual review required for this criterion']
    };
  }

  analyzeAllCriteria(validationResults: ValidationResultInput[]): ConfidenceSummary {
    const items: ConfidenceAssessment[] = validationResults.map(result =>
      this.analyzeConfidence(result.criterionId, result)
    );

    const summary: ConfidenceSummary = {
      totalCriteria: items.length,
      highConfidence: items.filter(i => i.confidenceLevel === 'HIGH').length,
      mediumConfidence: items.filter(i => i.confidenceLevel === 'MEDIUM').length,
      lowConfidence: items.filter(i => i.confidenceLevel === 'LOW').length,
      manualRequired: items.filter(i => i.confidenceLevel === 'MANUAL_REQUIRED').length,
      humanVerificationNeeded: items.filter(i => i.humanVerificationRequired).length,
      items
    };

    return summary;
  }

  getDefaultCriteriaSummary(): ConfidenceSummary {
    const allCriteria = [
      '1.1.1', '1.2.1', '1.2.2', '1.2.3', '1.3.1', '1.3.2', '1.3.3',
      '1.4.1', '1.4.3', '1.4.4', '1.4.5', '1.4.6',
      '2.1.1', '2.1.2', '2.2.1', '2.2.2', '2.3.1',
      '2.4.1', '2.4.2', '2.4.3', '2.4.4', '2.4.5', '2.4.6', '2.4.7',
      '3.1.1', '3.1.2', '3.2.1', '3.2.2', '3.2.3', '3.2.4',
      '3.3.1', '3.3.2', '3.3.3', '3.3.4',
      '4.1.1', '4.1.2', '4.1.3'
    ];

    const items = allCriteria.map(criterionId => this.analyzeConfidence(criterionId));

    return {
      totalCriteria: items.length,
      highConfidence: items.filter(i => i.confidenceLevel === 'HIGH').length,
      mediumConfidence: items.filter(i => i.confidenceLevel === 'MEDIUM').length,
      lowConfidence: items.filter(i => i.confidenceLevel === 'LOW').length,
      manualRequired: items.filter(i => i.confidenceLevel === 'MANUAL_REQUIRED').length,
      humanVerificationNeeded: items.filter(i => i.humanVerificationRequired).length,
      items
    };
  }

  private getWcagCriterionName(criterionId: string): string {
    const criterionNames: Record<string, string> = {
      '1.1.1': 'Non-text Content',
      '1.2.1': 'Audio-only and Video-only (Prerecorded)',
      '1.2.2': 'Captions (Prerecorded)',
      '1.2.3': 'Audio Description or Media Alternative (Prerecorded)',
      '1.3.1': 'Info and Relationships',
      '1.3.2': 'Meaningful Sequence',
      '1.3.3': 'Sensory Characteristics',
      '1.4.1': 'Use of Color',
      '1.4.3': 'Contrast (Minimum)',
      '1.4.4': 'Resize Text',
      '1.4.5': 'Images of Text',
      '1.4.6': 'Contrast (Enhanced)',
      '2.1.1': 'Keyboard',
      '2.1.2': 'No Keyboard Trap',
      '2.2.1': 'Timing Adjustable',
      '2.2.2': 'Pause, Stop, Hide',
      '2.3.1': 'Three Flashes or Below Threshold',
      '2.4.1': 'Bypass Blocks',
      '2.4.2': 'Page Titled',
      '2.4.3': 'Focus Order',
      '2.4.4': 'Link Purpose (In Context)',
      '2.4.5': 'Multiple Ways',
      '2.4.6': 'Headings and Labels',
      '2.4.7': 'Focus Visible',
      '3.1.1': 'Language of Page',
      '3.1.2': 'Language of Parts',
      '3.2.1': 'On Focus',
      '3.2.2': 'On Input',
      '3.2.3': 'Consistent Navigation',
      '3.2.4': 'Consistent Identification',
      '3.3.1': 'Error Identification',
      '3.3.2': 'Labels or Instructions',
      '3.3.3': 'Error Suggestion',
      '3.3.4': 'Error Prevention (Legal, Financial, Data)',
      '4.1.1': 'Parsing',
      '4.1.2': 'Name, Role, Value',
      '4.1.3': 'Status Messages'
    };

    return criterionNames[criterionId] || `WCAG ${criterionId}`;
  }
}

export { ConfidenceAnalyzerService };
export const confidenceAnalyzerService = new ConfidenceAnalyzerService();
