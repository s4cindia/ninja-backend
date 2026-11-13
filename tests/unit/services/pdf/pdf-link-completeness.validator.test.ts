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
import { PDFDocument, PDFName, StandardFonts, rgb } from 'pdf-lib';
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
    // The full, untruncated URL -- context/message both truncate for display
    // (80/120 chars); a fixer relocating this text in the content stream
    // needs the exact, complete string.
    expect(issues[0].linkCompletenessData?.url).toBe('https://cwrp.ca/policy-legislation');
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

describe('PdfLinkCompletenessValidator -- cross-reference detection', () => {
  async function crossRefIssuesFor(text: string): Promise<import('../../../../src/services/audit/base-audit.service').AuditIssue[]> {
    const src = await PDFDocument.create();
    const page = src.addPage([500, 300]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText(text, { x: 60, y: 200, size: 12, font, color: rgb(0, 0, 0) });
    const buffer = Buffer.from(await src.save());
    const report = await pdfAuditService.runAuditFromBuffer(buffer, `cross-ref-${Date.now()}-${Math.random()}`, 'test.pdf', 'custom', ['links']);
    return report.issues.filter(i => i.code === 'CROSS-REFERENCE-MISSING-LINK');
  }

  it('flags "see Chapter N"-style prose cross-references', async () => {
    const issues = await crossRefIssuesFor('For more detail, see Chapter 3 of this book.');

    expect(issues.length).toBe(1);
    expect(issues[0].context).toContain('see Chapter 3');
    expect(issues[0].category).toBe('links');
    expect(issues[0].severity).toBe('moderate');
    expect(issues[0].crossReferenceData).toEqual({ keyword: 'chapter', number: '3', fullText: 'see Chapter 3' });
  });

  it('flags "see p. N" and "see page N" abbreviated forms', async () => {
    const issues = await crossRefIssuesFor('As discussed, see p. 45 for the full table.');

    expect(issues.length).toBe(1);
    expect(issues[0].context).toContain('see p. 45');
  });

  it('flags "see Fig. N" and matches a decimal section number', async () => {
    const issues = await crossRefIssuesFor('The results (see Fig. 2) show a clear trend.');

    expect(issues.length).toBe(1);
    expect(issues[0].context).toContain('see Fig. 2');
  });

  it('does not flag an unqualified "see above"/"see below" with no specific numbered target', async () => {
    const issues = await crossRefIssuesFor('As noted above, see above for context.');

    expect(issues.length).toBe(0);
  });

  it('does not flag ordinary prose containing the word "see" with no reference shape', async () => {
    const issues = await crossRefIssuesFor('I see what you mean about this topic.');

    expect(issues.length).toBe(0);
  });

  it('does not flag a cross-reference that already has a real Link annotation covering it', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([500, 300]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('For more detail, see Chapter 3 of this book.', { x: 60, y: 200, size: 12, font, color: rgb(0, 0, 0) });
    const buffer = Buffer.from(await src.save());

    const parsed = await pdfComprehensiveParserService.parseBuffer(buffer, 'test.pdf');
    try {
      parsed.pages[0].links = [
        {
          text: 'see Chapter 3',
          url: '#chapter-3',
          position: { x: 50, y: 95, width: 350, height: 20 },
          hasDescriptiveText: true,
        },
      ];

      const issues = await pdfLinkCompletenessValidator.validate(parsed);
      expect(issues.filter(i => i.code === 'CROSS-REFERENCE-MISSING-LINK')).toHaveLength(0);
    } finally {
      if (parsed.parsedPdf) await pdfParserService.close(parsed.parsedPdf);
    }
  });
});

describe('PdfLinkCompletenessValidator -- citation detection', () => {
  async function citationIssuesFor(text: string): Promise<import('../../../../src/services/audit/base-audit.service').AuditIssue[]> {
    const src = await PDFDocument.create();
    const page = src.addPage([500, 300]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText(text, { x: 60, y: 200, size: 12, font, color: rgb(0, 0, 0) });
    const buffer = Buffer.from(await src.save());
    const report = await pdfAuditService.runAuditFromBuffer(buffer, `citation-${Date.now()}-${Math.random()}`, 'test.pdf', 'custom', ['links']);
    return report.issues.filter(i => i.code === 'CITATION-MISSING-LINK');
  }

  it('flags a single-author "(Author Year)" citation', async () => {
    const issues = await citationIssuesFor('Research shows this effect (Johne 1999) clearly.');

    expect(issues.length).toBe(1);
    expect(issues[0].context).toContain('(Johne 1999)');
    expect(issues[0].category).toBe('links');
    expect(issues[0].severity).toBe('moderate');
    expect(issues[0].citationData).toEqual({ authorText: 'Johne', year: '1999', fullText: '(Johne 1999)' });
  });

  it('flags a two-author "(Author and Author2 Year)" citation', async () => {
    const issues = await citationIssuesFor('This finding (Hirschman and Holbrook 1982) is well known.');

    expect(issues.length).toBe(1);
    expect(issues[0].citationData).toEqual({
      authorText: 'Hirschman and Holbrook', year: '1982', fullText: '(Hirschman and Holbrook 1982)',
    });
  });

  it('captures a disambiguating suffix letter on the year ("2025b")', async () => {
    const issues = await citationIssuesFor('A recent study (Karsaklian 2025b) demonstrated this.');

    expect(issues.length).toBe(1);
    expect(issues[0].citationData?.year).toBe('2025b');
  });

  it('flags a citation carrying a trailing page locator ("Author Year, NN")', async () => {
    const issues = await citationIssuesFor('As noted (Kotler 1999, 13) in the text.');

    expect(issues.length).toBe(1);
    expect(issues[0].citationData).toEqual({ authorText: 'Kotler', year: '1999', fullText: '(Kotler 1999, 13)' });
  });

  it('does not flag a compound, multi-citation parenthetical', async () => {
    // A citation shape this platform has no resolution path for yet --
    // requiring the match to end exactly at the closing paren means this
    // is correctly left unmatched rather than grabbing only the first half.
    const issues = await citationIssuesFor('Several studies (Smith 2020; Jones 2021) agree on this.');

    expect(issues.length).toBe(0);
  });

  it('does not flag ordinary parenthetical text with no year', async () => {
    const issues = await citationIssuesFor('This happens occasionally (see above) in practice.');

    expect(issues.length).toBe(0);
  });

  it('does not flag a citation that already has a real Link annotation covering it', async () => {
    const src = await PDFDocument.create();
    const page = src.addPage([500, 300]);
    const font = await src.embedFont(StandardFonts.Helvetica);
    page.drawText('Research shows this effect (Johne 1999) clearly.', { x: 60, y: 200, size: 12, font, color: rgb(0, 0, 0) });
    const buffer = Buffer.from(await src.save());

    const parsed = await pdfComprehensiveParserService.parseBuffer(buffer, 'test.pdf');
    try {
      parsed.pages[0].links = [
        {
          text: '(Johne 1999)',
          url: '#ref-johne-1999',
          position: { x: 50, y: 95, width: 350, height: 20 },
          hasDescriptiveText: true,
        },
      ];

      const issues = await pdfLinkCompletenessValidator.validate(parsed);
      expect(issues.filter(i => i.code === 'CITATION-MISSING-LINK')).toHaveLength(0);
    } finally {
      if (parsed.parsedPdf) await pdfParserService.close(parsed.parsedPdf);
    }
  });
});

describe('PdfLinkCompletenessValidator -- index page-reference detection', () => {
  /**
   * Builds a one-page document whose text is a real index-style line (e.g.
   * "Advertising, 1, 2, 5, 41"), optionally with a raw /IDX1-tagged struct
   * element pointing at that same page -- the structural gate
   * findIndexPageNumbers uses to decide which pages this check even scans
   * (see INDEX_RAW_TAGS/INDEX_PAGEREF_TAIL_RE's own doc comments for why a
   * bare numeric-list regex alone, with no such gate, would false-positive
   * elsewhere in a real document).
   */
  async function buildIndexDoc(text: string, taggedAsIndex: boolean): Promise<Buffer> {
    const doc = await PDFDocument.create();
    const page = doc.addPage([500, 300]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText(text, { x: 60, y: 200, size: 12, font, color: rgb(0, 0, 0) });

    if (taggedAsIndex) {
      const idxRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('IDX1'), Pg: page.ref, K: 0 }));
      const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [idxRef] }));
      doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
    }

    return Buffer.from(await doc.save());
  }

  it('flags a page-number list on a page with a real raw /IDX1 element', async () => {
    const buffer = await buildIndexDoc('Advertising, 1, 2, 5, 41', true);
    const report = await pdfAuditService.runAuditFromBuffer(buffer, `index-pageref-${Date.now()}-${Math.random()}`, 'test.pdf', 'custom', ['links']);
    const issues = report.issues.filter(i => i.code === 'INDEX-ENTRY-MISSING-PAGE-LINK');

    expect(issues.length).toBe(1);
    expect(issues[0].message).toContain('1 index entry');
    expect(issues[0].context).toContain('Advertising, 1, 2, 5, 41');
    expect(issues[0].category).toBe('links');
  });

  it('does NOT flag the same page-number-list text when the page carries no IDX-tagged element', async () => {
    // Same visible text, no structural index gate -- confirms this is a
    // real structural check, not a bare "comma-separated numbers anywhere"
    // regex that would false-positive on an unrelated numeric list.
    const buffer = await buildIndexDoc('Advertising, 1, 2, 5, 41', false);
    const report = await pdfAuditService.runAuditFromBuffer(buffer, `index-pageref-gate-${Date.now()}-${Math.random()}`, 'test.pdf', 'custom', ['links']);
    const issues = report.issues.filter(i => i.code === 'INDEX-ENTRY-MISSING-PAGE-LINK');

    expect(issues.length).toBe(0);
  });

  it('does not flag an index-tagged page whose own text has no page-number list at all', async () => {
    const buffer = await buildIndexDoc('Index', true);
    const report = await pdfAuditService.runAuditFromBuffer(buffer, `index-pageref-noref-${Date.now()}-${Math.random()}`, 'test.pdf', 'custom', ['links']);
    const issues = report.issues.filter(i => i.code === 'INDEX-ENTRY-MISSING-PAGE-LINK');

    expect(issues.length).toBe(0);
  });

  it('does not flag an index page-reference line that already has a real Link annotation covering it', async () => {
    const buffer = await buildIndexDoc('Advertising, 1, 2, 5, 41', true);
    const parsed = await pdfComprehensiveParserService.parseBuffer(buffer, 'test.pdf');
    try {
      parsed.pages[0].links = [
        {
          text: 'Advertising, 1, 2, 5, 41',
          url: '#page-41',
          position: { x: 50, y: 80, width: 200, height: 30 },
          hasDescriptiveText: true,
        },
      ];

      const issues = await pdfLinkCompletenessValidator.validate(parsed);
      expect(issues.filter(i => i.code === 'INDEX-ENTRY-MISSING-PAGE-LINK')).toHaveLength(0);
    } finally {
      if (parsed.parsedPdf) await pdfParserService.close(parsed.parsedPdf);
    }
  });
});
