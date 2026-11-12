/**
 * Tests for PdfStructureWriterService.fixFootnoteStructure --
 * ROLEMAP-FOOTNOTE-FLATTENED. Matterhorn 01-006 / PDF/UA-2 (ISO
 * 14289-2:2024) SS8.2.5.14: retargets the custom tag's own /RoleMap entry
 * to /FENote (never /Note -- rule 8.2.5.14-1 prohibits bare /Note), sets a
 * NoteType=/Footnote attribute (owner /FENote, confirmed via veraPDF's own
 * rule 8.2.5.14-4) on every raw-tagged instance, and best-effort splits a
 * clean leading numeric label into a new /Lbl+/LBody pair -- see that
 * method's own doc comment (pdf-structure-writer.service.ts) for the full
 * algorithm and its documented /Ref-pairing (-2/-3) residual gap.
 */

import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, PDFName, PDFArray, PDFRef, PDFDict } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import { writePageContent } from '../../../../src/services/pdf/pdf-content-stream-io';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function footnoteIssue(element = 'TFN'): AuditIssue {
  return {
    id: 'rolemap-footnote-1',
    source: 'pdf-rolemap-integrity',
    severity: 'serious',
    code: 'ROLEMAP-FOOTNOTE-FLATTENED',
    message: 'test',
    element,
    location: `Document-wide (style: /${element})`,
    matterhornCheckpoint: '01-006',
    matterhornHow: 'H',
  } as AuditIssue;
}

function tagOf(doc: PDFDocument, ref: PDFRef): string {
  const dict = doc.context.lookup(ref, PDFDict);
  const s = dict.get(PDFName.of('S'));
  return s!.toString().replace(/^\//, '');
}

function kidsOf(doc: PDFDocument, ref: PDFRef): unknown[] {
  const dict = doc.context.lookup(ref, PDFDict);
  const k = dict.get(PDFName.of('K'));
  if (k instanceof PDFArray) return k.asArray();
  return k !== undefined ? [k] : [];
}

function parentOf(doc: PDFDocument, ref: PDFRef): PDFRef | undefined {
  const dict = doc.context.lookup(ref, PDFDict);
  const p = dict.get(PDFName.of('P'));
  return p instanceof PDFRef ? p : undefined;
}

function attributeDicts(doc: PDFDocument, ref: PDFRef): PDFDict[] {
  const dict = doc.context.lookup(ref, PDFDict);
  const aRaw = dict.get(PDFName.of('A'));
  const a = aRaw instanceof PDFRef ? doc.context.lookup(aRaw) : aRaw;
  if (a instanceof PDFArray) {
    return a.asArray()
      .map((item) => (item instanceof PDFRef ? doc.context.lookup(item) : item))
      .filter((item): item is PDFDict => item instanceof PDFDict);
  }
  return a instanceof PDFDict ? [a] : [];
}

function noteTypeAttr(doc: PDFDocument, ref: PDFRef): { owner: string | undefined; noteType: string | undefined } | null {
  const dicts = attributeDicts(doc, ref);
  const match = dicts.find((d) => d.get(PDFName.of('O'))?.toString() === '/FENote');
  if (!match) return null;
  return {
    owner: match.get(PDFName.of('O'))?.toString(),
    noteType: match.get(PDFName.of('NoteType'))?.toString(),
  };
}

/**
 * Builds a document with:
 *   - one page whose content stream has 5 BDC/EMC spans (MCIDs 5-9)
 *   - a /Sect holding 3 raw /TFN elements:
 *       tfn1: /K = [5, 6] -- MCID 5 decodes to "3." (clean numeric label),
 *             MCID 6 to the rest of the sentence. Expect a full /Lbl+/LBody split.
 *       tfn2: /K = [7, 8] -- MCID 7 decodes to "*" (symbol marker, no digit).
 *             Expect RoleMap-retarget + NoteType only, /Lbl declined.
 *       tfn3: /K = 9 (single bare scalar, not an array) -- MCID 9 decodes to
 *             "5. Single run footnote text." all in ONE marked-content run.
 *             Expect RoleMap-retarget + NoteType only, /Lbl declined (no
 *             structural split point at all).
 *   - /RoleMap: { TFN: /P }
 */
async function buildFootnoteDoc(): Promise<{
  doc: PDFDocument;
  sectRef: PDFRef;
  tfn1: PDFRef;
  tfn2: PDFRef;
  tfn3: PDFRef;
}> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 600]);

  const content =
    '/P <</MCID 5>>BDC\n(3.)Tj\nEMC\n' +
    '/P <</MCID 6>>BDC\n( Some footnote text follows here.)Tj\nEMC\n' +
    '/P <</MCID 7>>BDC\n(*)Tj\nEMC\n' +
    '/P <</MCID 8>>BDC\n( Some other footnote.)Tj\nEMC\n' +
    '/P <</MCID 9>>BDC\n(5. Single run footnote text.)Tj\nEMC\n';
  writePageContent(doc, 1, content);

  const tfn1 = doc.context.register(doc.context.obj({ S: PDFName.of('TFN'), Pg: page.ref, K: doc.context.obj([5, 6]) }));
  const tfn2 = doc.context.register(doc.context.obj({ S: PDFName.of('TFN'), Pg: page.ref, K: doc.context.obj([7, 8]) }));
  const tfn3 = doc.context.register(doc.context.obj({ S: PDFName.of('TFN'), Pg: page.ref, K: 9 }));

  const sectRef = doc.context.register(
    doc.context.obj({ S: PDFName.of('Sect'), K: doc.context.obj([tfn1, tfn2, tfn3]) })
  );
  for (const kid of [tfn1, tfn2, tfn3]) doc.context.lookup(kid, PDFDict).set(PDFName.of('P'), sectRef);

  const roleMapDict = doc.context.obj({ TFN: PDFName.of('P') });
  const structTreeRootRef = doc.context.register(
    doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: doc.context.obj([sectRef]), RoleMap: roleMapDict })
  );
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

  return { doc, sectRef, tfn1, tfn2, tfn3 };
}

