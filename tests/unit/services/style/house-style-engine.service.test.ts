import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock prisma before importing service
vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    houseRuleSet: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
      updateMany: vi.fn(),
    },
    houseStyleRule: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      createMany: vi.fn(),
    },
    $transaction: vi.fn(),
  },
}));

// Mock safe-regex2
vi.mock('safe-regex2', () => ({
  default: vi.fn().mockReturnValue(true),
}));

import prisma from '../../../../src/lib/prisma';
import { houseStyleEngine } from '../../../../src/services/style/house-style-engine.service';

describe('HouseStyleEngineService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('createRuleSet', () => {
    it('should create a new rule set', async () => {
      const mockRuleSet = {
        id: 'ruleset-1',
        tenantId: 'tenant-1',
        name: 'Test Rule Set',
        description: 'A test rule set',
        baseStyleGuide: 'CHICAGO',
        isDefault: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'user-1',
        rules: [],
        _count: { rules: 0 },
      };

      vi.mocked(prisma.houseRuleSet.findFirst).mockResolvedValue(null); // No existing
      // Mock the transaction to execute the callback and return the result
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        // Create a mock transaction client
        const txMock = {
          houseRuleSet: {
            updateMany: vi.fn().mockResolvedValue({ count: 0 }),
            create: vi.fn().mockResolvedValue(mockRuleSet),
          },
        };
        return callback(txMock);
      });

      const result = await houseStyleEngine.createRuleSet('tenant-1', 'user-1', {
        name: 'Test Rule Set',
        description: 'A test rule set',
        baseStyleGuide: 'CHICAGO',
        isDefault: false,
      });

      expect(result).toBeDefined();
      expect(result.name).toBe('Test Rule Set');
      expect(prisma.$transaction).toHaveBeenCalled();
    });

    it('should throw error if rule set name already exists', async () => {
      const existingRuleSet = {
        id: 'existing-1',
        tenantId: 'tenant-1',
        name: 'Existing Rule Set',
        description: null,
        baseStyleGuide: null,
        isDefault: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'user-1',
      };

      vi.mocked(prisma.houseRuleSet.findFirst).mockResolvedValue(existingRuleSet);

      await expect(
        houseStyleEngine.createRuleSet('tenant-1', 'user-1', {
          name: 'Existing Rule Set',
        })
      ).rejects.toThrow(/Rule set with.*already exists/);
    });

    it('should set as default and unset other defaults', async () => {
      const mockRuleSet = {
        id: 'ruleset-1',
        tenantId: 'tenant-1',
        name: 'Default Rule Set',
        description: null,
        baseStyleGuide: null,
        isDefault: true,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'user-1',
        rules: [],
        _count: { rules: 0 },
      };

      vi.mocked(prisma.houseRuleSet.findFirst).mockResolvedValue(null);
      // Mock the transaction
      const updateManyMock = vi.fn().mockResolvedValue({ count: 1 });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(prisma.$transaction).mockImplementation(async (callback: any) => {
        const txMock = {
          houseRuleSet: {
            updateMany: updateManyMock,
            create: vi.fn().mockResolvedValue(mockRuleSet),
          },
        };
        return callback(txMock);
      });

      const result = await houseStyleEngine.createRuleSet('tenant-1', 'user-1', {
        name: 'Default Rule Set',
        isDefault: true,
      });

      expect(result.isDefault).toBe(true);
      // Should have called updateMany to unset other defaults
      expect(updateManyMock).toHaveBeenCalled();
    });
  });

  describe('testRule', () => {
    it('should find matches for terminology rule', async () => {
      const rule = {
        name: 'Color vs Colour',
        ruleType: 'TERMINOLOGY' as const,
        category: 'TERMINOLOGY' as const,
        severity: 'WARNING' as const,
        preferredTerm: 'colour',
        avoidTerms: ['color'],
        isActive: true,
      };

      const sampleText = 'The color of the sky is blue. The color is beautiful.';

      const result = await houseStyleEngine.testRule(rule, sampleText);

      expect(result.matches).toBeDefined();
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0].matchedText).toBe('color');
      expect(result.matches[0].suggestedFix).toBe('colour');
    });

    it('should return result with executionTimeMs for pattern rule', async () => {
      const rule = {
        name: 'Find Test Word',
        ruleType: 'PATTERN' as const,
        category: 'FORMATTING' as const,
        severity: 'WARNING' as const,
        pattern: 'test', // Simple word pattern
        preferredTerm: '',
        avoidTerms: [],
        isActive: true,
      };

      const sampleText = 'This is a test sentence.';

      const result = await houseStyleEngine.testRule(rule, sampleText);

      // Verify the result structure is correct
      expect(result).toBeDefined();
      expect(result.executionTimeMs).toBeDefined();
      expect(typeof result.executionTimeMs).toBe('number');
      expect(result.matches).toBeDefined();
      expect(Array.isArray(result.matches)).toBe(true);
    });

    it('should return empty matches for safe text', async () => {
      const rule = {
        name: 'Color vs Colour',
        ruleType: 'TERMINOLOGY' as const,
        category: 'TERMINOLOGY' as const,
        severity: 'WARNING' as const,
        preferredTerm: 'colour',
        avoidTerms: ['color'],
        isActive: true,
      };

      const sampleText = 'The colour of the sky is blue.';

      const result = await houseStyleEngine.testRule(rule, sampleText);

      expect(result.matches).toHaveLength(0);
    });

    it('should reject unsafe regex patterns', async () => {
      const rule = {
        name: 'Unsafe Pattern',
        ruleType: 'PATTERN' as const,
        category: 'OTHER' as const,
        severity: 'WARNING' as const,
        pattern: '(a+)+$', // ReDoS vulnerable pattern
        avoidTerms: [],
        isActive: true,
      };

      const result = await houseStyleEngine.testRule(rule, 'aaaaaaaaaa');

      expect(result.error).toBeDefined();
      expect(result.error).toContain('catastrophic backtracking');
      expect(result.patternValid).toBe(false);
    });

    it('should handle invalid regex gracefully', async () => {
      const rule = {
        name: 'Invalid Pattern',
        ruleType: 'PATTERN' as const,
        category: 'OTHER' as const,
        severity: 'WARNING' as const,
        pattern: '[invalid(regex',
        avoidTerms: [],
        isActive: true,
      };

      const result = await houseStyleEngine.testRule(rule, 'test text');

      expect(result.error).toBeDefined();
    });

    it('should include execution time in result', async () => {
      const rule = {
        name: 'Simple Rule',
        ruleType: 'TERMINOLOGY' as const,
        category: 'TERMINOLOGY' as const,
        severity: 'WARNING' as const,
        preferredTerm: 'test',
        avoidTerms: ['tset'],
        isActive: true,
      };

      const result = await houseStyleEngine.testRule(rule, 'This is a tset.');

      expect(result.executionTimeMs).toBeDefined();
      expect(typeof result.executionTimeMs).toBe('number');
      expect(result.executionTimeMs).toBeGreaterThanOrEqual(0);
    });
  });

  describe('getRuleSet', () => {
    it('should return rule set with rules', async () => {
      const mockRuleSet = {
        id: 'ruleset-1',
        tenantId: 'tenant-1',
        name: 'Test Rule Set',
        description: 'Test description',
        baseStyleGuide: 'CHICAGO',
        isDefault: false,
        isActive: true,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: 'user-1',
        rules: [
          {
            id: 'rule-1',
            name: 'Test Rule',
            category: 'TERMINOLOGY',
            ruleType: 'TERMINOLOGY',
            severity: 'WARNING',
            isActive: true,
          },
        ],
        _count: { rules: 1 },
      };

      vi.mocked(prisma.houseRuleSet.findFirst).mockResolvedValue(mockRuleSet);

      const result = await houseStyleEngine.getRuleSet('ruleset-1', 'tenant-1');

      expect(result).toBeDefined();
      expect(result?.name).toBe('Test Rule Set');
      expect(result?.rules).toHaveLength(1);
    });

    it('should return null for non-existent rule set', async () => {
      vi.mocked(prisma.houseRuleSet.findFirst).mockResolvedValue(null);

      const result = await houseStyleEngine.getRuleSet('non-existent', 'tenant-1');

      expect(result).toBeNull();
    });
  });

  describe('getRuleSets', () => {
    it('should return paginated rule sets', async () => {
      const mockRuleSets = [
        {
          id: 'ruleset-1',
          tenantId: 'tenant-1',
          name: 'Rule Set 1',
          isDefault: false,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          _count: { rules: 5 },
        },
        {
          id: 'ruleset-2',
          tenantId: 'tenant-1',
          name: 'Rule Set 2',
          isDefault: true,
          isActive: true,
          createdAt: new Date(),
          updatedAt: new Date(),
          _count: { rules: 10 },
        },
      ];

      vi.mocked(prisma.houseRuleSet.findMany).mockResolvedValue(mockRuleSets);
      vi.mocked(prisma.houseRuleSet.count).mockResolvedValue(2);

      const result = await houseStyleEngine.getRuleSets('tenant-1', {
        page: 1,
        pageSize: 10,
      });

      expect(result.ruleSets).toHaveLength(2);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(10);
    });

    it('should filter active only when requested', async () => {
      vi.mocked(prisma.houseRuleSet.findMany).mockResolvedValue([]);
      vi.mocked(prisma.houseRuleSet.count).mockResolvedValue(0);

      await houseStyleEngine.getRuleSets('tenant-1', { activeOnly: true });

      expect(prisma.houseRuleSet.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            isActive: true,
          }),
        })
      );
    });
  });
});
