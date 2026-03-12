/**
 * Adobe PDF Services AutoTag Service
 *
 * Sends an untagged PDF to Adobe's AutoTag API and returns:
 *   - A fully tagged PDF with structure tree (figures, tables, headings, paragraphs, lists)
 *   - An XML tagging report (element counts + confidence)
 *   - Optionally a Word (.docx) export via the Export PDF API
 *
 * Requires env vars: ADOBE_PDF_SERVICES_CLIENT_ID, ADOBE_PDF_SERVICES_CLIENT_SECRET
 */

import { Readable } from 'stream';
import * as XLSX from 'xlsx';
import {
  ServicePrincipalCredentials,
  PDFServices,
  MimeType,
  AutotagPDFJob,
  AutotagPDFParams,
  AutotagPDFResult,
  ExportPDFJob,
  ExportPDFParams,
  ExportPDFResult,
  ExportPDFTargetFormat,
  Asset,
} from '@adobe/pdfservices-node-sdk';
import { PDFDocument, PDFDict, PDFArray, PDFName, PDFRef } from 'pdf-lib';
import { aiConfig } from '../../config/ai.config';
import { logger } from '../../lib/logger';

export interface AutoTagElementCounts {
  figures: number;
  tables: number;
  headings: number;
  paragraphs: number;
  lists: number;
}

/** A single flag entry from Adobe's AutoTag XLSX report */
export interface AdobeAutoTagFlag {
  elementType: string;
  page: number;
  confidence: string;
  reviewComment: string;
}

export interface AutoTagResult {
  taggedPdfBuffer: Buffer;
  /** Adobe tagging report (XLSX format) */
  reportBuffer: Buffer | null;
  wordBuffer: Buffer | null;
  /** Element counts walked from the tagged PDF's StructTreeRoot */
  elementCounts: AutoTagElementCounts | null;
  /** Parsed flags from Adobe's XLSX report — elements flagged for human review */
  parsedFlags: AdobeAutoTagFlag[];
}

async function streamToBuffer(readable: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of readable) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks);
}

function requireAsset(asset: Asset | undefined, label: string): Asset {
  if (!asset) throw new Error(`Adobe AutoTag: ${label} asset is missing from result`);
  return asset;
}

/**
 * Count structure elements by walking the tagged PDF's StructTreeRoot via pdf-lib.
 * The Adobe AutoTag report is XLSX (not XML), so we count directly from the PDF structure tree
 * which is always present in Adobe-tagged output.
 */
