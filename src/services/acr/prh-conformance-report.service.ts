/**
 * PRH UK conformance report (P5/PR4).
 *
 * Produces a structured "is this EPUB ready for PRH delivery?"
 * report from the persisted audit result. Classifies outstanding
 * PRH-* issues by priority tier (P1 — metadata/spine/nav, P2 —
 * boilerplate/copyright/brand/title/socials/order, P3 — markup
 * conventions + text-pattern heuristics) and reports per-tier
 * pass/fail counts so operators can make an informed export
 * decision.
 *
 * Two outputs:
 *   - `generatePrhConformanceReport(jobId)` returns the JSON
 *     structure (typed). Used by the export-bundle path and by
 *     the preflight endpoint.
 *   - `renderHtml(report)` returns a human-readable HTML version
 *     bundled alongside the JSON in the export zip.
 *
 * Skips entirely on non-PRH jobs — throws a descriptive error
 * the caller translates to a 400 / "not applicable" response.
 */

import prisma from '../../lib/prisma';

export type PriorityTier = 'P1' | 'P2' | 'P3' | 'P4';

export interface PrhConformanceIssue {
  code: string;
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  message: string;
  location: string;
  priorityTier: PriorityTier;
}

export interface PrhConformancePriorityStatus {
  tier: PriorityTier;
  passed: number;
  failed: number;
  outstanding: PrhConformanceIssue[];
}

export interface PrhConformanceReport {
  jobId: string;
  fileName: string | null;
  bookTitle: string | null;
  publisherProfile: {
    publisher: 'PRH-UK';
    imprint: string | null;
    confidence: 'medium' | 'high';
  };
  auditedAt: string;
  /** Per-priority tier breakdown for at-a-glance status. */
  priorityStatus: PrhConformancePriorityStatus[];
  /** All outstanding PRH-* issues, flat list. */
  outstandingIssues: PrhConformanceIssue[];
  conformsTo: 'EPUB Accessibility 1.1 - WCAG 2.2 Level AA';
  certifier: {
    name: 'Penguin Random House UK';
    credential: 'Ace by DAISY OK';
    /** Public accessibility-statement URL, embedded in the VPAT too. */
    publicUrl: 'https://www.penguin.co.uk/accessibility';
  };
  /**
   * True when ALL P1 + P2 issues are resolved. P3 + P4 are
   * advisory — the export doesn't block on them. When false, the
   * UI surfaces a "requires operator confirmation" prompt before
   * the export proceeds.
   */
  readyForDelivery: boolean;
}

/**
 * Build the conformance report. Throws when the job isn't a
 * PRH-UK build OR doesn't have an audit result yet — the caller
 * (controller, exporter) catches these and returns 400 / "not
 * applicable".
 */
export async function generatePrhConformanceReport(jobId: string): Promise<PrhConformanceReport> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, output: true, input: true },
  });
  if (!job) throw new Error(`Job ${jobId} not found`);
  if (!job.output) throw new Error(`Job ${jobId} has no audit output — run an audit first`);

  const output = job.output as Record<string, unknown>;
  const profile = (output.publisherProfile && typeof output.publisherProfile === 'object')
    ? (output.publisherProfile as Record<string, unknown>)
    : null;

  if (!profile || profile.publisher !== 'PRH-UK') {
    throw new Error('PRH conformance report only available on PRH-UK jobs');
  }
  if (profile.confidence !== 'medium' && profile.confidence !== 'high') {
    throw new Error('PRH conformance report requires medium-or-high publisher-profile confidence');
  }

  const fileName = readJobInputFileName(job.input);
  const bookTitle = typeof output.bookTitle === 'string' ? output.bookTitle : null;
  const auditedAt = typeof output.auditedAt === 'string' ? output.auditedAt : new Date().toISOString();

  // Walk combinedIssues, classify each PRH-* code by priority tier.
  const issues = Array.isArray(output.combinedIssues) ? output.combinedIssues : [];
  const outstandingIssues: PrhConformanceIssue[] = [];
  for (const raw of issues) {
    if (typeof raw !== 'object' || raw === null) continue;
    const issue = raw as Record<string, unknown>;
    const code = typeof issue.code === 'string' ? issue.code : null;
    if (!code || !code.startsWith('PRH-')) continue;
    const tier = priorityTierForCode(code);
    if (!tier) continue;
    outstandingIssues.push({
      code,
      severity: (typeof issue.severity === 'string' ? issue.severity : 'minor') as PrhConformanceIssue['severity'],
      message: typeof issue.message === 'string' ? issue.message : code,
      location: typeof issue.location === 'string' ? issue.location : 'EPUB',
      priorityTier: tier,
    });
  }

  const priorityStatus = (['P1', 'P2', 'P3', 'P4'] as const).map((tier) => {
    const outstanding = outstandingIssues.filter((i) => i.priorityTier === tier);
    return {
      tier,
      passed: TIER_CODE_COUNT[tier] - outstanding.length,
      failed: outstanding.length,
      outstanding,
    };
  });

  const p1p2Outstanding = outstandingIssues.filter((i) => i.priorityTier === 'P1' || i.priorityTier === 'P2');
  const readyForDelivery = p1p2Outstanding.length === 0;

  return {
    jobId,
    fileName,
    bookTitle,
    publisherProfile: {
      publisher: 'PRH-UK',
      imprint: typeof profile.imprint === 'string' ? profile.imprint : null,
      confidence: profile.confidence as 'medium' | 'high',
    },
    auditedAt,
    priorityStatus,
    outstandingIssues,
    conformsTo: 'EPUB Accessibility 1.1 - WCAG 2.2 Level AA',
    certifier: {
      name: 'Penguin Random House UK',
      credential: 'Ace by DAISY OK',
      publicUrl: 'https://www.penguin.co.uk/accessibility',
    },
    readyForDelivery,
  };
}

