import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pdfa11yService, type Pdfa11yFailure } from '../../../../src/services/pdf/pdfa11y.service';
import { mapPdfa11yFailures } from '../../../../src/data/pdfa11y-matterhorn.map';

/**
 * Coverage for parseJsonReport, validated against REAL pdfa11y v0.0.11
 * output (tests/fixtures/pdf/pdfa11y-output/*.json — captured by running
 * the actual pdfa11y CLI locally against the same 3 fixture PDFs already
 * used to validate verapdf-matterhorn.map.ts).
 */

const FIXTURE_DIR = join(__dirname, '../../../fixtures/pdf/pdfa11y-output');

function loadFixtureJson(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf-8');
}

// parseJsonReport is private; tested via a direct cast, same pragmatic
// pattern used for verapdf.service.ts's parseMrrXml. Returns just
// `.failures` for the many existing tests below that only care about the
// parsed content — parseJsonReportFull (below) exposes the full
// { ok, failures } shape for the ok/malformed-report regression tests.
type JsonParseResult = { ok: boolean; failures: Pdfa11yFailure[] };
function parseJsonReportFull(json: string): JsonParseResult {
  return (pdfa11yService as unknown as { parseJsonReport: (json: string, filePath: string) => JsonParseResult })
    .parseJsonReport(json, 'test.pdf');
}
function parseJsonReport(json: string): Pdfa11yFailure[] {
  return parseJsonReportFull(json).failures;
}

describe('Pdfa11yService.parseJsonReport — real JSON output', () => {
  it('parses a font-not-embedded WARN (Matterhorn 31-009) from cp31-font-not-embedded.pdf', () => {
    const failures = parseJsonReport(loadFixtureJson('cp31-font-not-embedded.json'));
    const failure = failures.find((f) => f.ruleId === 'UA-09-001');

    expect(failure).toBeTruthy();
    expect(failure!.description).toContain('not embedded');
  });

  it('parses a missing-ToUnicode FAIL (Matterhorn 31-027) from cp31-font-not-embedded.pdf', () => {
    const failures = parseJsonReport(loadFixtureJson('cp31-font-not-embedded.json'));
    const failure = failures.find((f) => f.ruleId === 'UA-10-001');

    expect(failure).toBeTruthy();
    expect(failure!.description).toContain('Unicode');
  });

  it('parses a missing-ToUnicode FAIL from cp31-missing-tounicode.pdf', () => {
    const failures = parseJsonReport(loadFixtureJson('cp31-missing-tounicode.json'));
    const failure = failures.find((f) => f.ruleId === 'UA-10-001');

    expect(failure).toBeTruthy();
    expect(failure!.description).toContain('AboriginalSerif');
  });

  it('parses a missing PDF/UA-identifier FAIL (Matterhorn 06-002) from cp06-metadata-failures.pdf', () => {
    const failures = parseJsonReport(loadFixtureJson('cp06-metadata-failures.json'));
    const failure = failures.find((f) => f.ruleId === 'UA-06-003');

    expect(failure).toBeTruthy();
    expect(failure!.description).toContain('pdfuaid:part');
  });

  it('excludes PASS and N/A states, keeping only FAIL and WARN', () => {
    const failures = parseJsonReport(loadFixtureJson('cp31-font-not-embedded.json'));
    // This fixture has 69 total rules but only 2 real failures (1 WARN + 1 FAIL) --
    // the rest are PASS or N/A and must not appear in the parsed result.
    expect(failures.length).toBe(2);
    expect(failures.map((f) => f.ruleId).sort()).toEqual(['UA-09-001', 'UA-10-001']);
  });

  it('returns [] for empty or unparseable input without throwing', () => {
    expect(parseJsonReport('')).toEqual([]);
    expect(parseJsonReport('not json at all')).toEqual([]);
  });

  it('returns [] when the report array is empty', () => {
    expect(parseJsonReport('[]')).toEqual([]);
  });
});

describe('Pdfa11yService.parseJsonReport — synthetic shape regressions', () => {
  it('treats WARN the same as FAIL (pdfa11y downgrades some strict PDF/UA-1 requirements to WARN for leniency)', () => {
    const json = JSON.stringify([{
      path: 'test.pdf',
      verdict: 'FAIL',
      summary: { total: 1, passed: 0, failed: 0, errors: 0, warnings: 1, infos: 0, conforming: false },
      results: [{
        id: 'UA-09-001',
        title: 'All fonts are embedded',
        state: 'WARN',
        findings: [{ severity: 'warning', message: 'standard-14 font not embedded' }],
      }],
    }]);

    const failures = parseJsonReport(json);
    expect(failures).toHaveLength(1);
    expect(failures[0].ruleId).toBe('UA-09-001');
  });

  it('keeps only the FIRST finding when a rule has multiple (matches Ninja surfacing one representative issue per condition)', () => {
    const json = JSON.stringify([{
      path: 'test.pdf',
      verdict: 'FAIL',
      summary: { total: 1, passed: 0, failed: 1, errors: 1, warnings: 0, infos: 0, conforming: false },
      results: [{
        id: 'UA-28-025',
        title: 'Visible annotations expose a text description',
        state: 'FAIL',
        findings: [
          { severity: 'error', message: 'Link annotation on page 5 has neither...', location: { page: 5 } },
          { severity: 'error', message: 'Link annotation on page 6 has neither...', location: { page: 6 } },
        ],
      }],
    }]);

    const failures = parseJsonReport(json);
    expect(failures).toHaveLength(1);
    expect(failures[0].pageNumber).toBe(5);
    expect(failures[0].description).toContain('page 5');
  });

  it('extracts struct_path as context when present', () => {
    const json = JSON.stringify([{
      path: 'test.pdf',
      verdict: 'FAIL',
      summary: { total: 1, passed: 0, failed: 1, errors: 1, warnings: 0, infos: 0, conforming: false },
      results: [{
        id: 'UA-13-004',
        title: 'Figure has Alt or ActualText',
        state: 'FAIL',
        findings: [{
          severity: 'error',
          message: 'Figure has neither /Alt nor /ActualText',
          location: { page: 4, struct_path: '/Document/Art/Sect/P/Link/Figure' },
        }],
      }],
    }]);

    const failures = parseJsonReport(json);
    expect(failures[0].pageNumber).toBe(4);
    expect(failures[0].context).toBe('/Document/Art/Sect/P/Link/Figure');
  });

  it('leaves pageNumber/context undefined for document-level findings with no location', () => {
    const json = JSON.stringify([{
      path: 'test.pdf',
      verdict: 'FAIL',
      summary: { total: 1, passed: 0, failed: 1, errors: 1, warnings: 0, infos: 0, conforming: false },
      results: [{
        id: 'UA-06-003',
        title: 'XMP metadata declares PDF/UA identifier',
        state: 'FAIL',
        findings: [{ severity: 'error', message: 'XMP metadata is present but contains no pdfuaid:part identifier' }],
      }],
    }]);

    const failures = parseJsonReport(json);
    expect(failures[0].pageNumber).toBeUndefined();
    expect(failures[0].context).toBeUndefined();
  });
});

