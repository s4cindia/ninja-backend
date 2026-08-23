import { describe, it, expect } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

// analyzeColorContrast is private; exercise via cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

const BASE_ISSUE: AuditIssue = {
  id: 'contrast-1',
  source: 'contrast-validator',
  severity: 'serious',
  code: 'COLOR-CONTRAST',
  message: 'Text has contrast ratio 2.10:1 (minimum 4.5:1 required for normal text)',
  pageNumber: 3,
};

describe('analyzeColorContrast', () => {
  it('turns the validator-measured contrastData into a deterministic, high-confidence suggestion', () => {
    const issue: AuditIssue = {
      ...BASE_ISSUE,
      contrastData: {
        foreground: '#777777',
        background: '#ffffff',
        ratio: 2.1,
        requiredRatio: 4.5,
        isLargeText: false,
      },
    };

    const res = svc.analyzeColorContrast(issue);

    expect(res).toBeTruthy();
    expect(res.suggestionType).toBe('color-contrast');
    expect(res.applyMode).toBe('guidance-only');
    expect(res.model).toBe('rule-based');
    expect(res.confidence).toBe(0.95);
    expect(res.guidance).toContain('4.5:1');
    expect(res.guidance).toContain('#777777');
    expect(res.guidance).toContain('#ffffff');
    expect(res.rationale).toContain('2.1:1');
  });

  it('uses the large-text threshold when contrastData.isLargeText is true', () => {
    const issue: AuditIssue = {
      ...BASE_ISSUE,
      contrastData: {
        foreground: '#999999',
        background: '#ffffff',
        ratio: 2.6,
        requiredRatio: 3.0,
        isLargeText: true,
      },
    };

    const res = svc.analyzeColorContrast(issue);
    expect(res.guidance).toContain('3:1');
    expect(res.guidance).toContain('large text');
  });

  it('returns null when the issue has no contrastData (never calls Gemini)', () => {
    const res = svc.analyzeColorContrast(BASE_ISSUE);
    expect(res).toBeNull();
  });
});
