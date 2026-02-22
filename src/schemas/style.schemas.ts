/**
 * Style Validation Schemas
 *
 * Zod schemas for style validation API requests.
 */

import { z } from 'zod';

// ============================================
// ENUMS
// ============================================

export const styleGuideTypeEnum = z.enum([
  'CHICAGO',
  'APA',
  'MLA',
  'AP',
  'VANCOUVER',
  'IEEE',
  'NATURE',
  'ELSEVIER',
  'CUSTOM',
]);

export const styleCategoryEnum = z.enum([
  'PUNCTUATION',
  'CAPITALIZATION',
  'NUMBERS',
  'ABBREVIATIONS',
  'HYPHENATION',
  'SPELLING',
  'GRAMMAR',
  'TERMINOLOGY',
  'FORMATTING',
  'CITATIONS',
  'OTHER',
]);

export const styleSeverityEnum = z.enum(['ERROR', 'WARNING', 'SUGGESTION']);

export const violationStatusEnum = z.enum([
  'PENDING',
  'FIXED',
  'IGNORED',
  'WONT_FIX',
  'AUTO_FIXED',
]);

export const houseRuleTypeEnum = z.enum([
  'TERMINOLOGY',
  'PATTERN',
  'CAPITALIZATION',
  'PUNCTUATION',
]);

export const ruleSetIdEnum = z.enum([
  'general',
  'academic',
  'chicago',
  'apa',
  'nature',
  'ieee',
]);

// ============================================
// PARAM SCHEMAS
// ============================================

export const documentIdParamSchema = {
  params: z.object({
    documentId: z.string().uuid('Invalid document ID format'),
  }),
};

export const violationIdParamSchema = {
  params: z.object({
    violationId: z.string().uuid('Invalid violation ID format'),
  }),
};

export const ruleIdParamSchema = {
  params: z.object({
    ruleId: z.string().uuid('Invalid rule ID format'),
  }),
};

export const jobIdParamSchema = {
  params: z.object({
    jobId: z.string().uuid('Invalid job ID format'),
  }),
};

// ============================================
// BODY SCHEMAS - VALIDATION
// ============================================

/**
 * Start validation request body
 */
export const startValidationSchema = {
  body: z.object({
    documentId: z.string().uuid('Invalid document ID format'),
    ruleSetIds: z
      .array(z.string())
      .optional()
      .transform((val) => (val && val.length > 0 ? val : ['general'])),
    styleGuide: styleGuideTypeEnum.optional(),
    includeHouseRules: z.boolean().default(true),
    useAiValidation: z.boolean().default(true),
  }),
};

/**
 * Get violations query parameters
 */
export const getViolationsQuerySchema = {
  params: z.object({
    documentId: z.string().uuid('Invalid document ID format'),
  }),
  query: z.object({
    category: styleCategoryEnum.optional(),
    severity: styleSeverityEnum.optional(),
    status: violationStatusEnum.optional(),
    ruleId: z.string().optional(),
    styleGuide: styleGuideTypeEnum.optional(),
    search: z.string().max(100).optional(),
    skip: z
      .string()
      .optional()
      .transform((v) => (v ? parseInt(v, 10) : 0)),
    take: z
      .string()
      .optional()
      .transform((v) => (v ? parseInt(v, 10) : 100)),
  }).optional(),
};

/**
 * Apply fix request body
 */
export const applyFixSchema = {
  params: z.object({
    violationId: z.string().uuid('Invalid violation ID format'),
  }),
  body: z.object({
    fixOption: z.string().min(1, 'Fix option is required'),
  }),
};

/**
 * Ignore violation request body
 */
export const ignoreViolationSchema = {
  params: z.object({
    violationId: z.string().uuid('Invalid violation ID format'),
  }),
  body: z.object({
    reason: z.string().max(500, 'Reason too long').optional(),
  }),
};

/**
 * Bulk action request body
 */
export const bulkActionSchema = {
  body: z.object({
    violationIds: z
      .array(z.string().uuid('Invalid violation ID'))
      .min(1, 'At least one violation ID is required')
      .max(100, 'Maximum 100 violations per request'),
    action: z.enum(['fix', 'ignore', 'wont_fix']),
    reason: z.string().max(500).optional(),
  }),
};

// ============================================
// BODY SCHEMAS - HOUSE RULES
// ============================================

/**
 * Create house rule request body
 */
