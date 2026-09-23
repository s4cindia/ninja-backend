import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { veraPdfService, type VeraPdfFailure } from '../../../../src/services/pdf/verapdf.service';
import { mapVeraPdfFailures } from '../../../../src/data/verapdf-matterhorn.map';

/**
 * Coverage for parseMrrXml, validated against REAL veraPDF 1.30.2 MRR output
 * (tests/fixtures/pdf/verapdf-output/*.xml — captured by running the actual
 * veraPDF CLI locally, not a hand-written fixture).
 *
 * This caught two real bugs in the original implementation, which assumed
 * an MRR shape that doesn't match real veraPDF 1.30.2 output:
 *   1. specMajor regex matched the wrong trailing digits when the
 *      specification string includes a year, e.g. "ISO 14289-1:2014".
 *   2. <check> elements are direct children of <rule> — there is no
 *      wrapping <checks> element.
 */

const FIXTURE_DIR = join(__dirname, '../../../fixtures/pdf/verapdf-output');

function loadFixtureXml(name: string): string {
  return readFileSync(join(FIXTURE_DIR, name), 'utf-8');
}

// parseMrrXml is private; tested via a direct cast, same pragmatic pattern
// used elsewhere in this suite for private-method coverage. Returns just
// `.failures` for the many existing tests below that only care about the
// parsed content — parseMrrXmlFull (below) exposes the full { ok, failures }
// shape for the ok/malformed-report regression tests.
type MrrParseResult = { ok: boolean; failures: VeraPdfFailure[] };
function parseMrrXmlFull(xml: string): MrrParseResult {
  return (veraPdfService as unknown as { parseMrrXml: (xml: string, filePath: string) => MrrParseResult })
    .parseMrrXml(xml, 'test.pdf');
}
function parseMrrXml(xml: string): VeraPdfFailure[] {
  return parseMrrXmlFull(xml).failures;
}

describe('VeraPdfService.parseMrrXml — real MRR output', () => {
  it('parses a font-not-embedded failure (Matterhorn 31-009) with the correct ruleId', () => {
    const failures = parseMrrXml(loadFixtureXml('cp31-font-not-embedded.xml'));

    expect(failures).toHaveLength(1);
    expect(failures[0].ruleId).toBe('1:7.21.4.1-1');
    expect(failures[0].description).toMatch(/font programs.*embedded/i);
    expect(failures[0].pageNumber).toBe(1);
    expect(failures[0].context).toContain('pages[0]');
  });

  it('parses a missing-ToUnicode failure (Matterhorn 31-027) with the correct ruleId', () => {
    const failures = parseMrrXml(loadFixtureXml('cp31-missing-tounicode.xml'));

    expect(failures).toHaveLength(1);
    expect(failures[0].ruleId).toBe('1:7.21.7-1');
    expect(failures[0].description).toMatch(/ToUnicode/i);
    expect(failures[0].pageNumber).toBe(1);
  });

  it('parses a missing PDF/UA-identifier failure (Matterhorn 06-002) with the correct ruleId', () => {
    const failures = parseMrrXml(loadFixtureXml('cp06-metadata-failures.xml'));

    expect(failures).toHaveLength(1);
    expect(failures[0].ruleId).toBe('1:5-1');
    expect(failures[0].description).toMatch(/PDF\/UA Identification/i);
    // Document-level metadata check — context has no pages[N] segment, so
    // there is genuinely no page to report (unlike the two font checks above).
    expect(failures[0].pageNumber).toBeUndefined();
    expect(failures[0].context).toContain('metadata[0]');
  });

  it('parses a Type1-font CharSet-omits-a-glyph failure (Matterhorn 31-012) with the correct ruleId', () => {
    // Fixture trimmed from real veraPDF 1.30.2 MRR output captured live
    // against a real 377-page document (132 real failing checks) -- see
    // verapdf-matterhorn.map.ts's own comment on this entry for why no
    // dedicated minimal fixture PDF was built for this specific condition.
    const failures = parseMrrXml(loadFixtureXml('cp31-charset-incomplete.xml'));

    expect(failures).toHaveLength(1);
    expect(failures[0].ruleId).toBe('1:7.21.4.2-1');
    expect(failures[0].description).toMatch(/CharSet.*list.*glyphs present/i);
    expect(failures[0].pageNumber).toBe(1);
  });

  it('does not mistake the specification year for the spec part number', () => {
    // Regression test for the real bug: /\d+$/ matched "2014" (the year) in
    // "ISO 14289-1:2014" instead of "1" (the actual PDF/UA part number).
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<report>
  <jobs>
    <job>
      <validationReport>
        <details>
          <rule specification="ISO 14289-1:2014" clause="7.1" testNumber="9" status="failed">
            <description>Synthetic rule for regression coverage</description>
            <check status="failed">
              <context>root/document[0]/pages[2](5 0 obj PDPage)</context>
              <errorMessage>synthetic</errorMessage>
            </check>
          </rule>
        </details>
      </validationReport>
    </job>
  </jobs>
</report>`;

    const failures = parseMrrXml(xml);
    expect(failures).toHaveLength(1);
    expect(failures[0].ruleId).toBe('1:7.1-9');
    expect(failures[0].pageNumber).toBe(3); // pages[2] -> 1-based page 3
  });

  it('ignores rules with status other than failed', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<report>
  <jobs>
    <job>
      <validationReport>
        <details>
          <rule specification="ISO 14289-1:2014" clause="7.1" testNumber="1" status="passed">
            <description>Should be skipped</description>
          </rule>
        </details>
      </validationReport>
    </job>
  </jobs>
</report>`;

    expect(parseMrrXml(xml)).toEqual([]);
  });

  it('returns [] for non-XML input without throwing', () => {
    expect(parseMrrXml('')).toEqual([]);
    expect(parseMrrXml('not xml at all')).toEqual([]);
  });
});

