import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../src/lib/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

import {
  normalizeOperatorLabel,
  __resetWarnedUnknownsForTest,
} from '../../../../src/services/metrics/operator-label-normalizer';
import { logger } from '../../../../src/lib/logger';

beforeEach(() => {
  vi.clearAllMocks();
  __resetWarnedUnknownsForTest();
});

describe('normalizeOperatorLabel', () => {
  it('returns null for null/undefined/empty', () => {
    expect(normalizeOperatorLabel(null)).toBeNull();
    expect(normalizeOperatorLabel(undefined)).toBeNull();
    expect(normalizeOperatorLabel('')).toBeNull();
    expect(normalizeOperatorLabel('   ')).toBeNull();
  });

  it('passes through canonical types unchanged', () => {
    expect(normalizeOperatorLabel('paragraph')).toBe('paragraph');
    expect(normalizeOperatorLabel('section-header')).toBe('section-header');
    expect(normalizeOperatorLabel('table')).toBe('table');
    expect(normalizeOperatorLabel('figure')).toBe('figure');
    expect(normalizeOperatorLabel('caption')).toBe('caption');
    expect(normalizeOperatorLabel('footnote')).toBe('footnote');
    expect(normalizeOperatorLabel('header')).toBe('header');
    expect(normalizeOperatorLabel('footer')).toBe('footer');
  });

  describe('Convention A: PDF-tag-name uppercase (Boyd-Hamill, Flanagan)', () => {
    it('LI → paragraph', () => {
      expect(normalizeOperatorLabel('LI')).toBe('paragraph');
    });
    it('HDR → header', () => {
      expect(normalizeOperatorLabel('HDR')).toBe('header');
    });
    it('TOCI → paragraph', () => {
      expect(normalizeOperatorLabel('TOCI')).toBe('paragraph');
    });
    it('FTR → footer', () => {
      expect(normalizeOperatorLabel('FTR')).toBe('footer');
    });
  });

  describe('Convention B: HTML-semantic lowercase (BirdingwithAI, Gold)', () => {
    it('all heading levels collapse to section-header', () => {
      for (const h of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
        expect(normalizeOperatorLabel(h)).toBe('section-header');
      }
    });
    it('list-item → paragraph', () => {
      expect(normalizeOperatorLabel('list-item')).toBe('paragraph');
      expect(normalizeOperatorLabel('list_item')).toBe('paragraph');
    });
    it('toci (any case) → paragraph', () => {
      expect(normalizeOperatorLabel('toci')).toBe('paragraph');
      expect(normalizeOperatorLabel('TOCI')).toBe('paragraph');
      expect(normalizeOperatorLabel('TocI')).toBe('paragraph');
    });
  });

  describe('case + whitespace tolerance', () => {
    it('normalizes case', () => {
      expect(normalizeOperatorLabel('Paragraph')).toBe('paragraph');
      expect(normalizeOperatorLabel('FOOTER')).toBe('footer');
      expect(normalizeOperatorLabel('h2')).toBe('section-header');
      expect(normalizeOperatorLabel('H2')).toBe('section-header');
    });
    it('trims surrounding whitespace', () => {
      expect(normalizeOperatorLabel('  table  ')).toBe('table');
      expect(normalizeOperatorLabel('\tLI\n')).toBe('paragraph');
    });
  });

  describe('table/figure variants', () => {
    it('table row/cell labels collapse to table', () => {
      for (const t of ['TR', 'TD', 'TH', 'THead', 'TBody', 'tfoot']) {
        expect(normalizeOperatorLabel(t)).toBe('table');
      }
    });
    it('figure synonyms collapse to figure', () => {
      for (const t of ['Picture', 'image', 'img', 'fig', 'FIGURE']) {
        expect(normalizeOperatorLabel(t)).toBe('figure');
      }
    });
  });

  it('returns null for unknown labels and logs once per unknown', () => {
    expect(normalizeOperatorLabel('weird-label-1')).toBeNull();
    expect(normalizeOperatorLabel('weird-label-1')).toBeNull(); // second call
    expect(normalizeOperatorLabel('weird-label-2')).toBeNull();
    // Two distinct unknowns → exactly two warnings (no duplicates).
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('does not warn for known labels even on repeated calls', () => {
    normalizeOperatorLabel('LI');
    normalizeOperatorLabel('h3');
    normalizeOperatorLabel('paragraph');
    expect(logger.warn).not.toHaveBeenCalled();
  });
});
