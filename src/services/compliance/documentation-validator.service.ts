import { logger } from '../../lib/logger';

export interface DocumentationIssue {
  code: string;
  section: string;
  severity: 'critical' | 'major' | 'minor';
  description: string;
  recommendation: string;
  wcagMapping?: string;
}

export interface DocumentationChecklistItem {
  id: string;
  requirement: string;
  section: string;
  checked: boolean;
  notes?: string;
}

export interface DocumentationValidationResult {
  hasAccessibilityDocumentation: boolean;
  documentationAccessible: boolean;
  alternateFormatsAvailable: boolean;
  issues: DocumentationIssue[];
  checklist: DocumentationChecklistItem[];
  score: number;
  compliance: {
    section602_3: 'Supports' | 'Partially Supports' | 'Does Not Support' | 'Not Applicable';
    section602_4: 'Supports' | 'Partially Supports' | 'Does Not Support' | 'Not Applicable';
  };
}

export interface DocumentationMetadata {
  hasAccessibilityStatement?: boolean;
  hasContactMethod?: boolean;
  hasAlternateFormats?: boolean;
  formats?: string[];
  accessibilityStatementUrl?: string;
  contactEmail?: string;
  contactPhone?: string;
  brailleAvailable?: boolean;
  largePrintAvailable?: boolean;
  audioAvailable?: boolean;
}

const CHAPTER_6_REQUIREMENTS = {
  '602.2': {
    section: '602.2',
    title: 'Accessibility and Compatibility Features',
    description: 'Documentation shall list and explain how to use the accessibility and compatibility features.',
  },
  '602.3': {
    section: '602.3',
    title: 'Electronic Support Documentation',
    description: 'Documentation in electronic format shall conform to Level A and Level AA Success Criteria in WCAG 2.0.',
  },
  '602.4': {
    section: '602.4',
    title: 'Alternate Formats for Non-Electronic Documentation',
    description: 'Where non-electronic documentation is provided, alternate formats usable by individuals with disabilities shall be provided upon request.',
  },
};

const MANUAL_VERIFICATION_CHECKLIST: Omit<DocumentationChecklistItem, 'checked' | 'notes'>[] = [
  {
    id: 'accessibility-statement',
    requirement: 'Accessibility statement is available and publicly accessible',
    section: '602.2',
  },
  {
    id: 'contact-method',
    requirement: 'Contact method for accessibility requests is provided (email, phone, or form)',
    section: '602.2',
  },
  {
    id: 'feature-documentation',
    requirement: 'Accessibility features are documented and explained',
    section: '602.2',
  },
  {
    id: 'documentation-wcag',
    requirement: 'Electronic documentation conforms to WCAG 2.0 Level AA',
    section: '602.3',
  },
  {
    id: 'documentation-accessible-format',
    requirement: 'Documentation is available in accessible electronic format (HTML, accessible PDF)',
    section: '602.3',
  },
  {
    id: 'alternate-braille',
    requirement: 'Braille format available upon request',
    section: '602.4',
  },
  {
    id: 'alternate-large-print',
    requirement: 'Large print format available upon request',
    section: '602.4',
  },
  {
    id: 'alternate-audio',
    requirement: 'Audio format available upon request',
    section: '602.4',
  },
  {
    id: 'request-process',
    requirement: 'Process for requesting alternate formats is documented',
    section: '602.4',
  },
];

class DocumentationValidatorService {
  validateDocumentation(metadata: DocumentationMetadata): DocumentationValidationResult {
    logger.info('Starting Chapter 6 documentation validation...');

    const issues: DocumentationIssue[] = [];
    const checklist = this.generateChecklist(metadata);

    const hasAccessibilityDocumentation = this.checkAccessibilityDocumentation(metadata, issues);
    const documentationAccessible = this.checkDocumentationAccessibility(metadata, issues);
    const alternateFormatsAvailable = this.checkAlternateFormats(metadata, issues);

    const section602_3 = this.evaluateSection602_3(metadata, issues);
    const section602_4 = this.evaluateSection602_4(metadata, issues);

    const score = this.calculateScore(checklist, issues);

    logger.info(`Chapter 6 validation completed - Score: ${score}%, Issues: ${issues.length}`);

    return {
      hasAccessibilityDocumentation,
      documentationAccessible,
      alternateFormatsAvailable,
      issues,
      checklist,
      score,
      compliance: {
        section602_3,
        section602_4,
      },
    };
  }

