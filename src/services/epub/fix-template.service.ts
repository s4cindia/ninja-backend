interface FixStep {
  step: number;
  instruction: string;
  code?: string;
}

interface CodeExample {
  before: string;
  after: string;
  description?: string;
}

interface FixTemplate {
  issueCode: string;
  category: 'metadata' | 'image' | 'structure' | 'navigation' | 'semantic' | 'validation' | 'accessibility';
  title: string;
  description: string;
  tool: 'sigil' | 'calibre' | 'text-editor' | 'in-app' | 'any';
  toolName: string;
  steps: FixStep[];
  codeExample?: CodeExample;
  resources?: Array<{ label: string; url: string }>;
  wcagCriteria?: string | null; // null indicates no direct WCAG mapping
  canAutoFix: boolean;
  canQuickFix: boolean;
}

const FIX_TEMPLATES: Record<string, FixTemplate> = {
  'OPF-085': {
    issueCode: 'OPF-085',
    category: 'metadata',
    title: 'Fix Invalid UUID Format',
    description: 'The dc:identifier value is marked as a UUID but contains an invalid format. UUIDs must follow the standard format with 32 hexadecimal digits separated by hyphens.',
    tool: 'sigil',
    toolName: 'Sigil',
    steps: [
      { step: 1, instruction: 'Open in Sigil: File → Open → Select your EPUB' },
      { step: 2, instruction: 'Open Book Browser panel (View → Book Browser)' },
      { step: 3, instruction: 'Double-click content.opf to open it' },
      { step: 4, instruction: 'Find the <dc:identifier> element with the invalid UUID' },
      { step: 5, instruction: 'Either fix the UUID format or change the identifier scheme' },
      { step: 6, instruction: 'Save: Ctrl+S' },
    ],
    codeExample: {
      before: '<dc:identifier id="uid">urn:uuid:ninja-test-03-empty-alt</dc:identifier>',
      after: '<dc:identifier id="uid">urn:uuid:550e8400-e29b-41d4-a716-446655440000</dc:identifier>',
      description: 'Replace with a valid UUID (32 hex digits with dashes) or remove the urn:uuid: prefix',
    },
    resources: [
      { label: 'UUID Generator', url: 'https://www.uuidgenerator.net/' },
      { label: 'EPUB 3 Identifiers', url: 'https://www.w3.org/publishing/epub3/epub-packages.html#sec-opf-dcidentifier' },
    ],
    wcagCriteria: null, // OPF-085 is an EPUB spec issue, not directly mapped to WCAG
    canAutoFix: false,
    canQuickFix: false,
  },

  'EPUB-IMG-001': {
    issueCode: 'EPUB-IMG-001',
    category: 'image',
    title: 'Add Meaningful Alt Text',
    description: 'Images must have alternative text that describes their content for screen reader users. Use descriptive text for informative images, or empty alt="" for purely decorative images.',
    tool: 'in-app',
    toolName: 'Quick Fix Panel',
    steps: [
      { step: 1, instruction: 'Click "Open Quick Fix Panel" to view the image' },
      { step: 2, instruction: 'Select the image type (Decorative, Informative, or Complex)' },
      { step: 3, instruction: 'For informative images: Click "Generate with AI" or write your own description' },
      { step: 4, instruction: 'For decorative images: Select "Decorative Image" to use empty alt=""' },
      { step: 5, instruction: 'Review and apply the fix' },
    ],
    codeExample: {
      before: '<img src="images/figure1.jpg" />',
      after: '<img src="images/figure1.jpg" alt="Bar chart showing sales growth from 2020 to 2024, with 15% year-over-year increase" />',
      description: 'Add alt attribute with descriptive text',
    },
    resources: [
      { label: 'Alt Text Decision Tree', url: 'https://www.w3.org/WAI/tutorials/images/decision-tree/' },
      { label: 'WCAG 1.1.1 Non-text Content', url: 'https://www.w3.org/WAI/WCAG21/Understanding/non-text-content.html' },
    ],
    wcagCriteria: '1.1.1',
    canAutoFix: false,
    canQuickFix: true,
  },

  'EPUB-META-001': {
    issueCode: 'EPUB-META-001',
    category: 'metadata',
    title: 'Add Document Language',
    description: 'The publication must declare its primary language using the dc:language element. This helps screen readers pronounce content correctly.',
    tool: 'in-app',
    toolName: 'Auto-Fix',
    steps: [
      { step: 1, instruction: 'This issue can be auto-fixed by the system' },
      { step: 2, instruction: 'Click "Start Remediation" to apply automatic fixes' },
      { step: 3, instruction: 'The system will add <dc:language>en</dc:language> to your package document' },
    ],
    codeExample: {
      before: '<metadata>\n  <dc:title>My Book</dc:title>\n</metadata>',
      after: '<metadata>\n  <dc:title>My Book</dc:title>\n  <dc:language>en</dc:language>\n</metadata>',
      description: 'Add dc:language element with appropriate language code',
    },
    resources: [
      { label: 'Language Tags', url: 'https://www.w3.org/International/articles/language-tags/' },
    ],
    wcagCriteria: '3.1.1',
    canAutoFix: true,
    canQuickFix: false,
  },

  'EPUB-META-002': {
    issueCode: 'EPUB-META-002',
    category: 'metadata',
    title: 'Add Accessibility Features Metadata',
    description: 'Declare the accessibility features present in your publication using schema:accessibilityFeature metadata.',
    tool: 'in-app',
    toolName: 'Auto-Fix',
    steps: [
      { step: 1, instruction: 'This issue can be auto-fixed by the system' },
      { step: 2, instruction: 'Click "Start Remediation" to apply automatic fixes' },
      { step: 3, instruction: 'The system will add appropriate accessibilityFeature metadata' },
    ],
    codeExample: {
      before: '<metadata>\n  <!-- No accessibility features declared -->\n</metadata>',
      after: '<metadata>\n  <meta property="schema:accessibilityFeature">alternativeText</meta>\n  <meta property="schema:accessibilityFeature">readingOrder</meta>\n  <meta property="schema:accessibilityFeature">structuralNavigation</meta>\n</metadata>',
      description: 'Add schema:accessibilityFeature metadata elements',
    },
    wcagCriteria: null, // EPUB accessibility metadata requirement, no direct WCAG equivalent
    canAutoFix: true,
    canQuickFix: false,
  },

  'EPUB-META-003': {
    issueCode: 'EPUB-META-003',
    category: 'metadata',
    title: 'Add Accessibility Summary',
    description: 'Provide a human-readable summary of the publication\'s accessibility features and any known limitations.',
    tool: 'in-app',
    toolName: 'Auto-Fix',
    steps: [
      { step: 1, instruction: 'This issue can be auto-fixed by the system' },
      { step: 2, instruction: 'Click "Start Remediation" to apply automatic fixes' },
      { step: 3, instruction: 'The system will add a default accessibility summary' },
      { step: 4, instruction: 'You may want to customize the summary after auto-fix' },
    ],
    codeExample: {
      before: '<metadata>\n  <!-- No accessibility summary -->\n</metadata>',
      after: '<metadata>\n  <meta property="schema:accessibilitySummary">This publication meets basic accessibility requirements. All images have alternative text descriptions. The content follows a logical reading order with proper heading structure for navigation.</meta>\n</metadata>',
      description: 'Add schema:accessibilitySummary with descriptive text',
    },
    wcagCriteria: null, // EPUB accessibility metadata requirement, no direct WCAG equivalent
    canAutoFix: true,
    canQuickFix: false,
  },

  'EPUB-META-004': {
    issueCode: 'EPUB-META-004',
    category: 'metadata',
    title: 'Add Access Mode Metadata',
    description: 'Declare how the content can be consumed using schema:accessMode metadata (textual, visual, auditory).',
    tool: 'in-app',
    toolName: 'Auto-Fix',
    steps: [
      { step: 1, instruction: 'This issue can be auto-fixed by the system' },
      { step: 2, instruction: 'Click "Start Remediation" to apply automatic fixes' },
      { step: 3, instruction: 'The system will add accessMode and accessModeSufficient metadata' },
    ],
    codeExample: {
      before: '<metadata>\n  <!-- No access mode declared -->\n</metadata>',
      after: '<metadata>\n  <meta property="schema:accessMode">textual</meta>\n  <meta property="schema:accessModeSufficient">textual</meta>\n</metadata>',
      description: 'Add schema:accessMode and schema:accessModeSufficient metadata',
    },
    wcagCriteria: null, // EPUB accessibility metadata requirement, no direct WCAG equivalent
    canAutoFix: true,
    canQuickFix: false,
  },

  'EPUB-STRUCT-002': {
    issueCode: 'EPUB-STRUCT-002',
    category: 'structure',
    title: 'Add Table Headers',
    description: 'Data tables must have header cells (<th>) with proper scope attributes to associate headers with data cells.',
    tool: 'in-app',
    toolName: 'Quick Fix Panel',
    steps: [
      { step: 1, instruction: 'Click "Open Quick Fix Panel" to view the table' },
      { step: 2, instruction: 'Identify which cells should be headers (usually first row or column)' },
      { step: 3, instruction: 'Apply the suggested fix or customize the header structure' },
      { step: 4, instruction: 'Verify the table reads correctly with a screen reader' },
    ],
    codeExample: {
      before: '<table>\n  <tr>\n    <td>Name</td>\n    <td>Price</td>\n  </tr>\n  <tr>\n    <td>Apple</td>\n    <td>$1.00</td>\n  </tr>\n</table>',
      after: '<table>\n  <tr>\n    <th scope="col">Name</th>\n    <th scope="col">Price</th>\n  </tr>\n  <tr>\n    <td>Apple</td>\n    <td>$1.00</td>\n  </tr>\n</table>',
      description: 'Convert header cells to <th> with scope attribute',
    },
    resources: [
      { label: 'WCAG Tables Tutorial', url: 'https://www.w3.org/WAI/tutorials/tables/' },
    ],
    wcagCriteria: '1.3.1',
    canAutoFix: false,
    canQuickFix: true,
  },

  'EPUB-STRUCT-003': {
    issueCode: 'EPUB-STRUCT-003',
    category: 'structure',
    title: 'Fix Heading Hierarchy',
    description: 'Headings must follow a logical hierarchy without skipping levels (e.g., h1 → h2 → h3, not h1 → h3).',
    tool: 'in-app',
    toolName: 'Auto-Fix',
    steps: [
      { step: 1, instruction: 'This issue can be auto-fixed by the system' },
      { step: 2, instruction: 'Click "Start Remediation" to apply automatic fixes' },
      { step: 3, instruction: 'The system will adjust heading levels to maintain proper hierarchy' },
    ],
    codeExample: {
      before: '<h1>Chapter 1</h1>\n<h3>Section 1.1</h3>  <!-- Skipped h2 -->',
      after: '<h1>Chapter 1</h1>\n<h2>Section 1.1</h2>  <!-- Proper hierarchy -->',
      description: 'Adjust heading levels to avoid skipping',
    },
    resources: [
      { label: 'WCAG Headings', url: 'https://www.w3.org/WAI/tutorials/page-structure/headings/' },
    ],
    wcagCriteria: '1.3.1',
    canAutoFix: true,
    canQuickFix: false,
  },

  'EPUB-STRUCT-004': {
    issueCode: 'EPUB-STRUCT-004',
    category: 'structure',
    title: 'Add Main Landmark',
    description: 'Documents should have ARIA landmark roles to help screen reader users navigate. The main content area should have role="main".',
    tool: 'in-app',
    toolName: 'Auto-Fix',
    steps: [
      { step: 1, instruction: 'This issue can be auto-fixed by the system' },
      { step: 2, instruction: 'Click "Start Remediation" to apply automatic fixes' },
      { step: 3, instruction: 'The system will add role="main" to the primary content area' },
    ],
    codeExample: {
      before: '<body>\n  <div class="content">...</div>\n</body>',
      after: '<body>\n  <main role="main">\n    <div class="content">...</div>\n  </main>\n</body>',
      description: 'Wrap main content with <main role="main">',
    },
    resources: [
      { label: 'ARIA Landmarks', url: 'https://www.w3.org/WAI/ARIA/apg/patterns/landmarks/' },
    ],
    wcagCriteria: '1.3.1',
    canAutoFix: true,
    canQuickFix: false,
  },

  'EPUB-SEM-001': {
    issueCode: 'EPUB-SEM-001',
    category: 'semantic',
    title: 'Add HTML Lang Attribute',
    description: 'Each HTML document must specify its language using the lang attribute on the <html> element.',
    tool: 'in-app',
    toolName: 'Auto-Fix',
    steps: [
      { step: 1, instruction: 'This issue can be auto-fixed by the system' },
      { step: 2, instruction: 'Click "Start Remediation" to apply automatic fixes' },
      { step: 3, instruction: 'The system will add lang attribute to HTML elements' },
    ],
    codeExample: {
      before: '<html xmlns="http://www.w3.org/1999/xhtml">',
      after: '<html xmlns="http://www.w3.org/1999/xhtml" lang="en" xml:lang="en">',
      description: 'Add lang and xml:lang attributes to html element',
    },
    wcagCriteria: '3.1.1',
    canAutoFix: true,
    canQuickFix: false,
  },

  'EPUB-SEM-002': {
    issueCode: 'EPUB-SEM-002',
    category: 'semantic',
    title: 'Fix Empty Links',
    description: 'Links must have accessible names. Empty links should have aria-label or visible text content.',
    tool: 'in-app',
    toolName: 'Auto-Fix',
    steps: [
      { step: 1, instruction: 'This issue can be auto-fixed by the system' },
      { step: 2, instruction: 'Click "Start Remediation" to apply automatic fixes' },
      { step: 3, instruction: 'The system will add aria-label attributes to empty links' },
    ],
    codeExample: {
      before: '<a href="chapter2.xhtml"></a>',
      after: '<a href="chapter2.xhtml" aria-label="Go to chapter2.xhtml">Link</a>',
      description: 'Add aria-label or visible text to empty links',
    },
    wcagCriteria: '2.4.4',
    canAutoFix: true,
    canQuickFix: false,
  },

  'METADATA-ACCESSMODESUFFICIENT': {
    issueCode: 'METADATA-ACCESSMODESUFFICIENT',
    category: 'metadata',
    title: 'Add Access Mode Sufficient Metadata',
    description: 'Declare the sufficient access modes that allow full consumption of the content.',
    tool: 'in-app',
    toolName: 'Auto-Fix',
    steps: [
      { step: 1, instruction: 'This issue can be auto-fixed by the system' },
      { step: 2, instruction: 'Click "Start Remediation" to apply automatic fixes' },
    ],
    codeExample: {
      before: '<metadata>\n  <!-- No accessModeSufficient -->\n</metadata>',
      after: '<metadata>\n  <meta property="schema:accessModeSufficient">textual</meta>\n</metadata>',
      description: 'Add schema:accessModeSufficient metadata',
    },
    wcagCriteria: '4.1.2',
    canAutoFix: true,
    canQuickFix: false,
  },

  'METADATA-ACCESSIBILITYHAZARD': {
    issueCode: 'METADATA-ACCESSIBILITYHAZARD',
    category: 'metadata',
    title: 'Add Accessibility Hazard Metadata',
    description: 'Declare any accessibility hazards present in the publication (flashing, motion, sound) or indicate none are present.',
    tool: 'in-app',
    toolName: 'Auto-Fix',
    steps: [
      { step: 1, instruction: 'This issue can be auto-fixed by the system' },
      { step: 2, instruction: 'Click "Start Remediation" to apply automatic fixes' },
      { step: 3, instruction: 'The system will add "no hazard" declarations by default' },
    ],
    codeExample: {
      before: '<metadata>\n  <!-- No hazard declarations -->\n</metadata>',
      after: '<metadata>\n  <meta property="schema:accessibilityHazard">noFlashingHazard</meta>\n  <meta property="schema:accessibilityHazard">noMotionSimulationHazard</meta>\n  <meta property="schema:accessibilityHazard">noSoundHazard</meta>\n</metadata>',
      description: 'Add schema:accessibilityHazard metadata',
    },
    wcagCriteria: '2.3.1',
    canAutoFix: true,
    canQuickFix: false,
  },

  'METADATA-ACCESSIBILITYSUMMARY': {
    issueCode: 'METADATA-ACCESSIBILITYSUMMARY',
    category: 'metadata',
    title: 'Add Accessibility Summary',
    description: 'Provide a human-readable summary describing the accessibility features of the publication.',
    tool: 'in-app',
    toolName: 'Auto-Fix',
    steps: [
      { step: 1, instruction: 'This issue can be auto-fixed by the system' },
      { step: 2, instruction: 'Click "Start Remediation" to apply automatic fixes' },
    ],
    codeExample: {
      before: '<metadata>\n  <!-- No accessibility summary -->\n</metadata>',
      after: '<metadata>\n  <meta property="schema:accessibilitySummary">This publication meets basic accessibility requirements.</meta>\n</metadata>',
      description: 'Add schema:accessibilitySummary metadata',
    },
    wcagCriteria: null, // EPUB accessibility metadata requirement, no direct WCAG equivalent
    canAutoFix: true,
    canQuickFix: false,
  },
};

