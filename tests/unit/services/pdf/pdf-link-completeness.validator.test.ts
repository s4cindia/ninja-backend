/**
 * PdfLinkCompletenessValidator -- detects URL-shaped PLAIN TEXT with no
 * underlying Link annotation at all. Distinct from PdfLinkValidator, which
 * only judges the text quality of links that already exist.
 *
 * Real incident: Curiel_187961_CSHP.pdf has ZERO annotations of any kind
 * anywhere in the document (confirmed via direct pikepdf inspection)
 * despite ~200 reference-list citation URLs rendered as plain, unstyled
 * prose text -- PAC's "Link in text does not have a 'Link' element" /
 * "Completeness of 'Link' elements" finding.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { pdfAuditService } from '../../../../src/services/pdf/pdf-audit.service';
import { pdfComprehensiveParserService } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';
import { pdfParserService } from '../../../../src/services/pdf/pdf-parser.service';
import { pdfLinkCompletenessValidator } from '../../../../src/services/pdf/validators/pdf-link-completeness.validator';

async function linkIssuesFor(text: string): Promise<import('../../../../src/services/audit/base-audit.service').AuditIssue[]> {
  const src = await PDFDocument.create();
  const page = src.addPage([500, 300]);
  const font = await src.embedFont(StandardFonts.Helvetica);
  page.drawText(text, { x: 60, y: 200, size: 12, font, color: rgb(0, 0, 0) });
  const buffer = Buffer.from(await src.save());
  const report = await pdfAuditService.runAuditFromBuffer(buffer, `link-completeness-${Date.now()}-${Math.random()}`, 'test.pdf', 'custom', ['links']);
  return report.issues.filter(i => i.code === 'LINK-MISSING-ANNOTATION');
}

describe('PdfLinkCompletenessValidator', () => {
  it('flags a plain-text https:// citation URL with no real hyperlink', async () => {
    const issues = await linkIssuesFor('See the policy at https://cwrp.ca/policy-legislation for details.');

    expect(issues.length).toBe(1);
    expect(issues[0].context).toContain('https://cwrp.ca/policy-legislation');
    expect(issues[0].matterhornCheckpoint).toBe('28-011');
    expect(issues[0].category).toBe('links');
  });

  it('flags a plain-text www.-prefixed URL (no explicit scheme)', async () => {
    const issues = await linkIssuesFor('Published by www.canadianscholars.ca in 2024.');

    expect(issues.length).toBe(1);
    expect(issues[0].context).toContain('www.canadianscholars.ca');
  });

  it('strips trailing sentence punctuation from the reported URL', async () => {
    const issues = await linkIssuesFor('Visit https://example.com/accessibility.');

    expect(issues.length).toBe(1);
    expect(issues[0].context).toContain('https://example.com/accessibility');
    expect(issues[0].context).not.toContain('accessibility.');
  });

  it('does not flag an incomplete fragment with no domain-name dot', async () => {
    // A bare "https://cyccb" (no ".tld") is not a usable link target as
    // printed -- real incident on Curiel_187961_CSHP.pdf where a
    // line/kerning split left exactly this kind of unusable fragment.
    const issues = await linkIssuesFor('The organization (https://cyccb) offers resources.');

    expect(issues.length).toBe(0);
  });

  it('does not flag a bare "www." with nothing meaningful after it', async () => {
    const issues = await linkIssuesFor('For more, see www. or ask a librarian.');

    expect(issues.length).toBe(0);
  });

  it('reports multiple distinct URLs on the same page as separate issues', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([500, 300]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('First: https://example.com/one', { x: 60, y: 220, size: 12, font, color: rgb(0, 0, 0) });
    page.drawText('Second: https://example.org/two', { x: 60, y: 200, size: 12, font, color: rgb(0, 0, 0) });
    const buffer = Buffer.from(await src.save());
    const report = await pdfAuditService.runAuditFromBuffer(buffer, 'link-completeness-multi', 'test.pdf', 'custom', ['links']);
    const issues = report.issues.filter(i => i.code === 'LINK-MISSING-ANNOTATION');

    expect(issues.length).toBe(2);
    expect(issues.some(i => i.context?.includes('example.com/one'))).toBe(true);
    expect(issues.some(i => i.context?.includes('example.org/two'))).toBe(true);
  });

  it('catches a second URL in the SAME text item, not just the first', async () => {
    // CodeRabbit finding on PR #637, confirmed real: a single pdf.js text
    // item can legitimately contain more than one URL (one drawText call =
    // one item here); an exec()-only match silently dropped every match
    // after the first.
    const issues = await linkIssuesFor('See https://example.com/one and https://example.org/two for details.');

    expect(issues.length).toBe(2);
    expect(issues.some(i => i.context?.includes('example.com/one'))).toBe(true);
    expect(issues.some(i => i.context?.includes('example.org/two'))).toBe(true);
  });

  it('does not flag ordinary prose with no URL-shaped text at all', async () => {
    const issues = await linkIssuesFor('This is a perfectly ordinary sentence with no web address in it.');

    expect(issues.length).toBe(0);
  });

  it('reports a boundingBox whose top sits above the baseline (covering the glyphs), not below it', async () => {
    // CodeRabbit finding on PR #637, confirmed real: transform[5] is the
    // baseline, which sits near the BOTTOM of a line of text -- a box
    // anchored there extending further down covers blank space under the
    // line, not the text itself. Page height 300, drawText at y:200,
    // size:12 -> baseline (top-down) = 300-200 = 100; the box's top should
    // be ~fontSize above that (88), not AT it (100).
    const issues = await linkIssuesFor('Visit https://example.com/boxcheck for details.');

    expect(issues.length).toBe(1);
    expect(issues[0].boundingBox!.y).toBeCloseTo(88, 0);
    expect(issues[0].boundingBox!.height).toBeCloseTo(12, 0);
  });

  it('does not flag a URL that already has a real Link annotation covering it', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([500, 300]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('Visit https://example.com/existing for details.', { x: 60, y: 200, size: 12, font, color: rgb(0, 0, 0) });
    const buffer = Buffer.from(await src.save());

    const parsed = await pdfComprehensiveParserService.parseBuffer(buffer, 'test.pdf');
    try {
      // Simulates a REAL Link annotation already covering this text --
      // position-overlap is all hasNearbyLinkAnnotation checks, so a
      // hand-built PdfLink exercises that path without needing to construct
      // a raw PDF-level annotation dictionary just for this one case.
      parsed.pages[0].links = [
        {
          text: 'https://example.com/existing',
          url: 'https://example.com/existing',
          position: { x: 50, y: 95, width: 350, height: 20 },
          hasDescriptiveText: true,
        },
      ];

      const issues = await pdfLinkCompletenessValidator.validate(parsed);
      expect(issues.length).toBe(0);
    } finally {
      if (parsed.parsedPdf) await pdfParserService.close(parsed.parsedPdf);
    }
  });
});
