import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { runPrhUkValidators } from '../../../../../../src/services/epub/profiles/prh-uk/run-validators';

const COMPLIANT_NAV = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"
      xmlns:epub="http://www.idpf.org/2007/ops"
      lang="en" xml:lang="en">
  <head><title>Contents</title></head>
  <body>
    <nav epub:type="toc" role="doc-toc" aria-labelledby="toc_head" id="toc">
      <h2 id="toc_head">Contents</h2>
      <ol><li><a href="cover.xhtml">Cover</a></li></ol>
    </nav>
    <nav epub:type="landmarks" class="at_only">
      <ol>
        <li><a epub:type="cover" href="cover.xhtml">Cover</a></li>
        <li><a epub:type="frontmatter" href="title.xhtml">Frontmatter</a></li>
        <li><a epub:type="toc" href="nav.xhtml">TOC</a></li>
        <li><a epub:type="bodymatter" href="ch01.xhtml">Begin Reading</a></li>
      </ol>
    </nav>
    <nav epub:type="page-list" hidden="hidden" class="hidden_content">
      <ol><li><a href="ch01.xhtml#p1">1</a></li></ol>
    </nav>
  </body>
</html>`;

describe('runPrhUkValidators (orchestrator)', () => {
  it('returns no issues when no OPF is present', async () => {
    const zip = new JSZip();
    zip.file('META-INF/container.xml', '<?xml version="1.0"?><container><rootfiles><rootfile full-path="missing.opf"/></rootfiles></container>');
    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    expect(await runPrhUkValidators(buffer)).toEqual([]);
  });

  it('locates the nav doc when OPF references it via a relative href with ".." (path-normalisation regression)', async () => {
    // Regression for CodeRabbit: resolveOpfRelative previously returned
    // `OEBPS/../text/nav.xhtml` which doesn't exist as a literal zip
    // entry, so the nav doc lookup silently failed and PRH-NAV-* checks
    // never ran.
    const zip = new JSZip();
    zip.file(
      'META-INF/container.xml',
      `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>`,
    );
    zip.file(
      'OEBPS/package.opf',
      `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0"
         prefix="schema: http://schema.org/ tdm: http://www.w3.org/ns/tdmrep#">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Cross-dir Book</dc:title>
    <meta property="dcterms:conformsTo" id="conf">EPUB Accessibility 1.1 - WCAG 2.2 Level AA</meta>
    <meta property="a11y:certifiedBy" refines="#conf" id="certifier">Penguin Random House UK</meta>
    <meta property="a11y:certifierCredential" refines="#certifier">Ace by DAISY OK</meta>
    <link rel="a11y:certifierCredential" href="https://daisy.github.io/ace"/>
    <meta property="tdm:reservation">1</meta>
    <meta property="schema:accessibilitySummary">Visit https://www.penguin.co.uk/accessibility</meta>
  </metadata>
  <manifest>
    <item id="nav" href="../text/nav-doc.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="cover" href="../text/cover.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="cover" linear="no"/>
    <itemref idref="nav"/>
  </spine>
</package>`,
    );
    // Use a deliberately non-compliant nav doc — it has the toc + landmarks
    // blocks but is MISSING the page-list block. If path normalisation
    // works, the nav validator parses the doc and emits
    // PRH-NAV-MISSING-PAGELIST. If normalisation is broken, the doc isn't
    // found and the validator silently emits nothing — and the test fails.
    // This makes the assertion unambiguous about whether the nav lookup
    // actually succeeded.
    const NAV_MISSING_PAGELIST = COMPLIANT_NAV.replace(
      /<nav epub:type="page-list"[\s\S]*?<\/nav>/,
      '',
    );
    zip.file('text/nav-doc.xhtml', NAV_MISSING_PAGELIST);
    zip.file(
      'text/cover.xhtml',
      '<?xml version="1.0"?><html lang="en" xml:lang="en"><head><title>Cover, Cross-dir Book</title></head><body/></html>',
    );

    const buffer = await zip.generateAsync({ type: 'nodebuffer' });
    const issues = await runPrhUkValidators(buffer);
    // Path normalisation working ⇒ nav doc found ⇒ PRH-NAV-MISSING-PAGELIST
    // is emitted. If normalisation is broken, the nav doc isn't found and
    // this assertion fails — making the regression test unambiguous.
    const pageListIssue = issues.find((i) => i.code === 'PRH-NAV-MISSING-PAGELIST');
    expect(pageListIssue).toBeDefined();
    // Sanity: metadata validator also ran (we'd have seen all-six PRH-META-*
    // issues if the orchestrator had aborted early before reading the OPF).
    const metaIssues = issues.filter((i) => i.code.startsWith('PRH-META-'));
    expect(metaIssues).toEqual([]);
  });
});
