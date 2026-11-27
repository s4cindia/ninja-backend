/**
 * Acrobat Pro Accessibility Report parser
 *
 * Best-effort, server-side parse of the HTML report Acrobat Pro's
 * Accessibility Checker writes when "Create accessibility report" is ticked
 * (saved by default under %APPDATA%\Adobe\Acrobat\DC\AccReports). Used by
 * the EPUB-from-certified-PDF certification gate: the gate needs the Failed
 * count, and the names of the failed rules so an operator can record a
 * per-rule waiver for a known Acrobat false positive.
 *
 * Report structure the parser relies on (English-language Acrobat):
 *   - <h2>Summary</h2> followed by a <ul> of "<Label>: <n>" items
 *     (Needs manual check / Passed manually / Failed manually / Skipped /
 *     Passed / Failed).
 *   - <h2>Detailed Report</h2> followed by one <table> in which a
 *     <td class="cattitle"><h3>Category</h3></td> row starts each category,
 *     a <th> row repeats the column headings, and every other row is
 *     <td>rule (link)</td><td>status</td><td>description</td>. The link's
 *     #fragment (e.g. "TabOrder") is a language-independent rule id.
 *
 * The summary list and the rule table are parsed independently and
 * cross-checked. `trusted` is true only when both were found, every rule
 * status was recognised, and the two agree -- anything less and the caller
 * must fall back to operator-entered counts (the same fallback as the PAC
 * report). An unrecognised status is never guessed at, because it could be
 * hiding a failure.
 *
 * Privacy: the report's header carries the PDF's file name (and Acrobat
 * adds a `pdf-source` comment with its full local path). Those usually name
 * the client title, so the parser deliberately never reads or returns them.
 */

import * as cheerio from 'cheerio';
import type { Element } from 'domhandler';

/** Real reports are a few KB; anything far larger is not one. */
export const MAX_ACROBAT_REPORT_BYTES = 2 * 1024 * 1024;

export type AcrobatRuleStatus =
  | 'Passed'
  | 'Failed'
  | 'Needs manual check'
  | 'Skipped'
  | 'Passed manually'
  | 'Failed manually';

export interface AcrobatReportCounts {
  passed: number;
  failed: number;
  needsManualCheck: number;
  skipped: number;
  passedManually: number;
  failedManually: number;
}

export interface AcrobatRuleResult {
  category: string;
  rule: string;
  /** Link fragment from the rule's help URL, e.g. "TabOrder"; null if absent. */
  ruleId: string | null;
  status: AcrobatRuleStatus;
  description: string;
}

export interface AcrobatReportParseResult {
  /** True only when the counts can be used without operator entry. */
  trusted: boolean;
  /**
   * Best available counts (summary list, else tallied from the rule table),
   * for pre-filling the operator form. Null when neither could be read.
   */
  counts: AcrobatReportCounts | null;
  /** Every rule whose status is Failed or Failed manually. */
  failedRules: AcrobatRuleResult[];
  /** Every rule row found, in report order. */
  rules: AcrobatRuleResult[];
  /** Human-readable reasons `trusted` is false, or minor oddities. */
  warnings: string[];
}

const STATUS_BY_LOWER: Record<string, AcrobatRuleStatus> = {
  passed: 'Passed',
  failed: 'Failed',
  'needs manual check': 'Needs manual check',
  skipped: 'Skipped',
  'passed manually': 'Passed manually',
  'failed manually': 'Failed manually',
};

const COUNT_KEY_BY_STATUS: Record<AcrobatRuleStatus, keyof AcrobatReportCounts> = {
  Passed: 'passed',
  Failed: 'failed',
  'Needs manual check': 'needsManualCheck',
  Skipped: 'skipped',
  'Passed manually': 'passedManually',
  'Failed manually': 'failedManually',
};

const COUNT_KEYS: (keyof AcrobatReportCounts)[] = [
  'passed', 'failed', 'needsManualCheck', 'skipped', 'passedManually', 'failedManually',
];

