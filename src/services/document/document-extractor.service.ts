/**
 * Document Extractor Service
 *
 * Extracts text content from PDF and Word documents
 */

import { promises as fsPromises } from 'fs';
import * as path from 'path';
import { logger } from '../../lib/logger';

interface ExtractedDocument {
  text: string;
  metadata?: {
    title?: string;
    author?: string;
    pageCount?: number;
    createdAt?: Date;
  };
}

class DocumentExtractorService {
  /**
   * Extract text from a PDF file
   */
  async extractFromPdf(filePath: string): Promise<ExtractedDocument> {
    try {
      // Dynamic import pdf-parse - handle both CJS and ESM exports
      const pdfParseModule = await import('pdf-parse');
      const pdfParse = pdfParseModule.default || pdfParseModule;
      const dataBuffer = await fsPromises.readFile(filePath);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const data = await (pdfParse as any)(dataBuffer);

      return {
        text: data.text,
        metadata: {
          title: data.info?.Title,
          author: data.info?.Author,
          pageCount: data.numpages,
        },
      };
    } catch (error) {
      logger.error('[DocumentExtractor] PDF extraction error:', error);
      throw new Error(`Failed to extract PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Extract text from a Word document
   */
  async extractFromDocx(filePath: string): Promise<ExtractedDocument> {
    try {
      // Dynamic import mammoth
      const mammoth = await import('mammoth');
      const result = await mammoth.extractRawText({ path: filePath });

      return {
        text: result.value,
        metadata: {
          title: path.basename(filePath, '.docx'),
        },
      };
    } catch (error) {
      logger.error('[DocumentExtractor] DOCX extraction error:', error);
      throw new Error(`Failed to extract DOCX: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Extract from any supported document type
   */
  async extract(filePath: string): Promise<ExtractedDocument> {
    const ext = path.extname(filePath).toLowerCase();

    switch (ext) {
      case '.pdf':
        return this.extractFromPdf(filePath);
      case '.docx':
      case '.doc':
        return this.extractFromDocx(filePath);
      default:
        throw new Error(`Unsupported file type: ${ext}`);
    }
  }
}

export const documentExtractor = new DocumentExtractorService();
