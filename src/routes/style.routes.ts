/**
 * Style Validation Routes
 *
 * API routes for style validation and house rules management
 */

import { Router } from 'express';
import multer from 'multer';
import * as path from 'path';
import * as os from 'os';
import { styleController, houseRulesController } from '../controllers/style';
import { styleGuideUploadController } from '../controllers/style/style-guide-upload.controller';
import { authenticate } from '../middleware/auth.middleware';
import { validate } from '../middleware/validate.middleware';
import {
  startValidationSchema,
  getViolationsQuerySchema,
  applyFixSchema,
  ignoreViolationSchema,
  bulkActionSchema,
  createHouseRuleSchema,
  updateHouseRuleSchema,
  getHouseRulesQuerySchema,
  importRulesSchema,
  testRuleSchema,
  createRuleSetSchema,
  updateRuleSetSchema,
  jobIdParamSchema,
  documentIdParamSchema,
  ruleSetIdParamSchema,
  testRulesDebugSchema,
} from '../schemas/style.schemas';
import { rateLimiters } from '../middleware/rate-limit.middleware';

const router = Router();

// Configure multer for file uploads
const ALLOWED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/msword',
];
const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.doc'];

const upload = multer({
  dest: path.join(os.tmpdir(), 'style-guide-uploads'),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB max
  },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    const isValidExt = ALLOWED_EXTENSIONS.includes(ext);
    const isValidMime = ALLOWED_MIME_TYPES.includes(file.mimetype);

    if (isValidExt && isValidMime) {
      cb(null, true);
    } else {
      cb(new Error('Only PDF and Word documents are allowed'));
    }
  },
});

// All routes require authentication
router.use(authenticate);

// ============================================
// VALIDATION ROUTES
// ============================================

/**
 * Start a style validation job
 * POST /api/v1/style/validate
 */
router.post(
  '/validate',
  rateLimiters.styleValidation,
  validate(startValidationSchema),
  (req, res, next) => styleController.startValidation(req, res, next)
);

/**
 * Get validation job status
 * GET /api/v1/style/job/:jobId
 */
router.get(
  '/job/:jobId',
  validate(jobIdParamSchema),
  (req, res, next) => styleController.getJobStatus(req, res, next)
);

/**
 * Get violations for a document
 * GET /api/v1/style/document/:documentId
 */
router.get(
  '/document/:documentId',
  validate(getViolationsQuerySchema),
  (req, res, next) => styleController.getViolations(req, res, next)
);

/**
 * Get validation summary for a document
 * GET /api/v1/style/document/:documentId/summary
 */
router.get(
  '/document/:documentId/summary',
  validate(documentIdParamSchema),
  (req, res, next) => styleController.getValidationSummary(req, res, next)
);

/**
 * Apply fix to a violation
 * POST /api/v1/style/violation/:violationId/fix
 */
router.post(
  '/violation/:violationId/fix',
  validate(applyFixSchema),
  (req, res, next) => styleController.applyFix(req, res, next)
);

/**
 * Ignore a violation
 * POST /api/v1/style/violation/:violationId/ignore
 */
router.post(
  '/violation/:violationId/ignore',
  validate(ignoreViolationSchema),
  (req, res, next) => styleController.ignoreViolation(req, res, next)
);

/**
 * Bulk fix/ignore violations
 * POST /api/v1/style/violations/bulk
 */
router.post(
  '/violations/bulk',
  validate(bulkActionSchema),
  (req, res, next) => styleController.bulkAction(req, res, next)
);

// Note: GET /rule-sets is handled by houseRulesController.listRuleSets below
// which returns both built-in and custom rule sets

/**
 * Get rules in a built-in rule set
 * GET /api/v1/style/rule-sets/:ruleSetId/built-in
 */
router.get(
  '/rule-sets/:ruleSetId/built-in',
  validate(ruleSetIdParamSchema),
  (req, res, next) => styleController.getRuleSetRules(req, res, next)
);

/**
 * Debug: Test rules against sample text
 * POST /api/v1/style/debug/test-rules
 */
router.post(
  '/debug/test-rules',
  validate(testRulesDebugSchema),
  (req, res, next) => styleController.testRulesDebug(req, res, next)
);

// ============================================
// STYLE GUIDE UPLOAD ROUTES
// ============================================

/**
 * Upload a style guide document and extract rules
 * POST /api/v1/style/upload-guide
 */
router.post(
  '/upload-guide',
  rateLimiters.styleGuideUpload,
  upload.single('file'),
  (req, res, next) => styleGuideUploadController.uploadStyleGuide(req, res, next)
);