function normaliseText(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function emptyCounts(): AcrobatReportCounts {
  return { passed: 0, failed: 0, needsManualCheck: 0, skipped: 0, passedManually: 0, failedManually: 0 };
}

function untrusted(warnings: string[]): AcrobatReportParseResult {
  return { trusted: false, counts: null, failedRules: [], rules: [], warnings };
}

/** The first element of `tag` after the <h2> whose text is `heading`, before the next <h2>. */
function findAfterHeading(
  $: cheerio.CheerioAPI,
  heading: string,
  tag: string,
): cheerio.Cheerio<Element> | null {
  const h2 = $('h2').filter((_, el) => normaliseText($(el).text()).toLowerCase() === heading.toLowerCase()).first();
  if (h2.length === 0) return null;
  const found = h2.nextUntil('h2', tag).first();
  return found.length > 0 ? found : null;
}

function parseSummary($: cheerio.CheerioAPI, warnings: string[]): AcrobatReportCounts | null {
  const list = findAfterHeading($, 'Summary', 'ul');
  if (!list) {
    warnings.push('Summary list not found.');
    return null;
  }

  const counts = emptyCounts();
  const seen = new Set<keyof AcrobatReportCounts>();
  list.children('li').each((_, li) => {
    const text = normaliseText($(li).text());
    const match = /^(.+?):\s*(\d+)$/.exec(text);
    const status = match ? STATUS_BY_LOWER[match[1].toLowerCase()] : undefined;
    if (!match || !status) {
      warnings.push(`Unrecognised summary line: "${text}".`);
      return;
    }
    const key = COUNT_KEY_BY_STATUS[status];
    counts[key] = Number(match[2]);
    seen.add(key);
  });

  // Acrobat always writes the Passed and Failed lines; without both the
  // list isn't one we understand.
  if (!seen.has('passed') || !seen.has('failed')) {
    warnings.push('Summary list is missing its Passed or Failed line.');
    return null;
  }
  return counts;
}

function ruleIdFromHref(href: string | undefined): string | null {
  if (!href) return null;
  const hash = href.indexOf('#');
  if (hash < 0 || hash === href.length - 1) return null;
  return href.slice(hash + 1);
}

/** Null when the table is missing or any row can't be read. */
function parseRuleTable($: cheerio.CheerioAPI, warnings: string[]): AcrobatRuleResult[] | null {
  const table = findAfterHeading($, 'Detailed Report', 'table');
  if (!table) {
    warnings.push('Detailed Report table not found.');
    return null;
  }

  const rules: AcrobatRuleResult[] = [];
  let category: string | null = null;
  let unreadable = false;

  table.find('tr').each((_, tr) => {
    const row = $(tr);
    const cells = row.children('td');

    const catCell = cells.filter('.cattitle');
    if (catCell.length > 0) {
      category = normaliseText(catCell.first().text());
      return;
    }
    if (cells.length === 0) return; // the repeated <th> heading row

    if (cells.length !== 3) {
      warnings.push(`Rule row with ${cells.length} cells (expected 3).`);
      unreadable = true;
      return;
    }

    const ruleCell = cells.eq(0);
    const rule = normaliseText(ruleCell.text());
    const statusText = normaliseText(cells.eq(1).text());
    const status = STATUS_BY_LOWER[statusText.toLowerCase()];
    if (!status) {
      warnings.push(`Rule "${rule}" has unrecognised status "${statusText}".`);
      unreadable = true;
      return;
    }
    if (!category) {
      warnings.push(`Rule "${rule}" appears before any category heading.`);
    }

    rules.push({
      category: category ?? '',
      rule,
      ruleId: ruleIdFromHref(ruleCell.find('a').first().attr('href')),
      status,
      description: normaliseText(cells.eq(2).text()),
    });
  });

  if (unreadable) return null;
  if (rules.length === 0) {
    warnings.push('Detailed Report table has no rule rows.');
    return null;
  }
  return rules;
}

function tally(rules: AcrobatRuleResult[]): AcrobatReportCounts {
  const counts = emptyCounts();
  for (const r of rules) counts[COUNT_KEY_BY_STATUS[r.status]]++;
  return counts;
}

function looksLikeAcrobatReport(html: string, $: cheerio.CheerioAPI): boolean {
  const generator = $('meta[name="generator"]').attr('content') ?? '';
  return /Generated by Adobe Acrobat/i.test(html)
    || /acrobat/i.test(generator)
    || normaliseText($('h1').first().text()).toLowerCase() === 'accessibility report';
}

export function parseAcrobatReport(html: string): AcrobatReportParseResult {
  if (Buffer.byteLength(html, 'utf8') > MAX_ACROBAT_REPORT_BYTES) {
    return untrusted([`File is larger than ${MAX_ACROBAT_REPORT_BYTES} bytes; not an Acrobat accessibility report.`]);
  }

  const $ = cheerio.load(html);
  if (!looksLikeAcrobatReport(html, $)) {
    return untrusted(['File does not look like an Acrobat accessibility report.']);
  }

  const warnings: string[] = [];
  const summary = parseSummary($, warnings);
  const rules = parseRuleTable($, warnings);
  const tableCounts = rules ? tally(rules) : null;

  let trusted = summary !== null && tableCounts !== null;
  if (summary && tableCounts) {
    for (const key of COUNT_KEYS) {
      if (summary[key] !== tableCounts[key]) {
        warnings.push(`Summary says ${key}=${summary[key]} but the rule table has ${tableCounts[key]}.`);
        trusted = false;
      }
    }
  }

  const allRules = rules ?? [];
  return {
    trusted,
    counts: summary ?? tableCounts,
    failedRules: allRules.filter((r) => r.status === 'Failed' || r.status === 'Failed manually'),
    rules: allRules,
    warnings,
  };
}
