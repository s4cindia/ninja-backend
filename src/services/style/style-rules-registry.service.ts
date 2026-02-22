/**
 * Style Rules Registry Service
 *
 * Provides built-in rule definitions for style validation including:
 * - Grammar, punctuation, capitalization rules
 * - Academic writing rules
 * - Publisher-specific rules (Nature, IEEE, Elsevier presets)
 */

import { StyleCategory, StyleSeverity, StyleGuideType } from '@prisma/client';

export interface StyleRule {
  id: string;
  name: string;
  description: string;
  category: StyleCategory;
  severity: StyleSeverity;
  pattern?: RegExp;
  replacement?: string | ((match: string) => string);
  validator?: (text: string, context?: RuleContext) => RuleMatch[];
  styleGuides: StyleGuideType[];
  examples?: {
    incorrect: string;
    correct: string;
  }[];
}

export interface RuleMatch {
  startOffset: number;
  endOffset: number;
  lineNumber?: number;
  matchedText: string;
  suggestedFix: string;
  ruleId: string;
  ruleName: string;
  ruleReference?: string;  // e.g., "CMOS 6.28", "APA 7 Section 4.12"
  description: string;
  explanation?: string;
}

export interface RuleContext {
  fullText: string;
  documentTitle?: string;
  styleGuide?: StyleGuideType;
}

export interface RuleSet {
  id: string;
  name: string;
  description: string;
  styleGuide?: StyleGuideType;
  rules: StyleRule[];
}

// Built-in style rules organized by category
const PUNCTUATION_RULES: StyleRule[] = [
  {
    id: 'punct-serial-comma',
    name: 'Serial Comma (Oxford Comma)',
    description: 'Use a comma before "and" or "or" in a series of three or more items',
    category: 'PUNCTUATION',
    severity: 'WARNING',
    pattern: /(\w+),\s+(\w+)\s+and\s+(\w+)/gi,
    validator: (text) => {
      const matches: RuleMatch[] = [];
      const regex = /(\w+),\s+(\w+)\s+and\s+(\w+)/gi;
      let match;
      while ((match = regex.exec(text)) !== null) {
        // Check if there's no comma before "and"
        const fullMatch = match[0];
        if (!fullMatch.includes(', and')) {
          matches.push({
            startOffset: match.index,
            endOffset: match.index + fullMatch.length,
            matchedText: fullMatch,
            suggestedFix: fullMatch.replace(/(\w+)\s+and/, '$1, and'),
            ruleId: 'punct-serial-comma',
            ruleName: 'Serial Comma (Oxford Comma)',
            description: 'Consider using a serial comma before "and" in a list',
          });
        }
      }
      return matches;
    },
    styleGuides: ['CHICAGO', 'APA', 'CUSTOM'],
    examples: [
      { incorrect: 'red, white and blue', correct: 'red, white, and blue' },
    ],
  },
  {
    id: 'punct-double-space',
    name: 'Double Space After Period',
    description: 'Use single space after periods, not double',
    category: 'PUNCTUATION',
    severity: 'WARNING',
    pattern: /\.\s{2,}/g,
    replacement: '. ',
    styleGuides: ['CHICAGO', 'APA', 'MLA', 'AP', 'CUSTOM'],
    examples: [
      { incorrect: 'End of sentence.  Start of next.', correct: 'End of sentence. Start of next.' },
    ],
  },
  {
    id: 'punct-comma-splice',
    name: 'Potential Comma Splice',
    description: 'Two independent clauses should not be joined by only a comma',
    category: 'PUNCTUATION',
    severity: 'WARNING',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      // Simple heuristic: comma followed by a pronoun starting a new clause
      const regex = /,\s+(I|he|she|it|they|we|you|this|that|these|those)\s+\w+/gi;
      let match;
      while ((match = regex.exec(text)) !== null) {
        // Skip if it's likely a subordinate clause or list
        const prevText = text.slice(Math.max(0, match.index - 50), match.index);
        if (!/\band\b|\bor\b|\bbut\b|\bif\b|\bwhen\b|\bwhile\b/i.test(prevText)) {
          matches.push({
            startOffset: match.index,
            endOffset: match.index + match[0].length,
            matchedText: match[0],
            suggestedFix: '; ' + match[0].slice(2),
            ruleId: 'punct-comma-splice',
            ruleName: 'Potential Comma Splice',
            description: 'Consider using a semicolon or period instead of a comma between independent clauses',
          });
        }
      }
      return matches;
    },
    styleGuides: ['CHICAGO', 'APA', 'MLA', 'CUSTOM'],
  },
];

const CAPITALIZATION_RULES: StyleRule[] = [
  {
    id: 'cap-sentence-start',
    name: 'Sentence Capitalization',
    description: 'Sentences should start with a capital letter',
    category: 'CAPITALIZATION',
    severity: 'ERROR',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      const regex = /[.!?]\s+([a-z])/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        matches.push({
          startOffset: match.index + match[0].length - 1,
          endOffset: match.index + match[0].length,
          matchedText: match[1],
          suggestedFix: match[1].toUpperCase(),
          ruleId: 'cap-sentence-start',
          ruleName: 'Sentence Capitalization',
          description: 'Capitalize the first letter of a sentence',
        });
      }
      return matches;
    },
    styleGuides: ['CHICAGO', 'APA', 'MLA', 'AP', 'CUSTOM'],
  },
  {
    id: 'cap-title-case',
    name: 'Title Case Check',
    description: 'Titles should follow proper title case capitalization',
    category: 'CAPITALIZATION',
    severity: 'SUGGESTION',
    validator: () => {
      // This is a complex rule that requires context awareness
      // Will be handled by AI validation
      return [];
    },
    styleGuides: ['CHICAGO', 'APA', 'MLA', 'AP', 'CUSTOM'],
  },
];

const NUMBER_RULES: StyleRule[] = [
  {
    id: 'num-spell-out-small',
    name: 'Spell Out Small Numbers',
    description: 'Spell out numbers one through nine; use numerals for 10 and above',
    category: 'NUMBERS',
    severity: 'WARNING',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      const smallNumbers: Record<string, string> = {
        '1': 'one', '2': 'two', '3': 'three', '4': 'four', '5': 'five',
        '6': 'six', '7': 'seven', '8': 'eight', '9': 'nine',
      };

      // Match standalone digits 1-9 (not part of larger numbers)
      const regex = /(?<!\d)([1-9])(?!\d)/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        // Skip if preceded by $ or other currency/unit indicators
        const prevChar = text[match.index - 1];
        if (prevChar && /[$%€£¥#]/.test(prevChar)) continue;

        // Skip if in a date-like context
        const context = text.slice(Math.max(0, match.index - 10), match.index + 10);
        if (/\d{1,2}[\/\-]\d|:\d{2}/.test(context)) continue;

        matches.push({
          startOffset: match.index,
          endOffset: match.index + 1,
          matchedText: match[1],
          suggestedFix: smallNumbers[match[1]],
          ruleId: 'num-spell-out-small',
          ruleName: 'Spell Out Small Numbers',
          description: 'Consider spelling out numbers one through nine',
        });
      }
      return matches;
    },
    styleGuides: ['CHICAGO', 'APA', 'CUSTOM'],
  },
  {
    id: 'num-percent',
    name: 'Percent Symbol Usage',
    description: 'Use % symbol with numerals, spell out with words',
    category: 'NUMBERS',
    severity: 'WARNING',
    pattern: /(\d+)\s+percent/gi,
    replacement: '$1%',
    styleGuides: ['AP', 'CHICAGO', 'CUSTOM'],
    examples: [
      { incorrect: '50 percent', correct: '50%' },
    ],
  },
];

