/**
 * PDF Modifier Service
 *
 * Handles PDF file modifications using pdf-lib
 */

import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import { logger } from '../../lib/logger';

export interface ModificationResult {
  success: boolean;
  field: string;
  oldValue: string | null;
  newValue: string;
  message: string;
}

class PdfModifierService {
  /**
   * Load PDF from buffer
   */
  async loadPDF(buffer: Buffer): Promise<PDFDocument> {
    try {
      const pdfDoc = await PDFDocument.load(buffer);
      logger.info('[PDF Modifier] PDF loaded successfully');
      return pdfDoc;
    } catch (error) {
      logger.error('[PDF Modifier] Failed to load PDF', { error });
      throw new Error('Failed to load PDF document');
    }
  }

  /**
   * Save PDF to buffer
   */
  async savePDF(doc: PDFDocument): Promise<Buffer> {
    try {
      const pdfBytes = await doc.save();
      logger.info('[PDF Modifier] PDF saved successfully');
      return Buffer.from(pdfBytes);
    } catch (error) {
      logger.error('[PDF Modifier] Failed to save PDF', { error });
      throw new Error('Failed to save PDF document');
    }
  }

  /**
   * Add or update document language
   * Fixes: WCAG 3.1.1 - Language of Page
   */
  async addLanguage(doc: PDFDocument, lang: string = 'en-US'): Promise<ModificationResult> {
    try {
      const catalog = doc.catalog;
      const oldLang = catalog.get(PDFName.of('Lang'));
      const oldValue = oldLang ? oldLang.toString() : null;

      catalog.set(PDFName.of('Lang'), PDFString.of(lang));

      logger.info('[PDF Modifier] Language updated', { oldValue, newValue: lang });

      return {
        success: true,
        field: 'language',
        oldValue,
        newValue: lang,
        message: `Document language set to ${lang}`,
      };
    } catch (error) {
      logger.error('[PDF Modifier] Failed to add language', { error });
      return {
        success: false,
        field: 'language',
        oldValue: null,
        newValue: lang,
        message: 'Failed to set document language',
      };
    }
  }

  /**
   * Add or update document title
   * Fixes: WCAG 2.4.2 - Page Titled
   */
  async addTitle(doc: PDFDocument, title: string): Promise<ModificationResult> {
    try {
      const oldTitle = doc.getTitle();

      doc.setTitle(title);

      logger.info('[PDF Modifier] Title updated', { oldValue: oldTitle, newValue: title });

      return {
        success: true,
        field: 'title',
        oldValue: oldTitle || null,
        newValue: title,
        message: `Document title set to "${title}"`,
      };
    } catch (error) {
      logger.error('[PDF Modifier] Failed to add title', { error });
      return {
        success: false,
        field: 'title',
        oldValue: null,
        newValue: title,
        message: 'Failed to set document title',
      };
    }
  }

  /**
   * Add accessibility metadata (MarkInfo dictionary)
   * Indicates that the PDF is tagged for accessibility
   */
  async addMetadata(doc: PDFDocument): Promise<ModificationResult> {
    try {
      const catalog = doc.catalog;

      // Add MarkInfo dictionary for tagged PDF
      const markInfoDict = doc.context.obj({
        Marked: true,
      });

      catalog.set(PDFName.of('MarkInfo'), markInfoDict);

      logger.info('[PDF Modifier] Accessibility metadata added');

      return {
        success: true,
        field: 'metadata',
        oldValue: null,
        newValue: 'Marked: true',
        message: 'Accessibility metadata added (MarkInfo)',
      };
    } catch (error) {
      logger.error('[PDF Modifier] Failed to add metadata', { error });
      return {
        success: false,
        field: 'metadata',
        oldValue: null,
        newValue: 'Marked: true',
        message: 'Failed to add accessibility metadata',
      };
    }
  }

  /**
   * Add or update creator/producer metadata
   */
  async addCreator(doc: PDFDocument, creator: string = 'Ninja Accessibility Tool'): Promise<ModificationResult> {
    try {
      const oldCreator = doc.getCreator();
      const oldProducer = doc.getProducer();

      doc.setCreator(creator);
      doc.setProducer('Ninja Accessibility Tool');

      logger.info('[PDF Modifier] Creator updated', { oldCreator, oldProducer });

      return {
        success: true,
        field: 'creator',
        oldValue: oldCreator || null,
        newValue: creator,
        message: `Creator set to "${creator}"`,
      };
    } catch (error) {
      logger.error('[PDF Modifier] Failed to add creator', { error });
      return {
        success: false,
        field: 'creator',
        oldValue: null,
        newValue: creator,
        message: 'Failed to set creator',
      };
    }
  }
}

// Export singleton instance
export const pdfModifierService = new PdfModifierService();
