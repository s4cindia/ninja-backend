/**
 * pdf-structure-writer.service.ts — traverseStructTree ordering
 *
 * Live-confirmed bug: auto-remediation ran fixHeadingHierarchy round after
 * round, always reporting "success," while the re-audit kept re-flagging
 * the exact same HEADING-SKIP issues (399 issues, unchanged across 4
 * consecutive rounds). Root cause: traverseStructTree walked the structure
 * tree breadth-first, while the validator that raises HEADING-SKIP walks it
 * depth-first (true document/reading order) — see structure-analyzer
 * .service.ts's traverseStructureTree. For a document with multiple
 * same-depth sections (chapters), BFS visits every section's shallow
 * headings before descending into any one section's deeper sub-headings,
 * which desyncs the "previous heading level" tracking fixHeadingHierarchy
 * relies on from the sequence the validator actually checks against — so a
 * "successful" rename can still fail the re-audit.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFArray, PDFRef, PDFDict } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function headingIssue(id: string): AuditIssue {
  return { id, source: 'pdf-structure', severity: 'serious', code: 'HEADING-SKIP', message: 'test' };
}

/**
 * Document
 *   Sect1
 *     H1              (chapter title)
 *     SubSect1
 *       H4            (genuine skip relative to H1 in true reading order --
 *                       should become H2)
 *   Sect2
 *     H2              (a second chapter's own heading -- sits at shallower
 *                       *nesting depth* than Sect1's H4, so a breadth-first
 *                       walk visits it before H4 even though H4 comes first
 *                       in the actual document)
 *
 * True reading order: H1, H4, H2. Breadth-first order: H1, H2, H4.
 */
async function buildTwoChapterDoc(): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 600]);

  const leaf = (tag: string) => doc.context.register(doc.context.obj({ S: PDFName.of(tag), K: 0 }));

  const h1Ref = leaf('H1');
  const h4Ref = leaf('H4');
  const h2Ref = leaf('H2');

  // K arrays are embedded directly (not registered as a separate indirect
  // object) -- traverseStructTree resolves a ref-valued K to a PDFDict
  // (single child) but not to a PDFArray, matching how it's always worked;
  // this builder just needs to produce the shape the service actually reads.
  const subSect1Ref = doc.context.register(
    doc.context.obj({ S: PDFName.of('Sect'), K: doc.context.obj([h4Ref]) })
  );
  const sect1Ref = doc.context.register(
    doc.context.obj({ S: PDFName.of('Sect'), K: doc.context.obj([h1Ref, subSect1Ref]) })
  );
  const sect2Ref = doc.context.register(
    doc.context.obj({ S: PDFName.of('Sect'), K: doc.context.obj([h2Ref]) })
  );

  const documentRef = doc.context.register(
    doc.context.obj({ S: PDFName.of('Document'), K: doc.context.obj([sect1Ref, sect2Ref]) })
  );

  const structTreeRootRef = doc.context.register(
    doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: documentRef })
  );
  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

  return doc;
}

function tagOf(doc: PDFDocument, ref: PDFRef): string {
  const dict = doc.context.lookup(ref) as PDFDict;
  const s = dict.get(PDFName.of('S'));
  return s!.toString().replace(/^\//, '');
}

describe('pdf-structure-writer.service — traverseStructTree ordering', () => {
  it('fixHeadingHierarchy corrects a skip using true reading order, not breadth-first tree-depth order', async () => {
    const doc = await buildTwoChapterDoc();

    // Recover the refs the same way the service does, so we can inspect
    // the actual tag each element ends up with after the fix.
    const structRoot = doc.context.lookup(doc.catalog.get(PDFName.of('StructTreeRoot'))) as PDFDict;
    const documentDict = doc.context.lookup(structRoot.get(PDFName.of('K'))) as PDFDict;
    const [sect1Ref, sect2Ref] = (doc.context.lookup(documentDict.get(PDFName.of('K'))) as PDFArray)
      .asArray() as PDFRef[];
    const sect1Dict = doc.context.lookup(sect1Ref) as PDFDict;
    const [h1Ref, subSect1Ref] = (doc.context.lookup(sect1Dict.get(PDFName.of('K'))) as PDFArray).asArray() as PDFRef[];
    const subSect1Dict = doc.context.lookup(subSect1Ref) as PDFDict;
    const [h4Ref] = (doc.context.lookup(subSect1Dict.get(PDFName.of('K'))) as PDFArray).asArray() as PDFRef[];
    const sect2Dict = doc.context.lookup(sect2Ref) as PDFDict;
    const [h2Ref] = (doc.context.lookup(sect2Dict.get(PDFName.of('K'))) as PDFArray).asArray() as PDFRef[];

    const results = pdfStructureWriterService.fixHeadingHierarchy(doc, [headingIssue('issue-1')]);

    expect(results[0].success).toBe(true);
    expect(results[0].after).toContain('Fixed 1 heading level(s)');

    // The true-reading-order fix: H1 unchanged, H4 demoted to H2 (directly
    // follows H1, so only one level down is needed), H2 unchanged.
    // A breadth-first walk would instead see Sect2's H2 before Sect1's H4,
    // making H4's "previous level" 2 instead of 1 -- and demote it to H3.
    expect(tagOf(doc, h1Ref)).toBe('H1');
    expect(tagOf(doc, h4Ref)).toBe('H2');
    expect(tagOf(doc, h2Ref)).toBe('H2');
  });

  it('does not overflow the call stack on a deeply-nested structure tree', async () => {
    // A recursive pre-order DFS would blow Node's call stack on a real-world
    // tagged PDF with a long chain of nested Sect/Div elements (common in
    // deeply-nested TOCs/lists). traverseStructTree must use an explicit
    // stack instead of recursion to stay safe at depth.
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const DEPTH = 20000;
    let currentRef: PDFRef = doc.context.register(doc.context.obj({ S: PDFName.of('H1'), K: 0 }));
    for (let i = 0; i < DEPTH; i++) {
      currentRef = doc.context.register(
        doc.context.obj({ S: PDFName.of('Sect'), K: doc.context.obj([currentRef]) })
      );
    }

    const structTreeRootRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: currentRef })
    );
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    expect(() => pdfStructureWriterService.fixHeadingHierarchy(doc, [headingIssue('deep-1')])).not.toThrow();
  });
});