const GRAMMAR_RULES: StyleRule[] = [
  {
    id: 'gram-passive-voice',
    name: 'Passive Voice Detection',
    description: 'Consider using active voice for clearer writing',
    category: 'GRAMMAR',
    severity: 'SUGGESTION',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      // Common passive voice patterns: was/were/been + past participle
      const regex = /\b(was|were|been|being|is|are|am)\s+(being\s+)?(\w+ed)\b/gi;
      let match;
      while ((match = regex.exec(text)) !== null) {
        matches.push({
          startOffset: match.index,
          endOffset: match.index + match[0].length,
          matchedText: match[0],
          suggestedFix: match[0], // Cannot auto-fix passive voice
          ruleId: 'gram-passive-voice',
          ruleName: 'Passive Voice Detection',
          description: 'This appears to be passive voice. Consider rewriting in active voice.',
        });
      }
      return matches;
    },
    styleGuides: ['APA', 'CUSTOM'],
  },
  {
    id: 'gram-subject-verb',
    name: 'Subject-Verb Agreement',
    description: 'Ensure subject and verb agree in number',
    category: 'GRAMMAR',
    severity: 'ERROR',
    validator: () => {
      // Complex rule - delegated to AI validation
      return [];
    },
    styleGuides: ['CHICAGO', 'APA', 'MLA', 'AP', 'CUSTOM'],
  },
  {
    id: 'gram-dangling-modifier',
    name: 'Dangling Modifier',
    description: 'Ensure modifiers clearly refer to what they modify',
    category: 'GRAMMAR',
    severity: 'WARNING',
    validator: () => {
      // Complex rule - delegated to AI validation
      return [];
    },
    styleGuides: ['CHICAGO', 'APA', 'MLA', 'CUSTOM'],
  },
];

const TERMINOLOGY_RULES: StyleRule[] = [
  {
    id: 'term-utilize',
    name: 'Avoid "Utilize"',
    description: 'Use "use" instead of "utilize" for clearer writing',
    category: 'TERMINOLOGY',
    severity: 'SUGGESTION',
    pattern: /\butilize[sd]?\b/gi,
    replacement: (match) => {
      if (match.toLowerCase() === 'utilizes') return 'uses';
      if (match.toLowerCase() === 'utilized') return 'used';
      return 'use';
    },
    styleGuides: ['CHICAGO', 'APA', 'CUSTOM'],
    examples: [
      { incorrect: 'We utilize this method', correct: 'We use this method' },
    ],
  },
  {
    id: 'term-impact-verb',
    name: '"Impact" as a Verb',
    description: 'Consider using "affect" instead of "impact" as a verb',
    category: 'TERMINOLOGY',
    severity: 'SUGGESTION',
    pattern: /\b(impacts|impacted|impacting)\b/gi,
    replacement: (match) => {
      const map: Record<string, string> = {
        'impacts': 'affects',
        'impacted': 'affected',
        'impacting': 'affecting',
      };
      return map[match.toLowerCase()] || match;
    },
    styleGuides: ['CHICAGO', 'AP', 'CUSTOM'],
  },
  {
    id: 'term-very',
    name: 'Overuse of "Very"',
    description: 'Consider using more precise language instead of "very"',
    category: 'TERMINOLOGY',
    severity: 'SUGGESTION',
    pattern: /\bvery\s+(\w+)/gi,
    validator: (text) => {
      const matches: RuleMatch[] = [];
      const regex = /\bvery\s+(\w+)/gi;
      const betterWords: Record<string, string> = {
        'good': 'excellent',
        'bad': 'terrible',
        'big': 'enormous',
        'small': 'tiny',
        'happy': 'elated',
        'sad': 'miserable',
        'tired': 'exhausted',
        'hungry': 'ravenous',
        'angry': 'furious',
        'afraid': 'terrified',
      };

      let match;
      while ((match = regex.exec(text)) !== null) {
        const adjective = match[1].toLowerCase();
        if (betterWords[adjective]) {
          matches.push({
            startOffset: match.index,
            endOffset: match.index + match[0].length,
            matchedText: match[0],
            suggestedFix: betterWords[adjective],
            ruleId: 'term-very',
            ruleName: 'Overuse of "Very"',
            description: `Consider using "${betterWords[adjective]}" instead of "${match[0]}"`,
          });
        }
      }
      return matches;
    },
    styleGuides: ['CHICAGO', 'APA', 'CUSTOM'],
  },
];

const ABBREVIATION_RULES: StyleRule[] = [
  {
    id: 'abbr-first-use',
    name: 'Abbreviation First Use',
    description: 'Define abbreviations on first use',
    category: 'ABBREVIATIONS',
    severity: 'WARNING',
    validator: () => {
      // Complex rule requiring document-wide context - delegated to AI
      return [];
    },
    styleGuides: ['CHICAGO', 'APA', 'MLA', 'CUSTOM'],
  },
  {
    id: 'abbr-eg-ie',
    name: 'e.g. and i.e. Usage',
    description: 'Use proper formatting for e.g. and i.e.',
    category: 'ABBREVIATIONS',
    severity: 'WARNING',
    validator: (text) => {
      const matches: RuleMatch[] = [];

      // Check for e.g. without comma
      const egRegex = /\be\.g\.\s+(?!,)/gi;
      let match;
      while ((match = egRegex.exec(text)) !== null) {
        matches.push({
          startOffset: match.index,
          endOffset: match.index + match[0].length,
          matchedText: match[0],
          suggestedFix: 'e.g., ',
          ruleId: 'abbr-eg-ie',
          ruleName: 'e.g. and i.e. Usage',
          description: 'Follow "e.g." with a comma',
        });
      }

      // Check for i.e. without comma
      const ieRegex = /\bi\.e\.\s+(?!,)/gi;
      while ((match = ieRegex.exec(text)) !== null) {
        matches.push({
          startOffset: match.index,
          endOffset: match.index + match[0].length,
          matchedText: match[0],
          suggestedFix: 'i.e., ',
          ruleId: 'abbr-eg-ie',
          ruleName: 'e.g. and i.e. Usage',
          description: 'Follow "i.e." with a comma',
        });
      }

      return matches;
    },
    styleGuides: ['CHICAGO', 'APA', 'CUSTOM'],
  },
  {
    id: 'abbr-etc',
    name: 'etc. Usage',
    description: 'Use "etc." properly with preceding comma',
    category: 'ABBREVIATIONS',
    severity: 'WARNING',
    pattern: /([^,])\s+etc\./gi,
    replacement: '$1, etc.',
    styleGuides: ['CHICAGO', 'APA', 'CUSTOM'],
    examples: [
      { incorrect: 'apples oranges etc.', correct: 'apples, oranges, etc.' },
    ],
  },
];

// Publisher-specific rule sets
const NATURE_RULES: StyleRule[] = [
  {
    id: 'nature-british-spelling',
    name: 'British Spelling',
    description: 'Nature uses British spelling conventions',
    category: 'SPELLING',
    severity: 'WARNING',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      const americanToBritish: Record<string, string> = {
        'color': 'colour',
        'favor': 'favour',
        'honor': 'honour',
        'behavior': 'behaviour',
        'analyze': 'analyse',
        'organize': 'organise',
        'realize': 'realise',
        'center': 'centre',
        'meter': 'metre',
        'fiber': 'fibre',
      };

      for (const [american, british] of Object.entries(americanToBritish)) {
        const regex = new RegExp(`\\b${american}\\b`, 'gi');
        let match;
        while ((match = regex.exec(text)) !== null) {
          matches.push({
            startOffset: match.index,
            endOffset: match.index + match[0].length,
            matchedText: match[0],
            suggestedFix: british,
            ruleId: 'nature-british-spelling',
            ruleName: 'British Spelling',
            description: `Nature style requires British spelling: use "${british}" instead of "${american}"`,
          });
        }
      }
      return matches;
    },
    styleGuides: ['NATURE'],
  },
  {
    id: 'nature-units',
    name: 'SI Units',
    description: 'Use SI units with proper formatting',
    category: 'FORMATTING',
    severity: 'WARNING',
    validator: () => {
      // Complex rule - delegated to AI
      return [];
    },
    styleGuides: ['NATURE', 'IEEE'],
  },
];

