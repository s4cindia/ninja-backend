/**
 * Style Rules Index
 *
 * Re-exports all rule types and rule arrays for easy importing.
 */

// Types
export * from './types';

// Common rules
export {
  PUNCTUATION_RULES,
  CAPITALIZATION_RULES,
  NUMBER_RULES,
  GRAMMAR_RULES,
  TERMINOLOGY_RULES,
  ABBREVIATION_RULES,
} from './common-rules';

// Publisher-specific rules
export {
  NATURE_RULES,
  IEEE_RULES,
} from './publisher-rules';

// Style guide-specific rules
export {
  CHICAGO_SPECIFIC_RULES,
  APA_SPECIFIC_RULES,
  MLA_RULES,
  AP_RULES,
  VANCOUVER_RULES,
  WRITING_QUALITY_RULES,
} from './style-guide-rules';
