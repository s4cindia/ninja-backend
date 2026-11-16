/**
 * PdfStructureTagsController -- GET/PATCH /pdf/:jobId/structure-tags*, the
 * page-by-page structure-tag review feature. Uses a REAL small PDFDocument
 * (same fixture technique as structure-tag-inventory.service.test.ts) as
 * what the mocked pdfModifierService.loadPDF resolves to, so the inventory
 * extraction and the real renameElement run for real -- only I/O
 * (file storage, tenant config) is mocked.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Request, Response } from 'express';
import { PDFDocument, PDFName } from 'pdf-lib';
import { writePageContent } from '../../../src/services/pdf/pdf-content-stream-io';

vi.mock('../../../src/services/storage/file-storage.service', () => ({
  fileStorageService: {
    getRemediatedFile: vi.fn(),
    getFile: vi.fn(),
    downloadFile: vi.fn(),
    saveRemediatedFile: vi.fn(),
  },
}));
vi.mock('../../../src/services/pdf/pdf-modifier.service', () => ({
  pdfModifierService: { loadPDF: vi.fn(), savePDF: vi.fn() },
}));
vi.mock('../../../src/services/pdf/ai-remediation-tenant-config.service', () => ({
  getEffectiveAiRemediationConfig: vi.fn(),
}));

import { pdfStructureTagsController } from '../../../src/controllers/pdf-structure-tags.controller';
import { fileStorageService } from '../../../src/services/storage/file-storage.service';
import { pdfModifierService } from '../../../src/services/pdf/pdf-modifier.service';
import { getEffectiveAiRemediationConfig } from '../../../src/services/pdf/ai-remediation-tenant-config.service';

async function buildOneHeadingDoc(): Promise<{ doc: PDFDocument; elementId: string }> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const hRef = doc.context.register(doc.context.obj({ S: PDFName.of('H1'), Pg: page.ref, K: 5 }));
  const docRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: [hRef] }));
  const root = doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: [docRef] });
  doc.catalog.set(PDFName.of('StructTreeRoot'), doc.context.register(root));
  writePageContent(doc, 1, '<</MCID 5>>BDC q 1 0 0 1 100 500 cm 0 0 m 70 0 l S Q EMC');
  return { doc, elementId: `${hRef.objectNumber}-${hRef.generationNumber}` };
}

function makeRes(): Response {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res as Response;
}

function makeReq(overrides: Partial<Request> = {}): Request {
  return {
    params: { jobId: 'job-1' },
    query: {},
    body: {},
    user: { id: 'user-1', tenantId: 'tenant-1' },
    job: { id: 'job-1', tenantId: 'tenant-1', fullQC: true, input: { fileName: 'doc.pdf' } },
    ...overrides,
  } as unknown as Request;
}

const next = vi.fn();

describe('PdfStructureTagsController', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getEffectiveAiRemediationConfig).mockResolvedValue({ fullQCDefault: false } as any);
    vi.mocked(fileStorageService.getRemediatedFile).mockResolvedValue(null as any);
    vi.mocked(fileStorageService.getFile).mockResolvedValue(Buffer.from('irrelevant, loadPDF is mocked') as any);
    vi.mocked(pdfModifierService.savePDF).mockResolvedValue(Buffer.from('saved') as any);
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue('https://example.com/doc_remediated.pdf');
  });

  describe('listPage', () => {
    it('rejects with 403 when Full QC does not resolve true for this job', async () => {
      const { doc } = await buildOneHeadingDoc();
      vi.mocked(pdfModifierService.loadPDF).mockResolvedValue(doc);
      const req = makeReq({ job: { id: 'job-1', tenantId: 'tenant-1', fullQC: false, input: {} } as any, query: { page: '1' } as any });

      await pdfStructureTagsController.listPage(req, makeRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    });

    it('returns every structure element on the requested page when Full QC is enabled', async () => {
      const { doc, elementId } = await buildOneHeadingDoc();
      vi.mocked(pdfModifierService.loadPDF).mockResolvedValue(doc);
      const res = makeRes();

      await pdfStructureTagsController.listPage(makeReq({ query: { page: '1' } as any }), res, next);

      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: [expect.objectContaining({ elementId, tag: 'H1', pageNumber: 1 })],
      });
      expect(next).not.toHaveBeenCalled();
    });

    it('rejects with 400 when the page query parameter is missing or not a positive integer', async () => {
      const { doc } = await buildOneHeadingDoc();
      vi.mocked(pdfModifierService.loadPDF).mockResolvedValue(doc);

      await pdfStructureTagsController.listPage(makeReq({ query: {} as any }), makeRes(), next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));

      next.mockClear();
      await pdfStructureTagsController.listPage(makeReq({ query: { page: '0' } as any }), makeRes(), next);
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('rejects with 400 when the requested page is out of range', async () => {
      const { doc } = await buildOneHeadingDoc();
      vi.mocked(pdfModifierService.loadPDF).mockResolvedValue(doc);

      await pdfStructureTagsController.listPage(makeReq({ query: { page: '99' } as any }), makeRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });
  });

  describe('retag', () => {
    it('rejects with 403 when Full QC does not resolve true for this job', async () => {
      const { doc, elementId } = await buildOneHeadingDoc();
      vi.mocked(pdfModifierService.loadPDF).mockResolvedValue(doc);
      const req = makeReq({
        job: { id: 'job-1', tenantId: 'tenant-1', fullQC: false, input: {} } as any,
        params: { jobId: 'job-1', elementId },
        body: { newTag: 'H2' },
      });

      await pdfStructureTagsController.retag(req, makeRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 403 }));
    });

    it('rejects with 400 when newTag is not a recognized PDF/UA structure tag', async () => {
      const { doc, elementId } = await buildOneHeadingDoc();
      vi.mocked(pdfModifierService.loadPDF).mockResolvedValue(doc);
      const req = makeReq({ params: { jobId: 'job-1', elementId }, body: { newTag: 'NotARealTag' } });

      await pdfStructureTagsController.retag(req, makeRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }));
    });

    it('rejects with 404 when the elementId does not resolve to a real structure element', async () => {
      const { doc } = await buildOneHeadingDoc();
      vi.mocked(pdfModifierService.loadPDF).mockResolvedValue(doc);
      const req = makeReq({ params: { jobId: 'job-1', elementId: '999999-0' }, body: { newTag: 'H2' } });

      await pdfStructureTagsController.retag(req, makeRes(), next);

      expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }));
    });

    it('retags the element, saves the remediated file, and returns the element with its new tag', async () => {
      const { doc, elementId } = await buildOneHeadingDoc();
      vi.mocked(pdfModifierService.loadPDF).mockResolvedValue(doc);
      const res = makeRes();
      const req = makeReq({ params: { jobId: 'job-1', elementId }, body: { newTag: 'H2' } });

      await pdfStructureTagsController.retag(req, res, next);

      expect(fileStorageService.saveRemediatedFile).toHaveBeenCalledWith('job-1', expect.stringContaining('_remediated'), expect.anything());
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({ elementId, tag: 'H2', pageNumber: 1 }),
      });
      expect(next).not.toHaveBeenCalled();
    });
  });
});
