/**
 * Regression coverage for fixCitationLink/resolveCitationDestination --
 * builds a real internal /Link (GoTo action) for an in-text citation
 * ("(Karsaklian 2017)") ONLY when it matches EXACTLY ONE raw /REF-tagged
 * reference-list entry, document-wide. Reuses buildLinkAnnotationFix (the
 * same splice/ParentTree/rollback core as fixLinkMissingAnnotation/
 * fixCrossReferenceLink) for the annotation-writing half; these tests focus
 * on the NEW half -- /REF text recovery (extractTextFromStructElem's
 * /ActualText fast path, AND the content-stream MCID fallback through the
 * new glyph-aware decodeMcidTextWithGlyphs/extractDecodedTextInRange) and
 * author+year matching's own "decline rather than guess" gates.
 *
 * Real document evidence this is built against
 * (Karsaklian_189165_9781606497623.pdf): 20/20 real in-text citations each
 * matched exactly one /REF entry; one real case ("Hoffman, D., and T.
 * Novak 2018") decodes its own "ff" as a single raw ligature byte without a
 * font-aware decode, which would silently break author-name matching.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFRef, PDFDict, PDFHexString } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function citationIssue(
  pageNumber: number,
  citationData: NonNullable<AuditIssue['citationData']>,
): AuditIssue {
  return {
    id: 'citation-link-1',
    source: 'link-completeness-validator',
    severity: 'moderate',
    code: 'CITATION-MISSING-LINK',
    message: `Text reads as an in-text citation ("${citationData.fullText}") but has no underlying Link annotation to its reference-list entry`,
    wcagCriteria: ['1.3.1', '4.1.2'],
    matterhornCheckpoint: '28-011',
    matterhornHow: 'M',
    category: 'links',
    pageNumber,
    citationData,
    boundingBox: { x: 100, y: 300, width: 150, height: 10, pageWidth: 612, pageHeight: 792 },
  } as AuditIssue;
}

function setFlatParentTree(doc: PDFDocument, structTreeRootRef: PDFRef, entries: PDFRef[]): void {
  const pageArr = doc.context.obj(entries);
  const parentTree = doc.context.obj({ Nums: [0, pageArr] });
  doc.context.lookup(structTreeRootRef, PDFDict).set(PDFName.of('ParentTree'), parentTree);
}

/**
 * Builds a 2-page document: page 1 carries the citation text embedded
 * mid-sentence in one `/P <</MCID 0>>` span (same real shape as
 * fixCrossReferenceLink's own test fixture -- always needs the same-operand
 * splitter, not the "isolated in its own operand" clean path), page 2
 * carries zero or more /REF struct elements -- the resolution targets.
 * Each entry with `actualText` set gets it directly on the /REF dict
 * (extractTextFromStructElem's fast path); `mcidContent` instead gives it a
 * real leaf MCID whose own content-stream text must be decoded
 * (collectLeafMcids + decodeMcidTextWithGlyphs).
 */
async function buildDoc(
  citationText: string,
  refEntries: Array<{ actualText?: string; mcidContent?: string }> = [],
): Promise<{ doc: PDFDocument; pRef: PDFRef }> {
  const doc = await PDFDocument.create();
  const page1 = doc.addPage([612, 792]);
  page1.node.set(PDFName.of('StructParents'), doc.context.obj(0));
  const page2 = doc.addPage([612, 792]);
  page2.node.set(PDFName.of('StructParents'), doc.context.obj(1));

  writePageContent(doc, 1, `/P <</MCID 0>> BDC BT\n/T1_0 1 Tf\n(Research shows this effect ${citationText} clearly.)Tj\nET EMC`);
  const simpleFontRef = doc.context.register(doc.context.obj({ Type: PDFName.of('Font'), Subtype: PDFName.of('Type1'), BaseFont: PDFName.of('ABCDEF+Test') }));
  page1.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T1_0: simpleFontRef } }));

  const pRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructElem'), S: PDFName.of('P'), Pg: page1.ref, K: 0 }));

  let nextMcid = 0;
  const page2TextParts: string[] = [];
  const refRefs = refEntries.map((entry) => {
    const dict: Record<string, unknown> = { S: PDFName.of('REF'), Pg: page2.ref };
    if (entry.actualText !== undefined) {
      dict.ActualText = PDFHexString.fromText(entry.actualText);
      dict.K = nextMcid; // still needs a /K so the element has a real MCID on its own page
      page2TextParts.push(`/REF <</MCID ${nextMcid}>> BDC BT\n(placeholder)Tj\nET EMC`);
      nextMcid++;
    } else if (entry.mcidContent !== undefined) {
      dict.K = nextMcid;
      page2TextParts.push(`/REF <</MCID ${nextMcid}>> BDC BT\n/T1_1 1 Tf\n(${entry.mcidContent})Tj\nET EMC`);
      nextMcid++;
    }
    return doc.context.register(doc.context.obj(dict));
  });
  writePageContent(doc, 2, page2TextParts.join('\n'));
  const simpleFontRef2 = doc.context.register(doc.context.obj({ Type: PDFName.of('Font'), Subtype: PDFName.of('Type1'), BaseFont: PDFName.of('ABCDEF+Test2') }));
  page2.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T1_1: simpleFontRef2 } }));

  const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [pRef, ...refRefs] }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
  setFlatParentTree(doc, structTreeRootRef, [pRef]);

  return { doc, pRef };
}

