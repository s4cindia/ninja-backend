/**
 * Publisher-Specific Style Rules
 *
 * Rules specific to academic publishers like Nature and IEEE.
 */

import type { StyleRule, RuleMatch } from './types';

export const NATURE_RULES: StyleRule[] = [
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

export const IEEE_RULES: StyleRule[] = [
  {
    id: 'ieee-first-person',
    name: 'First Person Usage',
    description: 'IEEE papers typically use first person plural for authors',
    category: 'GRAMMAR',
    severity: 'SUGGESTION',
    validator: (text) => {
      const matches: RuleMatch[] = [];
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