const IEEE_RULES: StyleRule[] = [
  {
    id: 'ieee-first-person',
    name: 'First Person Usage',
    description: 'IEEE papers typically use first person plural for authors',
    category: 'GRAMMAR',
    severity: 'SUGGESTION',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      // Flag singular first person in technical context
      const regex = /\b(I|my|mine)\b(?!\s+(will|would|could|should|may|might|can))/gi;
      let match;
      while ((match = regex.exec(text)) !== null) {
        matches.push({
          startOffset: match.index,
          endOffset: match.index + match[0].length,
          matchedText: match[0],
          suggestedFix: match[0].toLowerCase() === 'i' ? 'we' :
                        match[0].toLowerCase() === 'my' ? 'our' : 'ours',
          ruleId: 'ieee-first-person',
          ruleName: 'First Person Usage',
          description: 'Consider using first person plural ("we", "our") for multi-author papers',
        });
      }
      return matches;
    },
    styleGuides: ['IEEE'],
  },
  {
    id: 'ieee-equation-refs',
    name: 'Equation References',
    description: 'Refer to equations as "equation (1)" or "(1)"',
    category: 'FORMATTING',
    severity: 'WARNING',
    pattern: /\b[Ee]q\.\s*\(?(\d+)\)?/g,
    replacement: 'equation ($1)',
    styleGuides: ['IEEE'],
    examples: [
      { incorrect: 'As shown in Eq. 1', correct: 'As shown in equation (1)' },
    ],
  },
];

// Additional Chicago Manual of Style Rules
const CHICAGO_SPECIFIC_RULES: StyleRule[] = [
  {
    id: 'chicago-en-dash',
    name: 'En Dash for Ranges',
    description: 'Use en dash (–) for ranges, not hyphen',
    category: 'PUNCTUATION',
    severity: 'WARNING',
    pattern: /(\d+)-(\d+)/g,
    replacement: '$1–$2',
    styleGuides: ['CHICAGO'],
    examples: [
      { incorrect: 'pages 10-20', correct: 'pages 10–20' },
    ],
  },
  {
    id: 'chicago-em-dash-spaces',
    name: 'Em Dash Without Spaces',
    description: 'Em dashes should not have spaces around them (Chicago style)',
    category: 'PUNCTUATION',
    severity: 'WARNING',
    pattern: /\s+—\s+/g,
    replacement: '—',
    styleGuides: ['CHICAGO'],
    examples: [
      { incorrect: 'word — word', correct: 'word—word' },
    ],
  },
  {
    id: 'chicago-possessive-singular',
    name: "Possessive of Singular Nouns Ending in 's'",
    description: "Add 's to singular nouns ending in s",
    category: 'GRAMMAR',
    severity: 'SUGGESTION',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      // Look for patterns like "James'" that should be "James's"
      const regex = /\b([A-Z][a-z]*s)'\s/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        matches.push({
          startOffset: match.index,
          endOffset: match.index + match[0].length,
          matchedText: match[0],
          suggestedFix: match[1] + "'s ",
          ruleId: 'chicago-possessive-singular',
          ruleName: "Possessive of Singular Nouns Ending in 's'",
          description: "Chicago recommends adding 's to singular nouns ending in s",
        });
      }
      return matches;
    },
    styleGuides: ['CHICAGO'],
  },
  {
    id: 'chicago-that-which',
    name: 'That vs. Which',
    description: 'Use "that" for restrictive clauses (no comma), "which" for nonrestrictive (with comma)',
    category: 'GRAMMAR',
    severity: 'SUGGESTION',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      // Flag "which" without preceding comma (might be restrictive clause)
      const regex = /[^,]\s+which\s+/gi;
      let match;
      while ((match = regex.exec(text)) !== null) {
        matches.push({
          startOffset: match.index + 1,
          endOffset: match.index + match[0].length,
          matchedText: match[0].slice(1),
          suggestedFix: ' that ',
          ruleId: 'chicago-that-which',
          ruleName: 'That vs. Which',
          description: 'Consider using "that" for restrictive clauses (no comma needed)',
        });
      }
      return matches;
    },
    styleGuides: ['CHICAGO', 'APA'],
  },
  {
    id: 'chicago-towards',
    name: 'Toward vs. Towards',
    description: 'American English prefers "toward" without the s',
    category: 'SPELLING',
    severity: 'SUGGESTION',
    pattern: /\btowards\b/gi,
    replacement: 'toward',
    styleGuides: ['CHICAGO', 'APA', 'AP'],
  },
  {
    id: 'chicago-amongst',
    name: 'Among vs. Amongst',
    description: 'American English prefers "among" to "amongst"',
    category: 'SPELLING',
    severity: 'SUGGESTION',
    pattern: /\bamongst\b/gi,
    replacement: 'among',
    styleGuides: ['CHICAGO', 'APA', 'AP'],
  },
  {
    id: 'chicago-whilst',
    name: 'While vs. Whilst',
    description: 'American English prefers "while" to "whilst"',
    category: 'SPELLING',
    severity: 'SUGGESTION',
    pattern: /\bwhilst\b/gi,
    replacement: 'while',
    styleGuides: ['CHICAGO', 'APA', 'AP'],
  },
  {
    id: 'chicago-ibid-discouraged',
    name: 'Ibid. Discouraged',
    description: 'Chicago 17th edition discourages ibid. in favor of shortened citations',
    category: 'CITATIONS',
    severity: 'SUGGESTION',
    pattern: /\b[Ii]bid\.\s*/g,
    validator: (text) => {
      const matches: RuleMatch[] = [];
      const regex = /\b[Ii]bid\.(\s*,\s*\d+)?/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        matches.push({
          startOffset: match.index,
          endOffset: match.index + match[0].length,
          matchedText: match[0],
          suggestedFix: '[use shortened citation]',
          ruleId: 'chicago-ibid-discouraged',
          ruleName: 'Ibid. Discouraged',
          description: 'Chicago 17th edition discourages ibid. Use shortened citations instead',
        });
      }
      return matches;
    },
    styleGuides: ['CHICAGO'],
  },
  {
    id: 'chicago-footnote-placement',
    name: 'Footnote Number Placement',
    description: 'Footnote numbers should be placed after punctuation (except dash)',
    category: 'PUNCTUATION',
    severity: 'WARNING',
    validator: () => {
      // Complex rule - requires document context
      return [];
    },
    styleGuides: ['CHICAGO'],
  },
  {
    id: 'chicago-ellipsis-spacing',
    name: 'Ellipsis Spacing',
    description: 'Use three spaced periods for ellipsis in quoted material',
    category: 'PUNCTUATION',
    severity: 'SUGGESTION',
    pattern: /\.{3}/g,
    replacement: '. . .',
    styleGuides: ['CHICAGO'],
    examples: [
      { incorrect: 'the quick... brown fox', correct: 'the quick . . . brown fox' },
    ],
  },
  {
    id: 'chicago-publisher-full-name',
    name: 'Publisher Names',
    description: 'Write out publisher names in full',
    category: 'CITATIONS',
    severity: 'SUGGESTION',
    validator: () => {
      // Complex rule - needs citation context
      return [];
    },
    styleGuides: ['CHICAGO'],
  },
  {
    id: 'chicago-headline-style',
    name: 'Headline-Style Capitalization',
    description: 'Titles use headline style: capitalize first/last words and all major words',
    category: 'CAPITALIZATION',
    severity: 'SUGGESTION',
    validator: () => {
      // Complex rule - delegated to AI
      return [];
    },
    styleGuides: ['CHICAGO'],
  },
  {
    id: 'chicago-numbers-spell-out',
    name: 'Chicago Number Style',
    description: 'Spell out numbers one through one hundred and round numbers',
    category: 'NUMBERS',
    severity: 'SUGGESTION',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      // Chicago spells out numbers up to one hundred
      const numberWords: Record<string, string> = {
        '11': 'eleven', '12': 'twelve', '13': 'thirteen', '14': 'fourteen',
        '15': 'fifteen', '16': 'sixteen', '17': 'seventeen', '18': 'eighteen',
        '19': 'nineteen', '20': 'twenty', '30': 'thirty', '40': 'forty',
        '50': 'fifty', '60': 'sixty', '70': 'seventy', '80': 'eighty', '90': 'ninety',
      };

      for (const [num, word] of Object.entries(numberWords)) {
        const regex = new RegExp(`(?<!\\d)${num}(?!\\d)`, 'g');
        let match;
        while ((match = regex.exec(text)) !== null) {
          // Skip if preceded by $ or other currency/unit indicators
          const prevChar = text[match.index - 1];
          if (prevChar && /[$%€£¥#]/.test(prevChar)) continue;

          matches.push({
            startOffset: match.index,
            endOffset: match.index + match[0].length,
            matchedText: match[0],
            suggestedFix: word,
            ruleId: 'chicago-numbers-spell-out',
            ruleName: 'Chicago Number Style',
            description: 'Chicago style spells out numbers one through one hundred',
          });
        }
      }
      return matches;
    },
    styleGuides: ['CHICAGO'],
  },
];

