/**
 * Style Guide Upload Controller
 *
 * Handles uploading and extracting rules from PDF/Word style guide documents
 */

import { Response, NextFunction } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { styleGuideExtractor } from '../../services/style/style-guide-extractor.service';
import { houseStyleEngine } from '../../services/style/house-style-engine.service';
import type { AuthenticatedRequest } from '../../types/authenticated-request';
import { logger } from '../../lib/logger';

// Valid category values
const VALID_CATEGORIES = [
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
] as const;

// Valid rule types
const VALID_RULE_TYPES = ['TERMINOLOGY', 'PATTERN', 'CAPITALIZATION', 'PUNCTUATION'] as const;

// Valid severity values
const VALID_SEVERITIES = ['ERROR', 'WARNING', 'SUGGESTION'] as const;

/**
 * Normalize category value - fix typos and map to valid enum
 */
function normalizeCategory(category: string): string {
  if (!category) return 'OTHER';

  const upper = category.toUpperCase().trim();

  // Direct match
  if (VALID_CATEGORIES.includes(upper as typeof VALID_CATEGORIES[number])) {
    return upper;
  }

  // Fix common typos using fuzzy matching
  const typoMap: Record<string, string> = {
    'PUNCTUATOIN': 'PUNCTUATION',
    'PUNTUATION': 'PUNCTUATION',
    'PUNTUACTION': 'PUNCTUATION',
    'CAPITLIZATION': 'CAPITALIZATION',
    'CAPTALIZATION': 'CAPITALIZATION',
    'CAPTIALIZATION': 'CAPITALIZATION',
    'CAPITALISATION': 'CAPITALIZATION',
    'GRAMMER': 'GRAMMAR',
    'GRAMAR': 'GRAMMAR',
    'ABBREVATIONS': 'ABBREVIATIONS',
    'ABREVIATIONS': 'ABBREVIATIONS',
    'ABBR': 'ABBREVIATIONS',
    'HYPENATION': 'HYPHENATION',
    'HYPHANATION': 'HYPHENATION',
    'SPELING': 'SPELLING',
    'SPELLINGS': 'SPELLING',
    'TERMINOLGY': 'TERMINOLOGY',
    'TERMINOLOY': 'TERMINOLOGY',
    'TERMS': 'TERMINOLOGY',
    'FORMATING': 'FORMATTING',
    'FORMAT': 'FORMATTING',
    'CITATION': 'CITATIONS',
    'REFERENCE': 'CITATIONS',
    'REFERENCES': 'CITATIONS',
    'NUMBER': 'NUMBERS',
    'NUMERIC': 'NUMBERS',
    'NUMERALS': 'NUMBERS',
    'STYLE': 'FORMATTING',
    'USAGE': 'GRAMMAR',
    'WORD_CHOICE': 'TERMINOLOGY',
    'WORD CHOICE': 'TERMINOLOGY',
    'WORDCHOICE': 'TERMINOLOGY',
  };

  if (typoMap[upper]) {
    return typoMap[upper];
  }

  // Try to find closest match
  for (const valid of VALID_CATEGORIES) {
    if (upper.includes(valid) || valid.includes(upper)) {
      return valid;
    }
  }

  return 'OTHER';
}

/**
 * Normalize rule type
 */
function normalizeRuleType(ruleType: string): string {
  if (!ruleType) return 'TERMINOLOGY';

  const upper = ruleType.toUpperCase().trim();

  if (VALID_RULE_TYPES.includes(upper as typeof VALID_RULE_TYPES[number])) {
    return upper;
  }

  // Map common variations
  const typeMap: Record<string, string> = {
    'TERM': 'TERMINOLOGY',
    'TERMS': 'TERMINOLOGY',
    'REGEX': 'PATTERN',
    'REGEXP': 'PATTERN',
    'CAPS': 'CAPITALIZATION',
    'CAPITAL': 'CAPITALIZATION',
    'PUNCT': 'PUNCTUATION',
  };

  return typeMap[upper] || 'TERMINOLOGY';
}

/**
 * Normalize severity
 */
