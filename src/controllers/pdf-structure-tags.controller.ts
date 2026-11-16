/**
 * Structure Tag QC Review Controller
 *
 * GET/PATCH /pdf/:jobId/structure-tags* -- the page-by-page structure-tag
 * review feature (gated by the Full QC toggle, see resolveFullQC in
 * auto-remediation-loop.service.ts). Both endpoints resolve Full QC
 * themselves and reject with 403 when it's off, even though the frontend
 * also hides the entry point -- see the Full QC design decision,
 * 2026-11-16: the toggle must not be visibility-only at the API layer.
 */

import { Request, Response, NextFunction } from 'express';
import path from 'path';
import { AppError } from '../utils/app-error';
import { logger } from '../lib/logger';
import { fileStorageService } from '../services/storage/file-storage.service';
import { pdfModifierService } from '../services/pdf/pdf-modifier.service';
import { getEffectiveAiRemediationConfig } from '../services/pdf/ai-remediation-tenant-config.service';
import { resolveFullQC } from '../services/pdf/auto-remediation-loop.service';
import {
  extractStructureTagsForPage,
  isValidStructureTag,
  resolveElementRef,
  resolveElementPageNumber,
  buildPageByRef,
} from '../services/pdf/structure-tag-inventory.service';
import { pdfStructureWriterService } from '../services/pdf/pdf-structure-writer.service';
import type { PDFDocument } from 'pdf-lib';

/**
 * Loads the job's current PDF buffer -- the remediated file if one exists
 * from a prior fix/retag, otherwise the original upload -- same fallback
 * order as pdf-remediation.controller.ts's applyQuickFix/previewFix.
 */
async function loadCurrentPdfBuffer(jobId: string, job: { input: unknown }): Promise<{ buffer: Buffer; fileName: string; remediatedFileName: string }> {
  const jobInput = job.input as { fileName?: string; fileUrl?: string };
  const fileName = jobInput?.fileName || 'document.pdf';
  const parsed = path.parse(fileName);
  const remediatedFileName = `${parsed.name}_remediated${parsed.ext || '.pdf'}`;

  let buffer: Buffer | null = null;
  try {
    buffer = await fileStorageService.getRemediatedFile(jobId, fileName);
  } catch (err) {
    logger.debug(`[StructureTags] No remediated file yet for job ${jobId}: ${err}`);
  }

  if (!buffer) {
    try {
      buffer = await fileStorageService.getFile(jobId, fileName);
    } catch (err) {
      logger.debug(`[StructureTags] Could not load original file for job ${jobId}: ${err}`);
    }
    if (!buffer && jobInput?.fileUrl) {
      buffer = await fileStorageService.downloadFile(jobInput.fileUrl);
    }
  }

  if (!buffer) throw AppError.notFound('PDF file not found in storage.');
  return { buffer, fileName, remediatedFileName };
}

async function assertFullQcEnabled(job: { tenantId: string; fullQC: boolean | null }): Promise<void> {
  const aiRemediationConfig = await getEffectiveAiRemediationConfig(job.tenantId);
  const effective = resolveFullQC(job.fullQC, aiRemediationConfig.fullQCDefault);
  if (!effective) {
    throw AppError.forbidden('Full QC is not enabled for this job.');
  }
}

export class PdfStructureTagsController {
  /** GET /pdf/:jobId/structure-tags?page=N */
  async listPage(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      const job = req.job!;
      await assertFullQcEnabled(job);

      const page = parseInt(String(req.query.page ?? ''), 10);
      if (!Number.isInteger(page) || page < 1) {
        throw AppError.badRequest('A positive integer "page" query parameter is required.');
      }

      const { buffer } = await loadCurrentPdfBuffer(job.id, job);
      const doc = await pdfModifierService.loadPDF(buffer);

      if (page > doc.getPageCount()) {
        throw AppError.badRequest(`Page ${page} is out of range (document has ${doc.getPageCount()} pages).`);
      }

      const elements = extractStructureTagsForPage(doc, page);
      res.json({ success: true, data: elements });
    } catch (error) {
      next(error);
    }
  }

  /** PATCH /pdf/:jobId/structure-tags/:elementId -- body: { newTag: string } */
  async retag(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      if (!req.user) throw AppError.unauthorized('Not authenticated');
      const job = req.job!;
      await assertFullQcEnabled(job);

      const { elementId } = req.params;
      const newTag = req.body?.newTag;
      if (typeof newTag !== 'string' || !isValidStructureTag(newTag)) {
        throw AppError.badRequest(`"${newTag}" is not a recognized PDF/UA structure tag.`);
      }

      const { buffer, remediatedFileName } = await loadCurrentPdfBuffer(job.id, job);
      const doc: PDFDocument = await pdfModifierService.loadPDF(buffer);

      const elementRef = resolveElementRef(doc, elementId);
      if (!elementRef) {
        throw AppError.notFound(`Structure element "${elementId}" was not found in this document.`);
      }

      const pageByRef = buildPageByRef(doc);
      const pageNumber = resolveElementPageNumber(doc, elementRef, pageByRef);
      if (!pageNumber) {
        throw AppError.badRequest(`Could not resolve a page for structure element "${elementId}".`);
      }

      pdfStructureWriterService.renameElement(doc, elementRef, newTag);

      const modifiedBuffer = await pdfModifierService.savePDF(doc);
      await fileStorageService.saveRemediatedFile(job.id, remediatedFileName, modifiedBuffer);

      // Re-extract fresh from the just-mutated in-memory doc (no second file
      // round trip) so the response reflects the actual post-rename bbox --
      // renameElement only touches /S, so geometry is expected to be
      // unchanged, but this avoids ever fabricating the response.
      const updated = extractStructureTagsForPage(doc, pageNumber).find(el => el.elementId === elementId);
      if (!updated) {
        throw AppError.internal(`Retagged "${elementId}" to ${newTag} but could not re-read it back afterward.`);
      }

      res.json({ success: true, data: updated });
    } catch (error) {
      next(error);
    }
  }
}

export const pdfStructureTagsController = new PdfStructureTagsController();