/**
 * Render the report as a standalone HTML document — bundled
 * alongside the JSON in the export zip so operators can open the
 * report in a browser without tooling.
 */
export function renderHtml(report: PrhConformanceReport): string {
  const escape = (s: string): string =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  const tierRows = report.priorityStatus
    .map((tier) => `
      <tr>
        <td>${tier.tier}</td>
        <td>${tier.passed}</td>
        <td>${tier.failed}</td>
        <td>${tier.failed === 0 ? '✓ Pass' : '✗ Outstanding'}</td>
      </tr>`)
    .join('');

  const issueRows = report.outstandingIssues
    .map((issue) => `
      <tr>
        <td>${escape(issue.code)}</td>
        <td>${escape(issue.priorityTier)}</td>
        <td>${escape(issue.severity)}</td>
        <td>${escape(issue.location)}</td>
        <td>${escape(issue.message)}</td>
      </tr>`)
    .join('');

  const verdictBanner = report.readyForDelivery
    ? `<div style="background:#d4edda;color:#155724;padding:12px;border-radius:4px;margin:16px 0;">✓ Ready for PRH delivery — all P1 + P2 issues resolved.</div>`
    : `<div style="background:#f8d7da;color:#721c24;padding:12px;border-radius:4px;margin:16px 0;">✗ NOT ready for delivery — ${report.priorityStatus.filter((t) => (t.tier === 'P1' || t.tier === 'P2') && t.failed > 0).reduce((sum, t) => sum + t.failed, 0)} P1/P2 issue(s) outstanding.</div>`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>PRH UK Conformance Report — ${escape(report.bookTitle ?? report.fileName ?? report.jobId)}</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 960px; margin: 2em auto; padding: 0 1em; color: #222; }
  h1 { border-bottom: 2px solid #888; padding-bottom: 0.3em; }
  table { border-collapse: collapse; width: 100%; margin: 1em 0; }
  th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid #ddd; vertical-align: top; }
  th { background: #f4f4f4; }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; }
  dt { font-weight: 600; }
  .meta { background: #f9f9f9; padding: 16px; border-radius: 4px; }
</style>
</head>
<body>
<h1>PRH UK Conformance Report</h1>
${verdictBanner}
<div class="meta">
<dl>
  <dt>Job ID</dt><dd>${escape(report.jobId)}</dd>
  <dt>Book title</dt><dd>${escape(report.bookTitle ?? '(not in OPF dc:title)')}</dd>
  <dt>File</dt><dd>${escape(report.fileName ?? '(unknown)')}</dd>
  <dt>Publisher</dt><dd>${escape(report.publisherProfile.publisher)} / ${escape(report.publisherProfile.imprint ?? 'unknown imprint')} (${escape(report.publisherProfile.confidence)} confidence)</dd>
  <dt>Audited at</dt><dd>${escape(report.auditedAt)}</dd>
  <dt>Conforms to</dt><dd>${escape(report.conformsTo)}</dd>
  <dt>Certifier</dt><dd>${escape(report.certifier.name)} — ${escape(report.certifier.credential)}</dd>
  <dt>Accessibility statement</dt><dd><a href="${escape(report.certifier.publicUrl)}">${escape(report.certifier.publicUrl)}</a></dd>
</dl>
</div>

<h2>Status by Priority Tier</h2>
<table>
<thead><tr><th>Tier</th><th>Passed</th><th>Failed</th><th>Status</th></tr></thead>
<tbody>${tierRows}</tbody>
</table>

<h2>Outstanding Issues (${report.outstandingIssues.length})</h2>
${report.outstandingIssues.length === 0
  ? '<p>No outstanding PRH issues — all checks pass.</p>'
  : `<table>
      <thead><tr><th>Code</th><th>Tier</th><th>Severity</th><th>Location</th><th>Message</th></tr></thead>
      <tbody>${issueRows}</tbody>
    </table>`}

<p style="color:#666;font-size:0.9em;margin-top:3em;">
P1 + P2 must pass for delivery readiness. P3 + P4 are advisory.
Generated by Ninja Accessibility Platform.
</p>
</body>
</html>
`;
}

// ── helpers ──────────────────────────────────────────────────────────────

/**
 * Total count of codes per priority tier in the canonical PRH-*
 * code registry. Used to compute "passed" counts (total tier
 * codes minus outstanding). Hard-coded so the report doesn't have
 * to re-read prh-issue-codes.ts at runtime.
 */
const TIER_CODE_COUNT: Record<PriorityTier, number> = {
  // P1 — metadata (6) + spine (2) + nav (5) + per-XHTML (2) + image (2) = 17
  P1: 17,
  // P2 — copyright (8) + brand (3) + title (4) + socials (5) + order (5) = 25
  P2: 25,
  // P3 — body epub:type + doc-* ARIA (8) + forbidden (3) + notes/pagebreak (2) + text heuristics (3) = 16
  P3: 16,
  // P4 has no PRH-* codes (AI policy gate + cover-alt template were
  // implemented as behaviors, not new codes). 0 to keep the type happy.
  P4: 0,
};

/**
 * Map every PRH-* code prefix to its priority tier. Anything that
 * doesn't match returns null — the report ignores codes outside
 * the PRH validator family even if they happen to start with
 * `PRH-`.
 */
function priorityTierForCode(code: string): PriorityTier | null {
  // P1
  if (code.startsWith('PRH-META-')) return 'P1';
  if (code.startsWith('PRH-SPINE-')) return 'P1';
  if (code.startsWith('PRH-NAV-')) return 'P1';
  if (code.startsWith('PRH-XHTML-')) return 'P1';
  if (code === 'PRH-COVER-ALT-EMPTY') return 'P1';
  if (code === 'PRH-DECORATIVE-MISSING-PRESENTATION-ROLE') return 'P1';

  // P2
  if (code.startsWith('PRH-COPY-')) return 'P2';
  if (code.startsWith('PRH-BRAND-')) return 'P2';
  if (code.startsWith('PRH-TITLE-')) return 'P2';
  if (code.startsWith('PRH-SOCIALS-')) return 'P2';
  if (code.startsWith('PRH-ORDER-')) return 'P2';

  // P3
  if (code.startsWith('PRH-MARKUP-')) return 'P3';
  if (code.startsWith('PRH-ARIA-')) return 'P3';
  if (code === 'PRH-BODY-HAS-ARIA') return 'P3';
  if (code === 'PRH-PAGEBREAK-MALFORMED') return 'P3';
  if (code === 'PRH-FOOTNOTE-ID-MISMATCH') return 'P3';
  if (code === 'PRH-TABLE-LAYOUT-WITHOUT-PRESENTATION') return 'P3';
  if (code === 'PRH-LANG-INLINE-NOT-MARKED') return 'P3';
  if (code === 'PRH-HASHTAG-NOT-CAMEL-CASE') return 'P3';
  if (code === 'PRH-ACRONYM-INSERTED-SEPARATORS') return 'P3';

  return null;
}

function readJobInputFileName(input: unknown): string | null {
  if (!input || typeof input !== 'object') return null;
  const inputObj = input as { originalName?: unknown; fileName?: unknown };
  if (typeof inputObj.originalName === 'string') return inputObj.originalName;
  if (typeof inputObj.fileName === 'string') return inputObj.fileName;
  return null;
}