function normalizeSeverity(severity: string): string {
  if (!severity) return 'WARNING';

  const upper = severity.toUpperCase().trim();

  if (VALID_SEVERITIES.includes(upper as typeof VALID_SEVERITIES[number])) {
    return upper;
  }

  // Map common variations
  const severityMap: Record<string, string> = {
    'HIGH': 'ERROR',
    'CRITICAL': 'ERROR',
    'MEDIUM': 'WARNING',
    'WARN': 'WARNING',
    'LOW': 'SUGGESTION',
    'INFO': 'SUGGESTION',
    'HINT': 'SUGGESTION',
  };

  return severityMap[upper] || 'WARNING';
}

export class StyleGuideUploadController {
  /**
   * Upload and extract rules from a style guide document
   * POST /api/v1/style/upload-guide
   */
  async uploadStyleGuide(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const userId = req.user?.id;

      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      // Check if file was uploaded
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_FILE', message: 'No file uploaded' },
        });
      }

      const file = req.file;
      const ext = path.extname(file.originalname).toLowerCase();

      // Validate file type
      if (!['.pdf', '.docx', '.doc'].includes(ext)) {
        // Clean up uploaded file
        try {
          await fs.promises.unlink(file.path);
        } catch {
          // Ignore cleanup errors
        }
        return res.status(400).json({
          success: false,
          error: { code: 'INVALID_FILE_TYPE', message: 'Only PDF and Word documents are supported' },
        });
      }

      const fileType = ext === '.pdf' ? 'pdf' : 'docx';

      let extractionResult;
      try {
        // Extract rules from document
        extractionResult = await styleGuideExtractor.extractFromDocument(
          file.path,
          file.originalname,
          fileType
        );
      } finally {
        // Always clean up uploaded file
        try {
          await fs.promises.unlink(file.path);
        } catch {
          // Ignore cleanup errors
        }
      }

      if (!extractionResult.success) {
        return res.status(422).json({
          success: false,
          error: {
            code: 'EXTRACTION_FAILED',
            message: 'Failed to extract rules from document',
            details: extractionResult.warnings,
          },
        });
      }

      return res.status(200).json({
        success: true,
        data: {
          documentTitle: extractionResult.documentTitle,
          totalRulesExtracted: extractionResult.totalRulesExtracted,
          rules: extractionResult.rules,
          categories: extractionResult.categories,
          processingTimeMs: extractionResult.processingTimeMs,
          warnings: extractionResult.warnings,
          sourceDocument: extractionResult.sourceDocument,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Save extracted rules to a new rule set
   * POST /api/v1/style/save-extracted-rules
   */
  async saveExtractedRules(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const userId = req.user?.id;

      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const { rules, sourceDocumentName, ruleSetName, ruleSetDescription, baseStyleGuide } = req.body;

      if (!rules || !Array.isArray(rules) || rules.length === 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_RULES', message: 'No rules provided' },
        });
      }

      // Use provided name or generate from source document
      const finalRuleSetName = ruleSetName || sourceDocumentName || `Imported Rules ${new Date().toISOString().split('T')[0]}`;

      // Normalize baseStyleGuide: strip empty strings
      const validBaseStyleGuide = baseStyleGuide && baseStyleGuide.trim() !== '' ? baseStyleGuide : undefined;

      logger.info(`[Style Upload] Creating rule set "${finalRuleSetName}" with ${rules.length} rules`);

      // Create a new rule set for the extracted rules
      let ruleSet;
      try {
        ruleSet = await houseStyleEngine.createRuleSet(tenantId, userId, {
          name: finalRuleSetName,
          description: ruleSetDescription || `Rules extracted from ${sourceDocumentName || 'uploaded document'}`,
          baseStyleGuide: validBaseStyleGuide,
          isDefault: false,
          source: 'uploaded',
          sourceFile: sourceDocumentName,
        });
      } catch (error) {
        logger.error(`[Style Upload] Failed to create rule set: ${error}`);
        return res.status(400).json({
          success: false,
          error: {
            code: 'RULE_SET_CREATE_FAILED',
            message: error instanceof Error ? error.message : 'Failed to create rule set',
          },
        });
      }

      const errors: Array<{ ruleName: string; error: string }> = [];

      // Convert rules to RulesExport format for batch import (avoids N+1 queries)
      const rulesExport = {
        version: '1.0',
        exportedAt: new Date().toISOString(),
        tenantId,
        rules: rules.map((rule: { name: string; description?: string; category: string; ruleType: string; pattern?: string; preferredTerm?: string; avoidTerms?: string[]; severity: string }) => {
          // Normalize category, ruleType, and severity to handle typos
          const normalizedCategory = normalizeCategory(rule.category);
          const normalizedRuleType = normalizeRuleType(rule.ruleType);
          const normalizedSeverity = normalizeSeverity(rule.severity);

          logger.debug(`[Style Upload] Normalizing rule "${rule.name}": category ${rule.category} -> ${normalizedCategory}`);

          return {
            name: rule.name,
            description: rule.description || `Extracted from ${sourceDocumentName || 'uploaded document'}`,
            category: normalizedCategory as 'PUNCTUATION' | 'CAPITALIZATION' | 'NUMBERS' | 'ABBREVIATIONS' | 'HYPHENATION' | 'SPELLING' | 'GRAMMAR' | 'TERMINOLOGY' | 'FORMATTING' | 'CITATIONS' | 'OTHER',
            ruleType: normalizedRuleType as 'TERMINOLOGY' | 'PATTERN' | 'CAPITALIZATION' | 'PUNCTUATION',
            pattern: rule.pattern || null,
            preferredTerm: rule.preferredTerm || null,
            avoidTerms: rule.avoidTerms || [],
            severity: normalizedSeverity as 'ERROR' | 'WARNING' | 'SUGGESTION',
            isActive: true,
            baseStyleGuide: null,
            overridesRule: null,
          };
        }),
      };

      // Use batch import to avoid N+1 queries
      const importResult = await houseStyleEngine.importRulesToSet(
        tenantId,
        userId,
        ruleSet.id,
        rulesExport
      );

      // Convert import errors to expected format
      for (const error of importResult.errors) {
        errors.push({
          ruleName: error.replace(/^Rule \d+: "([^"]+)".*$/, '$1'),
          error: error,
        });
      }

      logger.info(`[Style Upload] Saved ${importResult.imported} rules to set "${finalRuleSetName}", ${errors.length} errors`);

      return res.status(200).json({
        success: true,
        data: {
          ruleSet: {
            id: ruleSet.id,
            name: ruleSet.name,
            description: ruleSet.description,
          },
          savedCount: importResult.imported,
          errorCount: errors.length,
          errors,
        },
      });
    } catch (error) {
      logger.error(`[Style Upload] Unexpected error saving rules: ${error}`);
      next(error);
    }
  }

  /**
   * Get editorial best practices (default rules)
   * GET /api/v1/style/best-practices
   */
  async getBestPractices(_req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const bestPractices = styleGuideExtractor.getEditorialBestPractices();

      return res.status(200).json({
        success: true,
        data: {
          rules: bestPractices,
          totalRules: bestPractices.length,
          categories: bestPractices.reduce((acc, rule) => {
            acc[rule.category] = (acc[rule.category] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Import best practices as house rules
   * POST /api/v1/style/import-best-practices
   */
  async importBestPractices(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const userId = req.user?.id;

      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const { ruleNames } = req.body; // Optional: specific rules to import
      const bestPractices = styleGuideExtractor.getEditorialBestPractices();

      // Filter rules if specific names provided
      const rulesToImport = ruleNames && ruleNames.length > 0
        ? bestPractices.filter(r => ruleNames.includes(r.name))
        : bestPractices;

      const savedRules = [];
      const errors = [];

      for (const rule of rulesToImport) {
        try {
          const savedRule = await houseStyleEngine.createRule(tenantId, userId, {
            name: rule.name,
            description: rule.description,
            category: rule.category,
            ruleType: rule.ruleType,
            pattern: rule.pattern,
            preferredTerm: rule.preferredTerm,
            avoidTerms: rule.avoidTerms || [],
            severity: rule.severity,
            isActive: true,
          });
          savedRules.push(savedRule);
        } catch (error) {
          errors.push({
            ruleName: rule.name,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      return res.status(200).json({
        success: true,
        data: {
          importedCount: savedRules.length,
          errorCount: errors.length,
          savedRules,
          errors,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const styleGuideUploadController = new StyleGuideUploadController();