describe('fixCitationLink', () => {
  it('resolves and links a citation to its single matching /ActualText-tagged /REF entry', async () => {
    const { doc } = await buildDoc('(Karsaklian 2017)', [
      { actualText: 'Karsaklian, E. 2017. Sustainable Negotiation. Emerald.' },
    ]);

    const result = pdfStructureWriterService.fixCitationLink(
      doc, citationIssue(1, { authorText: 'Karsaklian', year: '2017', fullText: '(Karsaklian 2017)' })
    );

    expect(result.success).toBe(true);
    expect(result.after).toContain('(Karsaklian 2017)');
  });

  it('disambiguates same-author entries by year alone (several Karsaklian entries, one per year)', async () => {
    const { doc } = await buildDoc('(Karsaklian 2017)', [
      { actualText: 'Karsaklian, E. 2014. The Intelligent International Negotiator. Business Expert Press.' },
      { actualText: 'Karsaklian, E. 2017. Sustainable Negotiation. Emerald.' },
      { actualText: 'Karsaklian, E. 2019. The After Deal. IAP.' },
    ]);

    const result = pdfStructureWriterService.fixCitationLink(
      doc, citationIssue(1, { authorText: 'Karsaklian', year: '2017', fullText: '(Karsaklian 2017)' })
    );

    expect(result.success).toBe(true);
  });

  it('matches a disambiguating suffix letter exactly ("2025b" must not match "2025a")', async () => {
    const { doc } = await buildDoc('(Karsaklian 2025b)', [
      { actualText: 'Karsaklian, E. 2025a. AI Marketing. The Magic That Unites the World. BEP.' },
      { actualText: 'Karsaklian, E. 2025b. The More You Measure the Less You Feel. ACR.' },
    ]);

    const result = pdfStructureWriterService.fixCitationLink(
      doc, citationIssue(1, { authorText: 'Karsaklian', year: '2025b', fullText: '(Karsaklian 2025b)' })
    );

    expect(result.success).toBe(true);
  });

  it('matches a two-author citation on the FIRST author\'s surname only', async () => {
    const { doc } = await buildDoc('(Karsaklian and Mehta 2026)', [
      { actualText: 'Karsaklian, E., and D. Mehta. 2026. We Know About Chatbot Cost-Efficiency. ACR.' },
    ]);

    const result = pdfStructureWriterService.fixCitationLink(
      doc, citationIssue(1, { authorText: 'Karsaklian and Mehta', year: '2026', fullText: '(Karsaklian and Mehta 2026)' })
    );

    expect(result.success).toBe(true);
  });

  it('declines when two /REF entries match the same author+year (ambiguous)', async () => {
    const { doc } = await buildDoc('(Smith 2020)', [
      { actualText: 'Smith, J. 2020. First Book. Publisher A.' },
      { actualText: 'Smith, J. 2020. Second Book. Publisher B.' },
    ]);

    const result = pdfStructureWriterService.fixCitationLink(
      doc, citationIssue(1, { authorText: 'Smith', year: '2020', fullText: '(Smith 2020)' })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('unambiguously');
  });

  it('declines when no /REF entry matches at all', async () => {
    const { doc } = await buildDoc('(Smith 2020)', [
      { actualText: 'Jones, A. 2020. An Unrelated Book. Publisher.' },
    ]);

    const result = pdfStructureWriterService.fixCitationLink(
      doc, citationIssue(1, { authorText: 'Smith', year: '2020', fullText: '(Smith 2020)' })
    );

    expect(result.success).toBe(false);
  });

  it('does not match an author name that is merely a SUBSTRING of a longer surname', async () => {
    // "Smith" must not match an entry starting with "Smithson" -- the real
    // referenceEntryMatches contract requires a word boundary right after
    // the matched name, not just a shared prefix.
    const { doc } = await buildDoc('(Smith 2020)', [
      { actualText: 'Smithson, K. 2020. A Different Author Entirely. Publisher.' },
    ]);

    const result = pdfStructureWriterService.fixCitationLink(
      doc, citationIssue(1, { authorText: 'Smith', year: '2020', fullText: '(Smith 2020)' })
    );

    expect(result.success).toBe(false);
  });

  it('does not match a bare (no-suffix) citation year against a suffixed-only entry', async () => {
    const { doc } = await buildDoc('(Smith 2020)', [
      { actualText: 'Smith, J. 2020b. Only A Suffixed Entry Exists. Publisher.' },
    ]);

    const result = pdfStructureWriterService.fixCitationLink(
      doc, citationIssue(1, { authorText: 'Smith', year: '2020', fullText: '(Smith 2020)' })
    );

    expect(result.success).toBe(false);
  });

  // Real, live-confirmed shape on Karsaklian_189165_9781606497623.pdf's own
  // bibliography: "Hoffman, D., and T. Novak 2018" decodes its own "ff" as a
  // single raw ligature byte without font-aware resolution -- this would
  // silently break matching citation text "Hoffman" against it. Exercises
  // the REAL fallback path (no /ActualText -- collectLeafMcids +
  // decodeMcidTextWithGlyphs over the /REF entry's own content-stream
  // bytes), not the cheap /ActualText shortcut the other tests above use.
  it('resolves a citation via the content-stream MCID fallback, resolving a ligature byte through the font\'s own /ToUnicode CMap', async () => {
    const { doc } = await buildDoc('(Hoffman and Novak 2018)', [
      { mcidContent: 'Ho\x01man, D., and T. Novak 2018. Consumer and Object Experience.' },
    ]);

    const page2 = doc.getPage(1);
    const cmapText = '/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n1 beginbfchar\n<01> <00660066>\nendbfchar\nendcmap\nend\nend';
    const toUnicodeRef = doc.context.register(doc.context.stream(cmapText));
    const fontRef = doc.context.register(doc.context.obj({ Type: PDFName.of('Font'), Subtype: PDFName.of('Type1'), BaseFont: PDFName.of('ABCDEF+Test2'), ToUnicode: toUnicodeRef }));
    page2.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T1_1: fontRef } }));

    const result = pdfStructureWriterService.fixCitationLink(
      doc, citationIssue(1, { authorText: 'Hoffman and Novak', year: '2018', fullText: '(Hoffman and Novak 2018)' })
    );

    expect(result.success).toBe(true);
  });

  it('declines (not a crash) when the content-stream MCID fallback has no resolvable font -- ligature stays undecoded and the match fails', async () => {
    const { doc } = await buildDoc('(Hoffman and Novak 2018)', [
      { mcidContent: 'Ho\x01man, D., and T. Novak 2018. Consumer and Object Experience.' },
    ]);
    // No /ToUnicode registered -- the raw \x01 byte never resolves to "ff",
    // so "Hoffman" never matches this entry's own undecoded text.

    const result = pdfStructureWriterService.fixCitationLink(
      doc, citationIssue(1, { authorText: 'Hoffman and Novak', year: '2018', fullText: '(Hoffman and Novak 2018)' })
    );

    expect(result.success).toBe(false);
  });

  it('declines when there are no /REF-tagged elements in the document at all', async () => {
    const { doc } = await buildDoc('(Smith 2020)', []);

    const result = pdfStructureWriterService.fixCitationLink(
      doc, citationIssue(1, { authorText: 'Smith', year: '2020', fullText: '(Smith 2020)' })
    );

    expect(result.success).toBe(false);
  });

  it('declines cleanly when the issue has no citationData', async () => {
    const { doc } = await buildDoc('(Karsaklian 2017)', [
      { actualText: 'Karsaklian, E. 2017. Sustainable Negotiation. Emerald.' },
    ]);
    const issue = citationIssue(1, { authorText: 'Karsaklian', year: '2017', fullText: '(Karsaklian 2017)' });
    delete (issue as { citationData?: unknown }).citationData;

    const result = pdfStructureWriterService.fixCitationLink(doc, issue);

    expect(result.success).toBe(false);
    expect(result.error).toContain('citationData');
  });

  it('declines cleanly when the issue has no boundingBox', async () => {
    const { doc } = await buildDoc('(Karsaklian 2017)', [
      { actualText: 'Karsaklian, E. 2017. Sustainable Negotiation. Emerald.' },
    ]);
    const issue = citationIssue(1, { authorText: 'Karsaklian', year: '2017', fullText: '(Karsaklian 2017)' });
    delete (issue as { boundingBox?: unknown }).boundingBox;

    const result = pdfStructureWriterService.fixCitationLink(doc, issue);

    expect(result.success).toBe(false);
    expect(result.error).toContain('boundingBox');
  });
});