// Additional APA 7th Edition Rules
const APA_SPECIFIC_RULES: StyleRule[] = [
  {
    id: 'apa-bias-free-gender',
    name: 'Gender-Neutral Language',
    description: 'Use gender-neutral terms and avoid gendered language',
    category: 'TERMINOLOGY',
    severity: 'WARNING',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      const genderedTerms: Record<string, string> = {
        'mankind': 'humankind',
        'manmade': 'artificial',
        'man-made': 'human-made',
        'manpower': 'workforce',
        'chairman': 'chairperson',
        'fireman': 'firefighter',
        'policeman': 'police officer',
        'stewardess': 'flight attendant',
        'waitress': 'server',
        'mailman': 'mail carrier',
      };

      for (const [gendered, neutral] of Object.entries(genderedTerms)) {
        const regex = new RegExp(`\\b${gendered}\\b`, 'gi');
        let match;
        while ((match = regex.exec(text)) !== null) {
          matches.push({
            startOffset: match.index,
            endOffset: match.index + match[0].length,
            matchedText: match[0],
            suggestedFix: neutral,
            ruleId: 'apa-bias-free-gender',
            ruleName: 'Gender-Neutral Language',
            description: `Use "${neutral}" instead of "${match[0]}" for inclusive language`,
          });
        }
      }
      return matches;
    },
    styleGuides: ['APA'],
  },
  {
    id: 'apa-singular-they',
    name: 'Singular They',
    description: 'APA endorses use of singular "they" for gender-neutral references',
    category: 'GRAMMAR',
    severity: 'SUGGESTION',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      // Flag "he or she" which can be replaced with "they"
      const regex = /\b(he or she|she or he|him or her|her or him|his or her|her or his)\b/gi;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const replacement = match[0].toLowerCase().includes('his') ? 'their' :
                           match[0].toLowerCase().includes('him') ? 'them' : 'they';
        matches.push({
          startOffset: match.index,
          endOffset: match.index + match[0].length,
          matchedText: match[0],
          suggestedFix: replacement,
          ruleId: 'apa-singular-they',
          ruleName: 'Singular They',
          description: 'Consider using singular "they" for gender-neutral language',
        });
      }
      return matches;
    },
    styleGuides: ['APA'],
  },
  {
    id: 'apa-anthropomorphism',
    name: 'Avoid Anthropomorphism',
    description: 'Avoid attributing human characteristics to inanimate objects',
    category: 'GRAMMAR',
    severity: 'SUGGESTION',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      // Common anthropomorphic phrases in academic writing
      const patterns = [
        { regex: /\bthe (study|paper|research|data|results?) (shows?|demonstrates?|argues?|believes?|thinks?|feels?)\b/gi,
          desc: 'Studies/papers cannot show, argue, or think - use "indicates" or "suggests"' },
        { regex: /\bthe (table|figure|graph) (shows?|illustrates?)\b/gi,
          desc: 'Consider "presents" or "displays" instead' },
      ];

      for (const { regex, desc } of patterns) {
        let match;
        while ((match = regex.exec(text)) !== null) {
          matches.push({
            startOffset: match.index,
            endOffset: match.index + match[0].length,
            matchedText: match[0],
            suggestedFix: match[0], // No auto-fix, needs human judgment
            ruleId: 'apa-anthropomorphism',
            ruleName: 'Avoid Anthropomorphism',
            description: desc,
          });
        }
      }
      return matches;
    },
    styleGuides: ['APA'],
  },
  {
    id: 'apa-et-al',
    name: 'Et al. Format',
    description: 'Use "et al." with period after "al"',
    category: 'ABBREVIATIONS',
    severity: 'ERROR',
    pattern: /\bet\s+al(?!\.)/gi,
    replacement: 'et al.',
    styleGuides: ['APA', 'CHICAGO', 'MLA'],
  },
  {
    id: 'apa-percent',
    name: 'Percent Symbol with Numbers',
    description: 'Use % symbol with numerals in APA style',
    category: 'NUMBERS',
    severity: 'WARNING',
    pattern: /(\d+)\s+percent/gi,
    replacement: '$1%',
    styleGuides: ['APA'],
  },
  {
    id: 'apa-no-contractions',
    name: 'Avoid Contractions',
    description: 'Formal academic writing should avoid contractions',
    category: 'GRAMMAR',
    severity: 'WARNING',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      const contractions: Record<string, string> = {
        "don't": 'do not',
        "doesn't": 'does not',
        "didn't": 'did not',
        "won't": 'will not',
        "wouldn't": 'would not',
        "can't": 'cannot',
        "couldn't": 'could not',
        "shouldn't": 'should not',
        "isn't": 'is not',
        "aren't": 'are not',
        "wasn't": 'was not',
        "weren't": 'were not',
        "haven't": 'have not',
        "hasn't": 'has not',
        "hadn't": 'had not',
        "it's": 'it is',
        "that's": 'that is',
        "there's": 'there is',
        "here's": 'here is',
        "what's": 'what is',
        "who's": 'who is',
        "let's": 'let us',
        "I'm": 'I am',
        "you're": 'you are',
        "we're": 'we are',
        "they're": 'they are',
        "I've": 'I have',
        "you've": 'you have',
        "we've": 'we have',
        "they've": 'they have',
        "I'll": 'I will',
        "you'll": 'you will',
        "we'll": 'we will',
        "they'll": 'they will',
        "I'd": 'I would',
        "you'd": 'you would',
        "we'd": 'we would',
        "they'd": 'they would',
      };

      for (const [contraction, expanded] of Object.entries(contractions)) {
        const regex = new RegExp(`\\b${contraction.replace("'", "'")}\\b`, 'gi');
        let match;
        while ((match = regex.exec(text)) !== null) {
          matches.push({
            startOffset: match.index,
            endOffset: match.index + match[0].length,
            matchedText: match[0],
            suggestedFix: expanded,
            ruleId: 'apa-no-contractions',
            ruleName: 'Avoid Contractions',
            description: 'Use the expanded form in formal academic writing',
          });
        }
      }
      return matches;
    },
    styleGuides: ['APA', 'CHICAGO'],
  },
  {
    id: 'apa-number-plural-apostrophe',
    name: 'No Apostrophe in Number Plurals',
    description: 'Never use apostrophe when expressing numbers in plural form',
    category: 'NUMBERS',
    severity: 'ERROR',
    pattern: /\b(\d{4})'s\b/g,
    replacement: '$1s',
    styleGuides: ['APA', 'CHICAGO', 'MLA'],
    examples: [
      { incorrect: "in the 1970's", correct: 'in the 1970s' },
    ],
  },
  {
    id: 'apa-sentence-case-titles',
    name: 'Sentence Case for Article/Chapter Titles',
    description: 'APA uses sentence case for article and chapter titles (capitalize only first word and proper nouns)',
    category: 'CAPITALIZATION',
    severity: 'SUGGESTION',
    validator: () => {
      // Complex rule - delegated to AI validation
      return [];
    },
    styleGuides: ['APA'],
  },
  {
    id: 'apa-ampersand-citations',
    name: 'Ampersand in Citations',
    description: 'Use ampersand (&) before last author in parenthetical citations',
    category: 'CITATIONS',
    severity: 'SUGGESTION',
    validator: () => {
      // Complex rule - needs citation context
      return [];
    },
    styleGuides: ['APA'],
  },
  {
    id: 'apa-running-head',
    name: 'Running Head Format',
    description: 'Running head should be in all caps and shortened version of title',
    category: 'FORMATTING',
    severity: 'SUGGESTION',
    validator: () => {
      return [];
    },
    styleGuides: ['APA'],
  },
  {
    id: 'apa-doi-format',
    name: 'DOI Format',
    description: 'Include DOI as https://doi.org/xxxxx format',
    category: 'CITATIONS',
    severity: 'WARNING',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      // Flag old DOI formats
      const regex = /\bdoi:\s*(\d+\.\d+\/[^\s]+)/gi;
      let match;
      while ((match = regex.exec(text)) !== null) {
        matches.push({
          startOffset: match.index,
          endOffset: match.index + match[0].length,
          matchedText: match[0],
          suggestedFix: `https://doi.org/${match[1]}`,
          ruleId: 'apa-doi-format',
          ruleName: 'DOI Format',
          description: 'APA 7th edition requires DOI as URL format',
        });
      }
      return matches;
    },
    styleGuides: ['APA'],
  },
];