describe('PdfStructureWriterService.fixFootnoteStructure', () => {
  it('retargets /RoleMap TFN -> /FENote, sets NoteType on every instance, and splits only the clean-numeric-label instance', async () => {
    const { doc, tfn1, tfn2, tfn3 } = await buildFootnoteDoc();

    const result = pdfStructureWriterService.fixFootnoteStructure(doc, footnoteIssue());

    expect(result.success).toBe(true);
    expect(result.before).toContain('/TFN -> /P');
    expect(result.after).toContain('/TFN -> /FENote');
    expect(result.after).toContain('1/3');

    // /RoleMap entry itself changed from /P to /FENote.
    const structRoot = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot')) as PDFRef, PDFDict);
    const roleMap = doc.context.lookup(structRoot.get(PDFName.of('RoleMap')) as PDFRef, PDFDict);
    expect(roleMap.get(PDFName.of('TFN'))?.toString()).toBe('/FENote');

    // tfn1: clean "3." numeric label -> split into /Lbl + /LBody.
    const tfn1Kids = kidsOf(doc, tfn1) as PDFRef[];
    expect(tfn1Kids).toHaveLength(2);
    expect(tagOf(doc, tfn1Kids[0])).toBe('Lbl');
    expect(tagOf(doc, tfn1Kids[1])).toBe('LBody');
    expect(parentOf(doc, tfn1Kids[0])?.objectNumber).toBe(tfn1.objectNumber);
    expect(parentOf(doc, tfn1Kids[1])?.objectNumber).toBe(tfn1.objectNumber);
    // The original MCID bindings are preserved, just redistributed --
    // /Lbl got MCID 5 (the label), /LBody got MCID 6 (the rest).
    const lblK = doc.context.lookup(tfn1Kids[0], PDFDict).get(PDFName.of('K'));
    expect((lblK as { asNumber: () => number }).asNumber()).toBe(5);
    const lbodyK = doc.context.lookup(tfn1Kids[1], PDFDict).get(PDFName.of('K'));
    expect((lbodyK as { asNumber: () => number }).asNumber()).toBe(6);

    // tfn2: symbol marker ("*") -- no /Lbl split, /K left exactly as-is.
    const tfn2Kids = kidsOf(doc, tfn2);
    expect(tfn2Kids).toHaveLength(2);
    expect((tfn2Kids[0] as { asNumber: () => number }).asNumber()).toBe(7);
    expect((tfn2Kids[1] as { asNumber: () => number }).asNumber()).toBe(8);

    // tfn3: single bare-scalar /K (one marked-content run) -- no split
    // point exists at all, /K left exactly as-is.
    const tfn3Dict = doc.context.lookup(tfn3, PDFDict);
    const tfn3K = tfn3Dict.get(PDFName.of('K'));
    expect((tfn3K as { asNumber: () => number }).asNumber()).toBe(9);

    // NoteType attribute present with the correct owner/value on ALL
    // THREE retargeted elements, regardless of /Lbl outcome.
    for (const ref of [tfn1, tfn2, tfn3]) {
      const attr = noteTypeAttr(doc, ref);
      expect(attr).not.toBeNull();
      expect(attr!.owner).toBe('/FENote');
      expect(attr!.noteType).toBe('/Footnote');
    }
  });

  it('refuses a non-footnote-shaped custom tag', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const roleMapDict = doc.context.obj({ H1A: PDFName.of('P') });
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: 0, RoleMap: roleMapDict })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const result = pdfStructureWriterService.fixFootnoteStructure(doc, footnoteIssue('H1A'));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Not a footnote-shaped custom tag');
  });

  it('fails cleanly when the issue has no element', async () => {
    const { doc } = await buildFootnoteDoc();
    const result = pdfStructureWriterService.fixFootnoteStructure(doc, footnoteIssue(''));
    expect(result.success).toBe(false);
    expect(result.error).toContain('element');
  });

  it('fails cleanly when there is no structure tree root', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const result = pdfStructureWriterService.fixFootnoteStructure(doc, footnoteIssue());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No structure tree root found');
  });

  it('fails cleanly when the struct tree root has no /RoleMap dict', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const structTreeRootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: 0 }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const result = pdfStructureWriterService.fixFootnoteStructure(doc, footnoteIssue());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No /RoleMap dict found');
  });

  it('fails cleanly when /RoleMap declares the tag but no instance actually uses it', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const documentRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: 0 }));
    const roleMapDict = doc.context.obj({ TFN: PDFName.of('P') });
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: documentRef, RoleMap: roleMapDict })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const result = pdfStructureWriterService.fixFootnoteStructure(doc, footnoteIssue());
    expect(result.success).toBe(false);
    expect(result.error).toContain('No raw "/TFN"-tagged elements found');

    // Nothing was mutated -- not even the /RoleMap entry.
    const structRoot = doc.context.lookup(structTreeRootRef, PDFDict);
    const roleMap = doc.context.lookup(structRoot.get(PDFName.of('RoleMap')) as PDFRef, PDFDict);
    expect(roleMap.get(PDFName.of('TFN'))?.toString()).toBe('/P');
  });

  it('rolls back cleanly on an injected failure during the /Lbl split -- restores /K, reverts any reparented child, deletes every newly created element, but keeps the already-applied RoleMap retarget and NoteType attribute', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    const content =
      '/P <</MCID 5>>BDC\n(3.)Tj\nEMC\n' +
      '/P <</MCID 6>>BDC\n( Some footnote text follows here.)Tj\nEMC\n';
    writePageContent(doc, 1, content);

    const tfn1 = doc.context.register(doc.context.obj({ S: PDFName.of('TFN'), Pg: page.ref, K: doc.context.obj([5, 6]) }));
    const sectRef = doc.context.register(doc.context.obj({ S: PDFName.of('Sect'), K: doc.context.obj([tfn1]) }));
    doc.context.lookup(tfn1, PDFDict).set(PDFName.of('P'), sectRef);
    const roleMapDict = doc.context.obj({ TFN: PDFName.of('P') });
    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: doc.context.obj([sectRef]), RoleMap: roleMapDict })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const originalTfn1Kids = kidsOf(doc, tfn1).map((k) => (k as { asNumber: () => number }).asNumber());

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const reachableSpy = vi.spyOn(pdfStructureWriterService as any, 'isReachableFromRoot').mockReturnValue(false);
    const registerSpy = vi.spyOn(doc.context, 'register');

    const result = pdfStructureWriterService.fixFootnoteStructure(doc, footnoteIssue());

    reachableSpy.mockRestore();

    // Overall fix still reports success -- the RoleMap retarget and
    // NoteType attribute are independent of the /Lbl split's own outcome.
    expect(result.success).toBe(true);
    expect(result.after).toContain('0/1 also split');

    // The element's own /K is restored to its original two MCID entries.
    const restoredKids = kidsOf(doc, tfn1).map((k) => (k as { asNumber: () => number }).asNumber());
    expect(restoredKids).toEqual(originalTfn1Kids);

    // RoleMap retarget still happened.
    const structRoot = doc.context.lookup(structTreeRootRef, PDFDict);
    const roleMap = doc.context.lookup(structRoot.get(PDFName.of('RoleMap')) as PDFRef, PDFDict);
    expect(roleMap.get(PDFName.of('TFN'))?.toString()).toBe('/FENote');

    // NoteType attribute still set (written before the /Lbl attempt, and
    // not rolled back by it).
    const attr = noteTypeAttr(doc, tfn1);
    expect(attr).not.toBeNull();
    expect(attr!.owner).toBe('/FENote');
    expect(attr!.noteType).toBe('/Footnote');

    // Every element newly created during the failed /Lbl attempt (the
    // /Lbl and /LBody candidates) is deleted -- orphaned (no /K, no /P).
    // The NoteType attribute dict itself is also created via register(),
    // so filter down to dicts actually typed /Lbl or /LBody.
    const createdRefs = registerSpy.mock.results.map((r) => r.value as PDFRef);
    const lblOrLbody = createdRefs.filter((ref) => {
      const dict = doc.context.lookup(ref, PDFDict);
      const s = dict.get(PDFName.of('S'))?.toString();
      return s === '/Lbl' || s === '/LBody';
    });
    expect(lblOrLbody.length).toBeGreaterThan(0);
    for (const ref of lblOrLbody) {
      const dict = doc.context.lookup(ref, PDFDict);
      expect(dict.get(PDFName.of('K'))).toBeUndefined();
      expect(dict.get(PDFName.of('P'))).toBeUndefined();
    }
  });
});