  private checkAccessibilityDocumentation(
    metadata: DocumentationMetadata,
    issues: DocumentationIssue[]
  ): boolean {
    let hasDocumentation = false;

    if (metadata.hasAccessibilityStatement) {
      hasDocumentation = true;
    } else {
      issues.push({
        code: '602.2-1',
        section: '602.2',
        severity: 'critical',
        description: 'No accessibility statement found',
        recommendation: 'Create and publish an accessibility statement that describes the accessibility features and any known limitations.',
        wcagMapping: 'WCAG 2.0 AA',
      });
    }

    if (!metadata.hasContactMethod) {
      issues.push({
        code: '602.2-2',
        section: '602.2',
        severity: 'major',
        description: 'No contact method for accessibility requests provided',
        recommendation: 'Provide a dedicated email address, phone number, or contact form for accessibility-related inquiries.',
      });
    }

    return hasDocumentation;
  }

  private checkDocumentationAccessibility(
    metadata: DocumentationMetadata,
    issues: DocumentationIssue[]
  ): boolean {
    const formats = metadata.formats || [];
    const accessibleFormats = ['html', 'accessible-pdf', 'epub'];
    
    const hasAccessibleFormat = formats.some(f => 
      accessibleFormats.includes(f.toLowerCase())
    );

    if (!hasAccessibleFormat && formats.length > 0) {
      issues.push({
        code: '602.3-1',
        section: '602.3',
        severity: 'major',
        description: 'Documentation not available in accessible electronic format',
        recommendation: 'Provide documentation in accessible formats such as HTML, accessible PDF, or EPUB.',
        wcagMapping: 'WCAG 2.0 AA',
      });
    }

    if (formats.length === 0) {
      issues.push({
        code: '602.3-2',
        section: '602.3',
        severity: 'critical',
        description: 'No documentation formats specified',
        recommendation: 'Specify the formats in which documentation is available and ensure at least one is accessible.',
        wcagMapping: 'WCAG 2.0 AA',
      });
      return false;
    }

    return hasAccessibleFormat;
  }

  private checkAlternateFormats(
    metadata: DocumentationMetadata,
    issues: DocumentationIssue[]
  ): boolean {
    const hasAnyAlternate = 
      metadata.brailleAvailable === true || 
      metadata.largePrintAvailable === true || 
      metadata.audioAvailable === true;

    if (!hasAnyAlternate) {
      issues.push({
        code: '602.4-1',
        section: '602.4',
        severity: 'major',
        description: 'No alternate formats (Braille, large print, audio) available upon request',
        recommendation: 'Establish a process to provide documentation in Braille, large print, or audio format upon request.',
      });
    }

    if (!metadata.brailleAvailable) {
      issues.push({
        code: '602.4-2',
        section: '602.4',
        severity: 'minor',
        description: 'Braille format not available',
        recommendation: 'Consider partnering with a Braille transcription service to provide Braille versions upon request.',
      });
    }

    if (!metadata.largePrintAvailable) {
      issues.push({
        code: '602.4-3',
        section: '602.4',
        severity: 'minor',
        description: 'Large print format not available',
        recommendation: 'Prepare large print versions (minimum 18pt font) of key documentation.',
      });
    }

    if (!metadata.audioAvailable) {
      issues.push({
        code: '602.4-4',
        section: '602.4',
        severity: 'minor',
        description: 'Audio format not available',
        recommendation: 'Consider providing audio recordings or text-to-speech compatible versions of documentation.',
      });
    }

    return hasAnyAlternate;
  }