// MLA Style Rules
const MLA_RULES: StyleRule[] = [
  {
    id: 'mla-title-italics',
    name: 'Italics for Titles',
    description: 'Book, journal, and website titles should be italicized',
    category: 'FORMATTING',
    severity: 'SUGGESTION',
    validator: () => {
      // Complex rule - requires context awareness
      return [];
    },
    styleGuides: ['MLA'],
  },
  {
    id: 'mla-quotation-marks',
    name: 'Quotation Marks for Short Works',
    description: 'Article, chapter, and short story titles should be in quotation marks',
    category: 'FORMATTING',
    severity: 'SUGGESTION',
    validator: () => {
      return [];
    },
    styleGuides: ['MLA'],
  },
  {
    id: 'mla-numbers',
    name: 'MLA Number Style',
    description: 'Spell out numbers that can be written in one or two words',
    category: 'NUMBERS',
    severity: 'WARNING',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      const numberWords: Record<string, string> = {
        '100': 'one hundred',
        '1000': 'one thousand',
      };

      // MLA spells out round numbers that can be expressed in two words
      const regex = /\b(100|1000|1,000)\b/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const clean = match[1].replace(',', '');
        if (numberWords[clean]) {
          matches.push({
            startOffset: match.index,
            endOffset: match.index + match[0].length,
            matchedText: match[0],
            suggestedFix: numberWords[clean],
            ruleId: 'mla-numbers',
            ruleName: 'MLA Number Style',
            description: 'MLA prefers spelling out round numbers expressible in two words',
          });
        }
      }
      return matches;
    },
    styleGuides: ['MLA'],
  },
  {
    id: 'mla-date-format',
    name: 'MLA Date Format',
    description: 'MLA uses day month year format with abbreviated months',
    category: 'FORMATTING',
    severity: 'SUGGESTION',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      // Flag US date format (Month Day, Year) like "January 15, 2024"
      const regex = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})\b/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const monthAbbrev: Record<string, string> = {
          'January': 'Jan.', 'February': 'Feb.', 'March': 'Mar.', 'April': 'Apr.',
          'May': 'May', 'June': 'June', 'July': 'July', 'August': 'Aug.',
          'September': 'Sept.', 'October': 'Oct.', 'November': 'Nov.', 'December': 'Dec.'
        };
        const abbrev = monthAbbrev[match[1]] || match[1];
        matches.push({
          startOffset: match.index,
          endOffset: match.index + match[0].length,
          matchedText: match[0],
          suggestedFix: `${match[2]} ${abbrev} ${match[3]}`,
          ruleId: 'mla-date-format',
          ruleName: 'MLA Date Format',
          description: 'MLA prefers day month year format',
        });
      }
      return matches;
    },
    styleGuides: ['MLA'],
  },
  {
    id: 'mla-et-al-three-plus',
    name: 'MLA Et Al. Usage',
    description: 'MLA uses et al. for works with three or more authors',
    category: 'ABBREVIATIONS',
    severity: 'SUGGESTION',
    validator: () => {
      // Complex rule - needs citation context
      return [];
    },
    styleGuides: ['MLA'],
  },
  {
    id: 'mla-title-case',
    name: 'MLA Title Case',
    description: 'Use title case: capitalize all major words, not prepositions, conjunctions, or articles unless first word',
    category: 'CAPITALIZATION',
    severity: 'SUGGESTION',
    validator: () => {
      // Complex rule - delegated to AI
      return [];
    },
    styleGuides: ['MLA'],
  },
];

