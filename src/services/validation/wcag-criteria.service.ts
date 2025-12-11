export interface WCAGCriterion {
  id: string;
  name: string;
  level: 'A' | 'AA' | 'AAA';
  principle: 'perceivable' | 'operable' | 'understandable' | 'robust';
  description: string;
  url: string;
}

const WCAG_CRITERIA: WCAGCriterion[] = [
  {
    id: '1.1.1',
    name: 'Non-text Content',
    level: 'A',
    principle: 'perceivable',
    description: 'All non-text content has a text alternative',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/non-text-content.html'
  },
  {
    id: '1.2.1',
    name: 'Audio-only and Video-only (Prerecorded)',
    level: 'A',
    principle: 'perceivable',
    description: 'Alternatives for prerecorded audio-only and video-only content',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/audio-only-and-video-only-prerecorded.html'
  },
  {
    id: '1.3.1',
    name: 'Info and Relationships',
    level: 'A',
    principle: 'perceivable',
    description: 'Information and relationships can be programmatically determined',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships.html'
  },
  {
    id: '1.3.2',
    name: 'Meaningful Sequence',
    level: 'A',
    principle: 'perceivable',
    description: 'Content sequence can be programmatically determined',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/meaningful-sequence.html'
  },
  {
    id: '1.4.1',
    name: 'Use of Color',
    level: 'A',
    principle: 'perceivable',
    description: 'Color is not the only visual means of conveying information',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/use-of-color.html'
  },
  {
    id: '1.4.3',
    name: 'Contrast (Minimum)',
    level: 'AA',
    principle: 'perceivable',
    description: 'Text has a contrast ratio of at least 4.5:1',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html'
  },
  {
    id: '1.4.4',
    name: 'Resize Text',
    level: 'AA',
    principle: 'perceivable',
    description: 'Text can be resized up to 200% without loss of content',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/resize-text.html'
  },
  {
    id: '1.4.5',
    name: 'Images of Text',
    level: 'AA',
    principle: 'perceivable',
    description: 'Text is used instead of images of text',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/images-of-text.html'
  },
  {
    id: '2.1.1',
    name: 'Keyboard',
    level: 'A',
    principle: 'operable',
    description: 'All functionality is available from a keyboard',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/keyboard.html'
  },
  {
    id: '2.1.2',
    name: 'No Keyboard Trap',
    level: 'A',
    principle: 'operable',
    description: 'Keyboard focus can be moved away from any component',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/no-keyboard-trap.html'
  },
  {
    id: '2.2.1',
    name: 'Timing Adjustable',
    level: 'A',
    principle: 'operable',
    description: 'Time limits can be turned off, adjusted, or extended',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/timing-adjustable.html'
  },
  {
    id: '2.4.1',
    name: 'Bypass Blocks',
    level: 'A',
    principle: 'operable',
    description: 'Mechanism to bypass repeated content',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/bypass-blocks.html'
  },
  {
    id: '2.4.2',
    name: 'Page Titled',
    level: 'A',
    principle: 'operable',
    description: 'Web pages have descriptive titles',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/page-titled.html'
  },
  {
    id: '2.4.3',
    name: 'Focus Order',
    level: 'A',
    principle: 'operable',
    description: 'Focus order preserves meaning and operability',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/focus-order.html'
  },
  {
    id: '2.4.4',
    name: 'Link Purpose (In Context)',
    level: 'A',
    principle: 'operable',
    description: 'Link purpose can be determined from link text',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/link-purpose-in-context.html'
  },
  {
    id: '2.4.6',
    name: 'Headings and Labels',
    level: 'AA',
    principle: 'operable',
    description: 'Headings and labels describe topic or purpose',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/headings-and-labels.html'
  },
  {
    id: '2.4.7',
    name: 'Focus Visible',
    level: 'AA',
    principle: 'operable',
    description: 'Keyboard focus indicator is visible',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/focus-visible.html'
  },
  {
    id: '3.1.1',
    name: 'Language of Page',
    level: 'A',
    principle: 'understandable',
    description: 'Default language can be programmatically determined',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/language-of-page.html'
  },
  {
    id: '3.1.2',
    name: 'Language of Parts',
    level: 'AA',
    principle: 'understandable',
    description: 'Language of each passage can be programmatically determined',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/language-of-parts.html'
  },
  {
    id: '3.2.1',
    name: 'On Focus',
    level: 'A',
    principle: 'understandable',
    description: 'Receiving focus does not change context',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/on-focus.html'
  },
  {
    id: '3.2.2',
    name: 'On Input',
    level: 'A',
    principle: 'understandable',
    description: 'Changing settings does not change context unexpectedly',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/on-input.html'
  },
  {
    id: '3.3.1',
    name: 'Error Identification',
    level: 'A',
    principle: 'understandable',
    description: 'Input errors are automatically detected and described',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/error-identification.html'
  },
  {
    id: '3.3.2',
    name: 'Labels or Instructions',
    level: 'A',
    principle: 'understandable',
    description: 'Labels or instructions are provided for user input',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/labels-or-instructions.html'
  },
  {
    id: '4.1.1',
    name: 'Parsing',
    level: 'A',
    principle: 'robust',
    description: 'Elements have complete start and end tags with unique IDs',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/parsing.html'
  },
  {
    id: '4.1.2',
    name: 'Name, Role, Value',
    level: 'A',
    principle: 'robust',
    description: 'User interface components have accessible names and roles',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html'
  }
];

export class WCAGCriteriaService {
  getAllCriteria(): WCAGCriterion[] {
    return [...WCAG_CRITERIA];
  }

  getCriteriaById(id: string): WCAGCriterion | undefined {
    return WCAG_CRITERIA.find(c => c.id === id);
  }

  getCriteriaByLevel(level: 'A' | 'AA' | 'AAA'): WCAGCriterion[] {
    return WCAG_CRITERIA.filter(c => c.level === level);
  }

  getCriteriaByPrinciple(principle: WCAGCriterion['principle']): WCAGCriterion[] {
    return WCAG_CRITERIA.filter(c => c.principle === principle);
  }
}

export const wcagCriteriaService = new WCAGCriteriaService();
