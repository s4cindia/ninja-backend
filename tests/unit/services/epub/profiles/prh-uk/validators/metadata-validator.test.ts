import { describe, it, expect } from 'vitest';
import { validatePrhMetadata } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/metadata-validator';

/** Build an OPF with a complete, PRH-compliant metadata block. */
function compliantOpf(): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0"
         prefix="schema: http://schema.org/ tdm: http://www.w3.org/ns/tdmrep#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Test Book</dc:title>
    <dc:publisher>Penguin Random House UK</dc:publisher>
    <meta property="dcterms:conformsTo" id="conf">EPUB Accessibility 1.1 - WCAG 2.2 Level AA</meta>
    <meta property="a11y:certifiedBy" refines="#conf" id="certifier">Penguin Random House UK</meta>
    <meta property="a11y:certifierCredential" refines="#certifier">Ace by DAISY OK</meta>
    <link rel="a11y:certifierCredential" href="https://daisy.github.io/ace"/>
    <meta property="tdm:reservation">1</meta>
    <meta property="schema:accessibilitySummary">For more information visit https://www.penguin.co.uk/accessibility</meta>
  </metadata>
</package>`;
}

const INPUT = (opfContent: string) => ({ opfContent, opfPath: 'EPUB/package.opf' });

describe('validatePrhMetadata', () => {
  it('emits zero issues for a fully compliant OPF', () => {
    expect(validatePrhMetadata(INPUT(compliantOpf()))).toEqual([]);
  });

  it('flags missing dcterms:conformsTo', () => {
    const opf = compliantOpf().replace(
      /<meta property="dcterms:conformsTo"[^>]*>[^<]*<\/meta>/,
      '',
    );
    const issues = validatePrhMetadata(INPUT(opf));
    expect(issues.find((i) => i.code === 'PRH-META-CONFORMS-TO')).toBeDefined();
  });

  it('flags wrong dcterms:conformsTo value (e.g. WCAG 2.1 instead of 2.2)', () => {
    const opf = compliantOpf().replace(
      'EPUB Accessibility 1.1 - WCAG 2.2 Level AA',
      'EPUB Accessibility 1.0 - WCAG 2.1 Level AA',
    );
    const issues = validatePrhMetadata(INPUT(opf));
    const issue = issues.find((i) => i.code === 'PRH-META-CONFORMS-TO');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/WCAG 2\.1/);
  });

  it('flags missing a11y:certifiedBy', () => {
    const opf = compliantOpf().replace(
      /<meta property="a11y:certifiedBy"[^>]*>[^<]*<\/meta>/,
      '',
    );
    const issues = validatePrhMetadata(INPUT(opf));
    expect(issues.find((i) => i.code === 'PRH-META-CERTIFIED-BY')).toBeDefined();
  });

  it('flags wrong a11y:certifiedBy value', () => {
    const opf = compliantOpf().replace(
      '>Penguin Random House UK</meta>',
      '>Other Publisher</meta>',
    );
    const issues = validatePrhMetadata(INPUT(opf));
    expect(issues.find((i) => i.code === 'PRH-META-CERTIFIED-BY')).toBeDefined();
  });

  it('flags missing a11y:certifierCredential meta', () => {
    const opf = compliantOpf().replace(
      /<meta property="a11y:certifierCredential"[^>]*>[^<]*<\/meta>/,
      '',
    );
    const issues = validatePrhMetadata(INPUT(opf));
    expect(issues.find((i) => i.code === 'PRH-META-CERTIFIER-CRED')).toBeDefined();
  });

  it('flags missing certifier <link>', () => {
    const opf = compliantOpf().replace(
      /<link rel="a11y:certifierCredential"[^>]*\/?>/,
      '',
    );
    const issues = validatePrhMetadata(INPUT(opf));
    expect(issues.find((i) => i.code === 'PRH-META-CERTIFIER-LINK')).toBeDefined();
  });

  it('accepts the certifier <link> when href and rel attribute order is reversed', () => {
    const opf = compliantOpf().replace(
      '<link rel="a11y:certifierCredential" href="https://daisy.github.io/ace"/>',
      '<link href="https://daisy.github.io/ace" rel="a11y:certifierCredential"/>',
    );
    const issues = validatePrhMetadata(INPUT(opf));
    expect(issues.find((i) => i.code === 'PRH-META-CERTIFIER-LINK')).toBeUndefined();
  });

  it('flags missing tdm:reservation meta', () => {
    const opf = compliantOpf().replace(
      /<meta property="tdm:reservation">[^<]*<\/meta>/,
      '',
    );
    const issues = validatePrhMetadata(INPUT(opf));
    const issue = issues.find((i) => i.code === 'PRH-META-TDM-RESERVATION');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/missing/i);
  });

  it('flags tdm:reservation when prefix declaration is absent', () => {
    const opf = compliantOpf().replace(
      ' prefix="schema: http://schema.org/ tdm: http://www.w3.org/ns/tdmrep#"',
      '',
    );
    const issues = validatePrhMetadata(INPUT(opf));
    const issue = issues.find((i) => i.code === 'PRH-META-TDM-RESERVATION');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/prefix/i);
  });

  it('flags missing accessibilitySummary', () => {
    const opf = compliantOpf().replace(
      /<meta property="schema:accessibilitySummary">[^<]*<\/meta>/,
      '',
    );
    const issues = validatePrhMetadata(INPUT(opf));
    expect(issues.find((i) => i.code === 'PRH-META-A11Y-SUMMARY-URL')).toBeDefined();
  });

  it('flags accessibilitySummary that does not reference the PRH URL', () => {
    const opf = compliantOpf().replace(
      'For more information visit https://www.penguin.co.uk/accessibility',
      'This ebook has been audited.',
    );
    const issues = validatePrhMetadata(INPUT(opf));
    const issue = issues.find((i) => i.code === 'PRH-META-A11Y-SUMMARY-URL');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/penguin\.co\.uk\/accessibility/);
  });

  it('emits exactly one issue per missing field (no double-counting)', () => {
    // Strip everything PRH expects.
    const opf = `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Bare Book</dc:title>
  </metadata>