// AP Style Rules
const AP_RULES: StyleRule[] = [
  {
    id: 'ap-state-abbreviations',
    name: 'AP State Abbreviations',
    description: 'Use AP style state abbreviations (not postal codes)',
    category: 'ABBREVIATIONS',
    severity: 'SUGGESTION',
    validator: () => {
      // Would need a comprehensive list and context
      return [];
    },
    styleGuides: ['AP'],
  },
  {
    id: 'ap-no-oxford-comma',
    name: 'No Oxford Comma',
    description: 'AP style does not use the serial (Oxford) comma',
    category: 'PUNCTUATION',
    severity: 'WARNING',
    pattern: /(\w+),\s+(\w+),\s+and\s+/gi,
    replacement: '$1, $2 and ',
    styleGuides: ['AP'],
    examples: [
      { incorrect: 'red, white, and blue', correct: 'red, white and blue' },
    ],
  },
  {
    id: 'ap-percent-spelled',
    name: 'Spell Out Percent',
    description: 'AP style spells out "percent" (does not use %)',
    category: 'NUMBERS',
    severity: 'WARNING',
    pattern: /(\d+)%/g,
    replacement: '$1 percent',
    styleGuides: ['AP'],
    examples: [
      { incorrect: '50%', correct: '50 percent' },
    ],
  },
  {
    id: 'ap-time-format',
    name: 'AP Time Format',
    description: 'Use figures except for noon and midnight',
    category: 'NUMBERS',
    severity: 'SUGGESTION',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      // Flag 12:00 p.m. or 12:00 a.m.
      const noonRegex = /12:00\s*p\.?m\.?/gi;
      const midnightRegex = /12:00\s*a\.?m\.?/gi;

      let match;
      while ((match = noonRegex.exec(text)) !== null) {
        matches.push({
          startOffset: match.index,
          endOffset: match.index + match[0].length,
          matchedText: match[0],
          suggestedFix: 'noon',
          ruleId: 'ap-time-format',
          ruleName: 'AP Time Format',
          description: 'Use "noon" instead of "12:00 p.m."',
        });
      }
      while ((match = midnightRegex.exec(text)) !== null) {
        matches.push({
          startOffset: match.index,
          endOffset: match.index + match[0].length,
          matchedText: match[0],
          suggestedFix: 'midnight',
          ruleId: 'ap-time-format',
          ruleName: 'AP Time Format',
          description: 'Use "midnight" instead of "12:00 a.m."',
        });
      }
      return matches;
    },
    styleGuides: ['AP'],
  },
  {
    id: 'ap-ages',
    name: 'AP Age Format',
    description: 'Always use figures for ages',
    category: 'NUMBERS',
    severity: 'WARNING',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      const ageWords: Record<string, string> = {
        'one-year-old': '1-year-old',
        'two-year-old': '2-year-old',
        'three-year-old': '3-year-old',
        'four-year-old': '4-year-old',
        'five-year-old': '5-year-old',
        'six-year-old': '6-year-old',
        'seven-year-old': '7-year-old',
        'eight-year-old': '8-year-old',
        'nine-year-old': '9-year-old',
      };

      for (const [spelled, numeric] of Object.entries(ageWords)) {
        const regex = new RegExp(`\\b${spelled}\\b`, 'gi');
        let match;
        while ((match = regex.exec(text)) !== null) {
          matches.push({
            startOffset: match.index,
            endOffset: match.index + match[0].length,
            matchedText: match[0],
            suggestedFix: numeric,
            ruleId: 'ap-ages',
            ruleName: 'AP Age Format',
            description: 'AP style uses figures for ages',
          });
        }
      }
      return matches;
    },
    styleGuides: ['AP'],
  },
];

// Vancouver Style Rules (Medical/Scientific)
const VANCOUVER_RULES: StyleRule[] = [
  {
    id: 'vancouver-citation-numbers',
    name: 'Numbered Citations',
    description: 'Vancouver uses numbered citations in order of appearance',
    category: 'CITATIONS',
    severity: 'SUGGESTION',
    validator: () => {
      // Would need citation detection
      return [];
    },
    styleGuides: ['VANCOUVER'],
  },
  {
    id: 'vancouver-journal-abbrev',
    name: 'Journal Title Abbreviations',
    description: 'Use standard NLM journal abbreviations',
    category: 'ABBREVIATIONS',
    severity: 'SUGGESTION',
    validator: () => {
      return [];
    },
    styleGuides: ['VANCOUVER'],
  },
  {
    id: 'vancouver-units',
    name: 'SI Units',
    description: 'Use SI units for measurements',
    category: 'FORMATTING',
    severity: 'WARNING',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      const nonSIUnits: Record<string, string> = {
        'inches': 'cm',
        'inch': 'cm',
        'feet': 'm',
        'foot': 'm',
        'pounds': 'kg',
        'pound': 'kg',
        'ounces': 'g',
        'ounce': 'g',
        'miles': 'km',
        'mile': 'km',
        'gallons': 'L',
        'gallon': 'L',
      };

      for (const [nonSI, si] of Object.entries(nonSIUnits)) {
        const regex = new RegExp(`\\d+\\s*${nonSI}\\b`, 'gi');
        let match;
        while ((match = regex.exec(text)) !== null) {
          matches.push({
            startOffset: match.index,
            endOffset: match.index + match[0].length,
            matchedText: match[0],
            suggestedFix: `[convert to ${si}]`,
            ruleId: 'vancouver-units',
            ruleName: 'SI Units',
            description: `Consider using SI units (${si}) instead of ${nonSI}`,
          });
        }
      }
      return matches;
    },
    styleGuides: ['VANCOUVER', 'NATURE', 'IEEE'],
  },
  {
    id: 'vancouver-author-format',
    name: 'Author Name Format',
    description: 'List authors surname first, followed by initials without periods',
    category: 'CITATIONS',
    severity: 'SUGGESTION',
    validator: () => {
      // Complex rule - needs citation parsing
      return [];
    },
    styleGuides: ['VANCOUVER'],
  },
  {
    id: 'vancouver-et-al-six',
    name: 'Vancouver Et Al. Usage',
    description: 'List first 6 authors, then et al. for 7 or more',
    category: 'CITATIONS',
    severity: 'SUGGESTION',
    validator: () => {
      return [];
    },
    styleGuides: ['VANCOUVER'],
  },
  {
    id: 'vancouver-date-format',
    name: 'Vancouver Date Format',
    description: 'Use Year Month Day format with abbreviated months',
    category: 'FORMATTING',
    severity: 'SUGGESTION',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      // Flag dates not in Vancouver format (Year Mon Day)
      const regex = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),?\s+(\d{4})\b/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const monthAbbrev: Record<string, string> = {
          'January': 'Jan', 'February': 'Feb', 'March': 'Mar', 'April': 'Apr',
          'May': 'May', 'June': 'Jun', 'July': 'Jul', 'August': 'Aug',
          'September': 'Sep', 'October': 'Oct', 'November': 'Nov', 'December': 'Dec'
        };
        const abbrev = monthAbbrev[match[1]] || match[1];
        matches.push({
          startOffset: match.index,
          endOffset: match.index + match[0].length,
          matchedText: match[0],
          suggestedFix: `${match[3]} ${abbrev} ${match[2]}`,
          ruleId: 'vancouver-date-format',
          ruleName: 'Vancouver Date Format',
          description: 'Vancouver style uses Year Month Day format',
        });
      }
      return matches;
    },
    styleGuides: ['VANCOUVER'],
  },
  {
    id: 'vancouver-doi',
    name: 'DOI in References',
    description: 'Include DOI at the end of references when available',
    category: 'CITATIONS',
    severity: 'SUGGESTION',
    validator: () => {
      return [];
    },
    styleGuides: ['VANCOUVER'],
  },
  {
    id: 'vancouver-page-range',
    name: 'Page Range Format',
    description: 'Use abbreviated page ranges (e.g., 123-8 not 123-128)',
    category: 'FORMATTING',
    severity: 'SUGGESTION',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      // Flag full page ranges where second number could be abbreviated
      const regex = /\b(\d{2,})[-–](\d{2,})\b/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const start = match[1];
        const end = match[2];
        // Check if they share leading digits
        if (start.length === end.length && start.length >= 2) {
          let commonPrefix = 0;
          for (let i = 0; i < start.length - 1; i++) {
            if (start[i] === end[i]) commonPrefix++;
            else break;
          }
          if (commonPrefix > 0) {
            const abbreviated = end.slice(commonPrefix);
            if (abbreviated !== end) {
              matches.push({
                startOffset: match.index,
                endOffset: match.index + match[0].length,
                matchedText: match[0],
                suggestedFix: `${start}-${abbreviated}`,
                ruleId: 'vancouver-page-range',
                ruleName: 'Page Range Format',
                description: 'Vancouver style uses abbreviated page ranges',
              });
            }
          }
        }
      }
      return matches;
    },
    styleGuides: ['VANCOUVER'],
  },
  {
    id: 'vancouver-medical-terms',
    name: 'Medical Terminology',
    description: 'Use standard medical terminology',
    category: 'TERMINOLOGY',
    severity: 'WARNING',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      // Common lay terms that should use medical terminology
      const medicalTerms: Record<string, string> = {
        'heart attack': 'myocardial infarction',
        'stroke': 'cerebrovascular accident',
        'high blood pressure': 'hypertension',
        'sugar diabetes': 'diabetes mellitus',
        'water pill': 'diuretic',
        'pain killer': 'analgesic',
        'blood thinner': 'anticoagulant',
      };

      for (const [lay, medical] of Object.entries(medicalTerms)) {
        const regex = new RegExp(`\\b${lay}\\b`, 'gi');
        let match;
        while ((match = regex.exec(text)) !== null) {
          matches.push({
            startOffset: match.index,
            endOffset: match.index + match[0].length,
            matchedText: match[0],
            suggestedFix: medical,
            ruleId: 'vancouver-medical-terms',
            ruleName: 'Medical Terminology',
            description: `Consider using "${medical}" instead of "${lay}" in medical writing`,
          });
        }
      }
      return matches;
    },
    styleGuides: ['VANCOUVER'],
  },
];

