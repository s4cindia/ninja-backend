/**
 * Common Style Rules
 *
 * Basic rules for punctuation, capitalization, numbers, grammar,
 * terminology, and abbreviations applicable across multiple style guides.
 */

import type { StyleRule, RuleMatch } from './types';

export const PUNCTUATION_RULES: StyleRule[] = [
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
      const regex = /,\s+(I|he|she|it|they|we|you|this|that|these|those)\s+\w+/gi;
      let match;
      while ((match = regex.exec(text)) !== null) {
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

export const CAPITALIZATION_RULES: StyleRule[] = [
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
      // Complex rule that requires context awareness - handled by AI validation
      return [];
    },
    styleGuides: ['CHICAGO', 'APA', 'MLA', 'AP', 'CUSTOM'],
  },
];

export const NUMBER_RULES: StyleRule[] = [
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

      const regex = /(?<!\d)([1-9])(?!\d)/g;
      let match;
      while ((match = regex.exec(text)) !== null) {
        const prevChar = text[match.index - 1];
        if (prevChar && /[$%€£¥#]/.test(prevChar)) continue;

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

export const GRAMMAR_RULES: StyleRule[] = [
  {
    id: 'gram-passive-voice',
    name: 'Passive Voice Detection',
    description: 'Consider using active voice for clearer writing',
    category: 'GRAMMAR',
    severity: 'SUGGESTION',
    validator: (text) => {
      const matches: RuleMatch[] = [];
      const regex = /\b(was|were|been|being|is|are|am)\s+(being\s+)?(\w+ed)\b/gi;
      let match;
      while ((match = regex.exec(text)) !== null) {
        matches.push({
          startOffset: match.index,
          endOffset: match.index + match[0].length,
          matchedText: match[0],
          suggestedFix: match[0],
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

export const TERMINOLOGY_RULES: StyleRule[] = [
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

export const ABBREVIATION_RULES: StyleRule[] = [
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
