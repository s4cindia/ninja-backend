/**
 * Style Rules Type Definitions
 *
 * Shared types for style rule definitions and matching.
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

export type ViolationSourceType = 'AI' | 'BUILT_IN' | 'HOUSE';

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
  source?: ViolationSourceType;  // Where the violation was detected from
  aiSeverity?: string;  // Raw severity from AI response (error|warning|suggestion)
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
