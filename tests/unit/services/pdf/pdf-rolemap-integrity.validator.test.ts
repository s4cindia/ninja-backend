/**
 * Tests for PDF RoleMap Integrity Validator
 *
 * Matterhorn 01-006. Confirmed real via a live S4 Carlisle manual QC
 * report plus direct inspection of Karsaklian_189165_9781606497623.pdf:
 * its /RoleMap maps H1A/H2A (headings), IDX1-3 (index), FGC (caption),
 * and TFN (footnote) all to plain /P.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFArray, PDFRef } from 'pdf-lib';
import { pdfRoleMapIntegrityValidator } from '../../../../src/services/pdf/validators/pdf-rolemap-integrity.validator';
import type { ParsedPDF } from '../../../../src/services/pdf/pdf-parser.service';

/** Builds a minimal StructTreeRoot with a /RoleMap and the given flat list of /S values as direct children of /Document. */
async function buildDocWithRoleMap(
  roleMapEntries: Record<string, string>,
  elementTypes: string[]
): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 600]);

  const kidRefs: PDFRef[] = elementTypes.map((type) => {
    const dict = doc.context.obj({ S: PDFName.of(type), K: 0 });
    return doc.context.register(dict);
  });

  const documentDict = doc.context.obj({
    S: PDFName.of('Document'),
    K: doc.context.register(doc.context.obj(kidRefs)) as unknown as PDFArray,
  });
  const documentRef = doc.context.register(documentDict);

  const roleMapDict = doc.context.obj(
    Object.fromEntries(Object.entries(roleMapEntries).map(([k, v]) => [k, PDFName.of(v)]))
  );

  const structTreeRootDict = doc.context.obj({
    Type: PDFName.of('StructTreeRoot'),
    K: documentRef,
    RoleMap: roleMapDict,
  });
  const structTreeRootRef = doc.context.register(structTreeRootDict);

  doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);
  return doc;
}

function asParsedPdf(doc: PDFDocument): ParsedPDF {
  return { pdfLibDoc: doc } as unknown as ParsedPDF;
}

describe('PdfRoleMapIntegrityValidator', () => {
  it('flags a heading-named custom tag used repeatedly that resolves to /P', async () => {
    const doc = await buildDocWithRoleMap(
      { H1A: 'P' },
      ['H1A', 'H1A', 'H1A', 'P', 'P']
    );

    const result = await pdfRoleMapIntegrityValidator.validate(asParsedPdf(doc));

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('ROLEMAP-HEADING-FLATTENED');
    expect(result.issues[0].category).toBe('headings');
    expect(result.issues[0].element).toBe('H1A');
    expect(result.issues[0].matterhornCheckpoint).toBe('01-006');
  });

  it('flags index, caption, and footnote categories as detect-only (structure category, not headings)', async () => {
    const doc = await buildDocWithRoleMap(
      { IDX1: 'P', FGC: 'P', TFN: 'P' },
      ['IDX1', 'IDX1', 'IDX1', 'FGC', 'FGC', 'FGC', 'TFN', 'TFN', 'TFN']
    );

    const result = await pdfRoleMapIntegrityValidator.validate(asParsedPdf(doc));

    expect(result.issues).toHaveLength(3);
    const codes = result.issues.map((i) => i.code).sort();
    expect(codes).toEqual(['ROLEMAP-CAPTION-FLATTENED', 'ROLEMAP-FOOTNOTE-FLATTENED', 'ROLEMAP-INDEX-FLATTENED']);
    expect(result.issues.every((i) => i.category === 'structure')).toBe(true);
  });

  it('does not flag a custom tag used fewer than the minimum usage threshold', async () => {
    const doc = await buildDocWithRoleMap({ H1A: 'P' }, ['H1A', 'H1A', 'P']);

    const result = await pdfRoleMapIntegrityValidator.validate(asParsedPdf(doc));

    expect(result.issues).toHaveLength(0);
  });

  it('does not flag a custom tag whose name does not match any known category pattern', async () => {
    const doc = await buildDocWithRoleMap({ TPT: 'P' }, ['TPT', 'TPT', 'TPT']);

    const result = await pdfRoleMapIntegrityValidator.validate(asParsedPdf(doc));

    expect(result.issues).toHaveLength(0);
  });

  it('does not flag a heading-named custom tag that already resolves to a real heading type', async () => {
    const doc = await buildDocWithRoleMap({ H1A: 'H1' }, ['H1A', 'H1A', 'H1A']);

    const result = await pdfRoleMapIntegrityValidator.validate(asParsedPdf(doc));

    expect(result.issues).toHaveLength(0);
  });

  it('follows a multi-hop RoleMap chain before judging the resolved target', async () => {
    const doc = await buildDocWithRoleMap({ H1A: 'CustomMid', CustomMid: 'P' }, ['H1A', 'H1A', 'H1A']);

    const result = await pdfRoleMapIntegrityValidator.validate(asParsedPdf(doc));

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].code).toBe('ROLEMAP-HEADING-FLATTENED');
  });

  it('returns no issues and zero metadata when there is no /StructTreeRoot at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const result = await pdfRoleMapIntegrityValidator.validate(asParsedPdf(doc));

    expect(result.issues).toHaveLength(0);
    expect(result.metadata).toEqual({ customTagsDeclared: 0, customTagsFlagged: 0 });
  });

  it('returns no issues when /StructTreeRoot has no /RoleMap at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: 0 });
    const documentRef = doc.context.register(documentDict);
    const structTreeRootDict = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: documentRef });
    const structTreeRootRef = doc.context.register(structTreeRootDict);
    doc.catalog.set(PDFName.of('StructTreeRoot'), structTreeRootRef);

    const result = await pdfRoleMapIntegrityValidator.validate(asParsedPdf(doc));

    expect(result.issues).toHaveLength(0);
  });

  it('reports the real custom-tag usage count in the issue message', async () => {
    const doc = await buildDocWithRoleMap({ H2A: 'P' }, ['H2A', 'H2A', 'H2A', 'H2A', 'H2A']);

    const result = await pdfRoleMapIntegrityValidator.validate(asParsedPdf(doc));

    expect(result.issues[0].message).toContain('used 5 time(s)');
    expect(result.issues[0].message).toContain('level 2');
  });
});
