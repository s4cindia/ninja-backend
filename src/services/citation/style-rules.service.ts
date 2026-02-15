import { logger as _logger } from '../../lib/logger';

export interface StyleRule {
  id: string;
  reference: string;      // "APA 8.17"
  name: string;           // "Use ampersand in parenthetical citations"
  category: 'punctuation' | 'capitalization' | 'author_format' | 'date_format' | 'italics' | 'order';
  description: string;
  examples: {
    incorrect: string;
    correct: string;
  }[];
  severity: 'error' | 'warning';
}

export interface StyleDefinition {
  code: string;
  name: string;
  version: string;
  inTextRules: StyleRule[];
  referenceRules: StyleRule[];
  sortOrder: 'alphabetical' | 'numbered' | 'appearance';
}

const APA7_RULES: StyleRule[] = [
  {
    id: 'apa7-ampersand-parenthetical',
    reference: 'APA 8.17',
    name: 'Use ampersand in parenthetical citations',
    category: 'author_format',
    description: 'In parenthetical citations, use "&" instead of "and" between author names.',
    examples: [
      { incorrect: '(Smith and Jones, 2020)', correct: '(Smith & Jones, 2020)' }
    ],
    severity: 'error'
  },
  {
    id: 'apa7-and-narrative',
    reference: 'APA 8.17',
    name: 'Use "and" in narrative citations',
    category: 'author_format',
    description: 'In narrative citations, use "and" instead of "&" between author names.',
    examples: [
      { incorrect: 'Smith & Jones (2020) found...', correct: 'Smith and Jones (2020) found...' }
    ],
    severity: 'error'
  },
  {
    id: 'apa7-et-al',
    reference: 'APA 8.17',
    name: 'Use et al. for three or more authors',
    category: 'author_format',
    description: 'For works with three or more authors, use the first author followed by "et al."',
    examples: [
      { incorrect: '(Smith, Jones, and Williams, 2020)', correct: '(Smith et al., 2020)' }
    ],
    severity: 'error'
  },
  {
    id: 'apa7-comma-before-year',
    reference: 'APA 8.11',
    name: 'Comma before year in parenthetical citations',
    category: 'punctuation',
    description: 'Place a comma between the author name(s) and year.',
    examples: [
      { incorrect: '(Smith 2020)', correct: '(Smith, 2020)' }
    ],
    severity: 'error'
  },
  {
    id: 'apa7-no-comma-narrative',
    reference: 'APA 8.11',
    name: 'No comma before year in narrative citations',
    category: 'punctuation',
    description: 'In narrative citations, do not place a comma before the year in parentheses.',
    examples: [
      { incorrect: 'Smith, (2020) found...', correct: 'Smith (2020) found...' }
    ],
    severity: 'error'
  },
  {
    id: 'apa7-nd-for-no-date',
    reference: 'APA 8.14',
    name: 'Use n.d. for no date',
    category: 'date_format',
    description: 'When no date is available, use "n.d." (no date).',
    examples: [
      { incorrect: '(Smith, no date)', correct: '(Smith, n.d.)' }
    ],
    severity: 'warning'
  },
  {
    id: 'apa7-multiple-citations-order',
    reference: 'APA 8.12',
    name: 'Alphabetize multiple citations',
    category: 'order',
    description: 'Multiple citations in the same parentheses should be alphabetized by first author.',
    examples: [
      { incorrect: '(Zebra, 2020; Apple, 2019)', correct: '(Apple, 2019; Zebra, 2020)' }
    ],
    severity: 'warning'
  },
  {
    id: 'apa7-semicolon-multiple',
    reference: 'APA 8.12',
    name: 'Semicolons between multiple citations',
    category: 'punctuation',
    description: 'Separate multiple citations in the same parentheses with semicolons.',
    examples: [
      { incorrect: '(Smith, 2020, Jones, 2019)', correct: '(Smith, 2020; Jones, 2019)' }
    ],
    severity: 'error'
  },
  {
    id: 'apa7-author-capitalization',
    reference: 'APA 6.14',
    name: 'Capitalize author surnames',
    category: 'capitalization',
    description: 'Author surnames should be capitalized.',
    examples: [
      { incorrect: '(smith, 2020)', correct: '(Smith, 2020)' }
    ],
    severity: 'error'
  },
  {
    id: 'apa7-page-number-format',
    reference: 'APA 8.13',
    name: 'Page number format',
    category: 'punctuation',
    description: 'Use "p." for single page, "pp." for page range.',
    examples: [
      { incorrect: '(Smith, 2020, page 45)', correct: '(Smith, 2020, p. 45)' },
      { incorrect: '(Smith, 2020, p. 45-50)', correct: '(Smith, 2020, pp. 45-50)' }
    ],
    severity: 'error'
  }
];

