import { describe, it, expect } from 'vitest';
import { validatePrhSpine } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/spine-validator';

const INPUT = (opfContent: string) => ({ opfContent, opfPath: 'EPUB/package.opf' });

function buildOpf(opts: {
  manifest: string;
  spine: string;
}): string {
  return `<?xml version="1.0"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata><dc:title xmlns:dc="http://purl.org/dc/elements/1.1/">x</dc:title></metadata>
  <manifest>
    ${opts.manifest}
  </manifest>
  <spine>
    ${opts.spine}
  </spine>
</package>`;
}

describe('validatePrhSpine', () => {
  it('emits zero issues for a compliant spine (cover linear=no, footnotes last + linear=no)', () => {
    const opf = buildOpf({
      manifest: `
        <item id="cover" href="xhtml/cover.xhtml" media-type="application/xhtml+xml"/>
        <item id="ch1" href="xhtml/chapter001.xhtml" media-type="application/xhtml+xml"/>
        <item id="footnotes" href="xhtml/footnotes.xhtml" media-type="application/xhtml+xml"/>
      `,
      spine: `
        <itemref idref="cover" linear="no"/>
        <itemref idref="ch1"/>
        <itemref idref="footnotes" linear="no"/>
      `,
    });
    expect(validatePrhSpine(INPUT(opf))).toEqual([]);
  });

  it('flags cover spine entry without linear="no"', () => {
    const opf = buildOpf({
      manifest: `
        <item id="cover" href="xhtml/cover.xhtml" media-type="application/xhtml+xml"/>
        <item id="ch1" href="xhtml/chapter001.xhtml" media-type="application/xhtml+xml"/>
      `,
      spine: `
        <itemref idref="cover"/>
        <itemref idref="ch1"/>
      `,
    });
    const issues = validatePrhSpine(INPUT(opf));
    expect(issues.find((i) => i.code === 'PRH-SPINE-COVER-LINEAR')).toBeDefined();
  });

  it('flags cover spine entry with explicit linear="yes"', () => {
    const opf = buildOpf({
      manifest: `<item id="cover" href="xhtml/cover.xhtml" media-type="application/xhtml+xml"/>`,
      spine: `<itemref idref="cover" linear="yes"/>`,
    });
    const issues = validatePrhSpine(INPUT(opf));
    expect(issues.find((i) => i.code === 'PRH-SPINE-COVER-LINEAR')).toBeDefined();
  });

  it('does NOT flag cover-linear when no cover XHTML is present (e.g. Kindle FXL)', () => {
    const opf = buildOpf({
      manifest: `<item id="ch1" href="xhtml/chapter001.xhtml" media-type="application/xhtml+xml"/>`,
      spine: `<itemref idref="ch1"/>`,
    });
    expect(validatePrhSpine(INPUT(opf)).find((i) => i.code === 'PRH-SPINE-COVER-LINEAR')).toBeUndefined();
  });

  it('flags footnotes file that is not the last entry in the spine', () => {
    const opf = buildOpf({
      manifest: `
        <item id="cover" href="xhtml/cover.xhtml" media-type="application/xhtml+xml"/>
        <item id="footnotes" href="xhtml/footnotes.xhtml" media-type="application/xhtml+xml"/>
        <item id="appendix" href="xhtml/appendix.xhtml" media-type="application/xhtml+xml"/>
      `,
      spine: `
        <itemref idref="cover" linear="no"/>
        <itemref idref="footnotes" linear="no"/>
        <itemref idref="appendix"/>
      `,
    });
    const issues = validatePrhSpine(INPUT(opf));
    const issue = issues.find((i) => i.code === 'PRH-SPINE-FOOTNOTES-LAST');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/trailing block/i);
  });

  it('flags footnotes file that is last but missing linear="no"', () => {
    const opf = buildOpf({
      manifest: `
        <item id="cover" href="xhtml/cover.xhtml" media-type="application/xhtml+xml"/>
        <item id="footnotes" href="xhtml/footnotes.xhtml" media-type="application/xhtml+xml"/>
      `,
      spine: `
        <itemref idref="cover" linear="no"/>
        <itemref idref="footnotes"/>
      `,
    });
    const issues = validatePrhSpine(INPUT(opf));
    const issue = issues.find((i) => i.code === 'PRH-SPINE-FOOTNOTES-LAST');
    expect(issue).toBeDefined();
    expect(issue?.message).toMatch(/linear="no"/);
  });

  it('does NOT flag footnotes-last when no footnotes file exists', () => {
    const opf = buildOpf({
      manifest: `
        <item id="cover" href="xhtml/cover.xhtml" media-type="application/xhtml+xml"/>
        <item id="ch1" href="xhtml/chapter001.xhtml" media-type="application/xhtml+xml"/>
      `,
      spine: `
        <itemref idref="cover" linear="no"/>
        <itemref idref="ch1"/>
      `,
    });
    const issues = validatePrhSpine(INPUT(opf));
    expect(issues.find((i) => i.code === 'PRH-SPINE-FOOTNOTES-LAST')).toBeUndefined();
  });

  it('returns empty when OPF has no spine block', () => {
    const opf = `<?xml version="1.0"?><package><manifest></manifest></package>`;
    expect(validatePrhSpine(INPUT(opf))).toEqual([]);
  });

  it('does NOT misclassify discover.xhtml as the cover (regression)', () => {
    // Regression for CodeRabbit P2: /cover/i matched inside "discover".
    // The token-aware regex requires "cover" to be flanked by separators.
    const opf = buildOpf({
      manifest: `
        <item id="discover" href="xhtml/discover.xhtml" media-type="application/xhtml+xml"/>
        <item id="ch1" href="xhtml/chapter001.xhtml" media-type="application/xhtml+xml"/>
      `,
      spine: `
        <itemref idref="discover"/>
        <itemref idref="ch1"/>
      `,
    });
    expect(validatePrhSpine(INPUT(opf)).find((i) => i.code === 'PRH-SPINE-COVER-LINEAR')).toBeUndefined();
  });

  it('flags an interrupted footnotes block: footnotes1, appendix, footnotes2 (regression)', () => {
    // Regression for CodeRabbit P2: previously only the final spine entry
    // was inspected, so a layout where footnotes1.xhtml sits earlier in
    // the spine with non-footnotes between it and footnotes2.xhtml passed
    // when only footnotes2 was correctly placed.
    const opf = buildOpf({
      manifest: `
        <item id="cover" href="xhtml/cover.xhtml" media-type="application/xhtml+xml"/>
        <item id="footnotes1" href="xhtml/footnotes1.xhtml" media-type="application/xhtml+xml"/>
        <item id="appendix" href="xhtml/appendix.xhtml" media-type="application/xhtml+xml"/>
        <item id="footnotes2" href="xhtml/footnotes2.xhtml" media-type="application/xhtml+xml"/>
      `,
      spine: `
        <itemref idref="cover" linear="no"/>
        <itemref idref="footnotes1"/>
        <itemref idref="appendix"/>
        <itemref idref="footnotes2" linear="no"/>
      `,
    });
    const issues = validatePrhSpine(INPUT(opf));
    // Should flag footnotes1 as misplaced AND footnotes1 as missing linear="no".
    const footnoteIssues = issues.filter((i) => i.code === 'PRH-SPINE-FOOTNOTES-LAST');
    expect(footnoteIssues.length).toBeGreaterThanOrEqual(1);
    const combinedMsgs = footnoteIssues.map((i) => i.message).join(' | ');
    expect(combinedMsgs).toMatch(/footnotes1/);
  });

  it('passes when both split footnotes files form the trailing block', () => {
    const opf = buildOpf({
      manifest: `
        <item id="cover" href="xhtml/cover.xhtml" media-type="application/xhtml+xml"/>
        <item id="footnotes1" href="xhtml/footnotes1.xhtml" media-type="application/xhtml+xml"/>
        <item id="footnotes2" href="xhtml/footnotes2.xhtml" media-type="application/xhtml+xml"/>
      `,
      spine: `
        <itemref idref="cover" linear="no"/>
        <itemref idref="footnotes1" linear="no"/>
        <itemref idref="footnotes2" linear="no"/>
      `,
    });
    expect(validatePrhSpine(INPUT(opf))).toEqual([]);
  });

  it('handles single-quoted attribute values', () => {
    const opf = `<?xml version="1.0"?>
<package version='3.0'>
  <manifest>
    <item id='cover' href='xhtml/cover.xhtml' media-type='application/xhtml+xml'/>
  </manifest>
  <spine>
    <itemref idref='cover'/>
  </spine>
</package>`;
    const issues = validatePrhSpine(INPUT(opf));
    expect(issues.find((i) => i.code === 'PRH-SPINE-COVER-LINEAR')).toBeDefined();
  });
});
