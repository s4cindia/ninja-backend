/**
 * Style Rules Registry Service
 *
 * Provides built-in rule definitions for style validation including:
 * - Grammar, punctuation, capitalization rules
 * - Academic writing rules
 * - Publisher-specific rules (Nature, IEEE, Elsevier presets)
 *
 * Rule definitions are split into modular files under ./rules/
 */

import { StyleGuideType, StyleCategory } from '@prisma/client';

// Import types and rules from modular files
import {
  StyleRule,
  RuleMatch,
  RuleContext,
  RuleSet,
  ViolationSourceType,
} from './rules/types';

import {
  PUNCTUATION_RULES,
  CAPITALIZATION_RULES,
  NUMBER_RULES,
  GRAMMAR_RULES,
  TERMINOLOGY_RULES,
  ABBREVIATION_RULES,
} from './rules/common-rules';

import {
  NATURE_RULES,
  IEEE_RULES,
} from './rules/publisher-rules';

import {
  CHICAGO_SPECIFIC_RULES,
  APA_SPECIFIC_RULES,
  MLA_RULES,
  AP_RULES,
  VANCOUVER_RULES,
  WRITING_QUALITY_RULES,
} from './rules/style-guide-rules';

// Re-export types for backward compatibility
export type { StyleRule, RuleMatch, RuleContext, RuleSet, ViolationSourceType };

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

// Rules that are too aggressive and generate many false positives
const NOISY_RULE_IDS = ['num-spell-out-small', 'gram-passive-voice', 'cap-sentence-start'];

const GENERAL_RULESET: RuleSet = {
  id: 'general',
  name: 'General Quality',
  description: 'Basic grammar, spelling, and punctuation rules',
  rules: [
    ...PUNCTUATION_RULES,
    ...CAPITALIZATION_RULES.filter(r => !NOISY_RULE_IDS.includes(r.id)),
    ...GRAMMAR_RULES.filter(r => !NOISY_RULE_IDS.includes(r.id)),
    ...NUMBER_RULES.filter(r => !NOISY_RULE_IDS.includes(r.id)),
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
    // ReDoS protection: Limit input size
    const MAX_INPUT_SIZE = 100000; // 100KB
    if (text.length > MAX_INPUT_SIZE) {
      return [];
    }

    // If rule has custom validator, use it
    if (rule.validator) {
      return rule.validator(text, context);
    }

    // Otherwise, use pattern matching
    if (rule.pattern) {
      const matches: RuleMatch[] = [];
      // Ensure 'g' flag is present to prevent infinite loop with exec()
      const flags = rule.pattern.flags.includes('g')
        ? rule.pattern.flags
        : rule.pattern.flags + 'g';
      const regex = new RegExp(rule.pattern.source, flags);
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
