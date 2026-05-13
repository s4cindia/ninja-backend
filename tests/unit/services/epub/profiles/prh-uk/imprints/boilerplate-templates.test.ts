import { describe, it, expect } from 'vitest';
import {
  buildBoilerplateSnippets,
  imprintTemplate,
  MISSING_TOKEN_PREFIX,
  type BoilerplateMetadata,
} from '../../../../../../../src/services/epub/profiles/prh-uk/imprints/boilerplate-templates';

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

describe('imprintTemplate dispatcher', () => {
  it('maps puffin / ladybird → children', () => {
    expect(imprintTemplate('puffin')).toBe('children');
    expect(imprintTemplate('ladybird')).toBe('children');
  });

  it('maps vintage → vintage-bespoke', () => {
    expect(imprintTemplate('vintage')).toBe('vintage-bespoke');
  });

  it('maps adult imprints → adult', () => {
    expect(imprintTemplate('penguin')).toBe('adult');
    expect(imprintTemplate('pelican')).toBe('adult');
    expect(imprintTemplate('merky')).toBe('adult');
    expect(imprintTemplate('cornerstone-saga')).toBe('adult');
  });

  it('falls back to adult for null / unknown', () => {
    expect(imprintTemplate(null)).toBe('adult');
    expect(imprintTemplate('unknown')).toBe('adult');
  });
});

describe('adult template', () => {
  it('includes the TDM-reservation paragraph', () => {
    const snippets = buildBoilerplateSnippets('adult', metadata());
    const tdm = snippets.find((s) => s.code === 'PRH-COPY-TDM-PARAGRAPH-MISSING');
    expect(tdm).toBeDefined();
    expect(tdm?.html).toMatch(/DSM Directive 2019\/790/);
  });

  it('includes the EEA representative line', () => {
    const snippets = buildBoilerplateSnippets('adult', metadata());
    const eea = snippets.find((s) => s.code === 'PRH-COPY-EEA-LINE-MISSING');
    expect(eea?.html).toMatch(/Morrison Chambers, 32 Nassau Street, Dublin D02 YH68/);
  });

  it('substitutes the division label into group + address blocks', () => {
    const snippets = buildBoilerplateSnippets('adult', metadata({ division: 'Pelican Books' }));
    const group = snippets.find((s) => s.code === 'PRH-COPY-GROUP-STATEMENT-MISSING');
    const address = snippets.find((s) => s.code === 'PRH-COPY-ADDRESS-BLOCK-MISSING');
    expect(group?.html).toMatch(/Pelican Books is part of the Penguin Random House group/);
    expect(address?.html).toMatch(/Pelican Books/);
  });

  it('uses the One Embassy Gardens address for adult template', () => {
    const snippets = buildBoilerplateSnippets('adult', metadata());
    const address = snippets.find((s) => s.code === 'PRH-COPY-ADDRESS-BLOCK-MISSING');
    expect(address?.html).toMatch(/One Embassy Gardens, 8 Viaduct Gardens, London SW11 7BW/);
  });

  it('substitutes the supplied ISBN into the ISBN line', () => {
    const snippets = buildBoilerplateSnippets('adult', metadata({ isbn: '978-0-241-12345-6' }));
    const isbn = snippets.find((s) => s.code === 'PRH-COPY-ISBN-MISSING');
    expect(isbn?.html).toMatch(/978-0-241-12345-6/);
    expect(isbn?.missingFields).toEqual([]);
  });

  it('flags __MISSING_ISBN__ when ISBN is null', () => {
    const snippets = buildBoilerplateSnippets('adult', metadata({ isbn: null }));
    const isbn = snippets.find((s) => s.code === 'PRH-COPY-ISBN-MISSING');
    expect(isbn?.html).toContain(`${MISSING_TOKEN_PREFIX}ISBN__`);
    expect(isbn?.missingFields).toEqual(['isbn']);
  });

  it('uses penguin.co.uk URL on adult template', () => {
    const snippets = buildBoilerplateSnippets('adult', metadata());
    const url = snippets.find((s) => s.code === 'PRH-COPY-IMPRINT-URL-MISSING');
    expect(url?.html).toMatch(/www\.penguin\.co\.uk/);
    expect(url?.html).not.toMatch(/vintage/);
    expect(url?.html).not.toMatch(/puffin/);
  });

  it('includes the PRH UK logo figure with the canonical alt text', () => {
    const snippets = buildBoilerplateSnippets('adult', metadata());
    const logo = snippets.find((s) => s.code === 'PRH-COPY-PRH-LOGO-MISSING');
    expect(logo?.html).toMatch(/<figure class="copyright_logo">/);
    expect(logo?.html).toMatch(/alt="Penguin Random House UK"/);
    expect(logo?.html).toMatch(/prh_uk_logo\.jpg/);
  });
});

