import { describe, it, expect, beforeEach } from 'vitest';
import JSZip from 'jszip';
import {
  fixConformsTo,
  fixCertifiedBy,
  fixCertifierCredential,
  fixCertifierLink,
  fixTdmReservation,
  fixA11ySummaryUrl,
} from '../../../../../../../src/services/epub/profiles/prh-uk/remediators/metadata-remediator';
import { validatePrhMetadata } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/metadata-validator';

const CONTAINER_XML = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="EPUB/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`;

/** Build a JSZip with a non-compliant OPF for the remediators to fix. */
async function bareEpubZip(): Promise<JSZip> {
  const zip = new JSZip();
  zip.file('META-INF/container.xml', CONTAINER_XML);
  zip.file(
    'EPUB/package.opf',
    `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Bare Book</dc:title>
  </metadata>
</package>`,
  );
  return zip;
}

async function readOpf(zip: JSZip): Promise<string> {
  const content = await zip.file('EPUB/package.opf')?.async('text');
  if (!content) throw new Error('OPF missing');
  return content;
}

describe('PRH metadata remediators', () => {
  let zip: JSZip;
  beforeEach(async () => {
    zip = await bareEpubZip();
  });

  it('fixConformsTo writes the literal PRH-required string', async () => {
    const result = await fixConformsTo(zip);
    expect(result[0].success).toBe(true);
    const opf = await readOpf(zip);
    expect(opf).toContain('EPUB Accessibility 1.1 - WCAG 2.2 Level AA');
    expect(opf).toContain('id="conf"');
  });

  it('fixCertifiedBy writes the literal PRH-required string with refines', async () => {
    await fixConformsTo(zip);
    const result = await fixCertifiedBy(zip);
    expect(result[0].success).toBe(true);
    const opf = await readOpf(zip);
    expect(opf).toContain('property="a11y:certifiedBy"');
    expect(opf).toContain('Penguin Random House UK');
    expect(opf).toContain('refines="#conf"');
    expect(opf).toContain('id="certifier"');
  });

  it('fixCertifierCredential writes "Ace by DAISY OK"', async () => {
    await fixConformsTo(zip);
    await fixCertifiedBy(zip);
    const result = await fixCertifierCredential(zip);
    expect(result[0].success).toBe(true);
    const opf = await readOpf(zip);
    expect(opf).toContain('Ace by DAISY OK');
    expect(opf).toContain('refines="#certifier"');
  });

  it('fixCertifierLink inserts the daisy.github.io/ace link', async () => {
    const result = await fixCertifierLink(zip);
    expect(result[0].success).toBe(true);
    const opf = await readOpf(zip);
    expect(opf).toContain('rel="a11y:certifierCredential"');
    expect(opf).toContain('https://daisy.github.io/ace');
  });

  it('fixCertifierLink replaces an existing link with a different href', async () => {
    // Insert a wrong link first.
    const opf0 = await readOpf(zip);
    const opfWithWrongLink = opf0.replace(
      '</metadata>',
      '  <link rel="a11y:certifierCredential" href="https://example.com/wrong"/>\n</metadata>',
    );
    zip.file('EPUB/package.opf', opfWithWrongLink);
    await fixCertifierLink(zip);
    const after = await readOpf(zip);
    expect(after).toContain('https://daisy.github.io/ace');
    expect(after).not.toContain('example.com/wrong');
  });

  it('fixTdmReservation declares the prefix on <package> and writes the meta', async () => {
    const result = await fixTdmReservation(zip);
    expect(result[0].success).toBe(true);
    const opf = await readOpf(zip);
    expect(opf).toContain('tdm: http://www.w3.org/ns/tdmrep#');
    expect(opf).toContain('<meta property="tdm:reservation"');
    expect(opf).toContain('>1</meta>');
  });

  it('fixTdmReservation appends to an existing prefix attribute without clobbering', async () => {
    const opf0 = await readOpf(zip);
    const opfWithSchema = opf0.replace(
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0">',
      '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" prefix="schema: http://schema.org/">',
    );
    zip.file('EPUB/package.opf', opfWithSchema);
    await fixTdmReservation(zip);
    const after = await readOpf(zip);
    expect(after).toContain('schema: http://schema.org/');
    expect(after).toContain('tdm: http://www.w3.org/ns/tdmrep#');
  });

  it('fixA11ySummaryUrl appends the PRH URL to an existing summary', async () => {
    const opf0 = await readOpf(zip);
    const opfWithSummary = opf0.replace(
      '</metadata>',
      '  <meta property="schema:accessibilitySummary">This ebook has been audited.</meta>\n</metadata>',
    );
    zip.file('EPUB/package.opf', opfWithSummary);
    await fixA11ySummaryUrl(zip);
    const after = await readOpf(zip);
    expect(after).toContain('penguin.co.uk/accessibility');
    expect(after).toContain('This ebook has been audited');
  });

  it('fixA11ySummaryUrl inserts a new summary when none exists', async () => {
    const result = await fixA11ySummaryUrl(zip);
    expect(result[0].success).toBe(true);
    const opf = await readOpf(zip);
    expect(opf).toContain('schema:accessibilitySummary');
    expect(opf).toContain('penguin.co.uk/accessibility');
  });

  it('end-to-end: applying all 6 fixes produces an OPF the validator accepts', async () => {
    await fixConformsTo(zip);
    await fixCertifiedBy(zip);
    await fixCertifierCredential(zip);
    await fixCertifierLink(zip);
    await fixTdmReservation(zip);
    await fixA11ySummaryUrl(zip);

    const opf = await readOpf(zip);
    const issues = validatePrhMetadata({ opfContent: opf, opfPath: 'EPUB/package.opf' });
    expect(issues).toEqual([]);
  });

  it('a fix is idempotent — running it twice does not re-write', async () => {
    await fixConformsTo(zip);
    const opfAfter1 = await readOpf(zip);
    const result2 = await fixConformsTo(zip);
    const opfAfter2 = await readOpf(zip);
    expect(opfAfter1).toBe(opfAfter2);
    expect(result2[0].description).toMatch(/already compliant/i);
  });

  it('returns success:false when OPF is missing', async () => {
    const broken = new JSZip();
    broken.file('META-INF/container.xml', CONTAINER_XML);
    // No EPUB/package.opf file.
    const result = await fixConformsTo(broken);
    expect(result[0].success).toBe(false);
    expect(result[0].description).toMatch(/OPF not found/i);
  });
});
