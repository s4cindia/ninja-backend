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
    id: '1.2.2',
    name: 'Captions (Prerecorded)',
    level: 'A',
    principle: 'perceivable',
    description: 'Captions are provided for all prerecorded audio content in synchronized media',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/captions-prerecorded.html'
  },
  {
    id: '1.2.3',
    name: 'Audio Description or Media Alternative (Prerecorded)',
    level: 'A',
    principle: 'perceivable',
    description: 'An alternative for time-based media or audio description of prerecorded video is provided',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/audio-description-or-media-alternative-prerecorded.html'
  },
  {
    id: '1.2.4',
    name: 'Captions (Live)',
    level: 'AA',
    principle: 'perceivable',
    description: 'Captions are provided for all live audio content in synchronized media',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/captions-live.html'
  },
  {
    id: '1.2.5',
    name: 'Audio Description (Prerecorded)',
    level: 'AA',
    principle: 'perceivable',
    description: 'Audio description is provided for all prerecorded video content in synchronized media',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/audio-description-prerecorded.html'
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
    id: '1.3.3',
    name: 'Sensory Characteristics',
    level: 'A',
    principle: 'perceivable',
    description: 'Instructions do not rely solely on sensory characteristics such as shape, color, size, location, or sound',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/sensory-characteristics.html'
  },
  {
    id: '1.3.4',
    name: 'Orientation',
    level: 'AA',
    principle: 'perceivable',
    description: 'Content does not restrict its view and operation to a single display orientation',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/orientation.html'
  },
  {
    id: '1.3.5',
    name: 'Identify Input Purpose',
    level: 'AA',
    principle: 'perceivable',
    description: 'The purpose of each input field collecting personal data can be programmatically determined',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/identify-input-purpose.html'
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
    id: '1.4.2',
    name: 'Audio Control',
    level: 'A',
    principle: 'perceivable',
    description: 'A mechanism is available to pause, stop, or control the volume of audio that plays automatically',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/audio-control.html'
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
    id: '1.4.10',
    name: 'Reflow',
    level: 'AA',
    principle: 'perceivable',
    description: 'Content can be presented without loss of information using a width of 320 CSS pixels',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/reflow.html'
  },
  {
    id: '1.4.11',
    name: 'Non-text Contrast',
    level: 'AA',
    principle: 'perceivable',
    description: 'Visual presentation of UI components and graphical objects has a contrast ratio of at least 3:1',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html'
  },
  {
    id: '1.4.12',
    name: 'Text Spacing',
    level: 'AA',
    principle: 'perceivable',
    description: 'No loss of content occurs when letter, word, line spacing, and paragraph spacing are adjusted',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/text-spacing.html'
  },
  {
    id: '1.4.13',
    name: 'Content on Hover or Focus',
    level: 'AA',
    principle: 'perceivable',
    description: 'Content that appears on hover or keyboard focus can be dismissed, hovered, and persistent',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/content-on-hover-or-focus.html'
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
    id: '2.1.4',
    name: 'Character Key Shortcuts',
    level: 'A',
    principle: 'operable',
    description: 'Single character key shortcuts can be turned off, remapped, or only active on focus',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/character-key-shortcuts.html'
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
    id: '2.2.2',
    name: 'Pause, Stop, Hide',
    level: 'A',
    principle: 'operable',
    description: 'Moving, blinking, scrolling, or auto-updating content can be paused, stopped, or hidden',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/pause-stop-hide.html'
  },
  {
    id: '2.3.1',
    name: 'Three Flashes or Below Threshold',
    level: 'A',
    principle: 'operable',
    description: 'Web pages do not contain content that flashes more than three times per second',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/three-flashes-or-below-threshold.html'
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
    id: '2.4.5',
    name: 'Multiple Ways',
    level: 'AA',
    principle: 'operable',
    description: 'More than one way is available to locate a web page within a set of pages',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/multiple-ways.html'
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
    id: '2.5.1',
    name: 'Pointer Gestures',
    level: 'A',
    principle: 'operable',
    description: 'All functionality that uses multipoint or path-based gestures can be operated with a single pointer',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/pointer-gestures.html'
  },
  {
    id: '2.5.2',
    name: 'Pointer Cancellation',
    level: 'A',
    principle: 'operable',
    description: 'For functionality that can be operated using a single pointer, at least one of: no down-event, abort/undo, up-reversal, or essential',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/pointer-cancellation.html'
  },
  {
    id: '2.5.3',
    name: 'Label in Name',
    level: 'A',
    principle: 'operable',
    description: 'For components with text labels, the accessible name contains the visible text',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/label-in-name.html'
  },
  {
    id: '2.5.4',
    name: 'Motion Actuation',
    level: 'A',
    principle: 'operable',
    description: 'Functionality operated by device or user motion can also be operated by UI components',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/motion-actuation.html'
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
    id: '3.2.3',
    name: 'Consistent Navigation',
    level: 'AA',
    principle: 'understandable',
    description: 'Navigational mechanisms repeated across pages occur in the same relative order',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/consistent-navigation.html'
  },
  {
    id: '3.2.4',
    name: 'Consistent Identification',
    level: 'AA',
    principle: 'understandable',
    description: 'Components with the same functionality are identified consistently',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/consistent-identification.html'
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
    id: '3.3.3',
    name: 'Error Suggestion',
    level: 'AA',
    principle: 'understandable',
    description: 'If an input error is detected and suggestions for correction are known, the suggestion is provided',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/error-suggestion.html'
  },
  {
    id: '3.3.4',
    name: 'Error Prevention (Legal, Financial, Data)',
    level: 'AA',
    principle: 'understandable',
    description: 'Submissions can be checked, confirmed, or reversed for pages that cause legal or financial commitments',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/error-prevention-legal-financial-data.html'
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
  },
  {
    id: '4.1.3',
    name: 'Status Messages',
    level: 'AA',
    principle: 'robust',
    description: 'Status messages can be programmatically determined through role or property without focus',
    url: 'https://www.w3.org/WAI/WCAG21/Understanding/status-messages.html'
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
