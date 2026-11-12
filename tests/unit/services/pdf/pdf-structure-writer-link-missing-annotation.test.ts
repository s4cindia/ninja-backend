/**
 * Regression coverage for fixLinkMissingAnnotation -- Slice 3 of the
 * LINK-MISSING-ANNOTATION fixer (Matterhorn 28-011). Wires slices 1-2's
 * pure content-stream splice (pdf-link-completeness-writer.ts) into a real
 * PDFDocument: creates the /Link annotation + structure element, splices it
 * into the enclosing /P's own /K, extends both ParentTree mechanisms.
 *
 * Fixture shape mirrors the REAL, live-confirmed Curiel_187961_CSHP.pdf
 * remediated copy exactly: the entire page's real content sits inside ONE
 * `/P <</MCID 0>> BDC BT ... ET EMC` span (see pdf-link-completeness-
 * writer.ts's own header comment for the full real-data breakdown).
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFArray, PDFNumber } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

const URL = 'https://example.com/citation-url';
const PAGE_CONTENT = `/P <</MCID 0>> BDC BT\n[(Some citation text before)]TJ\n0 -1.5 Td\n[(${URL})]TJ\n0 -1.5 Td\n[(More citation text after)]TJ\nET EMC`;

function issueFor(pageNumber: number, url: string): AuditIssue {
  return {
    id: 'link-completeness-1',
    source: 'link-completeness-validator',
    severity: 'serious',
    code: 'LINK-MISSING-ANNOTATION',
    message: `Text reads as a hyperlink ("${url}") but has no underlying Link annotation`,
    wcagCriteria: ['1.3.1', '4.1.2'],
    matterhornCheckpoint: '28-011',
    matterhornHow: 'M',
    category: 'links',
    pageNumber,
    linkCompletenessData: { url },
    boundingBox: { x: 100, y: 300, width: 150, height: 10, pageWidth: 612, pageHeight: 792 },
  } as AuditIssue;
}

/** Same flat /Nums-based /ParentTree helper pdf-structure-writer-artifact-swallows-content.test.ts already uses. */
function setFlatParentTree(doc: PDFDocument, structTreeRootRef: PDFRef, entries: PDFRef[]): void {
  const pageArr = doc.context.obj(entries);
  const parentTree = doc.context.obj({ Nums: [0, pageArr] });
  doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
}

/**
 * Builds a one-page document whose entire page is one `<tag> <</MCID 0>>`
 * span (the real shape). `structElementTag` (default 'P') is the struct
 * element's own /S -- separate from whatever tag name literally appears in
 * `content`'s own BDC, so a caller can build the real renameElement-drift
 * shape (content stream still says the original tag, struct element's /S
 * already corrected) on purpose.
 */
async function buildDoc(content: string, structElementTag = 'P'): Promise<{ doc: PDFDocument; pRef: PDFRef; structTreeRootRef: PDFRef }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  page.node.set(PDFName.of('StructParents'), doc.context.obj(0));
  writePageContent(doc, 1, content);

  const pRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of(structElementTag), Pg: page.ref, K: 0 }));
  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [pRef] }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
  setFlatParentTree(doc, structTreeRootRef, [pRef]);

  return { doc, pRef, structTreeRootRef };
}

function kidsOf(doc: PDFDocument, ref: PDFRef): unknown[] {
  const dict = doc.context.lookup(ref, PDFDict);
  const k = dict.get(PDFName.of('K'));
  return k instanceof PDFArray ? k.asArray() : [];
}

