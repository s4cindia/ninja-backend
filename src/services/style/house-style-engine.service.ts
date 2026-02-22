/**
 * House Style Engine Service
 *
 * Manages custom house style rules for tenants:
 * - CRUD operations for custom rules
 * - Import/export rules as JSON
 * - Test rules against sample text
 */

import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { AppError } from '../../utils/app-error';
import safeRegex from 'safe-regex2';
import type {
  HouseStyleRule,
  HouseRuleSet,
  StyleCategory,
  StyleSeverity,
  StyleGuideType,
  HouseRuleType,
} from '@prisma/client';
import type { RuleMatch } from './style-rules-registry.service';

// Rule Set types
export interface CreateRuleSetInput {
  name: string;
  description?: string;
  baseStyleGuide?: StyleGuideType;
  source?: string;
  sourceFile?: string;
  isDefault?: boolean;
}

export interface UpdateRuleSetInput {
  name?: string;
  description?: string;
  baseStyleGuide?: StyleGuideType;
  isActive?: boolean;
  isDefault?: boolean;
}

export interface RuleSetWithRules extends HouseRuleSet {
  rules: HouseStyleRule[];
  _count?: { rules: number };
}

export interface CreateHouseRuleInput {
  name: string;
  description?: string;
  category: StyleCategory;
  ruleType: HouseRuleType;
  pattern?: string;
  preferredTerm?: string;
  avoidTerms?: string[];
  severity?: StyleSeverity;
  isActive?: boolean;
  baseStyleGuide?: StyleGuideType;
  overridesRule?: string;
}

export interface UpdateHouseRuleInput {
  name?: string;
  description?: string;
  category?: StyleCategory;
  ruleType?: HouseRuleType;
  pattern?: string;
  preferredTerm?: string;
  avoidTerms?: string[];
  severity?: StyleSeverity;
  isActive?: boolean;
  baseStyleGuide?: StyleGuideType;
  overridesRule?: string;
}

export interface HouseRuleFilters {
  category?: StyleCategory;
  ruleType?: HouseRuleType;
  isActive?: boolean;
  baseStyleGuide?: StyleGuideType;
  search?: string;
}

export interface ExportedRule {
  name: string;
  description?: string | null;
  category: StyleCategory;
  ruleType: HouseRuleType;
  pattern?: string | null;
  preferredTerm?: string | null;
  avoidTerms: string[];
  severity: StyleSeverity;
  isActive: boolean;
  baseStyleGuide?: StyleGuideType | null;
  overridesRule?: string | null;
}

export interface RulesExport {
  version: string;
  exportedAt: string;
  tenantId: string;
  rules: ExportedRule[];
}

export interface ImportResult {
  imported: number;
  skipped: number;
  errors: string[];
}

export interface TestResult {
  matches: RuleMatch[];
  executionTimeMs: number;
  patternValid: boolean;
  error?: string;
}

export class HouseStyleEngineService {
  // ============================================
  // RULE SET MANAGEMENT
  // ============================================

  async createRuleSet(
    tenantId: string,
    userId: string,
    input: CreateRuleSetInput
  ): Promise<HouseRuleSet> {
    // Check if name already exists
    const existing = await prisma.houseRuleSet.findFirst({
      where: { tenantId, name: input.name },
    });

    if (existing) {
      throw AppError.badRequest(
        `Rule set with name "${input.name}" already exists`,
        'DUPLICATE_NAME'
      );
    }

    // Use transaction to ensure atomic default flag update
    const ruleSet = await prisma.$transaction(async (tx) => {
      // If setting as default, unset any existing default first
      if (input.isDefault) {
        await tx.houseRuleSet.updateMany({
          where: { tenantId, isDefault: true },
          data: { isDefault: false },
        });
      }

      return tx.houseRuleSet.create({
        data: {
          tenantId,
          name: input.name,
          description: input.description || null,
          baseStyleGuide: input.baseStyleGuide || null,
          source: input.source || 'manual',
          sourceFile: input.sourceFile || null,
          isDefault: input.isDefault ?? false,
          createdBy: userId,
        },
      });
    });

    logger.info(`[House Style] Created rule set ${ruleSet.id} for tenant ${tenantId}`);
    return ruleSet;
  }