const DEFAULT_TEMPLATE: Omit<FixTemplate, 'issueCode'> = {
  category: 'validation',
  title: 'Manual Fix Required',
  description: 'Review and manually remediate this accessibility issue according to WCAG guidelines. Check the issue message and location for specific details.',
  tool: 'sigil',
  toolName: 'Sigil',
  steps: [
    { step: 1, instruction: 'Open in Sigil: File → Open → Select your EPUB' },
    { step: 2, instruction: 'In Book Browser, expand "Text" and open the file from the issue location' },
    { step: 3, instruction: 'Switch to Code View: Press F9' },
    { step: 4, instruction: 'Find the element mentioned in the issue' },
    { step: 5, instruction: 'Fix according to the suggestion provided' },
    { step: 6, instruction: 'Save: Ctrl+S' },
  ],
  resources: [
    { label: 'Sigil User Guide', url: 'https://sigil-ebook.com/sigil/guide/' },
    { label: 'WCAG 2.1 Guidelines', url: 'https://www.w3.org/WAI/WCAG21/quickref/' },
  ],
  canAutoFix: false,
  canQuickFix: false,
};

class FixTemplateService {
  getTemplate(issueCode: string, suggestion?: string): FixTemplate {
    const upperCode = issueCode.toUpperCase();
    
    if (FIX_TEMPLATES[issueCode]) {
      return FIX_TEMPLATES[issueCode];
    }
    
    if (FIX_TEMPLATES[upperCode]) {
      return FIX_TEMPLATES[upperCode];
    }
    
    // Match by specific prefix (e.g., EPUB-SEM, EPUB-STRUCT, EPUB-META, EPUB-IMG)
    // Sort by prefix length descending to match most specific first
    const sortedEntries = Object.entries(FIX_TEMPLATES).sort((a, b) => b[0].length - a[0].length);
    for (const [key, template] of sortedEntries) {
      // Extract prefix up to the last hyphen-number segment (e.g., EPUB-SEM from EPUB-SEM-001)
      const keyPrefix = key.replace(/-\d+$/, '');
      const codePrefix = upperCode.replace(/-\d+$/, '');
      if (codePrefix === keyPrefix) {
        return {
          ...template,
          issueCode: issueCode,
          description: suggestion || template.description,
        };
      }
    }
    
    return {
      ...DEFAULT_TEMPLATE,
      issueCode: issueCode,
      description: suggestion || DEFAULT_TEMPLATE.description,
    };
  }

  getTemplateByCategory(category: FixTemplate['category']): FixTemplate[] {
    return Object.values(FIX_TEMPLATES).filter(t => t.category === category);
  }

  getAllTemplates(): FixTemplate[] {
    return Object.values(FIX_TEMPLATES);
  }

  hasTemplate(issueCode: string): boolean {
    // Check exact match first
    if (FIX_TEMPLATES[issueCode] || FIX_TEMPLATES[issueCode.toUpperCase()]) {
      return true;
    }
    
    // Check prefix match (mirrors getTemplate's logic)
    const upperCode = issueCode.toUpperCase();
    const codePrefix = upperCode.replace(/-\d+$/, '');
    
    for (const key of Object.keys(FIX_TEMPLATES)) {
      const keyPrefix = key.replace(/-\d+$/, '');
      if (codePrefix === keyPrefix) {
        return true;
      }
    }
    
    return false;
  }
}

export const fixTemplateService = new FixTemplateService();
export type { FixTemplate, FixStep, CodeExample };