async function countStructureElements(taggedPdfBuffer: Buffer): Promise<AutoTagElementCounts> {
  const counts: AutoTagElementCounts = { figures: 0, tables: 0, headings: 0, paragraphs: 0, lists: 0 };
  try {
    const pdfDoc = await PDFDocument.load(taggedPdfBuffer, { ignoreEncryption: true });
    const catalog = pdfDoc.context.lookup(pdfDoc.context.trailerInfo.Root);
    if (!(catalog instanceof PDFDict)) return counts;

    const structRootRaw = catalog.get(PDFName.of('StructTreeRoot'));
    if (!structRootRaw) return counts;
    const structRoot = pdfDoc.context.lookup(structRootRaw);
    if (!(structRoot instanceof PDFDict)) return counts;

    // BFS walk — avoids call-stack overflow on large documents
    const queue: PDFDict[] = [structRoot];
    while (queue.length > 0) {
      const node = queue.shift()!;
      const sTag = node.get(PDFName.of('S'));
      if (sTag) {
        const tag = sTag.toString().replace(/^\//, '');
        if (tag === 'Figure') counts.figures++;
        else if (tag === 'Table') counts.tables++;
        else if (/^H\d?$/.test(tag)) counts.headings++;
        else if (tag === 'P') counts.paragraphs++;
        else if (tag === 'L') counts.lists++;
      }
      const kids = node.get(PDFName.of('K'));
      const enqueue = (raw: unknown) => {
        const obj = raw instanceof PDFRef ? pdfDoc.context.lookup(raw) : raw;
        if (obj instanceof PDFDict) queue.push(obj);
      };
      if (kids instanceof PDFArray) kids.asArray().forEach(enqueue);
      else enqueue(kids);
    }
  } catch {
    // Non-fatal — return zero counts
  }
  return counts;
}

export class AdobeAutoTagService {
  /**
   * AutoTag a PDF. Returns tagged PDF buffer, report XML buffer, and optionally a Word export.
   * All outputs are returned as buffers — the caller is responsible for saving them.
   *
   * @param pdfBuffer - The original (untagged) PDF as a Buffer
   * @param options.generateReport - Whether to request the XML tagging report (default: true)
   * @param options.exportWord - Whether to export the tagged PDF to Word .docx (default: true)
   */
  async tagPdf(
    pdfBuffer: Buffer,
    options: { generateReport?: boolean; exportWord?: boolean } = {}
  ): Promise<AutoTagResult> {
    const { clientId, clientSecret } = aiConfig.adobe;

    const credentials = new ServicePrincipalCredentials({ clientId, clientSecret });
    const pdfServices = new PDFServices({ credentials });

    // Upload original PDF to Adobe
    const inputAsset = await pdfServices.upload({
      readStream: Readable.from(pdfBuffer),
      mimeType: MimeType.PDF,
    });

    // Build AutoTag params
    const params = new AutotagPDFParams({
      generateReport: options.generateReport ?? true,
      shiftHeadings: true,
    });

    // Submit AutoTag job and poll until complete
    const job = new AutotagPDFJob({ inputAsset, params });
    const pollingURL = await pdfServices.submit({ job });

    logger.info('[AdobeAutoTag] Polling for AutoTag job completion…');
    const response = await pdfServices.getJobResult({
      pollingURL,
      resultType: AutotagPDFResult,
    });

    // Download tagged PDF
    const taggedStream = await pdfServices.getContent({ asset: requireAsset(response.result?.taggedPDF, 'taggedPDF') });
    const taggedPdfBuffer = await streamToBuffer(taggedStream.readStream);
    logger.info(`[AdobeAutoTag] Tagged PDF downloaded (${(taggedPdfBuffer.length / 1024).toFixed(0)} KB)`);

    // Download tagging report (XLSX) if available
    let reportBuffer: Buffer | null = null;
    if ((options.generateReport ?? true) && response.result?.report) {
      const reportStream = await pdfServices.getContent({ asset: requireAsset(response.result.report, 'report') });
      reportBuffer = await streamToBuffer(reportStream.readStream);
      logger.info(`[AdobeAutoTag] Report downloaded (${(reportBuffer.length / 1024).toFixed(0)} KB)`);
    }

    // Count structure elements from the tagged PDF's StructTreeRoot
    const elementCounts = await countStructureElements(taggedPdfBuffer);
    logger.info(`[AdobeAutoTag] Structure counts — Figures:${elementCounts.figures} Tables:${elementCounts.tables} Headings:${elementCounts.headings} Paragraphs:${elementCounts.paragraphs} Lists:${elementCounts.lists}`);

    // Export to Word if requested (separate API call using the tagged PDF as input)
    let wordBuffer: Buffer | null = null;
    if (options.exportWord ?? true) {
      try {
        wordBuffer = await this.exportToWord(pdfServices, taggedPdfBuffer);
        logger.info(`[AdobeAutoTag] Word export downloaded (${(wordBuffer.length / 1024).toFixed(0)} KB)`);
      } catch (wordErr) {
        // Non-fatal — Word export failure does not fail the whole auto-tag
        logger.warn(`[AdobeAutoTag] Word export failed (non-fatal): ${wordErr instanceof Error ? wordErr.message : String(wordErr)}`);
      }
    }

    const parsedFlags = reportBuffer ? this.parseTaggingReport(reportBuffer) : [];

    return { taggedPdfBuffer, reportBuffer, wordBuffer, elementCounts, parsedFlags };
  }

  /**
   * Parse Adobe AutoTag XLSX report and return flags for elements needing review.
   * Includes column name validation with a warning log if Adobe changes their schema.
   */
  parseTaggingReport(reportBuffer: Buffer): AdobeAutoTagFlag[] {
    try {
      const workbook = XLSX.read(reportBuffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      if (!sheetName) {
        logger.warn('[AdobeAutoTag] XLSX report has no sheets');
        return [];
      }

      const sheet = workbook.Sheets[sheetName];

      // Adobe prepends a disclaimer row before the actual header row.
      // Read as raw rows first, find the header row, then re-parse from that offset.
      const rawRows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];
      const expectedCols = ['Element Type', 'Page', 'Confidence', 'Review Comment'];
      const headerRowIdx = rawRows.findIndex(
        (r) => Array.isArray(r) && expectedCols.every((col) => r.includes(col))
      );

      if (headerRowIdx === -1) {
        // Log actual columns from first row to help diagnose future schema changes
        const firstRowCols = rawRows[0] ?? [];
        logger.warn(`[AdobeAutoTag] XLSX report column mismatch. Expected: ${JSON.stringify(expectedCols)}. Got: ${JSON.stringify(firstRowCols)}. Returning empty flags.`);
        return [];
      }

      // Re-parse starting from the header row
      const rows = XLSX.utils.sheet_to_json(sheet, { range: headerRowIdx }) as Record<string, unknown>[];
      if (rows.length === 0) return [];

      return rows
        .filter(row => row['Review Comment'] && String(row['Review Comment']).trim().length > 0)
        .map(row => ({
          elementType: String(row['Element Type'] ?? ''),
          page: Number(row['Page'] ?? 0),
          confidence: String(row['Confidence'] ?? ''),
          reviewComment: String(row['Review Comment'] ?? ''),
        }));
    } catch (e) {
      logger.warn(`[AdobeAutoTag] Failed to parse XLSX report: ${e instanceof Error ? e.message : String(e)}`);
      return [];
    }
  }

  /**
   * Export a PDF buffer to Word (.docx) using Adobe Export PDF API.
   */
  private async exportToWord(pdfServices: PDFServices, pdfBuffer: Buffer): Promise<Buffer> {
    const inputAsset = await pdfServices.upload({
      readStream: Readable.from(pdfBuffer),
      mimeType: MimeType.PDF,
    });

    const params = new ExportPDFParams({ targetFormat: ExportPDFTargetFormat.DOCX });
    const job = new ExportPDFJob({ inputAsset, params });
    const pollingURL = await pdfServices.submit({ job });

    const result = await pdfServices.getJobResult({ pollingURL, resultType: ExportPDFResult });
    const wordStream = await pdfServices.getContent({ asset: requireAsset(result.result?.asset, 'wordAsset') });
    return streamToBuffer(wordStream.readStream);
  }
}

export const adobeAutoTagService = new AdobeAutoTagService();