const MLA9_RULES: StyleRule[] = [
  {
    id: 'mla9-no-comma-author-page',
    reference: 'MLA 6.1',
    name: 'No comma between author and page',
    category: 'punctuation',
    description: 'In MLA, do not use a comma between author name and page number.',
    examples: [
      { incorrect: '(Smith, 45)', correct: '(Smith 45)' }
    ],
    severity: 'error'
  },
  {
    id: 'mla9-no-p-page',
    reference: 'MLA 6.1',
    name: 'No "p." before page numbers',
    category: 'punctuation',
    description: 'Do not use "p." or "pp." before page numbers.',
    examples: [
      { incorrect: '(Smith p. 45)', correct: '(Smith 45)' }
    ],
    severity: 'error'
  },
  {
    id: 'mla9-and-two-authors',
    reference: 'MLA 6.1',
    name: 'Use "and" for two authors',
    category: 'author_format',
    description: 'Use "and" between two author names.',
    examples: [
      { incorrect: '(Smith & Jones 45)', correct: '(Smith and Jones 45)' }
    ],
    severity: 'error'
  },
  {
    id: 'mla9-et-al-three-plus',
    reference: 'MLA 6.1',
    name: 'Use et al. for three or more authors',
    category: 'author_format',
    description: 'For three or more authors, use first author followed by "et al."',
    examples: [
      { incorrect: '(Smith, Jones, and Williams 45)', correct: '(Smith et al. 45)' }
    ],
    severity: 'error'
  }
];

const CHICAGO17_RULES: StyleRule[] = [
  {
    id: 'chicago17-comma-year',
    reference: 'Chicago 15.20',
    name: 'Comma before year',
    category: 'punctuation',
    description: 'Use comma between author and year.',
    examples: [
      { incorrect: '(Smith 2020)', correct: '(Smith, 2020)' }
    ],
    severity: 'error'
  },
  {
    id: 'chicago17-and-two-authors',
    reference: 'Chicago 15.21',
    name: 'Use "and" for two authors',
    category: 'author_format',
    description: 'Use "and" between two author names in citations.',
    examples: [
      { incorrect: '(Smith & Jones, 2020)', correct: '(Smith and Jones, 2020)' }
    ],
    severity: 'error'
  },
  {
    id: 'chicago17-et-al-four-plus',
    reference: 'Chicago 15.22',
    name: 'Use et al. for four or more authors',
    category: 'author_format',
    description: 'For four or more authors, use first author plus "et al."',
    examples: [
      { incorrect: '(Smith, Jones, Williams, and Brown, 2020)', correct: '(Smith et al., 2020)' }
    ],
    severity: 'error'
  }
];

const VANCOUVER_RULES: StyleRule[] = [
  {
    id: 'vancouver-numeric-bracket',
    reference: 'Vancouver 1.1',
    name: 'Use bracketed numbers',
    category: 'punctuation',
    description: 'Citations should be numbered in brackets.',
    examples: [
      { incorrect: '(1)', correct: '[1]' },
      { incorrect: '¹', correct: '[1]' }
    ],
    severity: 'error'
  },
  {
    id: 'vancouver-sequential',
    reference: 'Vancouver 1.2',
    name: 'Sequential numbering',
    category: 'order',
    description: 'Citations should be numbered in order of appearance.',
    examples: [
      { incorrect: '[3] appears before [1]', correct: '[1] appears before [2]' }
    ],
    severity: 'error'
  }
];

class StyleRulesService {
  private styles: Map<string, StyleDefinition> = new Map();

  constructor() {
    this.initializeStyles();
  }

  private initializeStyles() {
    this.styles.set('apa7', {
      code: 'apa7',
      name: 'APA 7th Edition',
      version: '7th',
      inTextRules: APA7_RULES,
      referenceRules: [],
      sortOrder: 'alphabetical'
    });

    this.styles.set('mla9', {
      code: 'mla9',
      name: 'MLA 9th Edition',
      version: '9th',
      inTextRules: MLA9_RULES,
      referenceRules: [],
      sortOrder: 'alphabetical'
    });

    this.styles.set('chicago17', {
      code: 'chicago17',
      name: 'Chicago 17th Edition',
      version: '17th',
      inTextRules: CHICAGO17_RULES,
      referenceRules: [],
      sortOrder: 'alphabetical'
    });

    this.styles.set('vancouver', {
      code: 'vancouver',
      name: 'Vancouver',
      version: 'ICMJE',
      inTextRules: VANCOUVER_RULES,
      referenceRules: [],
      sortOrder: 'numbered'
    });

    this.styles.set('ieee', {
      code: 'ieee',
      name: 'IEEE',
      version: '2024',
      inTextRules: VANCOUVER_RULES,
      referenceRules: [],
      sortOrder: 'numbered'
    });
  }

  getAvailableStyles(): { code: string; name: string; version: string }[] {
    return Array.from(this.styles.values()).map(s => ({
      code: s.code,
      name: s.name,
      version: s.version
    }));
  }

  getStyle(code: string): StyleDefinition | undefined {
    return this.styles.get(code);
  }

  getRulesForStyle(code: string): StyleRule[] {
    const style = this.styles.get(code);
    return style?.inTextRules || [];
  }

  getRuleById(styleCode: string, ruleId: string): StyleRule | undefined {
    const rules = this.getRulesForStyle(styleCode);
    return rules.find(r => r.id === ruleId);
  }

  getRulesByCategory(styleCode: string, category: string): StyleRule[] {
    const rules = this.getRulesForStyle(styleCode);
    return rules.filter(r => r.category === category);
  }
}

export const styleRulesService = new StyleRulesService();