describe('Pdfa11yService.parseJsonReport — ok flag (CodeRabbit finding on PR #577)', () => {
  it('reports ok:true for a real, well-formed report, even with zero failures', () => {
    const json = JSON.stringify([{
      path: 'test.pdf',
      verdict: 'PASS',
      summary: { total: 1, passed: 1, failed: 0, errors: 0, warnings: 0, infos: 0, conforming: true },
      results: [{ id: 'UA-01-002', title: 'MarkInfo declares the document as marked', state: 'PASS' }],
    }]);

    expect(parseJsonReportFull(json)).toEqual({ ok: true, failures: [] });
  });

  it('reports ok:false for a technically-valid JSON object missing the expected report shape', () => {
    // Confirmed real bug: {} and {"results":[]} are valid JSON that the old
    // "starts with [ or {" check in validate() would accept, but neither is
    // pdfa11y's real report shape (a non-empty array whose first element
    // has a results array) -- indistinguishable from a real report with
    // zero failing rules without this check.
    expect(parseJsonReportFull('{}')).toEqual({ ok: false, failures: [] });
    expect(parseJsonReportFull('{"results":[]}')).toEqual({ ok: false, failures: [] });
  });

  it('reports ok:false for an empty array (not a real per-file report)', () => {
    expect(parseJsonReportFull('[]')).toEqual({ ok: false, failures: [] });
  });

  it('reports ok:false when the first array element has no results array', () => {
    expect(parseJsonReportFull('[{"path":"test.pdf","verdict":"PASS"}]')).toEqual({ ok: false, failures: [] });
  });

  it('reports ok:false for unparseable JSON', () => {
    expect(parseJsonReportFull('not json at all')).toEqual({ ok: false, failures: [] });
  });

  it('reports ok:true for the real captured fixtures', () => {
    expect(parseJsonReportFull(loadFixtureJson('cp31-font-not-embedded.json')).ok).toBe(true);
    expect(parseJsonReportFull(loadFixtureJson('cp31-missing-tounicode.json')).ok).toBe(true);
    expect(parseJsonReportFull(loadFixtureJson('cp06-metadata-failures.json')).ok).toBe(true);
  });
});

describe('Pdfa11yService.isAvailable / validate — graceful degradation', () => {
  it('reports unavailable and resolves validate() to { ran: false, failures: [] } when PDFA11Y_PATH is unset', async () => {
    if (process.env.PDFA11Y_PATH) return; // not this environment's concern
    expect(pdfa11yService.isAvailable()).toBe(false);
    // Codex finding on PR #577, confirmed real: `ran` must be false here,
    // not just `failures` empty — pac-report.service.ts needs to tell
    // "didn't run" apart from "ran and found nothing" to avoid classifying
    // an untested condition as a false PASS.
    await expect(pdfa11yService.validate('anything.pdf')).resolves.toEqual({ ran: false, failures: [] });
  });
});

describe('mapPdfa11yFailures — real fixture round-trip', () => {
  it('maps the real fixture failures to their Matterhorn condition IDs', () => {
    const failures: Pdfa11yFailure[] = [
      ...parseJsonReport(loadFixtureJson('cp31-font-not-embedded.json')),
      ...parseJsonReport(loadFixtureJson('cp31-missing-tounicode.json')),
      ...parseJsonReport(loadFixtureJson('cp06-metadata-failures.json')),
    ];

    const mapped = mapPdfa11yFailures(failures, new Set());

    expect(mapped.get('31-009')?.ruleId).toBe('UA-09-001');
    expect(mapped.get('31-027')?.ruleId).toBe('UA-10-001');
    expect(mapped.get('06-002')?.ruleId).toBe('UA-06-003');
  });

  it('skips a mapped condition already found by Ninja or veraPDF', () => {
    const failures = parseJsonReport(loadFixtureJson('cp06-metadata-failures.json'));
    const mapped = mapPdfa11yFailures(failures, new Set(['06-002']));
    expect(mapped.has('06-002')).toBe(false);
  });

  it('ignores an unmapped ruleId silently (no crash, just skipped)', () => {
    const failures: Pdfa11yFailure[] = [{ ruleId: 'UA-99-999', description: 'not in the map' }];
    const mapped = mapPdfa11yFailures(failures, new Set());
    expect(mapped.size).toBe(0);
  });
});