  async updateRuleSet(
    ruleSetId: string,
    tenantId: string,
    input: UpdateRuleSetInput
  ): Promise<HouseRuleSet> {
    const existing = await prisma.houseRuleSet.findFirst({
      where: { id: ruleSetId, tenantId },
    });

    if (!existing) {
      throw AppError.notFound('Rule set not found', 'RULE_SET_NOT_FOUND');
    }

    // If changing name, check for duplicates
    if (input.name && input.name !== existing.name) {
      const duplicate = await prisma.houseRuleSet.findFirst({
        where: { tenantId, name: input.name },
      });
      if (duplicate) {
        throw AppError.badRequest(
          `Rule set with name "${input.name}" already exists`,
          'DUPLICATE_NAME'
        );
      }
    }

    // Use transaction to ensure atomic default flag update
    const updated = await prisma.$transaction(async (tx) => {
      // If setting as default, unset any existing default first
      if (input.isDefault === true) {
        await tx.houseRuleSet.updateMany({
          where: { tenantId, isDefault: true, id: { not: ruleSetId } },
          data: { isDefault: false },
        });
      }

      return tx.houseRuleSet.update({
        where: { id: ruleSetId },
        data: {
          ...(input.name !== undefined && { name: input.name }),
          ...(input.description !== undefined && { description: input.description }),
          ...(input.baseStyleGuide !== undefined && { baseStyleGuide: input.baseStyleGuide }),
          ...(input.isActive !== undefined && { isActive: input.isActive }),
          ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
        },
      });
    });

    logger.info(`[House Style] Updated rule set ${ruleSetId}`);
    return updated;
  }

  async deleteRuleSet(ruleSetId: string, tenantId: string): Promise<void> {
    const existing = await prisma.houseRuleSet.findFirst({
      where: { id: ruleSetId, tenantId },
    });

    if (!existing) {
      throw AppError.notFound('Rule set not found', 'RULE_SET_NOT_FOUND');
    }

    // Cascade delete will remove associated rules
    await prisma.houseRuleSet.delete({
      where: { id: ruleSetId },
    });

    logger.info(`[House Style] Deleted rule set ${ruleSetId}`);
  }

  async getRuleSet(ruleSetId: string, tenantId: string): Promise<RuleSetWithRules | null> {
    return prisma.houseRuleSet.findFirst({
      where: { id: ruleSetId, tenantId },
      include: {
        rules: {
          orderBy: [{ category: 'asc' }, { name: 'asc' }],
        },
        _count: { select: { rules: true } },
      },
    });
  }

