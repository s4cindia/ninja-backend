/**
 * House Rules Controller
 *
 * Handles house style rule management:
 * - CRUD operations
 * - Import/export
 * - Rule testing
 */

import { Response, NextFunction } from 'express';
import { houseStyleEngine } from '../../services/style/house-style-engine.service';
import { styleRulesRegistry } from '../../services/style/style-rules-registry.service';
import type { AuthenticatedRequest } from '../../types/authenticated-request';
import type {
  CreateHouseRuleBody,
  UpdateHouseRuleBody,
  ImportRulesBody,
  TestRuleBody,
} from '../../schemas/style.schemas';
import type { HouseRuleFilters } from '../../services/style/house-style-engine.service';

export class HouseRulesController {
  // ============================================
  // RULE SET ENDPOINTS
  // ============================================

  /**
   * Create a new rule set
   * POST /api/v1/style/rule-sets
   */
  async createRuleSet(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const body = req.body as { name: string; description?: string; baseStyleGuide?: string; isDefault?: boolean };
      const tenantId = req.user?.tenantId;
      const userId = req.user?.id;

      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const ruleSet = await houseStyleEngine.createRuleSet(tenantId, userId, {
        name: body.name,
        description: body.description,
        baseStyleGuide: body.baseStyleGuide as HouseRuleFilters['baseStyleGuide'],
        isDefault: body.isDefault,
      });

      return res.status(201).json({
        success: true,
        data: ruleSet,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * List rule sets (both built-in and custom)
   * GET /api/v1/style/rule-sets
   */
  async listRuleSets(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const query = req.query as { includeRules?: string; activeOnly?: string; customOnly?: string };

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      // Get built-in rule sets from registry (unless customOnly is requested)
      const builtInRuleSets = query.customOnly === 'true' ? [] : styleRulesRegistry.getAllRuleSets().map((rs) => ({
        id: rs.id,
        name: rs.name,
        description: rs.description,
        styleGuide: rs.styleGuide,
        ruleCount: rs.rules.length,
        isBuiltIn: true,
      }));

      // Get custom rule sets from database
      const customRuleSets = await houseStyleEngine.getRuleSets(tenantId, {
        includeRules: query.includeRules === 'true',
        activeOnly: query.activeOnly === 'true',
      });

      // Add isBuiltIn: false and ruleCount to custom rule sets
      const formattedCustomRuleSets = customRuleSets.map((rs) => ({
        ...rs,
        ruleCount: rs._count?.rules || 0,
        isBuiltIn: false,
      }));

      // Combine both lists
      const allRuleSets = [...builtInRuleSets, ...formattedCustomRuleSets];

      return res.status(200).json({
        success: true,
        data: {
          ruleSets: allRuleSets,
          total: allRuleSets.length,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get a single rule set with its rules
   * GET /api/v1/style/rule-sets/:ruleSetId
   */
  async getRuleSet(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { ruleSetId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const ruleSet = await houseStyleEngine.getRuleSet(ruleSetId, tenantId);

      if (!ruleSet) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Rule set not found' },
        });
      }

      return res.status(200).json({
        success: true,
        data: ruleSet,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update a rule set
   * PUT /api/v1/style/rule-sets/:ruleSetId
   */
  async updateRuleSet(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { ruleSetId } = req.params;
      const body = req.body as { name?: string; description?: string; baseStyleGuide?: string; isActive?: boolean; isDefault?: boolean };
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const updated = await houseStyleEngine.updateRuleSet(ruleSetId, tenantId, {
        name: body.name,
        description: body.description,
        baseStyleGuide: body.baseStyleGuide as HouseRuleFilters['baseStyleGuide'],
        isActive: body.isActive,
        isDefault: body.isDefault,
      });

      return res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete a rule set
   * DELETE /api/v1/style/rule-sets/:ruleSetId
   */
  async deleteRuleSet(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { ruleSetId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      await houseStyleEngine.deleteRuleSet(ruleSetId, tenantId);

      return res.status(200).json({
        success: true,
        data: { message: 'Rule set deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Add a rule to a rule set
   * POST /api/v1/style/rule-sets/:ruleSetId/rules
   */
  async addRuleToSet(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { ruleSetId } = req.params;
      const body = req.body as CreateHouseRuleBody;
      const tenantId = req.user?.tenantId;
      const userId = req.user?.id;

      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const rule = await houseStyleEngine.createRuleInSet(tenantId, userId, ruleSetId, {
        name: body.name,
        description: body.description,
        category: body.category,
        ruleType: body.ruleType,
        pattern: body.pattern,
        preferredTerm: body.preferredTerm,
        avoidTerms: body.avoidTerms,
        severity: body.severity,
        isActive: body.isActive,
        baseStyleGuide: body.baseStyleGuide,
        overridesRule: body.overridesRule,
      });

      return res.status(201).json({
        success: true,
        data: rule,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Import rules to a rule set
   * POST /api/v1/style/rule-sets/:ruleSetId/import
   */
  async importRulesToSet(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { ruleSetId } = req.params;
      const body = req.body as ImportRulesBody;
      const tenantId = req.user?.tenantId;
      const userId = req.user?.id;

      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const result = await houseStyleEngine.importRulesToSet(tenantId, userId, ruleSetId, {
        version: body.version,
        exportedAt: body.exportedAt || new Date().toISOString(),
        tenantId,
        rules: body.rules,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  // ============================================
  // INDIVIDUAL RULE ENDPOINTS
  // ============================================

  /**
   * Create a new house rule
   * POST /api/v1/style/house-rules
   */
  async createRule(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const body = req.body as CreateHouseRuleBody;
      const tenantId = req.user?.tenantId;
      const userId = req.user?.id;

      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const rule = await houseStyleEngine.createRule(tenantId, userId, {
        name: body.name,
        description: body.description,
        category: body.category,
        ruleType: body.ruleType,
        pattern: body.pattern,
        preferredTerm: body.preferredTerm,
        avoidTerms: body.avoidTerms,
        severity: body.severity,
        isActive: body.isActive,
        baseStyleGuide: body.baseStyleGuide,
        overridesRule: body.overridesRule,
      });

      return res.status(201).json({
        success: true,
        data: rule,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Update a house rule
   * PUT /api/v1/style/house-rules/:ruleId
   */
  async updateRule(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { ruleId } = req.params;
      const body = req.body as UpdateHouseRuleBody;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const updated = await houseStyleEngine.updateRule(ruleId, tenantId, {
        name: body.name,
        description: body.description ?? undefined,
        category: body.category,
        ruleType: body.ruleType,
        pattern: body.pattern ?? undefined,
        preferredTerm: body.preferredTerm ?? undefined,
        avoidTerms: body.avoidTerms,
        severity: body.severity,
        isActive: body.isActive,
        baseStyleGuide: body.baseStyleGuide ?? undefined,
        overridesRule: body.overridesRule ?? undefined,
      });

      return res.status(200).json({
        success: true,
        data: updated,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Delete a house rule
   * DELETE /api/v1/style/house-rules/:ruleId
   */
  async deleteRule(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { ruleId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      await houseStyleEngine.deleteRule(ruleId, tenantId);

      return res.status(200).json({
        success: true,
        data: { message: 'Rule deleted successfully' },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Get a single house rule
   * GET /api/v1/style/house-rules/:ruleId
   */
  async getRule(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const { ruleId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const rule = await houseStyleEngine.getRule(ruleId, tenantId);

      if (!rule) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Rule not found' },
        });
      }

      return res.status(200).json({
        success: true,
        data: rule,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * List house rules
   * GET /api/v1/style/house-rules
   */
  async listRules(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;
      const query = req.query as Record<string, string | undefined>;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const filters: HouseRuleFilters = {};

      if (query.category) {
        filters.category = query.category as HouseRuleFilters['category'];
      }
      if (query.ruleType) {
        filters.ruleType = query.ruleType as HouseRuleFilters['ruleType'];
      }
      if (query.isActive !== undefined) {
        filters.isActive = query.isActive === 'true';
      }
      if (query.baseStyleGuide) {
        filters.baseStyleGuide = query.baseStyleGuide as HouseRuleFilters['baseStyleGuide'];
      }
      if (query.search) {
        filters.search = query.search;
      }

      const rules = await houseStyleEngine.getRules(tenantId, filters);

      return res.status(200).json({
        success: true,
        data: {
          rules,
          total: rules.length,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Import rules from JSON
   * POST /api/v1/style/house-rules/import
   */
  async importRules(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const body = req.body as ImportRulesBody;
      const tenantId = req.user?.tenantId;
      const userId = req.user?.id;

      if (!tenantId || !userId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const result = await houseStyleEngine.importRules(tenantId, userId, {
        version: body.version,
        exportedAt: body.exportedAt || new Date().toISOString(),
        tenantId,
        rules: body.rules,
      });

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Export rules to JSON
   * GET /api/v1/style/house-rules/export
   */
  async exportRules(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      const exportData = await houseStyleEngine.exportRules(tenantId);

      return res.status(200).json({
        success: true,
        data: exportData,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * Test a rule against sample text
   * POST /api/v1/style/house-rules/test
   */
  async testRule(req: AuthenticatedRequest, res: Response, next: NextFunction) {
    try {
      const body = req.body as TestRuleBody;

      const result = await houseStyleEngine.testRule(
        {
          name: body.rule.name,
          description: body.rule.description,
          category: body.rule.category,
          ruleType: body.rule.ruleType,
          pattern: body.rule.pattern,
          preferredTerm: body.rule.preferredTerm,
          avoidTerms: body.rule.avoidTerms,
          severity: body.rule.severity,
        },
        body.sampleText
      );

      return res.status(200).json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }
}

export const houseRulesController = new HouseRulesController();
