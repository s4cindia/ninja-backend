/**
 * PDF Modifier Service
 *
 * Service for safely modifying PDF files using pdf-lib
 * Handles metadata modifications, structure changes, and backup/rollback
 */

import { PDFDocument, PDFName, PDFString, PDFBool, PDFDict } from 'pdf-lib';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../../lib/logger';

/**
 * Result of a PDF modification operation
 */
export interface ModificationResult {
  /** Whether the modification was successful */
  success: boolean;
  /** Human-readable description of the change */
  description: string;
  /** File path where change was made (if applicable) */
  filePath?: string;
  /** Page number where change was made (if applicable) */
  pageNumber?: number;
  /** JSON or text representation before modification */
  before?: string;
  /** JSON or text representation after modification */
  after?: string;
  /** Error message if modification failed */
  error?: string;
}

/**
 * XMP metadata structure for accessibility
 */
export interface XMPMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  marked?: boolean; // PDF/UA requirement
}

/**
 * Validation result for PDF documents
 */
export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

/**
 * Service for modifying PDF files
 */
export class PdfModifierService {
  private backupDir: string;

  constructor(backupDir: string = '/tmp/pdf-backups') {
    this.backupDir = backupDir;
  }

  /**
   * Load a PDF document from buffer
   */
  async loadPDF(buffer: Buffer): Promise<PDFDocument> {
    try {
      logger.info('Loading PDF document', {
        bufferSize: buffer.length,
        bufferSizeMB: (buffer.length / 1024 / 1024).toFixed(2),
      });

      const pdfDoc = await PDFDocument.load(buffer, {
        updateMetadata: false, // Don't automatically update metadata
        ignoreEncryption: true, // Handle encrypted PDFs if possible
        throwOnInvalidObject: false, // Be lenient with invalid objects
      });

      logger.info('PDF document loaded successfully', {
        pages: pdfDoc.getPageCount(),
      });

      return pdfDoc;
    } catch (error) {
      logger.error('Failed to load PDF document', {
        message: error instanceof Error ? error.message : 'Unknown error',
        stack: error instanceof Error ? error.stack : undefined,
        errorType: error?.constructor?.name,
        errorDetails: JSON.stringify(error, Object.getOwnPropertyNames(error)),
        bufferSize: buffer.length,
        bufferSizeMB: (buffer.length / 1024 / 1024).toFixed(2),
      });
      throw new Error(`Failed to load PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Save a PDF document to buffer
   */
  async savePDF(doc: PDFDocument): Promise<Buffer> {
    try {
      const pdfBytes = await doc.save({
        useObjectStreams: true, // Enable compression
        addDefaultPage: false,  // Don't add extra pages
        updateFieldAppearances: true, // Update form fields if present
      });

      logger.info('PDF document saved successfully', {
        size: pdfBytes.length,
      });

      return Buffer.from(pdfBytes);
    } catch (error) {
      logger.error('Failed to save PDF document', { error });
      throw new Error(`Failed to save PDF: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Validate a PDF buffer
   */
  async validatePDF(buffer: Buffer): Promise<ValidationResult> {
    const result: ValidationResult = {
      valid: true,
      errors: [],
      warnings: [],
    };

    try {
      // Basic validation - can we load it?
      await this.loadPDF(buffer);

      // Check file size
      if (buffer.length === 0) {
        result.valid = false;
        result.errors.push('PDF file is empty');
      }

      // Check PDF header
      const header = buffer.slice(0, 8).toString('utf-8');
      if (!header.startsWith('%PDF-')) {
        result.valid = false;
        result.errors.push('Invalid PDF header');
      }

      // Size warnings
      const sizeMB = buffer.length / (1024 * 1024);
      if (sizeMB > 100) {
        result.warnings.push(`Large PDF file: ${sizeMB.toFixed(2)} MB`);
      }

      logger.info('PDF validation complete', { valid: result.valid, errors: result.errors.length, warnings: result.warnings.length });
    } catch (error) {
      result.valid = false;
      result.errors.push(`Validation error: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return result;
  }

  /**
   * Add or update document language
   * Tier 1 Handler - PDF-NO-LANGUAGE
   */
  async addLanguage(doc: PDFDocument, lang: string = 'en'): Promise<ModificationResult> {
    try {
      const catalog = doc.catalog;

      // Get current language if exists
      const currentLang = catalog.get(PDFName.of('Lang'));
      const before = currentLang ? currentLang.toString() : 'Not set';

      // Set language in catalog using public API
      const langName = PDFName.of('Lang');
      const langValue = PDFString.of(lang);

      catalog.set(langName, langValue);

      // Verify it was set
      const verify = catalog.get(langName);
      logger.info('Language set verification', {
        lang,
        before,
        after: verify ? verify.toString() : 'NOT SET',
      });

      return {
        success: true,
        description: `Set document language to '${lang}'`,
        before,
        after: lang,
      };
    } catch (error) {
      logger.error('Failed to add language', {
        error: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : undefined,
        lang
      });
      return {
        success: false,
        description: 'Failed to add language',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Add or update document title
   * Tier 1 Handler - PDF-NO-TITLE
   */
  async addTitle(doc: PDFDocument, title: string): Promise<ModificationResult> {
    try {
      // Get current title if exists
      const currentTitle = doc.getTitle();
      const before = currentTitle || 'Not set';

      // Set title
      doc.setTitle(title);

      const after = title;

      logger.info('Added title to PDF metadata', { title, before, after });

      return {
        success: true,
        description: `Set document title to '${title}'`,
        before,
        after,
      };
    } catch (error) {
      logger.error('Failed to add title', { error, title });
      return {
        success: false,
        description: 'Failed to add title',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Add or update XMP metadata stream
   * Tier 1 Handler - PDF-NO-METADATA
   */
  async addMetadata(doc: PDFDocument, metadata?: XMPMetadata): Promise<ModificationResult> {
    try {
      const before: Record<string, string> = {
        title: doc.getTitle() || 'Not set',
        author: doc.getAuthor() || 'Not set',
        subject: doc.getSubject() || 'Not set',
        keywords: doc.getKeywords() || 'Not set',
        creator: doc.getCreator() || 'Not set',
        producer: doc.getProducer() || 'Not set',
      };

      // Set metadata fields
      if (metadata?.title) doc.setTitle(metadata.title);
      if (metadata?.author) doc.setAuthor(metadata.author);
      if (metadata?.subject) doc.setSubject(metadata.subject);
      if (metadata?.keywords) {
        // Convert keywords string to array (split by comma, semicolon, or wrap single string)
        const keywordsArray = metadata.keywords.includes(',') || metadata.keywords.includes(';')
          ? metadata.keywords.split(/[,;]/).map(k => k.trim()).filter(k => k.length > 0)
          : [metadata.keywords];
        doc.setKeywords(keywordsArray);
      }
      if (metadata?.creator) doc.setCreator(metadata.creator);
      if (metadata?.producer) doc.setProducer(metadata.producer);

      // Set marked flag for PDF/UA compliance
      // IMPORTANT: Only set MarkInfo.Marked if a real tag tree exists
      if (metadata?.marked !== undefined) {
        const catalog = doc.catalog;

        // Preserve existing MarkInfo dictionary and merge new values
        let markInfo = catalog.get(PDFName.of('MarkInfo'));
        if (!markInfo || !(markInfo instanceof PDFDict)) {
          // Create new MarkInfo only if none exists
          markInfo = doc.context.obj({});
          catalog.set(PDFName.of('MarkInfo'), markInfo);
        }

        // Update only the Marked field, preserving other fields like Suspects, UserProperties
        (markInfo as PDFDict).set(PDFName.of('Marked'), metadata.marked ? PDFBool.True : PDFBool.False);
      }

      const after: Record<string, string> = {
        title: doc.getTitle() || 'Not set',
        author: doc.getAuthor() || 'Not set',
        subject: doc.getSubject() || 'Not set',
        keywords: doc.getKeywords() || 'Not set',
        creator: doc.getCreator() || 'Not set',
        producer: doc.getProducer() || 'Not set',
      };

      logger.info('Added metadata to PDF', { before, after });

      return {
        success: true,
        description: 'Updated PDF metadata',
        before: JSON.stringify(before, null, 2),
        after: JSON.stringify(after, null, 2),
      };
    } catch (error) {
      logger.error('Failed to add metadata', { error, metadata });
      return {
        success: false,
        description: 'Failed to add metadata',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Add or update creator information
   * Tier 1 Handler - PDF-NO-CREATOR
   */
  async addCreator(doc: PDFDocument, creator: string = 'Ninja Accessibility Platform'): Promise<ModificationResult> {
    try {
      const before = doc.getCreator() || 'Not set';

      // Set creator
      doc.setCreator(creator);

      // Also set producer if not set
      if (!doc.getProducer()) {
        doc.setProducer('Ninja PDF Remediation Engine');
      }

      const after = doc.getCreator() || creator;

      logger.info('Added creator to PDF metadata', { creator, before, after });

      return {
        success: true,
        description: `Set document creator to '${creator}'`,
        before,
        after,
      };
    } catch (error) {
      logger.error('Failed to add creator', { error, creator });
      return {
        success: false,
        description: 'Failed to add creator',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Set Marked flag to indicate PDF is tagged for accessibility
   * Tier 1 Handler - MATTERHORN-01-001
   */
  async setMarkedFlag(doc: PDFDocument, marked: boolean = true): Promise<ModificationResult> {
    try {
      const catalog = doc.catalog;

      // Get or create MarkInfo dictionary
      let markInfo = catalog.get(PDFName.of('MarkInfo'));
      if (!markInfo || !(markInfo instanceof PDFDict)) {
        markInfo = doc.context.obj({});
        catalog.set(PDFName.of('MarkInfo'), markInfo);
      }

      const before = (markInfo as PDFDict).get(PDFName.of('Marked'))?.toString() || 'Not set';

      // Set Marked flag in MarkInfo dictionary
      (markInfo as PDFDict).set(PDFName.of('Marked'), marked ? PDFBool.True : PDFBool.False);

      const after = marked ? 'true' : 'false';

      logger.info('Set Marked flag in MarkInfo dictionary', { marked, before, after });

      return {
        success: true,
        description: `Set Marked flag to ${marked} (indicates PDF is tagged for accessibility)`,
        before,
        after,
      };
    } catch (error) {
      logger.error('Failed to set Marked flag', { error, marked });
      return {
        success: false,
        description: 'Failed to set Marked flag',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Set DisplayDocTitle flag to show document title in window title bar
   * Tier 1 Handler - MATTERHORN-01-002
   */
  async setDisplayDocTitle(doc: PDFDocument, display: boolean = true): Promise<ModificationResult> {
    try {
      const catalog = doc.catalog;

      // Get or create ViewerPreferences dictionary
      let viewerPrefs = catalog.get(PDFName.of('ViewerPreferences'));
      if (!viewerPrefs || !(viewerPrefs instanceof PDFDict)) {
        viewerPrefs = doc.context.obj({});
        catalog.set(PDFName.of('ViewerPreferences'), viewerPrefs);
      }

      const before = (viewerPrefs as PDFDict).get(PDFName.of('DisplayDocTitle'))?.toString() || 'Not set';

      // Set DisplayDocTitle in ViewerPreferences
      (viewerPrefs as PDFDict).set(PDFName.of('DisplayDocTitle'), display ? PDFBool.True : PDFBool.False);

      const after = display ? 'true' : 'false';

      logger.info('Set DisplayDocTitle in ViewerPreferences', { display, before, after });

      return {
        success: true,
        description: `Set DisplayDocTitle to ${display} (document title shown in window)`,
        before,
        after,
      };
    } catch (error) {
      logger.error('Failed to set DisplayDocTitle', { error, display });
      return {
        success: false,
        description: 'Failed to set DisplayDocTitle',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Set Suspects flag to false (no suspected accessibility problems)
   * Tier 1 Handler - MATTERHORN-01-005
   */
  async setSuspectsFlag(doc: PDFDocument, suspects: boolean = false): Promise<ModificationResult> {
    try {
      const catalog = doc.catalog;

      // Get or create MarkInfo dictionary
      let markInfo = catalog.get(PDFName.of('MarkInfo'));
      if (!markInfo || !(markInfo instanceof PDFDict)) {
        markInfo = doc.context.obj({});
        catalog.set(PDFName.of('MarkInfo'), markInfo);
      }

      const before = (markInfo as PDFDict).get(PDFName.of('Suspects'))?.toString() || 'Not set';

      // Set Suspects flag in MarkInfo
      (markInfo as PDFDict).set(PDFName.of('Suspects'), suspects ? PDFBool.True : PDFBool.False);

      const after = suspects ? 'true' : 'false';

      logger.info('Set Suspects flag in MarkInfo', { suspects, before, after });

      return {
        success: true,
        description: `Set Suspects flag to ${suspects} (no suspected accessibility problems)`,
        before,
        after,
      };
    } catch (error) {
      logger.error('Failed to set Suspects flag', { error, suspects });
      return {
        success: false,
        description: 'Failed to set Suspects flag',
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Create a backup of the PDF buffer
   */
  async createBackup(buffer: Buffer, fileName: string): Promise<string> {
    try {
      // Ensure backup directory exists
      await fs.mkdir(this.backupDir, { recursive: true });

      // Create backup file path with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFileName = `${path.parse(fileName).name}_backup_${timestamp}.pdf`;
      const backupPath = path.join(this.backupDir, backupFileName);

      // Write backup file
      await fs.writeFile(backupPath, buffer);

      logger.info('Created PDF backup', { backupPath, size: buffer.length });

      return backupPath;
    } catch (error) {
      logger.error('Failed to create backup', { error, fileName });
      throw new Error(`Failed to create backup: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Rollback to a backup file
   */
  async rollback(backupPath: string): Promise<Buffer> {
    try {
      const buffer = await fs.readFile(backupPath);

      logger.info('Rolled back to backup', { backupPath, size: buffer.length });

      return buffer;
    } catch (error) {
      logger.error('Failed to rollback', { error, backupPath });
      throw new Error(`Failed to rollback: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }

  /**
   * Delete a backup file
   */
  async deleteBackup(backupPath: string): Promise<void> {
    try {
      await fs.unlink(backupPath);
      logger.info('Deleted backup file', { backupPath });
    } catch (error) {
      logger.warn('Failed to delete backup', { error, backupPath });
      // Don't throw - backup cleanup is non-critical
    }
  }

  /**
   * Clean up old backups (older than specified days)
   */
  async cleanupOldBackups(daysToKeep: number = 7): Promise<number> {
    try {
      const files = await fs.readdir(this.backupDir);
      const now = Date.now();
      const maxAge = daysToKeep * 24 * 60 * 60 * 1000;
      let deletedCount = 0;

      for (const file of files) {
        const filePath = path.join(this.backupDir, file);
        const stats = await fs.stat(filePath);

        if (now - stats.mtimeMs > maxAge) {
          await fs.unlink(filePath);
          deletedCount++;
        }
      }

      logger.info('Cleaned up old backups', { deletedCount, daysToKeep });

      return deletedCount;
    } catch (error) {
      logger.warn('Failed to cleanup old backups', { error });
      return 0;
    }
  }
}

// Export singleton instance
export const pdfModifierService = new PdfModifierService();
