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
// used elsewhere in this suite for private-method coverage.
function parseMrrXml(xml: string): VeraPdfFailure[] {
  return (veraPdfService as unknown as { parseMrrXml: (xml: string, filePath: string) => VeraPdfFailure[] })
    .parseMrrXml(xml, 'test.pdf');
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

describe('VeraPdfService.isAvailable / validate — graceful degradation', () => {
  it('reports unavailable and resolves validate() to [] when VERAPDF_PATH is unset', async () => {
    if (process.env.VERAPDF_PATH) return; // not this environment's concern
    expect(veraPdfService.isAvailable()).toBe(false);
    await expect(veraPdfService.validate('anything.pdf')).resolves.toEqual([]);
  });
});

describe('mapVeraPdfFailures — real fixture round-trip', () => {
  it('maps all 3 validated fixture failures to their Matterhorn condition IDs', () => {
    const failures: VeraPdfFailure[] = [
      ...parseMrrXml(loadFixtureXml('cp31-font-not-embedded.xml')),
      ...parseMrrXml(loadFixtureXml('cp31-missing-tounicode.xml')),
      ...parseMrrXml(loadFixtureXml('cp06-metadata-failures.xml')),
    ];

    const mapped = mapVeraPdfFailures(failures, new Set());

    expect(mapped.size).toBe(3);
    expect(mapped.get('31-009')?.ruleId).toBe('1:7.21.4.1-1');
    expect(mapped.get('31-027')?.ruleId).toBe('1:7.21.7-1');
    expect(mapped.get('06-002')?.ruleId).toBe('1:5-1');
  });

  it('skips a mapped condition already found by a Ninja validator', () => {
    const failures = parseMrrXml(loadFixtureXml('cp06-metadata-failures.xml'));
    const mapped = mapVeraPdfFailures(failures, new Set(['06-002']));
    expect(mapped.size).toBe(0);
  });
});
