import { describe, it, expect, beforeEach } from 'vitest';
import { ValidationRuleEngine } from '../../../src/services/validation/validation-rule-engine.service';

describe('ValidationRuleEngine', () => {
  let engine: ValidationRuleEngine;

  beforeEach(() => {
    engine = new ValidationRuleEngine();
  });

  describe('getActiveRules', () => {
    it('should return active validation rules', () => {
      const rules = engine.getActiveRules();
      expect(rules).toBeDefined();
      expect(Array.isArray(rules)).toBe(true);
    });

    it('should only return enabled rules', () => {
      const rules = engine.getActiveRules();
      expect(rules.every(r => r.enabled !== false)).toBe(true);
    });
  });

  describe('getRulesByCategory', () => {
    it('should filter rules by category', () => {
      const textRules = engine.getRulesByCategory('text');
      expect(textRules.every(r => r.category === 'text')).toBe(true);
    });
  });

  describe('validateRule', () => {
    it('should return validation result object', async () => {
      const mockContent = { type: 'text', content: 'Sample text' };
      const rules = engine.getActiveRules();

      expect(rules.length).toBeGreaterThan(0);
      
      const result = await engine.validateRule(rules[0], mockContent);
      expect(result).toHaveProperty('passed');
      expect(result).toHaveProperty('ruleId');
    });
  });
});