/**
 * Save extracted rules as house rules
 * POST /api/v1/style/save-extracted-rules
 */
router.post(
  '/save-extracted-rules',
  (req, res, next) => styleGuideUploadController.saveExtractedRules(req, res, next)
);

/**
 * Get editorial best practices (default rules)
 * GET /api/v1/style/best-practices
 */
router.get(
  '/best-practices',
  (req, res, next) => styleGuideUploadController.getBestPractices(req, res, next)
);

/**
 * Import best practices as house rules
 * POST /api/v1/style/import-best-practices
 */
router.post(
  '/import-best-practices',
  (req, res, next) => styleGuideUploadController.importBestPractices(req, res, next)
);

// ============================================
// RULE SET ROUTES (Custom Rule Collections)
// ============================================

/**
 * Create a new rule set
 * POST /api/v1/style/rule-sets
 */
router.post(
  '/rule-sets',
  validate(createRuleSetSchema),
  (req, res, next) => houseRulesController.createRuleSet(req, res, next)
);

/**
 * List all rule sets
 * GET /api/v1/style/rule-sets
 */
router.get(
  '/rule-sets',
  (req, res, next) => houseRulesController.listRuleSets(req, res, next)
);

/**
 * Get a single rule set with its rules
 * GET /api/v1/style/rule-sets/:ruleSetId
 */
router.get(
  '/rule-sets/:ruleSetId',
  (req, res, next) => houseRulesController.getRuleSet(req, res, next)
);

/**
 * Update a rule set
 * PUT /api/v1/style/rule-sets/:ruleSetId
 */
router.put(
  '/rule-sets/:ruleSetId',
  validate(updateRuleSetSchema),
  (req, res, next) => houseRulesController.updateRuleSet(req, res, next)
);

/**
 * Delete a rule set
 * DELETE /api/v1/style/rule-sets/:ruleSetId
 */
router.delete(
  '/rule-sets/:ruleSetId',
  (req, res, next) => houseRulesController.deleteRuleSet(req, res, next)
);

/**
 * Add a rule to a rule set
 * POST /api/v1/style/rule-sets/:ruleSetId/rules
 */
router.post(
  '/rule-sets/:ruleSetId/rules',
  validate(createHouseRuleSchema),
  (req, res, next) => houseRulesController.addRuleToSet(req, res, next)
);

/**
 * Import rules to a rule set
 * POST /api/v1/style/rule-sets/:ruleSetId/import
 */
router.post(
  '/rule-sets/:ruleSetId/import',
  validate(importRulesSchema),
  (req, res, next) => houseRulesController.importRulesToSet(req, res, next)
);

// ============================================
// HOUSE RULES ROUTES (Standalone rules for backward compat)
// ============================================

/**
 * Create a house rule
 * POST /api/v1/style/house-rules
 */
router.post(
  '/house-rules',
  validate(createHouseRuleSchema),
  (req, res, next) => houseRulesController.createRule(req, res, next)
);

/**
 * List house rules
 * GET /api/v1/style/house-rules
 */
router.get(
  '/house-rules',
  validate(getHouseRulesQuerySchema),
  (req, res, next) => houseRulesController.listRules(req, res, next)
);

/**
 * Export house rules
 * GET /api/v1/style/house-rules/export
 */
router.get(
  '/house-rules/export',
  (req, res, next) => houseRulesController.exportRules(req, res, next)
);

/**
 * Import house rules
 * POST /api/v1/style/house-rules/import
 */
router.post(
  '/house-rules/import',
  validate(importRulesSchema),
  (req, res, next) => houseRulesController.importRules(req, res, next)
);

/**
 * Test a house rule
 * POST /api/v1/style/house-rules/test
 */
router.post(
  '/house-rules/test',
  validate(testRuleSchema),
  (req, res, next) => houseRulesController.testRule(req, res, next)
);

/**
 * Get a single house rule
 * GET /api/v1/style/house-rules/:ruleId
 */
router.get(
  '/house-rules/:ruleId',
  (req, res, next) => houseRulesController.getRule(req, res, next)
);

/**
 * Update a house rule
 * PUT /api/v1/style/house-rules/:ruleId
 */
router.put(
  '/house-rules/:ruleId',
  validate(updateHouseRuleSchema),
  (req, res, next) => houseRulesController.updateRule(req, res, next)
);

/**
 * Delete a house rule
 * DELETE /api/v1/style/house-rules/:ruleId
 */
router.delete(
  '/house-rules/:ruleId',
  (req, res, next) => houseRulesController.deleteRule(req, res, next)
);

export default router;
