/**
 * Style Services Index
 *
 * Exports all style-related services
 */

export {
  StyleRulesRegistryService,
  styleRulesRegistry,
  type StyleRule,
  type RuleMatch,
  type RuleContext,
  type RuleSet,
} from './style-rules-registry.service';

export {
  HouseStyleEngineService,
  houseStyleEngine,
  type CreateHouseRuleInput,
  type UpdateHouseRuleInput,
  type HouseRuleFilters,
  type RulesExport,
  type ImportResult,
  type TestResult,
} from './house-style-engine.service';

export {
  StyleValidationService,
  styleValidation,
  type StartValidationInput,
  type ViolationFilters,
  type ApplyFixInput,
  type BulkActionInput,
  type BulkFixResult,
  type ValidationSummary,
  type ValidationProgress,
} from './style-validation.service';
