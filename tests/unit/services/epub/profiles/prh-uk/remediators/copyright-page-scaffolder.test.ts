import { describe, it, expect } from 'vitest';
import { _internals } from '../../../../../../../src/services/epub/profiles/prh-uk/remediators/copyright-page-scaffolder.service';
import type { BoilerplateMetadata } from '../../../../../../../src/services/epub/profiles/prh-uk/imprints/boilerplate-templates';

const { composeCopyrightXhtml, bodyClassForTemplate } = _internals;

function metadata(overrides: Partial<BoilerplateMetadata> = {}): BoilerplateMetadata {
  return {
    bookTitle: 'Test Book',
    authorName: 'Test Author',
    isbn: '978-1-234-56789-0',
    year: '2026',
    imprintDisplayName: 'Penguin',
    division: 'Penguin Books',
    ...overrides,
  };
}

describe('bodyClassForTemplate', () => {
  it('uses copyright_page_left for adult', () => {
    expect(bodyClassForTemplate('adult')).toBe('copyright_page_left');
  });
  it('uses copyright_page_left for children', () => {
    expect(bodyClassForTemplate('children')).toBe('copyright_page_left');
  });
  it('uses copyright_page_center for vintage-bespoke', () => {
    expect(bodyClassForTemplate('vintage-bespoke')).toBe('copyright_page_center');
  });
});

describe('composeCopyrightXhtml — adult', () => {
  it('produces a valid XHTML document with the canonical wrapper', () => {
    const { xhtml } = composeCopyrightXhtml('adult', metadata());
    expect(xhtml).toContain('<?xml version="1.0"');
    expect(xhtml).toContain('<!DOCTYPE html>');
    expect(xhtml).toMatch(/<html\b[^>]*xmlns:epub="http:\/\/www\.idpf\.org\/2007\/ops"/);
    expect(xhtml).toContain('<title>Copyright</title>');
    expect(xhtml).toContain('<body epub:type="frontmatter"');
    expect(xhtml).toContain('class="copyright_page_left"');
    expect(xhtml).toContain('<section epub:type="copyright-page">');
  });

  it('embeds the TDM-reservation paragraph on adult template', () => {
    const { xhtml } = composeCopyrightXhtml('adult', metadata());
    expect(xhtml).toMatch(/DSM Directive 2019\/790/);
  });

  it('embeds the EEA representative line on adult template', () => {
    const { xhtml } = composeCopyrightXhtml('adult', metadata());
    expect(xhtml).toMatch(/Morrison Chambers, 32 Nassau Street, Dublin D02 YH68/);
  });

  it('embeds the PRH UK logo figure', () => {
    const { xhtml } = composeCopyrightXhtml('adult', metadata());
    expect(xhtml).toMatch(/<figure class="copyright_logo">/);
    expect(xhtml).toMatch(/alt="Penguin Random House UK"/);
  });

  it('reports no missing fields when all metadata is present', () => {
    const { missingFields } = composeCopyrightXhtml('adult', metadata());
    expect(missingFields).toEqual([]);
  });

  it('reports missing ISBN field when metadata.isbn is null', () => {
    const { xhtml, missingFields } = composeCopyrightXhtml('adult', metadata({ isbn: null }));
    expect(missingFields).toContain('isbn');
    expect(xhtml).toContain('__MISSING_ISBN__');
  });
});

describe('composeCopyrightXhtml — children', () => {
  it('embeds all three children\'s URLs', () => {
    const { xhtml } = composeCopyrightXhtml('children', metadata());
    expect(xhtml).toMatch(/penguin\.co\.uk/);
    expect(xhtml).toMatch(/puffin\.co\.uk/);
    expect(xhtml).toMatch(/ladybird\.co\.uk/);
  });

  it('uses Children\'s correspondence address', () => {
    const { xhtml } = composeCopyrightXhtml('children', metadata());
    expect(xhtml).toMatch(/Penguin Random House Children/);
  });

  it('still includes TDM + EEA (same as adult)', () => {
    const { xhtml } = composeCopyrightXhtml('children', metadata());
    expect(xhtml).toMatch(/DSM Directive 2019\/790/);
    expect(xhtml).toMatch(/Morrison Chambers/);
  });
});

describe('composeCopyrightXhtml — vintage-bespoke', () => {
  it('uses copyright_page_center body class', () => {
    const { xhtml } = composeCopyrightXhtml('vintage-bespoke', metadata());
    expect(xhtml).toContain('class="copyright_page_center"');
  });

  it('does NOT include TDM or EEA (per Branding Guide §5.3)', () => {
    const { xhtml } = composeCopyrightXhtml('vintage-bespoke', metadata());
    expect(xhtml).not.toMatch(/DSM Directive/);
    expect(xhtml).not.toMatch(/Morrison Chambers/);
  });

  it('includes the Vintage bespoke anti-piracy opener', () => {
    const { xhtml } = composeCopyrightXhtml('vintage-bespoke', metadata());
    expect(xhtml).toMatch(/This ebook is copyright material/);
  });

  it('uses the Vintage address (20 Vauxhall Bridge Road)', () => {
    const { xhtml } = composeCopyrightXhtml('vintage-bespoke', metadata());
    expect(xhtml).toMatch(/20 Vauxhall Bridge Road, London SW1V 2SA/);
  });

  it('uses the Vintage URL', () => {
    const { xhtml } = composeCopyrightXhtml('vintage-bespoke', metadata());
    expect(xhtml).toMatch(/penguin\.co\.uk\/vintage/);
  });
});

describe('composeCopyrightXhtml — placeholder de-duplication', () => {
  it('de-duplicates the missing-field list across snippets', () => {
    // ISBN appears in only one snippet in the adult template, so
    // there's no opportunity for duplication YET — this test
    // documents the invariant for future template changes that add
    // the same token to multiple snippets.
    const { missingFields } = composeCopyrightXhtml('adult', metadata({ isbn: null, year: null }));
    const uniqueFields = new Set(missingFields);
    expect(missingFields.length).toBe(uniqueFields.size);
  });
});