// Common Writing Quality Rules
const WRITING_QUALITY_RULES: StyleRule[] = [
  {
    id: 'quality-redundancy',
    name: 'Redundant Phrases',
    description: 'Avoid redundant expressions',
    category: 'TERMINOLOGY',
    severity: 'SUGGESTION',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      const redundantPhrases: Record<string, string> = {
        'advance planning': 'planning',
        'basic fundamentals': 'fundamentals',
        'close proximity': 'proximity',
        'completely eliminate': 'eliminate',
        'consensus of opinion': 'consensus',
        'end result': 'result',
        'exact same': 'same',
        'free gift': 'gift',
        'future plans': 'plans',
        'general consensus': 'consensus',
        'new innovation': 'innovation',
        'past history': 'history',
        'personal opinion': 'opinion',
        'previous experience': 'experience',
        'repeat again': 'repeat',
        'revert back': 'revert',
        'sum total': 'total',
        'unexpected surprise': 'surprise',
        'whether or not': 'whether',
        'each and every': 'each',
        'first and foremost': 'first',
        'various different': 'various',
        'absolutely essential': 'essential',
        'actual fact': 'fact',
        'added bonus': 'bonus',
        'advance warning': 'warning',
      };

      for (const [redundant, concise] of Object.entries(redundantPhrases)) {
        const regex = new RegExp(`\\b${redundant}\\b`, 'gi');
        let match;
        while ((match = regex.exec(text)) !== null) {
          matches.push({
            startOffset: match.index,
            endOffset: match.index + match[0].length,
            matchedText: match[0],
            suggestedFix: concise,
            ruleId: 'quality-redundancy',
            ruleName: 'Redundant Phrases',
            description: `"${redundant}" is redundant; consider using just "${concise}"`,
          });
        }
      }
      return matches;
    },
    styleGuides: ['CHICAGO', 'APA', 'MLA', 'AP', 'CUSTOM'],
  },
  {
    id: 'quality-wordy',
    name: 'Wordy Phrases',
    description: 'Replace wordy phrases with concise alternatives',
    category: 'TERMINOLOGY',
    severity: 'SUGGESTION',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      const wordyPhrases: Record<string, string> = {
        'at this point in time': 'now',
        'due to the fact that': 'because',
        'in order to': 'to',
        'in the event that': 'if',
        'in spite of the fact that': 'although',
        'with regard to': 'about',
        'with respect to': 'about',
        'for the purpose of': 'for',
        'in the near future': 'soon',
        'at the present time': 'now',
        'on a daily basis': 'daily',
        'on a regular basis': 'regularly',
        'in a timely manner': 'promptly',
        'make a decision': 'decide',
        'take into consideration': 'consider',
        'give consideration to': 'consider',
        'make an attempt': 'try',
        'come to a conclusion': 'conclude',
        'is able to': 'can',
        'has the ability to': 'can',
        'in close proximity to': 'near',
        'a large number of': 'many',
        'a small number of': 'few',
        'the majority of': 'most',
        'in the absence of': 'without',
        'subsequent to': 'after',
        'prior to': 'before',
      };

      for (const [wordy, concise] of Object.entries(wordyPhrases)) {
        const regex = new RegExp(`\\b${wordy}\\b`, 'gi');
        let match;
        while ((match = regex.exec(text)) !== null) {
          matches.push({
            startOffset: match.index,
            endOffset: match.index + match[0].length,
            matchedText: match[0],
            suggestedFix: concise,
            ruleId: 'quality-wordy',
            ruleName: 'Wordy Phrases',
            description: `Consider using "${concise}" instead of "${wordy}"`,
          });
        }
      }
      return matches;
    },
    styleGuides: ['CHICAGO', 'APA', 'MLA', 'AP', 'CUSTOM'],
  },
  {
    id: 'quality-cliches',
    name: 'Avoid Clichés',
    description: 'Avoid overused phrases and clichés',
    category: 'TERMINOLOGY',
    severity: 'SUGGESTION',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      const cliches = [
        'at the end of the day',
        'think outside the box',
        'paradigm shift',
        'low-hanging fruit',
        'move the needle',
        'synergy',
        'leverage',
        'best practices',
        'value-added',
        'win-win',
        'circle back',
        'deep dive',
        'game changer',
        'disrupt',
      ];

      for (const cliche of cliches) {
        const regex = new RegExp(`\\b${cliche}\\b`, 'gi');
        let match;
        while ((match = regex.exec(text)) !== null) {
          matches.push({
            startOffset: match.index,
            endOffset: match.index + match[0].length,
            matchedText: match[0],
            suggestedFix: match[0], // No auto-fix
            ruleId: 'quality-cliches',
            ruleName: 'Avoid Clichés',
            description: `"${cliche}" is a cliché; consider more specific language`,
          });
        }
      }
      return matches;
    },
    styleGuides: ['CHICAGO', 'APA', 'CUSTOM'],
  },
  {
    id: 'quality-split-infinitive',
    name: 'Split Infinitive',
    description: 'Consider avoiding split infinitives (though modern usage allows them)',
    category: 'GRAMMAR',
    severity: 'SUGGESTION',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      // to + adverb + verb pattern
      const regex = /\bto\s+(\w+ly)\s+(\w+)/gi;
      let match;
      while ((match = regex.exec(text)) !== null) {
        matches.push({
          startOffset: match.index,
          endOffset: match.index + match[0].length,
          matchedText: match[0],
          suggestedFix: `to ${match[2]} ${match[1]}`,
          ruleId: 'quality-split-infinitive',
          ruleName: 'Split Infinitive',
          description: 'Consider moving the adverb: "to boldly go" → "to go boldly"',
        });
      }
      return matches;
    },
    styleGuides: ['CHICAGO'],
  },
];

// Combine all rules into rule sets
const ACADEMIC_RULESET: RuleSet = {
  id: 'academic',
  name: 'Academic Writing',
  description: 'Rules for academic and scholarly writing',
  rules: [
    ...GRAMMAR_RULES.filter(r => r.id.includes('passive')),
    ...TERMINOLOGY_RULES,
    ...PUNCTUATION_RULES,
    ...CAPITALIZATION_RULES,
  ],
};

const GENERAL_RULESET: RuleSet = {
  id: 'general',
  name: 'General Quality',
  description: 'Basic grammar, spelling, and punctuation rules',
  rules: [
    ...PUNCTUATION_RULES,
    ...CAPITALIZATION_RULES,
    ...GRAMMAR_RULES,
    ...NUMBER_RULES,
    ...ABBREVIATION_RULES,
    ...WRITING_QUALITY_RULES,
  ],
};