export const createHouseRuleSchema = {
  body: z.object({
    name: z
      .string()
      .min(1, 'Name is required')
      .max(200, 'Name too long'),
    description: z.string().max(1000).optional(),
    category: styleCategoryEnum,
    ruleType: houseRuleTypeEnum,
    pattern: z.string().max(500).optional(),
    preferredTerm: z.string().max(200).optional(),
    avoidTerms: z.array(z.string().max(200)).max(50).optional(),
    severity: styleSeverityEnum.default('WARNING'),
    isActive: z.boolean().default(true),
    baseStyleGuide: styleGuideTypeEnum.optional(),
    overridesRule: z.string().optional(),
  }).refine(
    (data) => {
      // Terminology rules need preferredTerm or avoidTerms
      if (data.ruleType === 'TERMINOLOGY') {
        return data.preferredTerm || (data.avoidTerms && data.avoidTerms.length > 0);
      }
      return true;
    },
    {
      message: 'Terminology rules require either preferredTerm or avoidTerms',
      path: ['ruleType'],
    }
  ).refine(
    (data) => {
      // Pattern rules need a pattern
      if (data.ruleType === 'PATTERN') {
        return !!data.pattern;
      }
      return true;
    },
    {
      message: 'Pattern rules require a pattern',
      path: ['pattern'],
    }
  ),
};

/**
 * Update house rule request body
 */
export const updateHouseRuleSchema = {
  params: z.object({
    ruleId: z.string().uuid('Invalid rule ID format'),
  }),
  body: z.object({
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(1000).optional().nullable(),
    category: styleCategoryEnum.optional(),
    ruleType: houseRuleTypeEnum.optional(),
    pattern: z.string().max(500).optional().nullable(),
    preferredTerm: z.string().max(200).optional().nullable(),
    avoidTerms: z.array(z.string().max(200)).max(50).optional(),
    severity: styleSeverityEnum.optional(),
    isActive: z.boolean().optional(),
    baseStyleGuide: styleGuideTypeEnum.optional().nullable(),
    overridesRule: z.string().optional().nullable(),
  }).refine(
    (data) => Object.values(data).some((v) => v !== undefined),
    { message: 'At least one field must be provided for update' }
  ),
};

/**
 * Get house rules query parameters
 */
export const getHouseRulesQuerySchema = {
  query: z.object({
    category: styleCategoryEnum.optional(),
    ruleType: houseRuleTypeEnum.optional(),
    isActive: z
      .string()
      .optional()
      .transform((v) => {
        if (v === 'true') return true;
        if (v === 'false') return false;
        return undefined;
      }),
    baseStyleGuide: styleGuideTypeEnum.optional(),
    search: z.string().max(100).optional(),
  }).optional(),
};

/**
 * Import rules request body
 */
export const importRulesSchema = {
  body: z.object({
    version: z.string(),
    exportedAt: z.string().optional(),
    tenantId: z.string().optional(), // Ignored - will use authenticated tenant
    rules: z.array(
      z.object({
        name: z.string().min(1).max(200),
        description: z.string().max(1000).optional().nullable(),
        category: styleCategoryEnum,
        ruleType: houseRuleTypeEnum,
        pattern: z.string().max(500).optional().nullable(),
        preferredTerm: z.string().max(200).optional().nullable(),
        avoidTerms: z.array(z.string()).default([]),
        severity: styleSeverityEnum,
        isActive: z.boolean(),
        baseStyleGuide: styleGuideTypeEnum.optional().nullable(),
        overridesRule: z.string().optional().nullable(),
      })
    ),
  }),
};

/**
 * Test rule request body
 */
export const testRuleSchema = {
  body: z.object({
    rule: z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(1000).optional(),
      category: styleCategoryEnum,
      ruleType: houseRuleTypeEnum,
      pattern: z.string().max(500).optional(),
      preferredTerm: z.string().max(200).optional(),
      avoidTerms: z.array(z.string().max(200)).max(50).optional(),
      severity: styleSeverityEnum.default('WARNING'),
    }),
    sampleText: z
      .string()
      .min(1, 'Sample text is required')
      .max(10000, 'Sample text too long'),
  }),
};

// ============================================
// TYPE EXPORTS
// ============================================

export type StyleGuideType = z.infer<typeof styleGuideTypeEnum>;
export type StyleCategory = z.infer<typeof styleCategoryEnum>;
export type StyleSeverity = z.infer<typeof styleSeverityEnum>;
export type ViolationStatus = z.infer<typeof violationStatusEnum>;
export type HouseRuleType = z.infer<typeof houseRuleTypeEnum>;
export type RuleSetId = z.infer<typeof ruleSetIdEnum>;

export type StartValidationBody = z.infer<typeof startValidationSchema.body>;
export type ApplyFixBody = z.infer<typeof applyFixSchema.body>;
export type IgnoreViolationBody = z.infer<typeof ignoreViolationSchema.body>;
export type BulkActionBody = z.infer<typeof bulkActionSchema.body>;

export type CreateHouseRuleBody = z.infer<typeof createHouseRuleSchema.body>;
export type UpdateHouseRuleBody = z.infer<typeof updateHouseRuleSchema.body>;
export type ImportRulesBody = z.infer<typeof importRulesSchema.body>;
export type TestRuleBody = z.infer<typeof testRuleSchema.body>;