  async getRuleSets(
    tenantId: string,
    options?: {
      includeRules?: boolean;
      activeOnly?: boolean;
      page?: number;
      pageSize?: number;
    }
  ): Promise<{ ruleSets: RuleSetWithRules[]; total: number; page: number; pageSize: number }> {
    const where: Record<string, unknown> = { tenantId };
    const page = options?.page || 1;
    const pageSize = Math.min(options?.pageSize || 50, 100); // Max 100 per page

    if (options?.activeOnly) {
      where.isActive = true;
    }

    const [ruleSets, total] = await Promise.all([
      prisma.houseRuleSet.findMany({
        where,
        include: {
          rules: options?.includeRules ? {
            orderBy: [{ category: 'asc' }, { name: 'asc' }],
          } : false,
          _count: { select: { rules: true } },
        },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.houseRuleSet.count({ where }),
    ]);

    return {
      ruleSets: ruleSets as RuleSetWithRules[],
      total,
      page,
      pageSize,
    };
  }

  async importRulesToSet(
    tenantId: string,
    userId: string,
    ruleSetId: string,
    rulesJson: RulesExport
  ): Promise<ImportResult> {
    // Verify rule set exists
    const ruleSet = await prisma.houseRuleSet.findFirst({
      where: { id: ruleSetId, tenantId },
    });

    if (!ruleSet) {
      throw AppError.notFound('Rule set not found', 'RULE_SET_NOT_FOUND');
    }

    const result: ImportResult = {
      imported: 0,
      skipped: 0,
      errors: [],
    };

    if (!rulesJson.rules || !Array.isArray(rulesJson.rules)) {
      throw AppError.badRequest('Invalid import format: rules array required', 'INVALID_IMPORT');
    }

    // Batch fetch existing rule names to avoid N+1 queries
    const ruleNames = rulesJson.rules.map(r => r.name);
    const existingRules = await prisma.houseStyleRule.findMany({
      where: {
        tenantId,
        ruleSetId,
        name: { in: ruleNames },
      },
      select: { name: true },
    });
    const existingNames = new Set(existingRules.map(r => r.name));

    // Prepare rules for batch insert
    const rulesToCreate: Array<{
      tenantId: string;
      ruleSetId: string;
      name: string;
      description: string | null;
      category: typeof rulesJson.rules[0]['category'];
      ruleType: typeof rulesJson.rules[0]['ruleType'];
      pattern: string | null;
      preferredTerm: string | null;
      avoidTerms: string[];
      severity: typeof rulesJson.rules[0]['severity'];
      isActive: boolean;
      baseStyleGuide: typeof rulesJson.rules[0]['baseStyleGuide'] | null;
      overridesRule: string | null;
      createdBy: string;
    }> = [];

    for (let i = 0; i < rulesJson.rules.length; i++) {
      const rule = rulesJson.rules[i];

      // Check for duplicate in existing names
      if (existingNames.has(rule.name)) {
        result.skipped++;
        result.errors.push(`Rule ${i + 1}: "${rule.name}" already exists in this set - skipped`);
        continue;
      }

      // Validate pattern if provided (ReDoS protection)
      if (rule.pattern) {
        try {
          new RegExp(rule.pattern);
          if (this.isUnsafeRegex(rule.pattern)) {
            result.errors.push(`Rule ${i + 1}: "${rule.name}" has unsafe regex pattern - skipped`);
            result.skipped++;
            continue;
          }
        } catch {
          result.errors.push(`Rule ${i + 1}: "${rule.name}" has invalid regex pattern - skipped`);
          result.skipped++;
          continue;
        }
      }

      rulesToCreate.push({
        tenantId,
        ruleSetId,
        name: rule.name,
        description: rule.description ?? null,
        category: rule.category,
        ruleType: rule.ruleType,
        pattern: rule.pattern ?? null,
        preferredTerm: rule.preferredTerm ?? null,
        avoidTerms: rule.avoidTerms || [],
        severity: rule.severity,
        isActive: rule.isActive,
        baseStyleGuide: rule.baseStyleGuide ?? null,
        overridesRule: rule.overridesRule ?? null,
        createdBy: userId,
      });
    }

    // Batch insert all valid rules
    if (rulesToCreate.length > 0) {
      await prisma.houseStyleRule.createMany({ data: rulesToCreate });
      result.imported = rulesToCreate.length;
    }

    logger.info(
      `[House Style] Imported ${result.imported} rules to set ${ruleSetId}, skipped ${result.skipped}`
    );

    return result;
  }

  async createRuleInSet(
    tenantId: string,
    userId: string,
    ruleSetId: string,
    input: CreateHouseRuleInput
  ): Promise<HouseStyleRule> {
    // Validate rule set exists
    const ruleSet = await prisma.houseRuleSet.findFirst({
      where: { id: ruleSetId, tenantId },
    });

    if (!ruleSet) {
      throw AppError.notFound('Rule set not found', 'RULE_SET_NOT_FOUND');
    }

    // Validate pattern if provided
    if (input.pattern) {
      try {
        new RegExp(input.pattern);
      } catch (error) {
        throw AppError.badRequest(
          `Invalid regex pattern: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'INVALID_PATTERN'
        );
      }

      // ReDoS protection: Check for potentially catastrophic patterns
      if (this.isUnsafeRegex(input.pattern)) {
        throw AppError.badRequest(
          'Pattern contains potentially catastrophic backtracking. Avoid nested quantifiers like (a+)+ or (.*)+',
          'UNSAFE_PATTERN'
        );
      }
    }

    // Validate terminology rule has required fields
    if (input.ruleType === 'TERMINOLOGY') {
      if (!input.preferredTerm && (!input.avoidTerms || input.avoidTerms.length === 0)) {
        throw AppError.badRequest(
          'Terminology rules require either preferredTerm or avoidTerms',
          'MISSING_TERMINOLOGY_FIELDS'
        );
      }
    }

    // Validate pattern rule has pattern
    if (input.ruleType === 'PATTERN' && !input.pattern) {
      throw AppError.badRequest(
        'Pattern rules require a regex pattern',
        'MISSING_PATTERN'
      );
    }

    const rule = await prisma.houseStyleRule.create({
      data: {
        tenantId,
        ruleSetId,
        name: input.name,
        description: input.description || null,
        category: input.category,
        ruleType: input.ruleType,
        pattern: input.pattern || null,
        preferredTerm: input.preferredTerm || null,
        avoidTerms: input.avoidTerms || [],
        severity: input.severity || 'WARNING',
        isActive: input.isActive ?? true,
        baseStyleGuide: input.baseStyleGuide || null,
        overridesRule: input.overridesRule || null,
        createdBy: userId,
      },
    });

    logger.info(`[House Style] Created rule ${rule.id} in set ${ruleSetId}`);
    return rule;
  }

  async getRulesInSet(ruleSetId: string, tenantId: string): Promise<HouseStyleRule[]> {
    return prisma.houseStyleRule.findMany({
      where: { ruleSetId, tenantId },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
  }

  // ============================================
  // STANDALONE RULE MANAGEMENT (backward compat)
  // ============================================

  async createRule(
    tenantId: string,
    userId: string,
    input: CreateHouseRuleInput
  ): Promise<HouseStyleRule> {
    // Validate pattern if provided
    if (input.pattern) {
      try {
        new RegExp(input.pattern);
      } catch (error) {
        throw AppError.badRequest(
          `Invalid regex pattern: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'INVALID_PATTERN'
        );
      }

      // ReDoS protection
      if (this.isUnsafeRegex(input.pattern)) {
        throw AppError.badRequest(
          'Pattern contains potentially catastrophic backtracking. Avoid nested quantifiers like (a+)+ or (.*)+',
          'UNSAFE_PATTERN'
        );
      }
    }

    // Validate terminology rule has required fields
    if (input.ruleType === 'TERMINOLOGY') {
      if (!input.preferredTerm && (!input.avoidTerms || input.avoidTerms.length === 0)) {
        throw AppError.badRequest(
          'Terminology rules require either preferredTerm or avoidTerms',
          'MISSING_TERMINOLOGY_FIELDS'
        );
      }
    }

    // Validate pattern rule has pattern
    if (input.ruleType === 'PATTERN' && !input.pattern) {
      throw AppError.badRequest(
        'Pattern rules require a regex pattern',
        'MISSING_PATTERN'
      );
    }

    const rule = await prisma.houseStyleRule.create({
      data: {
        tenantId,
        name: input.name,
        description: input.description || null,
        category: input.category,
        ruleType: input.ruleType,
        pattern: input.pattern || null,
        preferredTerm: input.preferredTerm || null,
        avoidTerms: input.avoidTerms || [],
        severity: input.severity || 'WARNING',
        isActive: input.isActive ?? true,
        baseStyleGuide: input.baseStyleGuide || null,
        overridesRule: input.overridesRule || null,
        createdBy: userId,
      },
    });

    logger.info(`[House Style] Created rule ${rule.id} for tenant ${tenantId}`);
    return rule;
  }

  async updateRule(
    ruleId: string,
    tenantId: string,
    input: UpdateHouseRuleInput
  ): Promise<HouseStyleRule> {
    // Verify rule exists and belongs to tenant
    const existing = await prisma.houseStyleRule.findFirst({
      where: { id: ruleId, tenantId },
    });

    if (!existing) {
      throw AppError.notFound('House style rule not found', 'RULE_NOT_FOUND');
    }

    // Validate pattern if being updated
    if (input.pattern !== undefined && input.pattern) {
      try {
        new RegExp(input.pattern);
      } catch (error) {
        throw AppError.badRequest(
          `Invalid regex pattern: ${error instanceof Error ? error.message : 'Unknown error'}`,
          'INVALID_PATTERN'
        );
      }

      // ReDoS protection
      if (this.isUnsafeRegex(input.pattern)) {
        throw AppError.badRequest(
          'Pattern contains potentially catastrophic backtracking. Avoid nested quantifiers like (a+)+ or (.*)+',
          'UNSAFE_PATTERN'
        );
      }
    }

    const updated = await prisma.houseStyleRule.update({
      where: { id: ruleId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.category !== undefined && { category: input.category }),
        ...(input.ruleType !== undefined && { ruleType: input.ruleType }),
        ...(input.pattern !== undefined && { pattern: input.pattern }),
        ...(input.preferredTerm !== undefined && { preferredTerm: input.preferredTerm }),
        ...(input.avoidTerms !== undefined && { avoidTerms: input.avoidTerms }),
        ...(input.severity !== undefined && { severity: input.severity }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.baseStyleGuide !== undefined && { baseStyleGuide: input.baseStyleGuide }),
        ...(input.overridesRule !== undefined && { overridesRule: input.overridesRule }),
      },
    });

    logger.info(`[House Style] Updated rule ${ruleId}`);
    return updated;
  }

  async deleteRule(ruleId: string, tenantId: string): Promise<void> {
    // Verify rule exists and belongs to tenant
    const existing = await prisma.houseStyleRule.findFirst({
      where: { id: ruleId, tenantId },
    });

    if (!existing) {
      throw AppError.notFound('House style rule not found', 'RULE_NOT_FOUND');
    }

    await prisma.houseStyleRule.delete({
      where: { id: ruleId },
    });

    logger.info(`[House Style] Deleted rule ${ruleId}`);
  }

  async getRule(ruleId: string, tenantId: string): Promise<HouseStyleRule | null> {
    return prisma.houseStyleRule.findFirst({
      where: { id: ruleId, tenantId },
    });
  }

  async getRules(
    tenantId: string,
    filters?: HouseRuleFilters
  ): Promise<HouseStyleRule[]> {
    const where: Record<string, unknown> = { tenantId };

    if (filters?.category) {
      where.category = filters.category;
    }

    if (filters?.ruleType) {
      where.ruleType = filters.ruleType;
    }

    if (filters?.isActive !== undefined) {
      where.isActive = filters.isActive;
    }

    if (filters?.baseStyleGuide) {
      where.baseStyleGuide = filters.baseStyleGuide;
    }

    if (filters?.search) {
      where.OR = [
        { name: { contains: filters.search, mode: 'insensitive' } },
        { description: { contains: filters.search, mode: 'insensitive' } },
        { preferredTerm: { contains: filters.search, mode: 'insensitive' } },
      ];
    }

    return prisma.houseStyleRule.findMany({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: where as any,
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });
  }

  async getActiveRules(tenantId: string): Promise<HouseStyleRule[]> {
    return this.getRules(tenantId, { isActive: true });
  }

  /**
   * Get rules from specific rule sets by their IDs
   */
  async getRulesFromSets(tenantId: string, ruleSetIds: string[]): Promise<HouseStyleRule[]> {
    if (!ruleSetIds || ruleSetIds.length === 0) {
      return [];
    }

    const rules = await prisma.houseStyleRule.findMany({
      where: {
        tenantId,
        isActive: true,
        ruleSetId: { in: ruleSetIds },
      },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
    });

    logger.debug(`[House Style] Retrieved ${rules.length} rules from ${ruleSetIds.length} rule sets`);
    return rules;
  }

  async importRules(
    tenantId: string,
    userId: string,
    rulesJson: RulesExport
  ): Promise<ImportResult> {
    const result: ImportResult = {
      imported: 0,
      skipped: 0,
      errors: [],
    };

    if (!rulesJson.rules || !Array.isArray(rulesJson.rules)) {
      throw AppError.badRequest('Invalid import format: rules array required', 'INVALID_IMPORT');
    }

    // Batch fetch existing rule names to avoid N+1 queries
    const ruleNames = rulesJson.rules.map(r => r.name);
    const existingRules = await prisma.houseStyleRule.findMany({
      where: {
        tenantId,
        name: { in: ruleNames },
      },
      select: { name: true },
    });
    const existingNames = new Set(existingRules.map(r => r.name));

    // Prepare rules for batch insert
    const rulesToCreate: Array<{
      tenantId: string;
      name: string;
      description: string | null;
      category: typeof rulesJson.rules[0]['category'];
      ruleType: typeof rulesJson.rules[0]['ruleType'];
      pattern: string | null;
      preferredTerm: string | null;
      avoidTerms: string[];
      severity: typeof rulesJson.rules[0]['severity'];
      isActive: boolean;
      baseStyleGuide: typeof rulesJson.rules[0]['baseStyleGuide'] | null;
      overridesRule: string | null;
      createdBy: string;
    }> = [];

    for (let i = 0; i < rulesJson.rules.length; i++) {
      const rule = rulesJson.rules[i];

      // Check for duplicate in existing names
      if (existingNames.has(rule.name)) {
        result.skipped++;
        result.errors.push(`Rule ${i + 1}: "${rule.name}" already exists - skipped`);
        continue;
      }

      // Validate pattern if provided (ReDoS protection)
      if (rule.pattern) {
        try {
          new RegExp(rule.pattern);
          if (this.isUnsafeRegex(rule.pattern)) {
            result.errors.push(`Rule ${i + 1}: "${rule.name}" has unsafe regex pattern - skipped`);
            result.skipped++;
            continue;
          }
        } catch {
          result.errors.push(`Rule ${i + 1}: "${rule.name}" has invalid regex pattern - skipped`);
          result.skipped++;
          continue;
        }
      }

      rulesToCreate.push({
        tenantId,
        name: rule.name,
        description: rule.description ?? null,
        category: rule.category,
        ruleType: rule.ruleType,
        pattern: rule.pattern ?? null,
        preferredTerm: rule.preferredTerm ?? null,
        avoidTerms: rule.avoidTerms || [],
        severity: rule.severity,
        isActive: rule.isActive,
        baseStyleGuide: rule.baseStyleGuide ?? null,
        overridesRule: rule.overridesRule ?? null,
        createdBy: userId,
      });
    }

    // Batch insert all valid rules
    if (rulesToCreate.length > 0) {
      await prisma.houseStyleRule.createMany({ data: rulesToCreate });
      result.imported = rulesToCreate.length;
    }

    logger.info(
      `[House Style] Imported ${result.imported} rules for tenant ${tenantId}, skipped ${result.skipped}`
    );

    return result;
  }

  async exportRules(tenantId: string): Promise<RulesExport> {
    const rules = await this.getRules(tenantId);

    return {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      tenantId,
      rules: rules.map(rule => ({
        name: rule.name,
        description: rule.description,
        category: rule.category,
        ruleType: rule.ruleType,
        pattern: rule.pattern,
        preferredTerm: rule.preferredTerm,
        avoidTerms: rule.avoidTerms,
        severity: rule.severity,
        isActive: rule.isActive,
        baseStyleGuide: rule.baseStyleGuide,
        overridesRule: rule.overridesRule,
      })),
    };
  }

  async testRule(
    rule: CreateHouseRuleInput | HouseStyleRule,
    sampleText: string
  ): Promise<TestResult> {
    const startTime = Date.now();
    const matches: RuleMatch[] = [];
    let patternValid = true;
    let error: string | undefined;

    // ReDoS protection: Limit input size
    const MAX_INPUT_SIZE = 100000; // 100KB
    if (sampleText.length > MAX_INPUT_SIZE) {
      return {
        matches: [],
        executionTimeMs: Date.now() - startTime,
        patternValid: false,
        error: `Input text too large (${sampleText.length} chars). Maximum allowed: ${MAX_INPUT_SIZE} chars`,
      };
    }

    // ReDoS protection: Validate pattern before execution
    if (rule.pattern && (rule.ruleType === 'PATTERN' || rule.ruleType === 'PUNCTUATION')) {
      if (this.isUnsafeRegex(rule.pattern)) {
        return {
          matches: [],
          executionTimeMs: Date.now() - startTime,
          patternValid: false,
          error: 'Pattern contains potentially catastrophic backtracking. Avoid nested quantifiers like (a+)+ or (.*)+',
        };
      }
    }

    try {
      if (rule.ruleType === 'PATTERN' && rule.pattern) {
        // Test regex pattern (already validated above)
        const regex = new RegExp(rule.pattern, 'gi');
        let match;

        while ((match = regex.exec(sampleText)) !== null) {
          matches.push({
            startOffset: match.index,
            endOffset: match.index + match[0].length,
            matchedText: match[0],
            suggestedFix: '', // Pattern rules don't have auto-fix
            ruleId: 'id' in rule ? rule.id : 'test-rule',
            ruleName: rule.name,
            description: rule.description || '',
          });
        }
      } else if (rule.ruleType === 'TERMINOLOGY') {
        // Test terminology rule
        const avoidTerms = rule.avoidTerms || [];
        const preferredTerm = rule.preferredTerm || '';

        for (const term of avoidTerms) {
          const regex = new RegExp(`\\b${this.escapeRegex(term)}\\b`, 'gi');
          let match;

          while ((match = regex.exec(sampleText)) !== null) {
            matches.push({
              startOffset: match.index,
              endOffset: match.index + match[0].length,
              matchedText: match[0],
              suggestedFix: preferredTerm || `[avoid: ${term}]`,
              ruleId: 'id' in rule ? rule.id : 'test-rule',
              ruleName: rule.name,
              description: rule.description || `Use "${preferredTerm}" instead of "${term}"`,
            });
          }
        }
      } else if (rule.ruleType === 'CAPITALIZATION') {
        // Test capitalization rules with avoidTerms
        for (const term of rule.avoidTerms || []) {
          // Check for incorrect capitalization
          const regex = new RegExp(`\\b${this.escapeRegex(term)}\\b`, 'g');
          let match;

          while ((match = regex.exec(sampleText)) !== null) {
            if (match[0] !== rule.preferredTerm) {
              matches.push({
                startOffset: match.index,
                endOffset: match.index + match[0].length,
                matchedText: match[0],
                suggestedFix: rule.preferredTerm || match[0],
                ruleId: 'id' in rule ? rule.id : 'test-rule',
                ruleName: rule.name,
                description: `Use correct capitalization: "${rule.preferredTerm}"`,
              });
            }
          }
        }
      } else if (rule.ruleType === 'PUNCTUATION') {
        // Punctuation rules typically use patterns
        if (rule.pattern) {
          const regex = new RegExp(rule.pattern, 'gi');
          let match;

          while ((match = regex.exec(sampleText)) !== null) {
            matches.push({
              startOffset: match.index,
              endOffset: match.index + match[0].length,
              matchedText: match[0],
              suggestedFix: rule.preferredTerm || '',
              ruleId: 'id' in rule ? rule.id : 'test-rule',
              ruleName: rule.name,
              description: rule.description || '',
            });
          }
        }
      }
    } catch (err) {
      patternValid = false;
      error = err instanceof Error ? err.message : 'Unknown error';
    }

    return {
      matches,
      executionTimeMs: Date.now() - startTime,
      patternValid,
      error,
    };
  }

  /**
   * @deprecated Use executeHouseRulesAsync instead. This method does not work correctly
   * because testRule is async and cannot be called synchronously.
   */
  executeHouseRules(_rules: HouseStyleRule[], _text: string): RuleMatch[] {
    throw new Error('executeHouseRules is deprecated. Use executeHouseRulesAsync instead.');
  }

  async executeHouseRulesAsync(
    rules: HouseStyleRule[],
    text: string
  ): Promise<RuleMatch[]> {
    const allMatches: RuleMatch[] = [];

    for (const rule of rules) {
      if (!rule.isActive) continue;

      const result = await this.testRule(rule, text);
      allMatches.push(...result.matches);
    }

    return allMatches.sort((a, b) => a.startOffset - b.startOffset);
  }

  private escapeRegex(string: string): string {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Check if a regex pattern is potentially unsafe (ReDoS vulnerable)
   * Uses safe-regex2 library for accurate detection of catastrophic backtracking patterns
   */
  private isUnsafeRegex(pattern: string): boolean {
    try {
      // safe-regex2 returns true if the pattern is SAFE, so we negate it
      return !safeRegex(pattern);
    } catch {
      // If safe-regex2 throws, treat pattern as unsafe
      return true;
    }
  }
}

export const houseStyleEngine = new HouseStyleEngineService();