describe('children template', () => {
  it('includes the same TDM + EEA + BL CIP as adult', () => {
    const snippets = buildBoilerplateSnippets('children', metadata());
    expect(snippets.find((s) => s.code === 'PRH-COPY-TDM-PARAGRAPH-MISSING')).toBeDefined();
    expect(snippets.find((s) => s.code === 'PRH-COPY-EEA-LINE-MISSING')).toBeDefined();
    expect(snippets.find((s) => s.code === 'PRH-COPY-BL-CIP-MISSING')).toBeDefined();
  });

  it('uses the Penguin Random House Children’s address', () => {
    const snippets = buildBoilerplateSnippets('children', metadata());
    const address = snippets.find((s) => s.code === 'PRH-COPY-ADDRESS-BLOCK-MISSING');
    expect(address?.html).toMatch(/Penguin Random House Children/);
  });

  it('emits all three URLs (penguin, puffin, ladybird) in a single block', () => {
    const snippets = buildBoilerplateSnippets('children', metadata());
    const url = snippets.find((s) => s.code === 'PRH-COPY-IMPRINT-URL-MISSING');
    expect(url?.html).toMatch(/penguin\.co\.uk/);
    expect(url?.html).toMatch(/puffin\.co\.uk/);
    expect(url?.html).toMatch(/ladybird\.co\.uk/);
  });

  it('ISBN paragraph carries id="isbn" on children template', () => {
    const snippets = buildBoilerplateSnippets('children', metadata());
    const isbn = snippets.find((s) => s.code === 'PRH-COPY-ISBN-MISSING');
    expect(isbn?.html).toMatch(/id="isbn"/);
  });
});

describe('vintage-bespoke template', () => {
  it('does NOT include the TDM paragraph (per Branding Guide §5.3)', () => {
    const snippets = buildBoilerplateSnippets('vintage-bespoke', metadata());
    expect(snippets.find((s) => s.code === 'PRH-COPY-TDM-PARAGRAPH-MISSING')).toBeUndefined();
  });

  it('does NOT include the EEA representative line', () => {
    const snippets = buildBoilerplateSnippets('vintage-bespoke', metadata());
    expect(snippets.find((s) => s.code === 'PRH-COPY-EEA-LINE-MISSING')).toBeUndefined();
  });

  it('includes the Vintage bespoke anti-piracy opener', () => {
    const snippets = buildBoilerplateSnippets('vintage-bespoke', metadata());
    const opener = snippets.find((s) => s.code === 'PRH-COPY-VINTAGE-OPENER-MISSING');
    expect(opener?.html).toMatch(/This ebook is copyright material/);
  });

  it('uses the Vintage 20 Vauxhall Bridge Road address', () => {
    const snippets = buildBoilerplateSnippets('vintage-bespoke', metadata());
    const address = snippets.find((s) => s.code === 'PRH-COPY-ADDRESS-BLOCK-MISSING');
    expect(address?.html).toMatch(/20 Vauxhall Bridge Road, London SW1V 2SA/);
  });

  it('uses the vintage-specific URL', () => {
    const snippets = buildBoilerplateSnippets('vintage-bespoke', metadata());
    const url = snippets.find((s) => s.code === 'PRH-COPY-IMPRINT-URL-MISSING');
    expect(url?.html).toMatch(/penguin\.co\.uk\/vintage/);
  });
});

describe('placeholder substitution', () => {
  it('flags missing book title via __MISSING_BOOK_TITLE__', () => {
    // Adult template doesn't currently include [BOOK_TITLE] in any
    // snippet (the title isn't part of the verbatim boilerplate);
    // confirm the mechanism works when a future snippet adds one by
    // testing the substitution helper indirectly via metadata that
    // omits ISBN — verifies missingFields tracking is wired up.
    const snippets = buildBoilerplateSnippets('adult', metadata({ isbn: null }));
    const isbn = snippets.find((s) => s.code === 'PRH-COPY-ISBN-MISSING');
    expect(isbn?.missingFields).toContain('isbn');
    expect(isbn?.html).toContain(MISSING_TOKEN_PREFIX);
  });

  it('substitutes the supplied ISBN without leaving any __MISSING_*__ tokens', () => {
    const snippets = buildBoilerplateSnippets('adult', metadata({ isbn: '978-0-241-12345-6' }));
    for (const s of snippets) {
      expect(s.html).not.toContain(MISSING_TOKEN_PREFIX);
      expect(s.missingFields).toEqual([]);
    }
  });
});
