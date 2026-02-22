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

    const ruleSet = await prisma.houseRuleSet.create({
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

    const updated = await prisma.houseRuleSet.update({
      where: { id: ruleSetId },
      data: {
        ...(input.name !== undefined && { name: input.name }),
        ...(input.description !== undefined && { description: input.description }),
        ...(input.baseStyleGuide !== undefined && { baseStyleGuide: input.baseStyleGuide }),
        ...(input.isActive !== undefined && { isActive: input.isActive }),
        ...(input.isDefault !== undefined && { isDefault: input.isDefault }),
      },
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
    options?: { includeRules?: boolean; activeOnly?: boolean }
  ): Promise<RuleSetWithRules[]> {
    const where: Record<string, unknown> = { tenantId };

    if (options?.activeOnly) {
      where.isActive = true;
    }

    return prisma.houseRuleSet.findMany({
      where,
      include: {
        rules: options?.includeRules ? {
          orderBy: [{ category: 'asc' }, { name: 'asc' }],
        } : false,
        _count: { select: { rules: true } },
      },
      orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
    }) as Promise<RuleSetWithRules[]>;
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

    for (let i = 0; i < rulesJson.rules.length; i++) {
      const rule = rulesJson.rules[i];
      try {
        // Check for duplicate name within this rule set
        const existing = await prisma.houseStyleRule.findFirst({
          where: {
            tenantId,
            ruleSetId,
            name: rule.name,
          },
        });

        if (existing) {
          result.skipped++;
          result.errors.push(`Rule ${i + 1}: "${rule.name}" already exists in this set - skipped`);
          continue;
        }

        await this.createRuleInSet(tenantId, userId, ruleSetId, {
          name: rule.name,
          description: rule.description ?? undefined,
          category: rule.category,
          ruleType: rule.ruleType,
          pattern: rule.pattern ?? undefined,
          preferredTerm: rule.preferredTerm ?? undefined,
          avoidTerms: rule.avoidTerms,
          severity: rule.severity,
          isActive: rule.isActive,
          baseStyleGuide: rule.baseStyleGuide ?? undefined,
          overridesRule: rule.overridesRule ?? undefined,
        });

        result.imported++;
      } catch (error) {
        result.errors.push(
          `Rule ${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
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

    for (let i = 0; i < rulesJson.rules.length; i++) {
      const rule = rulesJson.rules[i];
      try {
        // Check for duplicate name
        const existing = await prisma.houseStyleRule.findFirst({
          where: {
            tenantId,
            name: rule.name,
          },
        });

        if (existing) {
          result.skipped++;
          result.errors.push(`Rule ${i + 1}: "${rule.name}" already exists - skipped`);
          continue;
        }

        await this.createRule(tenantId, userId, {
          name: rule.name,
          description: rule.description ?? undefined,
          category: rule.category,
          ruleType: rule.ruleType,
          pattern: rule.pattern ?? undefined,
          preferredTerm: rule.preferredTerm ?? undefined,
          avoidTerms: rule.avoidTerms,
          severity: rule.severity,
          isActive: rule.isActive,
          baseStyleGuide: rule.baseStyleGuide ?? undefined,
          overridesRule: rule.overridesRule ?? undefined,
        });

        result.imported++;
      } catch (error) {
        result.errors.push(
          `Rule ${i + 1}: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
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

    try {
      if (rule.ruleType === 'PATTERN' && rule.pattern) {
        // Test regex pattern
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
          const regex = new RegExp(`\\b${term}\\b`, 'g');
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

  executeHouseRules(rules: HouseStyleRule[], text: string): RuleMatch[] {
    const allMatches: RuleMatch[] = [];

    for (const rule of rules) {
      if (!rule.isActive) continue;

      const result = this.testRule(rule, text);
      // Note: testRule returns a Promise, but we need sync execution
      // For actual execution, use executeHouseRulesAsync
      void result; // Suppress unused warning
    }

    return allMatches;
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
}

export const houseStyleEngine = new HouseStyleEngineService();
