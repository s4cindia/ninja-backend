import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    job: { findUnique: vi.fn() },
  },
}));

import prisma from '../../../../src/lib/prisma';
import {
  generatePrhConformanceReport,
  renderHtml,
} from '../../../../src/services/acr/prh-conformance-report.service';

const mJobFindUnique = prisma.job.findUnique as ReturnType<typeof vi.fn>;

beforeEach(() => {
  mJobFindUnique.mockReset();
});

function mockJob(output: Record<string, unknown>, input: Record<string, unknown> = { originalName: 'test.epub' }) {
  mJobFindUnique.mockResolvedValue({ id: 'job-1', output, input });
}

describe('generatePrhConformanceReport — applicability gating', () => {
  it('throws when the job is not found', async () => {
    mJobFindUnique.mockResolvedValue(null);
    await expect(generatePrhConformanceReport('missing')).rejects.toThrow(/not found/i);
  });

  it('throws when the job has no audit output', async () => {
    mJobFindUnique.mockResolvedValue({ id: 'job-1', output: null, input: {} });
    await expect(generatePrhConformanceReport('job-1')).rejects.toThrow(/no audit output/i);
  });

  it('throws on non-PRH-UK publishers', async () => {
    mockJob({ publisherProfile: { publisher: 'HACHETTE-UK', confidence: 'high' } });
    await expect(generatePrhConformanceReport('job-1')).rejects.toThrow(/only available on PRH-UK/i);
  });

  it('throws on low-confidence PRH-UK matches', async () => {
    mockJob({ publisherProfile: { publisher: 'PRH-UK', confidence: 'low' } });
    await expect(generatePrhConformanceReport('job-1')).rejects.toThrow(/medium-or-high/i);
  });
});

describe('generatePrhConformanceReport — issue classification', () => {
  it('classifies PRH-META-* as P1', async () => {
    mockJob({
      publisherProfile: { publisher: 'PRH-UK', imprint: 'penguin', confidence: 'high' },
      combinedIssues: [
        { code: 'PRH-META-CONFORMS-TO', severity: 'moderate', message: 'msg', location: 'package.opf' },
      ],
    });
    const report = await generatePrhConformanceReport('job-1');
    expect(report.outstandingIssues[0].priorityTier).toBe('P1');
  });

  it('classifies PRH-COPY-*, PRH-BRAND-*, PRH-TITLE-*, PRH-SOCIALS-*, PRH-ORDER-* as P2', async () => {
    mockJob({
      publisherProfile: { publisher: 'PRH-UK', confidence: 'high' },
      combinedIssues: [
        { code: 'PRH-COPY-TDM-PARAGRAPH-MISSING', message: 'a', location: 'copyright.xhtml' },
        { code: 'PRH-BRAND-PAGE-MISSING', message: 'b', location: 'EPUB' },
        { code: 'PRH-TITLE-PAGE-MISSING', message: 'c', location: 'EPUB' },
        { code: 'PRH-SOCIALS-PAGE-MISSING', message: 'd', location: 'EPUB' },
        { code: 'PRH-ORDER-COVER-NOT-FIRST', message: 'e', location: 'package.opf' },
      ],
    });
    const report = await generatePrhConformanceReport('job-1');
    expect(report.outstandingIssues.every((i) => i.priorityTier === 'P2')).toBe(true);
  });

  it('classifies PRH-MARKUP-*, PRH-ARIA-*, PRH-BODY-HAS-ARIA, PRH-PAGEBREAK-MALFORMED, heuristic codes as P3', async () => {
    mockJob({
      publisherProfile: { publisher: 'PRH-UK', confidence: 'high' },
      combinedIssues: [
        { code: 'PRH-MARKUP-DEPRECATED-TAG', message: 'a', location: 'ch1.xhtml' },
        { code: 'PRH-ARIA-CHAPTER-ROLE-MISSING', message: 'b', location: 'ch1.xhtml' },
        { code: 'PRH-BODY-HAS-ARIA', message: 'c', location: 'ch1.xhtml' },
        { code: 'PRH-PAGEBREAK-MALFORMED', message: 'd', location: 'ch1.xhtml' },
        { code: 'PRH-HASHTAG-NOT-CAMEL-CASE', message: 'e', location: 'ch1.xhtml' },
      ],
    });
    const report = await generatePrhConformanceReport('job-1');
    expect(report.outstandingIssues.every((i) => i.priorityTier === 'P3')).toBe(true);
  });

  it('ignores non-PRH-* codes', async () => {
    mockJob({
      publisherProfile: { publisher: 'PRH-UK', confidence: 'high' },
      combinedIssues: [
        { code: 'EPUB-IMG-001', message: 'missing alt', location: 'ch1.xhtml' },
        { code: 'RSC-005', message: 'epubcheck warning', location: '' },
        { code: 'PRH-META-CONFORMS-TO', message: 'a', location: 'package.opf' },
      ],
    });
    const report = await generatePrhConformanceReport('job-1');
    expect(report.outstandingIssues).toHaveLength(1);
    expect(report.outstandingIssues[0].code).toBe('PRH-META-CONFORMS-TO');
  });
});