const NATURE_RULESET: RuleSet = {
  id: 'nature',
  name: 'Nature Publishing',
  description: 'Rules specific to Nature journal submissions',
  styleGuide: 'NATURE',
  rules: [
    ...NATURE_RULES,
    ...GRAMMAR_RULES,
    ...PUNCTUATION_RULES,
  ],
};

const IEEE_RULESET: RuleSet = {
  id: 'ieee',
  name: 'IEEE Standards',
  description: 'Rules for IEEE publication standards',
  styleGuide: 'IEEE',
  rules: [
    ...IEEE_RULES,
    ...GRAMMAR_RULES,
    ...PUNCTUATION_RULES,
    ...NUMBER_RULES,
  ],
};

const CHICAGO_RULESET: RuleSet = {
  id: 'chicago',
  name: 'Chicago Manual of Style',
  description: 'Rules based on the Chicago Manual of Style',
  styleGuide: 'CHICAGO',
  rules: [
    ...PUNCTUATION_RULES.filter(r => r.styleGuides.includes('CHICAGO')),
    ...CAPITALIZATION_RULES,
    ...NUMBER_RULES.filter(r => r.styleGuides.includes('CHICAGO')),
    ...GRAMMAR_RULES,
    ...TERMINOLOGY_RULES.filter(r => r.styleGuides.includes('CHICAGO')),
    ...ABBREVIATION_RULES.filter(r => r.styleGuides.includes('CHICAGO')),
    ...CHICAGO_SPECIFIC_RULES,
    ...WRITING_QUALITY_RULES.filter(r => r.styleGuides.includes('CHICAGO')),
  ],
};

const APA_RULESET: RuleSet = {
  id: 'apa',
  name: 'APA 7th Edition',
  description: 'Rules based on APA Publication Manual 7th Edition',
  styleGuide: 'APA',
  rules: [
    ...PUNCTUATION_RULES.filter(r => r.styleGuides.includes('APA')),
    ...CAPITALIZATION_RULES,
    ...NUMBER_RULES.filter(r => r.styleGuides.includes('APA')),
    ...GRAMMAR_RULES.filter(r => r.styleGuides.includes('APA')),
    ...TERMINOLOGY_RULES.filter(r => r.styleGuides.includes('APA')),
    ...ABBREVIATION_RULES.filter(r => r.styleGuides.includes('APA')),
    ...APA_SPECIFIC_RULES,
    ...WRITING_QUALITY_RULES.filter(r => r.styleGuides.includes('APA')),
  ],
};

const MLA_RULESET: RuleSet = {
  id: 'mla',
  name: 'MLA Style',
  description: 'Rules based on MLA Handbook',
  styleGuide: 'MLA',
  rules: [
    ...PUNCTUATION_RULES.filter(r => r.styleGuides.includes('MLA')),
    ...CAPITALIZATION_RULES,
    ...GRAMMAR_RULES,
    ...MLA_RULES,
    ...WRITING_QUALITY_RULES.filter(r => r.styleGuides.includes('MLA')),
  ],
};

const AP_RULESET: RuleSet = {
  id: 'ap',
  name: 'AP Style',
  description: 'Rules based on Associated Press Stylebook',
  styleGuide: 'AP',
  rules: [
    ...PUNCTUATION_RULES.filter(r => r.styleGuides.includes('AP')),
    ...CAPITALIZATION_RULES,
    ...AP_RULES,
    ...CHICAGO_SPECIFIC_RULES.filter(r => r.styleGuides.includes('AP')),
    ...WRITING_QUALITY_RULES.filter(r => r.styleGuides.includes('AP')),
  ],
};

const VANCOUVER_RULESET: RuleSet = {
  id: 'vancouver',
  name: 'Vancouver Style',
  description: 'Rules for medical/scientific writing (ICMJE recommendations)',
  styleGuide: 'VANCOUVER',
  rules: [
    ...PUNCTUATION_RULES,
    ...CAPITALIZATION_RULES,
    ...GRAMMAR_RULES,
    ...VANCOUVER_RULES,
  ],
};

export class StyleRulesRegistryService {
  private ruleSets: Map<string, RuleSet> = new Map();
  private allRules: Map<string, StyleRule> = new Map();

  constructor() {
    this.registerDefaultRuleSets();
  }

  private registerDefaultRuleSets(): void {
    const defaultSets = [
      GENERAL_RULESET,
      ACADEMIC_RULESET,
      CHICAGO_RULESET,
      APA_RULESET,
      MLA_RULESET,
      AP_RULESET,
      VANCOUVER_RULESET,
      NATURE_RULESET,
      IEEE_RULESET,
    ];

    for (const ruleSet of defaultSets) {
      this.ruleSets.set(ruleSet.id, ruleSet);
      for (const rule of ruleSet.rules) {
        this.allRules.set(rule.id, rule);
      }
    }
  }

  getRuleSet(id: string): RuleSet | undefined {
    return this.ruleSets.get(id);
  }

  getAllRuleSets(): RuleSet[] {
    return Array.from(this.ruleSets.values());
  }

  getRule(id: string): StyleRule | undefined {
    return this.allRules.get(id);
  }

  getRulesForStyleGuide(styleGuide: StyleGuideType): StyleRule[] {
    return Array.from(this.allRules.values()).filter(
      rule => rule.styleGuides.includes(styleGuide)
    );
  }

  getRulesByCategory(category: StyleCategory): StyleRule[] {
    return Array.from(this.allRules.values()).filter(
      rule => rule.category === category
    );
  }

  executeRule(rule: StyleRule, text: string, context?: RuleContext): RuleMatch[] {
    // If rule has custom validator, use it
    if (rule.validator) {
      return rule.validator(text, context);
    }

    // Otherwise, use pattern matching
    if (rule.pattern) {
      const matches: RuleMatch[] = [];
      const regex = new RegExp(rule.pattern.source, rule.pattern.flags);
      let match;

      while ((match = regex.exec(text)) !== null) {
        let suggestedFix = match[0];

        if (typeof rule.replacement === 'function') {
          suggestedFix = rule.replacement(match[0]);
        } else if (typeof rule.replacement === 'string') {
          suggestedFix = match[0].replace(rule.pattern, rule.replacement);
        }

        matches.push({
          startOffset: match.index,
          endOffset: match.index + match[0].length,
          matchedText: match[0],
          suggestedFix,
          ruleId: rule.id,
          ruleName: rule.name,
          description: rule.description,
        });
      }

      return matches;
    }

    return [];
  }

  executeRuleSet(ruleSetId: string, text: string, context?: RuleContext): RuleMatch[] {
    const ruleSet = this.ruleSets.get(ruleSetId);
    if (!ruleSet) return [];

    const allMatches: RuleMatch[] = [];

    for (const rule of ruleSet.rules) {
      const matches = this.executeRule(rule, text, context);
      allMatches.push(...matches);
    }

    // Sort by offset
    return allMatches.sort((a, b) => a.startOffset - b.startOffset);
  }

  validateText(
    text: string,
    ruleSetIds: string[],
    context?: RuleContext
  ): RuleMatch[] {
    const allMatches: RuleMatch[] = [];
    const processedOffsets = new Set<string>();

    for (const ruleSetId of ruleSetIds) {
      const matches = this.executeRuleSet(ruleSetId, text, context);

      for (const match of matches) {
        // Deduplicate overlapping matches
        const key = `${match.startOffset}-${match.endOffset}-${match.ruleId}`;
        if (!processedOffsets.has(key)) {
          processedOffsets.add(key);
          allMatches.push(match);
        }
      }
    }

    return allMatches.sort((a, b) => a.startOffset - b.startOffset);
  }
}

export const styleRulesRegistry = new StyleRulesRegistryService();
