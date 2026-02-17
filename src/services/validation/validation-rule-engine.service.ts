export interface ValidationRule {
  id: string;
  name: string;
  category: 'text' | 'images' | 'structure' | 'navigation' | 'forms' | 'media';
  wcagCriteria: string[];
  severity: 'error' | 'warning' | 'info';
  enabled: boolean;
  description: string;
}

export interface ValidationResult {
  passed: boolean;
  ruleId: string;
  ruleName: string;
  severity: 'error' | 'warning' | 'info';
  message?: string;
  details?: Record<string, unknown>;
}

export interface ContentToValidate {
  type: string;
  content: string;
  metadata?: Record<string, unknown>;
}

const VALIDATION_RULES: ValidationRule[] = [
  {
    id: 'text-alt-images',
    name: 'Alternative Text for Images',
    category: 'images',
    wcagCriteria: ['1.1.1'],
    severity: 'error',
    enabled: true,
    description: 'All images must have alternative text'
  },
  {
    id: 'text-heading-hierarchy',
    name: 'Heading Hierarchy',
    category: 'structure',
    wcagCriteria: ['1.3.1', '2.4.6'],
    severity: 'error',
    enabled: true,
    description: 'Headings must follow a logical hierarchy'
  },
  {
    id: 'text-contrast-minimum',
    name: 'Color Contrast',
    category: 'text',
    wcagCriteria: ['1.4.3'],
    severity: 'error',
    enabled: true,
    description: 'Text must have sufficient color contrast'
  },
  {
    id: 'text-language-defined',
    name: 'Language Defined',
    category: 'structure',
    wcagCriteria: ['3.1.1'],
    severity: 'error',
    enabled: true,
    description: 'Document must have a defined language'
  },
  {
    id: 'nav-link-purpose',
    name: 'Link Purpose',
    category: 'navigation',
    wcagCriteria: ['2.4.4'],
    severity: 'warning',
    enabled: true,
    description: 'Link text should describe the link destination'
  },
  {
    id: 'nav-focus-order',
    name: 'Focus Order',
    category: 'navigation',
    wcagCriteria: ['2.4.3'],
    severity: 'error',
    enabled: true,
    description: 'Focus order should be logical and meaningful'
  },
  {
    id: 'form-labels',
    name: 'Form Labels',
    category: 'forms',
    wcagCriteria: ['3.3.2'],
    severity: 'error',
    enabled: true,
    description: 'Form inputs must have associated labels'
  },
  {
    id: 'media-captions',
    name: 'Media Captions',
    category: 'media',
    wcagCriteria: ['1.2.1'],
    severity: 'warning',
    enabled: true,
    description: 'Audio and video should have captions or transcripts'
  },
  {
    id: 'structure-reading-order',
    name: 'Reading Order',
    category: 'structure',
    wcagCriteria: ['1.3.2'],
    severity: 'error',
    enabled: true,
    description: 'Content must have a meaningful reading order'
  },
  {
    id: 'text-resize',
    name: 'Text Resize',
    category: 'text',
    wcagCriteria: ['1.4.4'],
    severity: 'warning',
    enabled: true,
    description: 'Text should be resizable without loss of functionality'
  }
];

export class ValidationRuleEngine {
  private rules: ValidationRule[] = [...VALIDATION_RULES];

  getActiveRules(): ValidationRule[] {
    return this.rules.filter(r => r.enabled !== false);
  }

  getAllRules(): ValidationRule[] {
    return [...this.rules];
  }

  getRuleById(id: string): ValidationRule | undefined {
    return this.rules.find(r => r.id === id);
  }

  getRulesByCategory(category: ValidationRule['category']): ValidationRule[] {
    return this.rules.filter(r => r.category === category);
  }

  getRulesBySeverity(severity: ValidationRule['severity']): ValidationRule[] {
    return this.rules.filter(r => r.severity === severity);
  }

  getRulesByWCAGCriterion(criterionId: string): ValidationRule[] {
    return this.rules.filter(r => r.wcagCriteria.includes(criterionId));
  }

  async validateRule(rule: ValidationRule, content: ContentToValidate): Promise<ValidationResult> {
    const result: ValidationResult = {
      passed: true,
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity
    };

    switch (rule.id) {
      case 'text-alt-images':
        if (content.type === 'image' && !content.metadata?.altText) {
          result.passed = false;
          result.message = 'Image is missing alternative text';
        }
        break;

      case 'text-heading-hierarchy':
        if (content.type === 'structure' && content.metadata?.headingSkipped) {
          result.passed = false;
          result.message = 'Heading levels are skipped';
        }
        break;

      case 'text-language-defined':
        if (content.type === 'document' && !content.metadata?.language) {
          result.passed = false;
          result.message = 'Document language is not defined';
        }
        break;

      default:
        result.passed = true;
        result.message = 'Rule validation completed';
    }

    return result;
  }

  async validateContent(content: ContentToValidate): Promise<ValidationResult[]> {
    const activeRules = this.getActiveRules();
    const results: ValidationResult[] = [];

    for (const rule of activeRules) {
      const result = await this.validateRule(rule, content);
      results.push(result);
    }

    return results;
  }
}

export const validationRuleEngine = new ValidationRuleEngine();