describe('generatePrhConformanceReport — readyForDelivery', () => {
  it('is true when no P1 or P2 issues remain', async () => {
    mockJob({
      publisherProfile: { publisher: 'PRH-UK', confidence: 'high' },
      combinedIssues: [
        { code: 'PRH-HASHTAG-NOT-CAMEL-CASE', message: 'a', location: 'ch1.xhtml' }, // P3
      ],
    });
    const report = await generatePrhConformanceReport('job-1');
    expect(report.readyForDelivery).toBe(true);
  });

  it('is false when any P1 issue remains', async () => {
    mockJob({
      publisherProfile: { publisher: 'PRH-UK', confidence: 'high' },
      combinedIssues: [
        { code: 'PRH-META-CONFORMS-TO', message: 'a', location: 'package.opf' },
      ],
    });
    const report = await generatePrhConformanceReport('job-1');
    expect(report.readyForDelivery).toBe(false);
  });

  it('is false when any P2 issue remains', async () => {
    mockJob({
      publisherProfile: { publisher: 'PRH-UK', confidence: 'high' },
      combinedIssues: [
        { code: 'PRH-COPY-TDM-PARAGRAPH-MISSING', message: 'a', location: 'copyright.xhtml' },
      ],
    });
    const report = await generatePrhConformanceReport('job-1');
    expect(report.readyForDelivery).toBe(false);
  });

  it('is true when only P3 issues remain (P3 is advisory)', async () => {
    mockJob({
      publisherProfile: { publisher: 'PRH-UK', confidence: 'high' },
      combinedIssues: [
        { code: 'PRH-MARKUP-DEPRECATED-TAG', message: 'a', location: 'ch1.xhtml' },
        { code: 'PRH-LANG-INLINE-NOT-MARKED', message: 'b', location: 'ch1.xhtml' },
      ],
    });
    const report = await generatePrhConformanceReport('job-1');
    expect(report.readyForDelivery).toBe(true);
  });
});

describe('generatePrhConformanceReport — report shape', () => {
  it('embeds the canonical certifier metadata', async () => {
    mockJob({
      publisherProfile: { publisher: 'PRH-UK', imprint: 'penguin', confidence: 'high' },
      combinedIssues: [],
    });
    const report = await generatePrhConformanceReport('job-1');
    expect(report.certifier.name).toBe('Penguin Random House UK');
    expect(report.certifier.credential).toBe('Ace by DAISY OK');
    expect(report.certifier.publicUrl).toBe('https://www.penguin.co.uk/accessibility');
    expect(report.conformsTo).toBe('EPUB Accessibility 1.1 - WCAG 2.2 Level AA');
  });

  it('reports per-tier counts (passed = total tier codes - failed)', async () => {
    mockJob({
      publisherProfile: { publisher: 'PRH-UK', confidence: 'high' },
      combinedIssues: [
        { code: 'PRH-META-CONFORMS-TO', message: 'a', location: 'package.opf' },
        { code: 'PRH-META-CERTIFIED-BY', message: 'b', location: 'package.opf' },
      ],
    });
    const report = await generatePrhConformanceReport('job-1');
    const p1 = report.priorityStatus.find((t) => t.tier === 'P1');
    expect(p1?.failed).toBe(2);
    expect(p1?.passed).toBe(17 - 2); // 17 total P1 codes
  });

  it('surfaces bookTitle and imprint when present', async () => {
    mockJob({
      publisherProfile: { publisher: 'PRH-UK', imprint: 'penguin', confidence: 'medium' },
      combinedIssues: [],
      bookTitle: 'The Book',
    });
    const report = await generatePrhConformanceReport('job-1');
    expect(report.bookTitle).toBe('The Book');
    expect(report.publisherProfile.imprint).toBe('penguin');
    expect(report.publisherProfile.confidence).toBe('medium');
  });
});

describe('renderHtml', () => {
  it('produces a valid HTML document with the canonical structure', async () => {
    mockJob({
      publisherProfile: { publisher: 'PRH-UK', imprint: 'penguin', confidence: 'high' },
      combinedIssues: [],
      bookTitle: 'The Book',
    });
    const report = await generatePrhConformanceReport('job-1');
    const html = renderHtml(report);
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<title>PRH UK Conformance Report');
    expect(html).toContain('The Book');
    expect(html).toContain('Status by Priority Tier');
  });

  it('shows the green "Ready for delivery" banner when readyForDelivery is true', async () => {
    mockJob({
      publisherProfile: { publisher: 'PRH-UK', confidence: 'high' },
      combinedIssues: [],
    });
    const report = await generatePrhConformanceReport('job-1');
    const html = renderHtml(report);
    expect(html).toMatch(/Ready for PRH delivery/);
  });

  it('shows the red "NOT ready" banner with the outstanding count', async () => {
    mockJob({
      publisherProfile: { publisher: 'PRH-UK', confidence: 'high' },
      combinedIssues: [
        { code: 'PRH-META-CONFORMS-TO', message: 'a', location: 'package.opf' },
        { code: 'PRH-COPY-TDM-PARAGRAPH-MISSING', message: 'b', location: 'copyright.xhtml' },
      ],
    });
    const report = await generatePrhConformanceReport('job-1');
    const html = renderHtml(report);
    expect(html).toMatch(/NOT ready for delivery/);
    expect(html).toMatch(/2 P1\/P2 issue\(s\) outstanding/);
  });

  it('HTML-escapes user-supplied content (book title, messages)', async () => {
    mockJob({
      publisherProfile: { publisher: 'PRH-UK', confidence: 'high' },
      combinedIssues: [
        { code: 'PRH-COPY-TDM-PARAGRAPH-MISSING', message: 'has <script>alert(1)</script>', location: 'ch.xhtml' },
      ],
      bookTitle: 'Book & Co. <Edition>',
    });
    const report = await generatePrhConformanceReport('job-1');
    const html = renderHtml(report);
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Book &amp; Co. &lt;Edition&gt;');
  });
});
