import { describe, it, expect, beforeEach } from 'vitest';
import { WCAGCriteriaService } from '../../../src/services/validation/wcag-criteria.service';

describe('WCAGCriteriaService', () => {
  let service: WCAGCriteriaService;

  beforeEach(() => {
    service = new WCAGCriteriaService();
  });

  describe('getAllCriteria', () => {
    it('should return all WCAG criteria', () => {
      const criteria = service.getAllCriteria();
      expect(criteria).toBeDefined();
      expect(Array.isArray(criteria)).toBe(true);
      expect(criteria.length).toBeGreaterThan(0);
    });

    it('should include perceivable criteria (1.x.x)', () => {
      const criteria = service.getAllCriteria();
      const perceivable = criteria.filter(c => c.id.startsWith('1.'));
      expect(perceivable.length).toBeGreaterThan(0);
    });

    it('should include operable criteria (2.x.x)', () => {
      const criteria = service.getAllCriteria();
      const operable = criteria.filter(c => c.id.startsWith('2.'));
      expect(operable.length).toBeGreaterThan(0);
    });
  });

  describe('getCriteriaById', () => {
    it('should return criterion by valid ID', () => {
      const criterion = service.getCriteriaById('1.1.1');
      expect(criterion).toBeDefined();
      expect(criterion?.id).toBe('1.1.1');
    });

    it('should return undefined for invalid ID', () => {
      const criterion = service.getCriteriaById('99.99.99');
      expect(criterion).toBeUndefined();
    });
  });

  describe('getCriteriaByLevel', () => {
    it('should filter criteria by level A', () => {
      const levelA = service.getCriteriaByLevel('A');
      expect(levelA.every(c => c.level === 'A')).toBe(true);
    });

    it('should filter criteria by level AA', () => {
      const levelAA = service.getCriteriaByLevel('AA');
      expect(levelAA.every(c => c.level === 'AA')).toBe(true);
    });
  });
});