describe('fixLinkMissingAnnotation', () => {
  it('creates a /Link annotation + structure element and splices the enclosing /P\'s /K into [original, Link, remainder]', async () => {
    const { doc, pRef, structTreeRootRef } = await buildDoc(PAGE_CONTENT);

    const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, URL));
    expect(result.success).toBe(true);
    expect(result.after).toContain(URL);

    // Enclosing /P's own /K: [0, linkRef, 1] -- original MCID untouched,
    // new /Link spliced in, remainder given a fresh MCID.
    const pK = kidsOf(doc, pRef);
    expect(pK).toHaveLength(3);
    expect(pK[0]).toBeInstanceOf(PDFNumber);
    expect((pK[0] as PDFNumber).asNumber()).toBe(0);
    const linkRef = pK[1] as PDFRef;
    expect(linkRef).toBeInstanceOf(PDFRef);
    expect(pK[2]).toBeInstanceOf(PDFNumber);
    expect((pK[2] as PDFNumber).asNumber()).toBe(2); // nextMcid started at 1 (0 already used) -> link=1, remainder=2

    const linkDict = doc.context.lookup(linkRef, PDFDict);
    expect(linkDict.get(PDFName.of('S'))?.toString()).toBe('/Link');
    expect(linkDict.get(PDFName.of('P'))?.toString()).toBe(pRef.toString());
    const linkK = linkDict.get(PDFName.of('K'));
    expect(linkK).toBeInstanceOf(PDFArray);
    const linkKArr = (linkK as PDFArray).asArray();
    expect(linkKArr).toHaveLength(2);
    expect((linkKArr[0] as PDFNumber).asNumber()).toBe(1); // linkMcid
    const objrRef = linkKArr[1] as PDFRef;
    const objrDict = doc.context.lookup(objrRef, PDFDict);
    expect(objrDict.get(PDFName.of('Type'))?.toString()).toBe('/OBJR');

    // The real annotation.
    const page = doc.getPage(0);
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')), PDFArray);
    expect(annots.size()).toBe(1);
    const annotRef = annots.get(0) as PDFRef;
    expect(objrDict.get(PDFName.of('Obj'))?.toString()).toBe(annotRef.toString());
    const annotDict = doc.context.lookup(annotRef, PDFDict);
    expect(annotDict.get(PDFName.of('Subtype'))?.toString()).toBe('/Link');
    expect(annotDict.get(PDFName.of('A')) instanceof PDFDict ? (annotDict.get(PDFName.of('A')) as PDFDict).get(PDFName.of('URI'))?.toString() : null).toBe(`(${URL})`);
    const rect = doc.context.lookup(annotDict.get(PDFName.of('Rect')), PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
    // boundingBox {x:100,y:300,width:150,height:10,pageHeight:792} -> [100, 792-300-10, 250, 792-300]
    expect(rect).toEqual([100, 482, 250, 492]);
    expect(annotDict.get(PDFName.of('StructParent'))).toBeInstanceOf(PDFNumber);

    // Content stream: URL's own run now sits inside a fresh /Link span;
    // the remainder sits inside a fresh /P span under its own new MCID.
    const fixedContent = decodePageContent(doc, 1)!;
    expect(fixedContent).toContain(`EMC /Link <</MCID 1>> BDC `);
    expect(fixedContent).toContain(`EMC /P <</MCID 2>> BDC `);
    expect(fixedContent).toContain(`(${URL})`);
    expect(fixedContent).toContain('More citation text after');

    // Both ParentTree mechanisms: page-level array now resolves MCID 1 ->
    // linkRef and MCID 2 -> pRef (the remainder's owner is still the
    // original /P), and the document-level standalone-object key space
    // has an entry for the annotation's own /StructParent resolving to
    // the SAME linkRef.
    const structRoot = doc.context.lookup(structTreeRootRef, PDFDict);
    const parentTree = doc.context.lookup(structRoot.get(PDFName.of('ParentTree')), PDFDict);
    const nums = doc.context.lookup(parentTree.get(PDFName.of('Nums')), PDFArray).asArray();
    const pageArr = doc.context.lookup(nums[1], PDFArray).asArray();
    expect((pageArr[1] as PDFRef).toString()).toBe(linkRef.toString());
    expect((pageArr[2] as PDFRef).toString()).toBe(pRef.toString());

    const structParentKey = (annotDict.get(PDFName.of('StructParent')) as PDFNumber).asNumber();
    let foundAnnotEntry: PDFRef | null = null;
    for (let i = 0; i < nums.length; i += 2) {
      if (nums[i] instanceof PDFNumber && (nums[i] as PDFNumber).asNumber() === structParentKey) {
        foundAnnotEntry = nums[i + 1] as PDFRef;
      }
    }
    expect(foundAnnotEntry?.toString()).toBe(linkRef.toString());
  });

  // Real, live-confirmed shape from Curiel_187961_CSHP.pdf (page 14: content
  // stream /H6, struct element /S /H3; page 32, x5: content stream /H6,
  // struct element /S /H5) -- renameElement (used by fixHeadingHierarchy/
  // fixMultipleH1 to correct a heading-level-skip gap) only ever updates
  // the struct dict's own /S, never the content stream's own BDC tag-name
  // literal, so a heading that's been renamed legitimately disagrees with
  // its own content-stream tag with no actual inconsistency at all --
  // nothing else in this codebase ever reads that tag-name operand for
  // role determination, only the struct element's own /S is authoritative.
  // A prior version of this fixer declined on this exact, harmless
  // disagreement (34/209 of Curiel's own real cases) -- regression test
  // for the fix.
  it('still applies when the enclosing struct element\'s own /S disagrees with the content stream\'s own (cosmetic) BDC tag name', async () => {
    const content = `/H6 <</MCID 0>> BDC BT\n[(Some heading text before)]TJ\n0 -1.5 Td\n[(${URL})]TJ\n0 -1.5 Td\n[(More heading text after)]TJ\nET EMC`;
    const { doc, pRef } = await buildDoc(content, 'H3');

    const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, URL));
    expect(result.success).toBe(true);

    // Reopened remainder keeps the content stream's OWN tag name (/H6) --
    // this fix doesn't need (and shouldn't attempt) to reconcile the two,
    // only to stop treating their disagreement as a blocking problem.
    const fixedContent = decodePageContent(doc, 1)!;
    expect(fixedContent).toContain('EMC /H6 <</MCID 2>> BDC ');

    // The struct element's own /S is untouched by this fix either way.
    const pDict = doc.context.lookup(pRef, PDFDict);
    expect(pDict.get(PDFName.of('S'))?.toString()).toBe('/H3');
  });

  it('declines when the URL cannot be located as a clean operator run on the page', async () => {
    const { doc } = await buildDoc(PAGE_CONTENT);
    const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, 'https://not-on-this-page.example.com'));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not locate this text');
  });

  it('declines when the enclosing content has no MCID of its own (a bare /Artifact)', async () => {
    const content = `/Artifact BMC BT\n[(before)]TJ\n0 -1.5 Td\n[(${URL})]TJ\n0 -1.5 Td\n[(after)]TJ\nET EMC`;
    const { doc } = await buildDoc(content);
    const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, URL));
    expect(result.success).toBe(false);
    expect(result.error).toContain('untagged /Artifact span');
  });

  it('declines cleanly when the issue has no boundingBox', async () => {
    const { doc } = await buildDoc(PAGE_CONTENT);
    const issue = issueFor(1, URL);
    delete issue.boundingBox;
    const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issue);
    expect(result.success).toBe(false);
    expect(result.error).toContain('no boundingBox');
  });

  it('rolls back content, /Annots, and the enclosing /K when a later ParentTree extension fails', async () => {
    // A legitimate, real document shape -- a HIERARCHICAL /Kids ParentTree
    // -- that resolveParentTreePageArray (used EARLY, to find the
    // enclosing /P) fully supports, and that extendParentTree's own
    // resolveParentTreeNumsArray/findParentTreeLeafNums now also walks
    // (fixing 11 real permanently-failed suggestions on Karsaklian_189165).
    // The leaf's /Limits correctly covers this page's key (so both the
    // early read and the leaf-find below succeed, reaching real /Annots +
    // content-stream + /K mutation first) -- the late failure instead
    // comes from a deliberately STALE page array (3 slots, though the
    // real content only ever used MCID 0), so extendParentTree's own
    // contiguity check rejects the commit once the real MCIDs are known.
    // Keeps this a REALISTIC late failure, after mutation has already
    // happened -- exactly the rollback path this test exists to exercise.
    const { doc, pRef, structTreeRootRef } = await buildDoc(PAGE_CONTENT);
    const structRoot = doc.context.lookup(structTreeRootRef, PDFDict);
    const staleEntryArray = doc.context.obj([pRef, pRef, pRef]);
    const pageArrRef = doc.context.register(staleEntryArray);
    const leafNodeRef = doc.context.register(doc.context.obj({ Limits: [0, 0], Nums: [0, pageArrRef] }));
    const hierarchicalParentTree = doc.context.obj({ Kids: [leafNodeRef] });
    structRoot.set(PDFName.of('ParentTree'), hierarchicalParentTree);

    const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, URL));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/contiguously/);

    // Rollback must have restored all three mutated surfaces.
    const page = doc.getPage(0);
    expect(page.node.get(PDFName.of('Annots'))).toBeUndefined();
    const pDict = doc.context.lookup(pRef, PDFDict);
    const restoredK = pDict.get(PDFName.of('K'));
    expect(restoredK).toBeInstanceOf(PDFNumber);
    expect((restoredK as PDFNumber).asNumber()).toBe(0);
    expect(decodePageContent(doc, 1)).toBe(PAGE_CONTENT);
  });

  // Real, live-confirmed root cause of 11/209 of Curiel_187961_CSHP.pdf's
  // own real LINK-MISSING-ANNOTATION issues: the URL genuinely exists on
  // the page, but the document's embedded Type1 subset font encodes the
  // typographic ligature "fi" as a custom single-byte glyph code (standard
  // PDF subsetting) -- without reading that font's own /ToUnicode CMap, a
  // raw-byte decode produces a control character instead of "fi", so the
  // URL never matches. End-to-end: a real font dict with a real /ToUnicode
  // CMap (bfchar <01> -> <0066 0069>, i.e. "fi"), and the URL's own byte
  // \x01 standing in for the real document's own ligature code.
  it('finds and fixes a URL containing a font-specific ligature byte, by reading that font\'s own /ToUnicode CMap', async () => {
    const ligatureUrl = 'https://example.com/defiles';
    const content = `/P <</MCID 0>> BDC BT\n/T1_0 1 Tf\n[(Some citation text before)]TJ\n0 -1.5 Td\n[(https://example.com/de\x01les)]TJ\n0 -1.5 Td\n[(More citation text after)]TJ\nET EMC`;
    const { doc } = await buildDoc(content);

    const page = doc.getPage(0);
    const cmapText = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 beginbfchar\n<01> <00660069>\nendbfchar\nendcmap\nend\nend';
    const toUnicodeRef = doc.context.register(doc.context.stream(cmapText));
    const fontRef = doc.context.register(doc.context.obj({ Type: PDFName.of('Font'), Subtype: PDFName.of('Type1'), BaseFont: PDFName.of('ABCDEF+Test'), ToUnicode: toUnicodeRef }));
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T1_0: fontRef } }));

    const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, ligatureUrl));
    expect(result.success).toBe(true);

    const fixedContent = decodePageContent(doc, 1)!;
    expect(fixedContent).toContain('EMC /Link <</MCID 1>> BDC ');
    expect(fixedContent).toContain('(https://example.com/de\x01les)'); // original bytes untouched, still the raw ligature code
  });

  // Real, live-confirmed shape: the URL shares its own text-show operand
  // with a short lead-in phrase ("Retrieved from ", 30.1%+5.3% of
  // Curiel_187961_CSHP.pdf's own real issues) -- the clean path
  // (findUrlOperatorRun) declines this; fixLinkMissingAnnotation now falls
  // back to the same-operand splitter (findUrlSubstringRun/
  // buildUrlSubstringSplice) rather than giving up.
  it('falls back to the same-operand splitter when the clean path declines, carving the URL out of a shared operand', async () => {
    const url = 'https://example.com/citation-url';
    const content = `/P <</MCID 0>> BDC BT\n/T1_0 1 Tf\n(Retrieved from ${url})Tj\nET EMC`;
    const { doc, pRef } = await buildDoc(content);

    // The splitter's own font-safety guard requires a resolvable, simple
    // (/Type1/TrueType/MMType1/Type3) font at the cut point -- declines
    // (correctly) when it can't verify this, same as the "non-simple font"
    // decline test below. A real font dict, no /ToUnicode needed here
    // (this fixture has no ligature to resolve).
    const page0 = doc.getPage(0);
    const simpleFontRef = doc.context.register(doc.context.obj({ Type: PDFName.of('Font'), Subtype: PDFName.of('Type1'), BaseFont: PDFName.of('ABCDEF+Test') }));
    page0.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T1_0: simpleFontRef } }));

    const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, url));
    expect(result.success).toBe(true);
    expect(result.after).toContain('same-operand splitter');

    // Enclosing /P's own /K: [0, linkRef] -- no remainder needed, the URL
    // was the last real content before the enclosing tag's own close.
    const pK = kidsOf(doc, pRef);
    expect(pK).toHaveLength(2);
    expect((pK[0] as PDFNumber).asNumber()).toBe(0);
    const linkRef = pK[1] as PDFRef;

    const linkDict = doc.context.lookup(linkRef, PDFDict);
    expect(linkDict.get(PDFName.of('S'))?.toString()).toBe('/Link');

    const fixedContent = decodePageContent(doc, 1)!;
    expect(fixedContent).toContain('(Retrieved from )'); // leading leftover, now its own properly-closed literal
    expect(fixedContent).toContain(`EMC /Link <</MCID 1>> BDC (${url})`);

    // The real annotation exists too, same as the clean path's own test above.
    const page = doc.getPage(0);
    const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')), PDFArray);
    expect(annots.size()).toBe(1);
  });

  it('still declines (does not guess) when even the same-operand splitter cannot safely cut -- e.g. a non-simple font', async () => {
    const url = 'https://example.com/citation-url';
    const content = `/P <</MCID 0>> BDC BT\n/T1_0 1 Tf\n(Retrieved from ${url})Tj\nET EMC`;
    const { doc } = await buildDoc(content);

    const page = doc.getPage(0);
    const fontRef = doc.context.register(doc.context.obj({ Type: PDFName.of('Font'), Subtype: PDFName.of('Type0'), BaseFont: PDFName.of('ABCDEF+CIDTest') }));
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T1_0: fontRef } }));

    const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, url));
    expect(result.success).toBe(false);
    expect(result.error).toContain('Could not locate this text');
  });

  // Paragraph-ceiling follow-on (2026-11-06): real, live-confirmed finding
  // on Curiel_187961_CSHP.pdf -- all 209 real LINK-MISSING-ANNOTATION issues
  // sit in only 28 unique (page, enclosing-MCID) paragraphs (several
  // citation URLs routinely share ONE /P). Before this fix, only the FIRST
  // URL per paragraph could ever be spliced: fixing it widens /K from a
  // bare scalar to an array, so every OTHER URL sharing that paragraph hit
  // the (then-unconditional) "/K is no longer the single bare MCID" decline
  // -- even though its own content-stream location was already 100%
  // correct. These tests simulate that exact real shape: TWO URLs in one
  // paragraph, fixed via two SEQUENTIAL calls on the same document.
  describe('paragraph ceiling: a second URL sharing the same already-widened /K', () => {
    const urlA = 'https://example.com/first-citation';
    const urlB = 'https://example.com/second-citation';
    // Each URL shares its own literal with a short lead-in phrase ("First
    // citation: " / "Second citation: ") -- same mid-literal shape as the
    // "falls back to the same-operand splitter" test above, so both fixes
    // below go through the splitter, which needs a resolvable simple font
    // at the cut point (registered on the page below, same pattern).
    const twoUrlContent = `/P <</MCID 0>> BDC BT\n/T1_0 1 Tf\n[(First citation: ${urlA})]TJ\n0 -1.5 Td\n[(Second citation: ${urlB})]TJ\n0 -1.5 Td\n[(Trailing prose)]TJ\nET EMC`;

    function registerSimpleFont(doc: PDFDocument): void {
      const page0 = doc.getPage(0);
      const simpleFontRef = doc.context.register(doc.context.obj({ Type: PDFName.of('Font'), Subtype: PDFName.of('Type1'), BaseFont: PDFName.of('ABCDEF+Test') }));
      page0.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T1_0: simpleFontRef } }));
    }

    it('fixes a second URL in the same paragraph after the first fix already widened /K to an array', async () => {
      const { doc, pRef } = await buildDoc(twoUrlContent);
      registerSimpleFont(doc);

      const first = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, urlA));
      expect(first.success).toBe(true);

      // Confirm the real precondition this test exists to exercise: /P's
      // own /K is now an array (NOT still a bare scalar) before the second
      // fix even runs.
      const afterFirstK = kidsOf(doc, pRef);
      expect(afterFirstK.length).toBeGreaterThan(1);

      const second = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, urlB));
      expect(second.success).toBe(true);
      expect(second.after).toContain(urlB);

      // Final /K: [0, link1Ref, remainder1Mcid, link2Ref, remainder2Mcid?]
      // -- both Links spliced in, each immediately after its own
      // enclosingMcid entry, reading order preserved throughout.
      const finalK = kidsOf(doc, pRef);
      expect((finalK[0] as PDFNumber).asNumber()).toBe(0);
      const link1Ref = finalK[1] as PDFRef;
      expect(link1Ref).toBeInstanceOf(PDFRef);
      const link1Dict = doc.context.lookup(link1Ref, PDFDict);
      expect(link1Dict.get(PDFName.of('S'))?.toString()).toBe('/Link');

      const remainder1Mcid = (finalK[2] as PDFNumber).asNumber();
      const link2Ref = finalK[3] as PDFRef;
      expect(link2Ref).toBeInstanceOf(PDFRef);
      expect(link2Ref.toString()).not.toBe(link1Ref.toString());
      const link2Dict = doc.context.lookup(link2Ref, PDFDict);
      expect(link2Dict.get(PDFName.of('S'))?.toString()).toBe('/Link');
      // Both Link struct elements share the SAME /P (the one, shared
      // paragraph) as their parent -- not two different containers.
      expect(link2Dict.get(PDFName.of('P'))?.toString()).toBe(pRef.toString());

      expect(finalK).toHaveLength(5);
      const remainder2Mcid = (finalK[4] as PDFNumber).asNumber();
      expect(remainder2Mcid).not.toBe(remainder1Mcid);

      // Both annotations real and present.
      const page = doc.getPage(0);
      const annots = doc.context.lookup(page.node.get(PDFName.of('Annots')), PDFArray);
      expect(annots.size()).toBe(2);

      // Both URLs' own text actually present, each inside its own fresh
      // /Link-tagged span.
      const fixedContent = decodePageContent(doc, 1)!;
      expect(fixedContent).toContain(`(${urlA})`);
      expect(fixedContent).toContain(`(${urlB})`);
    });

    it('declines (does not guess) when /K is an array but the target MCID is not in it at all', async () => {
      const { doc, pRef } = await buildDoc(PAGE_CONTENT);
      const pDict = doc.context.lookup(pRef, PDFDict);
      // A /K array that doesn't contain MCID 0 anywhere -- an unrelated
      // shape this fixer has never produced itself, so the right behavior
      // is still to decline, not to guess a splice position.
      pDict.set(PDFName.of('K'), doc.context.obj([PDFNumber.of(7), PDFNumber.of(8)]));

      const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, URL));
      expect(result.success).toBe(false);
      expect(result.error).toContain('0 time(s)');
    });

    it('declines (does not guess) when /K is an array containing the target MCID more than once', async () => {
      const { doc, pRef } = await buildDoc(PAGE_CONTENT);
      const pDict = doc.context.lookup(pRef, PDFDict);
      // Pathological, should-never-happen shape -- confirm the fixer still
      // declines rather than picking one of the two ambiguous positions.
      pDict.set(PDFName.of('K'), doc.context.obj([PDFNumber.of(0), PDFNumber.of(0)]));

      const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, URL));
      expect(result.success).toBe(false);
      expect(result.error).toContain('2 time(s)');
    });

    /**
     * Real root cause behind Karsaklian_189165_9781606497623's one
     * remaining "correctly skipped" failure after PR #777: MCID 1844's own
     * paragraph (an Adobe InDesign /Story -> /TX export) carries it as an
     * MCR (Marked Content Reference) dict -- <</Type /MCR /Pg ref /MCID
     * n>>, PDF32000 14.7.4.4 -- not a bare number. That's an equally valid
     * PDF shape, but the array-membership check only recognized bare
     * numbers, so it reported "0 time(s)" for an MCID that was genuinely
     * there, just spelled differently -- declining a case that was never
     * actually ambiguous.
     */
    it('finds the target MCID when /K is an array containing it as an MCR (Marked Content Reference) dict, not a bare number', async () => {
      const { doc, pRef } = await buildDoc(PAGE_CONTENT);
      const pDict = doc.context.lookup(pRef, PDFDict);
      const page = doc.getPage(0);
      // Same real shape as Karsaklian_189165: siblings before/after as bare
      // numbers, the target itself as an MCR dict with its own explicit /Pg.
      // The trailing sibling uses a placeholder (999) deliberately far from
      // any MCID this fixer would itself allocate, so it can't be mistaken
      // for the new splice's own fresh remainder MCID below.
      pDict.set(PDFName.of('K'), doc.context.obj([
        PDFNumber.of(-1),
        doc.context.obj({ Type: PDFName.of('MCR'), Pg: page.ref, MCID: PDFNumber.of(0) }),
        PDFNumber.of(999),
      ]));

      const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, URL));
      expect(result.success).toBe(true);

      // Spliced in immediately after the MCR entry's own position (index 1),
      // not before it and not at the array's end -- the original leading
      // sibling and trailing sibling are both untouched.
      const finalK = kidsOf(doc, pRef);
      expect((finalK[0] as PDFNumber).asNumber()).toBe(-1);
      expect(finalK[1]).toBeInstanceOf(PDFDict);
      expect((finalK[1] as PDFDict).get(PDFName.of('Type'))?.toString()).toBe('/MCR');
      expect(finalK[2]).toBeInstanceOf(PDFRef); // the new Link struct element
      expect((finalK[finalK.length - 1] as PDFNumber).asNumber()).toBe(999); // original trailing sibling, untouched
    });

    it('also finds the target MCID when the MCR dict itself is stored as an indirect reference', async () => {
      const { doc, pRef } = await buildDoc(PAGE_CONTENT);
      const pDict = doc.context.lookup(pRef, PDFDict);
      const page = doc.getPage(0);
      const mcrRef = doc.context.register(doc.context.obj({ Type: PDFName.of('MCR'), Pg: page.ref, MCID: PDFNumber.of(0) }));
      pDict.set(PDFName.of('K'), doc.context.obj([mcrRef]));

      const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, URL));
      expect(result.success).toBe(true);
    });

    it('still declines when an MCR dict is present but for a DIFFERENT MCID -- doesn\'t false-positive-match on the dict shape alone', async () => {
      const { doc, pRef } = await buildDoc(PAGE_CONTENT);
      const pDict = doc.context.lookup(pRef, PDFDict);
      const page = doc.getPage(0);
      pDict.set(PDFName.of('K'), doc.context.obj([
        doc.context.obj({ Type: PDFName.of('MCR'), Pg: page.ref, MCID: PDFNumber.of(99) }),
      ]));

      const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, URL));
      expect(result.success).toBe(false);
      expect(result.error).toContain('0 time(s)');
    });

    it('rolls back to the original, untouched /K array when a later step fails on an already-widened paragraph', async () => {
      const { doc, pRef, structTreeRootRef } = await buildDoc(twoUrlContent);
      registerSimpleFont(doc);

      const first = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, urlA));
      expect(first.success).toBe(true);
      const afterFirstK = kidsOf(doc, pRef);
      expect(afterFirstK).toHaveLength(3); // [0, link1Ref, remainder1Mcid]

      // Same late-failure trigger as the scalar-/K rollback test above: a
      // hierarchical /ParentTree (now wrapping the SAME page array the
      // first fix already extended, with its own key correctly covered by
      // the one leaf's /Limits, so the first fix's already-committed state
      // reads back fine) but with one extra bogus slot appended -- a stale
      // page array, so the first fix above succeeds normally (ran before
      // this injection) and only the second hits extendParentTree's own
      // contiguity decline.
      const structRoot = doc.context.lookup(structTreeRootRef, PDFDict);
      const existingParentTree = doc.context.lookup(structRoot.get(PDFName.of('ParentTree')), PDFDict);
      const existingNums = doc.context.lookup(existingParentTree.get(PDFName.of('Nums')), PDFArray);
      const existingPageArr = doc.context.lookup(existingNums.get(1), PDFArray);
      const pageArrRef = doc.context.register(doc.context.obj([...existingPageArr.asArray(), pRef]));
      const leafNodeRef = doc.context.register(doc.context.obj({ Limits: [0, 0], Nums: [0, pageArrRef] }));
      const hierarchicalParentTree = doc.context.obj({ Kids: [leafNodeRef] });
      structRoot.set(PDFName.of('ParentTree'), hierarchicalParentTree);

      const second = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, urlB));
      expect(second.success).toBe(false);
      expect(second.error).toMatch(/contiguously/);

      // Rollback must restore the array /K to EXACTLY its pre-second-fix
      // shape -- not lose link1's own already-committed splice from the
      // first fix, and not leave a half-applied second splice behind
      // either. This is the real hazard the no-in-place-mutation design
      // (building a brand new array rather than calling k.insert()
      // in-place) exists to avoid.
      const pDict = doc.context.lookup(pRef, PDFDict);
      const restoredK = pDict.get(PDFName.of('K'));
      expect(restoredK).toBeInstanceOf(PDFArray);
      const restoredArr = (restoredK as PDFArray).asArray();
      expect(restoredArr).toHaveLength(3);
      expect((restoredArr[0] as PDFNumber).asNumber()).toBe(0);
      expect(restoredArr[1]).toBeInstanceOf(PDFRef);
      expect(restoredArr[1].toString()).toBe(afterFirstK[1].toString()); // same link1Ref, untouched
      expect((restoredArr[2] as PDFNumber).asNumber()).toBe((afterFirstK[2] as PDFNumber).asNumber());
    });
  });

  /**
   * Regression for a real corruption bug this fix's own hierarchical
   * /ParentTree support introduced as a side effect: once
   * resolveParentTreeNumsArray/findParentTreeLeafNums started returning
   * ONE leaf's /Nums instead of throwing, appendAnnotationParentTreeEntry
   * (which allocates a brand-new STANDALONE /StructParent key for the
   * Link annotation itself -- a document-wide keyspace, not a per-page
   * one) kept treating that single leaf's /Nums as if it were the WHOLE
   * document's keyspace: it under-counted the true highest existing key
   * (missed any higher key sitting in a DIFFERENT leaf) and inserted the
   * new key into the wrong leaf, violating that leaf's own /Limits.
   * Reproduced directly against a synthetic tree mirroring
   * Karsaklian_189165's real multi-leaf shape before this was fixed.
   */
  it('allocates the new annotation\'s standalone /StructParent key correctly on a MULTI-leaf hierarchical /ParentTree, widening the trailing leaf rather than corrupting the page\'s own leaf', async () => {
    const { doc, pRef, structTreeRootRef } = await buildDoc(PAGE_CONTENT);
    const structRoot = doc.context.lookup(structTreeRootRef, PDFDict);

    // Leaf A covers this page's own content key (0). Leaf B is a sibling
    // leaf covering a HIGHER key range, already holding one unrelated
    // standalone entry (key 3) -- the real shape that would otherwise be
    // invisible to a highestKey scan limited to leaf A alone.
    const pageArrRef = doc.context.register(doc.context.obj([pRef]));
    const leafARef = doc.context.register(doc.context.obj({ Limits: [0, 0], Nums: [0, pageArrRef] }));
    const unrelatedRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('Link') }));
    const leafBRef = doc.context.register(doc.context.obj({ Limits: [1, 5], Nums: [3, unrelatedRef] }));
    structRoot.set(PDFName.of('ParentTree'), doc.context.obj({ Kids: [leafARef, leafBRef] }));
    structRoot.set(PDFName.of('ParentTreeNextKey'), PDFNumber.of(6));

    const result = pdfStructureWriterService.fixLinkMissingAnnotation(doc, issueFor(1, URL));
    expect(result.success).toBe(true);

    // Leaf A (the page's own leaf) must be completely untouched.
    const leafA = doc.context.lookup(leafARef, PDFDict);
    expect((leafA.get(PDFName.of('Limits')) as PDFArray).asArray().map(n => (n as PDFNumber).asNumber())).toEqual([0, 0]);
    expect((leafA.get(PDFName.of('Nums')) as PDFArray).asArray()).toHaveLength(2);

    // The new standalone key (6, the counter's value -- correctly ahead of
    // leaf B's own existing key 3) must land in leaf B, with /Limits
    // widened to cover it.
    const leafB = doc.context.lookup(leafBRef, PDFDict);
    const leafBLimits = (leafB.get(PDFName.of('Limits')) as PDFArray).asArray().map(n => (n as PDFNumber).asNumber());
    expect(leafBLimits).toEqual([1, 6]);
    const leafBNums = (leafB.get(PDFName.of('Nums')) as PDFArray).asArray();
    expect(leafBNums).toHaveLength(4);
    expect((leafBNums[0] as PDFNumber).asNumber()).toBe(3); // untouched original entry
    expect((leafBNums[2] as PDFNumber).asNumber()).toBe(6); // new entry, in sorted position

    expect((structRoot.get(PDFName.of('ParentTreeNextKey')) as PDFNumber).asNumber()).toBe(7);
  });
});
