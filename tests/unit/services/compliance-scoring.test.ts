import { describe, it, expect } from 'vitest';
import { ComplianceScoringService } from '../../../src/services/validation/compliance-scoring.service';

describe('ComplianceScoringService', () => {
  describe('calculateScore', () => {
    it('should return 100 for all passed validations', () => {
      const results = [
        { passed: true, ruleId: '1', severity: 'error' as const },
        { passed: true, ruleId: '2', severity: 'error' as const },
        { passed: true, ruleId: '3', severity: 'warning' as const },
      ];
      
      const service = new ComplianceScoringService();
      const score = service.calculateScore(results);
      
      expect(score.overallScore).toBe(100);
      expect(score.passed).toBe(true);
    });

    it('should reduce score for failed validations', () => {
      const results = [
        { passed: true, ruleId: '1', severity: 'error' as const },
        { passed: false, ruleId: '2', severity: 'error' as const },
        { passed: true, ruleId: '3', severity: 'warning' as const },
      ];
      
      const service = new ComplianceScoringService();
      const score = service.calculateScore(results);
      
      expect(score.overallScore).toBeLessThan(100);
    });

    it('should handle empty results', () => {
      const service = new ComplianceScoringService();
      const score = service.calculateScore([]);
      
      expect(score).toBeDefined();
      expect(typeof score.overallScore).toBe('number');
    });
  });

  describe('getComplianceLevel', () => {
    it('should return appropriate level for score', () => {
      const service = new ComplianceScoringService();
      
      expect(service.getComplianceLevel(95)).toBe('high');
      expect(service.getComplianceLevel(75)).toBe('medium');
      expect(service.getComplianceLevel(50)).toBe('low');
    });
  });
});
