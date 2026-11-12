/**
 * Tests for PdfStructureWriterService.fixDegenerateRoleMapEntry -- Matterhorn
 * 01-006. Purely mechanical: retargets one /RoleMap entry. No struct-tree/
 * MCID interaction -- every instance of the custom style is fixed at once
 * because every RoleMap-resolving consumer (NVDA included) re-resolves the
 * same dict.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

async function buildDocWithRoleMap(roleMapEntries: Record<string, string>): Promise<PDFDocument> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 600]);

  const documentDict = doc.context.obj({ S: PDFName.of('Document'), K: 0 });
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

function roleMapIssue(element: string): AuditIssue {
  return {
    id: 'rolemap-1',
    source: 'pdf-rolemap-integrity',
    severity: 'serious',
    code: 'ROLEMAP-HEADING-FLATTENED',
    message: 'test',
    element,
    location: 'test',
  } as AuditIssue;
}

describe('PdfStructureWriterService.fixDegenerateRoleMapEntry', () => {
  it('retargets a heading-named custom tag to the correct /Hn level', async () => {
    const doc = await buildDocWithRoleMap({ H2A: 'P' });

    const result = pdfStructureWriterService.fixDegenerateRoleMapEntry(doc, roleMapIssue('H2A'));

    expect(result.success).toBe(true);
    expect(result.before).toBe('/H2A -> /P');
    expect(result.after).toBe('/H2A -> /H2');
  });

  it('retargets a caption-named custom tag to /Caption', async () => {
    const doc = await buildDocWithRoleMap({ FGC: 'P' });

    const result = pdfStructureWriterService.fixDegenerateRoleMapEntry(doc, roleMapIssue('FGC'));

    expect(result.success).toBe(true);
    expect(result.after).toBe('/FGC -> /Caption');
  });

  it('refuses to fix an index-named custom tag (no single safe target)', async () => {
    const doc = await buildDocWithRoleMap({ IDX1: 'P' });

    const result = pdfStructureWriterService.fixDegenerateRoleMapEntry(doc, roleMapIssue('IDX1'));

    expect(result.success).toBe(false);
    expect(result.error).toContain('No safe, unambiguous RoleMap retarget');
  });

  it('refuses to fix a footnote-named custom tag (no single safe target)', async () => {
    const doc = await buildDocWithRoleMap({ TFN: 'P' });

    const result = pdfStructureWriterService.fixDegenerateRoleMapEntry(doc, roleMapIssue('TFN'));

    expect(result.success).toBe(false);
  });

  it('fails cleanly when the issue has no element', async () => {
    const doc = await buildDocWithRoleMap({ H1A: 'P' });

    const result = pdfStructureWriterService.fixDegenerateRoleMapEntry(doc, roleMapIssue(''));

    expect(result.success).toBe(false);
    expect(result.error).toContain('element');
  });

  it('fails cleanly when there is no structure tree root', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const result = pdfStructureWriterService.fixDegenerateRoleMapEntry(doc, roleMapIssue('H1A'));

    expect(result.success).toBe(false);
    expect(result.error).toContain('No structure tree root found');
  });
});
