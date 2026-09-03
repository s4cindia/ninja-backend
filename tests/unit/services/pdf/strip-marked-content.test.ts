import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import {
  stripMcidMarkedContent,
  prepareDocumentForRetag,
  resolvePagePropertyMcidStates,
} from '../../../../src/services/pdf/strip-marked-content';
import { tokenize } from '../../../../src/services/zone-extractor/seam-c/content-stream';
import { decodePageContent, writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';

describe('stripMcidMarkedContent', () => {
  it('strips a single inline-dict MCID-tagged BDC…EMC pair, preserving the content between them', () => {
    const content = 'q\n/Part <</MCID 0>> BDC\nBT /F1 12 Tf (Hello) Tj ET\nEMC\nQ';
    const result = stripMcidMarkedContent(content);

    expect(result.bailedOnUnsupportedForm).toBe(false);
    expect(result.removedCount).toBe(1);
    expect(result.content).toContain('BT /F1 12 Tf (Hello) Tj ET');
    expect(result.content).not.toContain('BDC');
    expect(result.content).not.toContain('EMC');
    expect(result.content).not.toContain('MCID');
    expect(result.content.startsWith('q\n')).toBe(true);
    expect(result.content.trim().endsWith('Q')).toBe(true);
  });

  it('matches the real-world format found in the pilot document (no space before BDC)', () => {
    const content = 'q\n/Part <</MCID 0 >>BDC\n<41> Tj\nEMC\nQ';
    const result = stripMcidMarkedContent(content);

    expect(result.removedCount).toBe(1);
    expect(result.content).toContain('<41> Tj');
    expect(result.content).not.toContain('BDC');
  });

  it('strips multiple independent (non-nested) MCID pairs and leaves unrelated content untouched', () => {
    const content = 'BEFORE /P <</MCID 0>> BDC AAA EMC MIDDLE /H1 <</MCID 1>> BDC BBB EMC AFTER';
    const result = stripMcidMarkedContent(content);

    expect(result.removedCount).toBe(2);
    // Double spaces where the removed tokens' own surrounding whitespace
    // meets — cosmetic only, PDF content streams are whitespace-insensitive
    // between tokens (already covered by the re-tokenization test below).
    expect(result.content).toBe('BEFORE  AAA  MIDDLE  BBB  AFTER');
  });

  it('correctly pairs nested BDC…EMC and strips only the MCID-tagged ones', () => {
    // Outer MCID-tagged region containing an inner /Artifact BMC (bare tag,
    // no property dict — never MCID-tagged) that must not be stripped, and
    // must not desync the pairing of the outer EMC.
    const content = '/P <</MCID 0>> BDC OUTER-BEFORE /Artifact BMC INNER EMC OUTER-AFTER EMC';
    const result = stripMcidMarkedContent(content);

    expect(result.removedCount).toBe(1); // only the outer MCID pair
    expect(result.content).toContain('/Artifact BMC');
    expect(result.content).toContain('INNER');
    expect(result.content).toContain('EMC'); // the inner BMC's own EMC survives
    expect(result.content).toContain('OUTER-BEFORE');
    expect(result.content).toContain('OUTER-AFTER');
  });

  it('bails on the named-properties-resource BDC form when no property states are supplied', () => {
    const content = 'q /OC /MC0 BDC ARTWORK EMC Q /P <</MCID 0>> BDC MORE EMC';
    const result = stripMcidMarkedContent(content);

    expect(result.bailedOnUnsupportedForm).toBe(true);
    expect(result.removedCount).toBe(0);
    expect(result.content).toBe(content); // byte-for-byte unchanged
  });

  it('bails on the named-properties-resource BDC form when the property is absent from the supplied states', () => {
    const content = 'q /P0 /MC0 BDC ARTWORK EMC Q';
    // Map is non-empty but doesn't mention "MC0" -- must still bail, not
    // silently default to "not tagged".
    const result = stripMcidMarkedContent(content, new Map([['SomeOtherProp', 'not-mcid']]));

    expect(result.bailedOnUnsupportedForm).toBe(true);
    expect(result.content).toBe(content);
  });

  it('strips the named-properties-resource BDC form when the property is confirmed MCID-tagged', () => {
    const content = 'q /Part /P0 BDC ARTWORK EMC Q';
    const result = stripMcidMarkedContent(content, new Map([['P0', 'mcid']]));

    expect(result.bailedOnUnsupportedForm).toBe(false);
    expect(result.removedCount).toBe(1);
    expect(result.content).not.toContain('BDC');
    expect(result.content).not.toContain('EMC');
    expect(result.content).toContain('ARTWORK');
  });

  it('preserves (without bailing or stripping) a named-properties BDC confirmed not MCID-tagged', () => {
    // e.g. an /OC optional-content-group property -- a real, resolvable
    // property that legitimately isn't a structure-tree MCID mark.
    const content = 'q /OC /MC0 BDC ARTWORK EMC Q';
    const result = stripMcidMarkedContent(content, new Map([['MC0', 'not-mcid']]));

    expect(result.bailedOnUnsupportedForm).toBe(false);
    expect(result.removedCount).toBe(0);
    expect(result.content).toBe(content);
  });

  it('is a no-op on content with no marked content at all', () => {
    const content = 'q BT /F1 12 Tf (No tags here) Tj ET Q';
    const result = stripMcidMarkedContent(content);

    expect(result.removedCount).toBe(0);
    expect(result.bailedOnUnsupportedForm).toBe(false);
    expect(result.content).toBe(content);
  });

  it('re-tokenizes cleanly, with every non-tag token surviving in the same order', () => {
    const content = 'q\nBT\n/Part <</MCID 0 >>BDC\n1 0 0 1 50 700 Tm\n(Hello) Tj\nEMC\nET\nQ';
    const result = stripMcidMarkedContent(content);

    const expectedSurvivors = ['q', 'BT', '1', '0', '0', '1', '50', '700', 'Tm', '(Hello)', 'Tj', 'ET', 'Q'];
    const actualTokens = tokenize(result.content).map((t) => t.v);

    expect(actualTokens).toEqual(expectedSurvivors);
  });
});

describe('prepareDocumentForRetag', () => {
  /** A real pdf-lib-rendered page, then post-processed to wrap its content in an MCID BDC…EMC — simulating "already tagged" the same way the real pilot document's own tagging shape looks. */
  async function buildTaggedDoc(pageCount: number): Promise<PDFDocument> {
    const src = await PDFDocument.create();
    const font = await src.embedFont(StandardFonts.Helvetica);
    for (let i = 0; i < pageCount; i++) {
      const page = src.addPage([400, 600]);
      page.drawText(`Page ${i + 1}`, { x: 50, y: 500, size: 14, font });
    }
    // pdf-lib buffers drawText internally — a save+reload round trip is
    // required before decodePageContent can see the real content stream.
    const doc = await PDFDocument.load(await src.save());
    for (let i = 0; i < pageCount; i++) {
      const content = decodePageContent(doc, i + 1)!;
      writePageContent(doc, i + 1, `/Part <</MCID 0>> BDC\n${content}\nEMC`);
    }
    // Minimal but real StructTreeRoot — enough for the "was there one" check.
    const rootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot') }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef);
    doc.catalog.set(PDFName.of('MarkInfo'), doc.context.obj({ Marked: true }));
    return doc;
  }

  it('strips every page and removes the catalog StructTreeRoot pointer', async () => {
    const doc = await buildTaggedDoc(3);
    const result = prepareDocumentForRetag(doc);

    expect(result.success).toBe(true);
    expect(result.pagesStripped).toBe(3);
    expect(result.totalPages).toBe(3);
    expect(result.bailedOnPage).toBeNull();
    expect(doc.catalog.get(PDFName.of('StructTreeRoot'))).toBeUndefined();

    for (let i = 0; i < 3; i++) {
      const after = decodePageContent(doc, i + 1)!;
      expect(after).not.toContain('BDC');
      expect(after).not.toContain('MCID');
      expect(after).toContain('Tj'); // original text-show op preserved
    }
  });

  it('is all-or-nothing: one page with an unsupported BDC form aborts the whole document unchanged', async () => {
    const doc = await buildTaggedDoc(3);
    // Corrupt page 2 with a named-properties-resource BDC pointing at a
    // property that was never registered in any /Resources /Properties
    // dict -- unresolvable, so still bails even with the named-form support.
    const page2Content = decodePageContent(doc, 2)!;
    writePageContent(doc, 2, page2Content.replace('/Part <</MCID 0>> BDC', '/OC /MC0 BDC'));

    const result = prepareDocumentForRetag(doc);

    expect(result.success).toBe(false);
    expect(result.bailedOnPage).toBe(2);
    expect(result.pagesStripped).toBe(0);
    // The catalog must be untouched — this is the load-bearing guarantee.
    expect(doc.catalog.get(PDFName.of('StructTreeRoot'))).toBeDefined();
    // Page 1 (which would have stripped cleanly on its own) must also be untouched.
    expect(decodePageContent(doc, 1)).toContain('BDC');
  });

  it('strips a page using the named-properties-resource BDC form when its property is registered as MCID-tagged', async () => {
    // Live-confirmed bug (real 805-page document): page 2 used this exact
    // form -- `/Tag /PropertyName BDC` indirecting through a real,
    // registered /Resources /Properties entry -- and strip-and-retag bailed
    // on it every round, so the isHeadingShell retag gate (PR #515)
    // correctly *triggered* a retag attempt that could never succeed.
    const doc = await buildTaggedDoc(3);

    const propRef = doc.context.register(doc.context.obj({ MCID: 0 }));
    const propertiesRef = doc.context.register(doc.context.obj({ P0: propRef }));
    const resourcesRef = doc.context.register(doc.context.obj({ Properties: propertiesRef }));
    const page2 = doc.getPage(1);
    page2.node.set(PDFName.of('Resources'), resourcesRef);

    const page2Content = decodePageContent(doc, 2)!;
    writePageContent(doc, 2, page2Content.replace('/Part <</MCID 0>> BDC', '/Part /P0 BDC'));

    const result = prepareDocumentForRetag(doc);

    expect(result.success).toBe(true);
    expect(result.pagesStripped).toBe(3);
    expect(result.bailedOnPage).toBeNull();
    expect(doc.catalog.get(PDFName.of('StructTreeRoot'))).toBeUndefined();
    for (let i = 0; i < 3; i++) {
      const after = decodePageContent(doc, i + 1)!;
      expect(after).not.toContain('BDC');
      expect(after).toContain('Tj');
    }
  });

  it('reports success: false with no changes when there is nothing to strip', async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([400, 600]);
    page.drawText('Plain page, never tagged', { x: 50, y: 500, size: 14, font });

    const result = prepareDocumentForRetag(doc);

    expect(result.success).toBe(false);
    expect(result.pagesStripped).toBe(0);
    expect(result.bailedOnPage).toBeNull();
    expect(doc.catalog.get(PDFName.of('StructTreeRoot'))).toBeUndefined(); // never had one
  });
});

describe('resolvePagePropertyMcidStates', () => {
  it('returns an empty map when the page has no /Resources /Properties dict', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    expect(resolvePagePropertyMcidStates(doc, 1).size).toBe(0);
  });

  it('resolves each property to "mcid" or "not-mcid" based on whether its dict carries /MCID', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const mcidPropRef = doc.context.register(doc.context.obj({ MCID: 0 }));
    const ocPropRef = doc.context.register(doc.context.obj({ Type: PDFName.of('OCG') }));
    const propertiesRef = doc.context.register(
      doc.context.obj({ P0: mcidPropRef, MC0: ocPropRef })
    );
    const resourcesRef = doc.context.register(doc.context.obj({ Properties: propertiesRef }));
    doc.getPage(0).node.set(PDFName.of('Resources'), resourcesRef);

    const states = resolvePagePropertyMcidStates(doc, 1);

    expect(states.get('P0')).toBe('mcid');
    expect(states.get('MC0')).toBe('not-mcid');
    expect(states.get('NeverRegistered')).toBeUndefined();
  });
});
