/**
 * Tests for PdfStructureWriterService.fixTabOrder -- Matterhorn 28-008/
 * 28-009. Purely mechanical: sets a page's /Tabs entry to /S. No struct-
 * tree/MCID interaction, no failure mode once the page itself resolves.
 */

import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { pdfStructureWriterService } from '../../../../src/services/pdf/pdf-structure-writer.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function tabOrderIssue(pageNumber?: number): AuditIssue {
  return {
    id: 'tab-order-1',
    source: 'pdf-tab-order',
    severity: 'moderate',
    code: 'TAB-ORDER-NOT-STRUCTURE',
    message: 'test',
    pageNumber,
    location: 'test',
  } as AuditIssue;
}

describe('PdfStructureWriterService.fixTabOrder', () => {
  it('sets /Tabs to /S on a page with no existing /Tabs entry', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);

    const result = pdfStructureWriterService.fixTabOrder(doc, tabOrderIssue(1));

    expect(result.success).toBe(true);
    expect(result.before).toBe('/Tabs missing');
    expect(result.after).toBe('/Tabs /S');
    expect(doc.getPage(0).node.get(PDFName.of('Tabs'))?.toString()).toBe('/S');
  });

  it('overwrites an existing /Tabs value that is not /S', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('Tabs'), PDFName.of('R'));

    const result = pdfStructureWriterService.fixTabOrder(doc, tabOrderIssue(1));

    expect(result.success).toBe(true);
    expect(result.before).toBe('/Tabs /R');
    expect(doc.getPage(0).node.get(PDFName.of('Tabs'))?.toString()).toBe('/S');
  });

  it('is idempotent on a page that already has /Tabs = /S', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('Tabs'), PDFName.of('S'));

    const result = pdfStructureWriterService.fixTabOrder(doc, tabOrderIssue(1));

    expect(result.success).toBe(true);
    expect(result.before).toBe('/Tabs /S');
    expect(doc.getPage(0).node.get(PDFName.of('Tabs'))?.toString()).toBe('/S');
  });

  it('fails cleanly when the issue has no pageNumber', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);

    const result = pdfStructureWriterService.fixTabOrder(doc, tabOrderIssue(undefined));

    expect(result.success).toBe(false);
    expect(result.error).toContain('pageNumber');
  });

  it('fails cleanly when pageNumber is out of range', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([612, 792]);

    const result = pdfStructureWriterService.fixTabOrder(doc, tabOrderIssue(99));

    expect(result.success).toBe(false);
    expect(result.error).toContain('Page 99 not found');
  });
});