describe('VeraPdfService.parseMrrXml — ok flag (CodeRabbit finding on PR #577)', () => {
  it('reports ok:true for a real, well-formed report, even with zero failures', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<report>
  <jobs>
    <job>
      <validationReport>
        <details>
        </details>
      </validationReport>
    </job>
  </jobs>
</report>`;

    expect(parseMrrXmlFull(xml)).toEqual({ ok: true, failures: [] });
  });

  it('reports ok:false for XML that merely contains the substring "<report" but is not real MRR structure', () => {
    // A genuinely malformed/truncated report -- e.g. a stray log line or a
    // process crash mid-write -- could still contain "<report" without
    // being a real report at all. Confirmed real bug: the old code
    // returned [] here (a legitimate empty result), indistinguishable from
    // a real report with zero failing rules.
    expect(parseMrrXmlFull('<report>this is not real MRR XML</report>')).toEqual({ ok: false, failures: [] });
  });

  it('reports ok:false when <jobs>/<job> is missing entirely', () => {
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<report>
  <buildInformation></buildInformation>
</report>`;

    expect(parseMrrXmlFull(xml)).toEqual({ ok: false, failures: [] });
  });

  it('reports ok:false for unparseable XML (parse exception)', () => {
    expect(parseMrrXmlFull('<report><unclosed-tag></report>').ok).toBe(false);
  });

  it('reports ok:true for the real captured fixtures', () => {
    expect(parseMrrXmlFull(loadFixtureXml('cp31-font-not-embedded.xml')).ok).toBe(true);
    expect(parseMrrXmlFull(loadFixtureXml('cp31-missing-tounicode.xml')).ok).toBe(true);
    expect(parseMrrXmlFull(loadFixtureXml('cp06-metadata-failures.xml')).ok).toBe(true);
    expect(parseMrrXmlFull(loadFixtureXml('cp31-charset-incomplete.xml')).ok).toBe(true);
  });
});

describe('VeraPdfService.isAvailable / validate — graceful degradation', () => {
  it('reports unavailable and resolves validate() to { ran: false, failures: [] } when VERAPDF_PATH is unset', async () => {
    if (process.env.VERAPDF_PATH) return; // not this environment's concern
    expect(veraPdfService.isAvailable()).toBe(false);
    // Codex finding on PR #577, confirmed real: `ran` must be false here,
    // not just `failures` empty — a caller (pac-report.service.ts) needs to
    // tell "didn't run" apart from "ran and found nothing" to avoid
    // classifying an untested condition as a false PASS.
    await expect(veraPdfService.validate('anything.pdf')).resolves.toEqual({ ran: false, failures: [] });
  });
});

describe('mapVeraPdfFailures — real fixture round-trip', () => {
  it('maps all 4 validated fixture failures to their Matterhorn condition IDs', () => {
    const failures: VeraPdfFailure[] = [
      ...parseMrrXml(loadFixtureXml('cp31-font-not-embedded.xml')),
      ...parseMrrXml(loadFixtureXml('cp31-missing-tounicode.xml')),
      ...parseMrrXml(loadFixtureXml('cp06-metadata-failures.xml')),
      ...parseMrrXml(loadFixtureXml('cp31-charset-incomplete.xml')),
    ];

    const mapped = mapVeraPdfFailures(failures, new Set());

    expect(mapped.size).toBe(4);
    expect(mapped.get('31-009')?.ruleId).toBe('1:7.21.4.1-1');
    expect(mapped.get('31-027')?.ruleId).toBe('1:7.21.7-1');
    expect(mapped.get('06-002')?.ruleId).toBe('1:5-1');
    expect(mapped.get('31-012')?.ruleId).toBe('1:7.21.4.2-1');
  });

  it('skips a mapped condition already found by a Ninja validator', () => {
    const failures = parseMrrXml(loadFixtureXml('cp06-metadata-failures.xml'));
    const mapped = mapVeraPdfFailures(failures, new Set(['06-002']));
    expect(mapped.size).toBe(0);
  });
});