  private evaluateSection602_3(
    metadata: DocumentationMetadata,
    issues: DocumentationIssue[]
  ): 'Supports' | 'Partially Supports' | 'Does Not Support' | 'Not Applicable' {
    const section602_3Issues = issues.filter(i => i.section === '602.3');
    const criticalIssues = section602_3Issues.filter(i => i.severity === 'critical');
    const majorIssues = section602_3Issues.filter(i => i.severity === 'major');

    if (criticalIssues.length > 0) {
      return 'Does Not Support';
    }

    if (majorIssues.length > 0) {
      return 'Partially Supports';
    }

    const formats = metadata.formats || [];
    if (formats.length === 0 && !metadata.hasAccessibilityStatement && section602_3Issues.length === 0) {
      return 'Not Applicable';
    }

    return 'Supports';
  }

  private evaluateSection602_4(
    metadata: DocumentationMetadata,
    issues: DocumentationIssue[]
  ): 'Supports' | 'Partially Supports' | 'Does Not Support' | 'Not Applicable' {
    const section602_4Issues = issues.filter(i => i.section === '602.4');
    const majorIssues = section602_4Issues.filter(i => i.severity === 'major');

    const hasAnyAlternate = 
      metadata.brailleAvailable === true || 
      metadata.largePrintAvailable === true || 
      metadata.audioAvailable === true;

    if (!hasAnyAlternate && majorIssues.length > 0) {
      return 'Does Not Support';
    }

    if (hasAnyAlternate && section602_4Issues.length > 0) {
      return 'Partially Supports';
    }

    if (hasAnyAlternate && section602_4Issues.length === 0) {
      return 'Supports';
    }

    return 'Does Not Support';
  }

  private generateChecklist(metadata: DocumentationMetadata): DocumentationChecklistItem[] {
    return MANUAL_VERIFICATION_CHECKLIST.map(item => {
      let checked = false;
      let notes: string | undefined;

      switch (item.id) {
        case 'accessibility-statement':
          checked = !!metadata.hasAccessibilityStatement;
          if (metadata.accessibilityStatementUrl) {
            notes = `URL: ${metadata.accessibilityStatementUrl}`;
          }
          break;
        case 'contact-method':
          checked = !!metadata.hasContactMethod;
          if (metadata.contactEmail || metadata.contactPhone) {
            notes = [
              metadata.contactEmail ? `Email: ${metadata.contactEmail}` : '',
              metadata.contactPhone ? `Phone: ${metadata.contactPhone}` : '',
            ].filter(Boolean).join(', ');
          }
          break;
        case 'alternate-braille':
          checked = metadata.brailleAvailable === true;
          break;
        case 'alternate-large-print':
          checked = metadata.largePrintAvailable === true;
          break;
        case 'alternate-audio':
          checked = metadata.audioAvailable === true;
          break;
        case 'documentation-accessible-format': {
          const formats = metadata.formats || [];
          const accessibleFormats = ['html', 'accessible-pdf', 'epub'];
          checked = formats.some(f => accessibleFormats.includes(f.toLowerCase()));
          if (formats.length > 0) {
            notes = `Available formats: ${formats.join(', ')}`;
          }
          break;
        }
        default:
          checked = false;
          notes = 'Requires manual verification';
      }

      return { ...item, checked, notes };
    });
  }

  private calculateScore(checklist: DocumentationChecklistItem[], issues: DocumentationIssue[]): number {
    const totalItems = checklist.length;
    if (totalItems === 0) return 0;

    const checkedItems = checklist.filter(item => item.checked).length;
    const baseScore = (checkedItems / totalItems) * 100;

    let penalty = 0;
    for (const issue of issues) {
      switch (issue.severity) {
        case 'critical':
          penalty += 15;
          break;
        case 'major':
          penalty += 8;
          break;
        case 'minor':
          penalty += 3;
          break;
      }
    }

    return Math.max(0, Math.round(baseScore - penalty));
  }

  getRequirements(): typeof CHAPTER_6_REQUIREMENTS {
    return { ...CHAPTER_6_REQUIREMENTS };
  }

  getChecklist(): Omit<DocumentationChecklistItem, 'checked' | 'notes'>[] {
    return [...MANUAL_VERIFICATION_CHECKLIST];
  }
}

export const documentationValidatorService = new DocumentationValidatorService();