</package>`;
    const issues = validatePrhMetadata(INPUT(opf));
    const codes = issues.map((i) => i.code).sort();
    expect(codes).toEqual([
      'PRH-META-A11Y-SUMMARY-URL',
      'PRH-META-CERTIFIED-BY',
      'PRH-META-CERTIFIER-CRED',
      'PRH-META-CERTIFIER-LINK',
      'PRH-META-CONFORMS-TO',
      'PRH-META-TDM-RESERVATION',
    ]);
    // Each issue carries severity, wcag, message, suggestion, location.
    for (const i of issues) {
      expect(i.severity).toBeDefined();
      expect(Array.isArray(i.wcag)).toBe(true);
      expect(i.message).toBeTruthy();
      expect(i.suggestion).toBeTruthy();
      expect(i.location).toBe('EPUB/package.opf');
    }
  });

  it('rejects a phishing-style certifier link href (substring impostor)', () => {
    // Regression for CodeRabbit major: previously hasCertifierLink used
    // includes() which would accept this attacker-controlled redirect URL.
    const opf = compliantOpf().replace(
      'href="https://daisy.github.io/ace"',
      'href="https://example.com/?next=https://daisy.github.io/ace"',
    );
    const issues = validatePrhMetadata(INPUT(opf));
    expect(issues.find((i) => i.code === 'PRH-META-CERTIFIER-LINK')).toBeDefined();
  });

  it('accepts a certifier link href that differs only by trailing slash', () => {
    const opf = compliantOpf().replace(
      'href="https://daisy.github.io/ace"',
      'href="https://daisy.github.io/ace/"',
    );
    const issues = validatePrhMetadata(INPUT(opf));
    expect(issues.find((i) => i.code === 'PRH-META-CERTIFIER-LINK')).toBeUndefined();
  });

  it('handles single-quoted attributes', () => {
    const opf = compliantOpf().replaceAll('"', "'");
    const issues = validatePrhMetadata(INPUT(opf));
    expect(issues).toEqual([]);
  });
});
