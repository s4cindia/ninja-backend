import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import path from 'path';
import { parseAcrobatReport, MAX_ACROBAT_REPORT_BYTES } from '../../../../src/services/certification/acrobat-report-parser';

// Hand-written synthetic copy of the Acrobat report's structure -- never a
// real report (real ones carry the client's file name and local path).
const FIXTURE = readFileSync(
  path.join(__dirname, '../../../fixtures/acrobat-report/synthetic-acrobat-report.html'),
  'utf8',
);

/** Change one rule row's status cell, identified by its rule-id fragment. */
function setRuleStatus(html: string, ruleId: string, status: string): string {
  const re = new RegExp(`(#${ruleId}">[^<]*</a></td><td>)[^<]*(</td>)`);
  if (!re.test(html)) throw new Error(`fixture has no rule ${ruleId}`);
  return html.replace(re, `$1${status}$2`);
}

function setSummaryLine(html: string, label: string, n: number): string {
  const re = new RegExp(`<li>${label}: \\d+</li>`);
  if (!re.test(html)) throw new Error(`fixture has no summary line ${label}`);
  return html.replace(re, `<li>${label}: ${n}</li>`);
}

describe('parseAcrobatReport', () => {
  it('reads the summary counts and agrees with the rule table', () => {
    const result = parseAcrobatReport(FIXTURE);
    expect(result.trusted).toBe(true);
    expect(result.warnings).toEqual([]);
    expect(result.counts).toEqual({
      passed: 27, failed: 3, needsManualCheck: 2, skipped: 0, passedManually: 0, failedManually: 0,
    });
    expect(result.rules).toHaveLength(32);
  });

  it('lists failed rules with category, name and language-independent rule id', () => {
    const { failedRules } = parseAcrobatReport(FIXTURE);
    expect(failedRules.map((r) => [r.category, r.rule, r.ruleId])).toEqual([
      ['Page Content', 'Tab order', 'TabOrder'],
      ['Tables', 'Headers', 'TableHeaders'],
      ['Lists', 'List items', 'ListItems'],
    ]);
    expect(failedRules[0].description).toBe('Tab order is consistent with structure order');
  });

  it('keeps the two always-manual rules as Needs manual check, not failures', () => {
    const { rules } = parseAcrobatReport(FIXTURE);
    const manual = rules.filter((r) => r.status === 'Needs manual check').map((r) => r.ruleId);
    expect(manual).toEqual(['LogicalRO', 'ColorContrast']);
  });

  it('never returns the PDF file name', () => {
    const result = parseAcrobatReport(FIXTURE);
    expect(JSON.stringify(result)).not.toContain('synthetic-sample.pdf');
  });

  it('parses a clean report as 0 failed', () => {
    let html = FIXTURE;
    for (const id of ['TabOrder', 'TableHeaders', 'ListItems']) html = setRuleStatus(html, id, 'Passed');
    html = setSummaryLine(setSummaryLine(html, 'Passed', 30), 'Failed', 0);
    const result = parseAcrobatReport(html);
    expect(result.trusted).toBe(true);
    expect(result.counts?.failed).toBe(0);
    expect(result.failedRules).toEqual([]);
  });

  it('treats Failed manually as a failed rule and counts it separately', () => {
    let html = setRuleStatus(FIXTURE, 'LogicalRO', 'Failed manually');
    html = setSummaryLine(setSummaryLine(html, 'Needs manual check', 1), 'Failed manually', 1);
    const result = parseAcrobatReport(html);
    expect(result.trusted).toBe(true);
    expect(result.counts).toMatchObject({ failed: 3, failedManually: 1, needsManualCheck: 1 });
    expect(result.failedRules.map((r) => r.ruleId)).toContain('LogicalRO');
  });

  it('handles Skipped rules (a check not run)', () => {
    let html = setRuleStatus(FIXTURE, 'Multimedia', 'Skipped');
    html = setSummaryLine(setSummaryLine(html, 'Passed', 26), 'Skipped', 1);
    const result = parseAcrobatReport(html);
    expect(result.trusted).toBe(true);
    expect(result.counts).toMatchObject({ skipped: 1, passed: 26 });
  });

  it('is not trusted when the summary and the rule table disagree', () => {
    const html = setSummaryLine(FIXTURE, 'Failed', 0);
    const result = parseAcrobatReport(html);
    expect(result.trusted).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/failed=0 but the rule table has 3/);
    // Counts still offered for pre-filling the operator form.
    expect(result.counts?.failed).toBe(0);
    expect(result.failedRules).toHaveLength(3);
  });

  it('is not trusted when a rule has an unrecognised status (could hide a failure)', () => {
    const html = setRuleStatus(FIXTURE, 'TabOrder', 'Échec');
    const result = parseAcrobatReport(html);
    expect(result.trusted).toBe(false);
    expect(result.rules).toEqual([]);
    expect(result.counts?.failed).toBe(3); // from the summary only
    expect(result.warnings.join(' ')).toMatch(/unrecognised status "Échec"/);
  });

  it('falls back to table tallies when the summary is missing', () => {
    const html = FIXTURE.replace(/<h2>Summary<\/h2>[\s\S]*?<\/ul>/, '');
    const result = parseAcrobatReport(html);
    expect(result.trusted).toBe(false);
    expect(result.counts).toMatchObject({ passed: 27, failed: 3, needsManualCheck: 2 });
    expect(result.failedRules).toHaveLength(3);
  });

  it('uses summary counts when the rule table is missing', () => {
    const html = FIXTURE.replace(/<h2>Detailed Report<\/h2>[\s\S]*?<\/table>/, '');
    const result = parseAcrobatReport(html);
    expect(result.trusted).toBe(false);
    expect(result.counts?.failed).toBe(3);
    expect(result.failedRules).toEqual([]);
  });

  it('tolerates extra whitespace and line breaks inside cells', () => {
    const html = FIXTURE.replace('<td>Failed</td><td>Tab order', '<td>\n  Failed\n</td><td>Tab order');
    const result = parseAcrobatReport(html);
    expect(result.trusted).toBe(true);
    expect(result.failedRules[0].ruleId).toBe('TabOrder');
  });

  it('rejects a file that is not an Acrobat report', () => {
    const result = parseAcrobatReport('<html><body><h1>PAC report</h1><p>Failed: 0</p></body></html>');
    expect(result).toEqual({
      trusted: false, counts: null, failedRules: [], rules: [],
      warnings: ['File does not look like an Acrobat accessibility report.'],
    });
  });

  it('rejects oversized input without parsing it', () => {
    const big = FIXTURE + ' '.repeat(MAX_ACROBAT_REPORT_BYTES);
    const result = parseAcrobatReport(big);
    expect(result.trusted).toBe(false);
    expect(result.counts).toBeNull();
  });

  it('does not execute or keep script content', () => {
    const html = FIXTURE.replace('</body>', '<script>globalThis.__acrobatPwned = true;</script></body>');
    const result = parseAcrobatReport(html);
    expect(result.trusted).toBe(true);
    expect((globalThis as Record<string, unknown>).__acrobatPwned).toBeUndefined();
  });
});
