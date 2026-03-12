/**
 * PDF Modifier Service
 *
 * Service for safely modifying PDF files using pdf-lib
 * Handles metadata modifications, structure changes, and backup/rollback
 */

import { PDFDocument, PDFName, PDFString, PDFBool, PDFDict, PDFArray, PDFRef, PDFRawStream } from 'pdf-lib';
import * as fs from 'fs/promises';
import * as path from 'path';
import { XMLParser, XMLBuilder } from 'fast-xml-parser';
import { logger } from '../../lib/logger';

// Minimal valid XMP skeleton with pdfuaid and dc namespaces pre-declared
const MINIMAL_XMP_TEMPLATE = `<?xpacket begin="\uFEFF" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
  <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description rdf:about=""
      xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"
      xmlns:dc="http://purl.org/dc/elements/1.1/"
      xmlns:xmp="http://ns.adobe.com/xap/1.0/">
    </rdf:Description>
  </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>`;

/**
 * Returns true if the string looks like a filename, UUID, or other non-meaningful title.
 * Used to decide whether to replace the existing title with a derived one.
 */
function isFilenameLike(title: string): boolean {
  // UUID pattern (with or without hyphens)
  if (/^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i.test(title)) return true;
  // Looks like a filename: contains extension, underscores/hyphens only, or is all digits
  if (/\.(pdf|docx?|txt|epub)$/i.test(title)) return true;
  // Short alphanumeric code (e.g. "9798765788493")
  if (/^\d{10,}$/.test(title)) return true;
  return false;
}

/**
 * Apply key-value patches to an XMP XML string by direct string insertion
 * into the rdf:Description element. Used only on MINIMAL_XMP_TEMPLATE (known-clean).
 */
function applyXmpPatchesToTemplate(xmpXml: string, patches: Record<string, string>): string {
  let result = xmpXml;
  for (const [key, value] of Object.entries(patches)) {
    const ns = key.split(':')[0];
    const localName = key.split(':')[1];
    const escapedValue = value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    // Replace existing attribute if present, otherwise insert before closing >
    const attrRegex = new RegExp(`${ns}:${localName}="[^"]*"`);
    if (attrRegex.test(result)) {
      result = result.replace(attrRegex, `${ns}:${localName}="${escapedValue}"`);
    } else {
      result = result.replace('    </rdf:Description>', `      <${key}>${escapedValue}</${key}>\n    </rdf:Description>`);
    }
  }
  return result;
}

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
  /**
   * Set alt text on a Figure element in the PDF structure tree.
   * Matches by imageId format "img_p{page}_{index}_{name}" from imageExtractorService.
   *
   * @returns ModificationResult — success: false if PDF has no structure tree
   */
  async setAltText(
    doc: PDFDocument,
    imageId: string,
    altText: string
  ): Promise<ModificationResult> {
    try {
      const structTreeRoot = this.getStructTreeRoot(doc);
      if (!structTreeRoot) {
        return {
          success: false,
          description: 'No structure tree',
          error: 'PDF has no tagged structure tree — alt text cannot be applied programmatically',
        };
      }

      // Parse page and index from imageId (format: img_p{page}_{index}_{...})
      const match = imageId.match(/img_p(\d+)_(\d+)/);
      const targetPage = match ? parseInt(match[1], 10) : 1;
      const targetIndex = match ? parseInt(match[2], 10) : 0;

      const figures = this.findStructureElementsByType(
        structTreeRoot,
        new Set(['Figure', 'figure']),
        doc.context
      );

      if (figures.length === 0) {
        return {
          success: false,
          description: 'No Figure elements in structure tree',
          error: 'The PDF structure tree has no Figure elements',
        };
      }

      // Try to find by page ref + index within page
      const pageRef = doc.getPage(targetPage - 1).ref;
      const figuresOnPage = figures.filter(fig => {
        const pg = fig.get(PDFName.of('Pg'));
        return pg && pg.toString() === pageRef.toString();
      });

      let target: PDFDict | undefined =
        figuresOnPage[targetIndex] ??
        figuresOnPage[0] ??
        figures[targetIndex] ??
        figures[0];

      if (!target) {
        return {
          success: false,
          description: 'Figure element not found',
          error: `No Figure element at page ${targetPage}, index ${targetIndex}`,
        };
      }

      const altEntry = target.get(PDFName.of('Alt'));
      const before = altEntry instanceof PDFString ? altEntry.decodeText() : 'None';
      target.set(PDFName.of('Alt'), PDFString.of(altText));

      logger.info(`[PdfModifier] Set alt text on Figure (page ${targetPage}, index ${targetIndex})`);

      return {
        success: true,
        description: `Set alt text on Figure element (page ${targetPage}, index ${targetIndex})`,
        pageNumber: targetPage,
        before,
        after: altText,
      };
    } catch (error) {
      return {
        success: false,
        description: 'Failed to set alt text',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Set a summary attribute on a Table element in the PDF structure tree.
   * Matches by tableId format "table_p{page}_{index}" from structureAnalyzerService.
   *
   * @returns ModificationResult — success: false if PDF has no structure tree
   */
  async setTableSummary(
    doc: PDFDocument,
    tableId: string,
    summary: string
  ): Promise<ModificationResult> {
    try {
      const structTreeRoot = this.getStructTreeRoot(doc);
      if (!structTreeRoot) {
        return {
          success: false,
          description: 'No structure tree',
          error: 'PDF has no tagged structure tree — table summary cannot be applied programmatically',
        };
      }

      // Parse page and index from tableId (format: table_p{page}_{index})
      const match = tableId.match(/table_p(\d+)_(\d+)/);
      const targetPage = match ? parseInt(match[1], 10) : 1;
      const targetIndex = match ? parseInt(match[2], 10) : 0;

      const tables = this.findStructureElementsByType(
        structTreeRoot,
        new Set(['Table', 'table']),
        doc.context
      );

      if (tables.length === 0) {
        return {
          success: false,
          description: 'No Table elements in structure tree',
          error: 'The PDF structure tree has no Table elements',
        };
      }

      const pageRef = doc.getPage(targetPage - 1).ref;
      const tablesOnPage = tables.filter(t => {
        const pg = t.get(PDFName.of('Pg'));
        return pg && pg.toString() === pageRef.toString();
      });

      const target: PDFDict | undefined =
        tablesOnPage[targetIndex] ??
        tablesOnPage[0] ??
        tables[targetIndex] ??
        tables[0];

      if (!target) {
        return {
          success: false,
          description: 'Table element not found',
          error: `No Table element at page ${targetPage}, index ${targetIndex}`,
        };
      }

      const summaryEntry = target.get(PDFName.of('Summary'));
      const before = summaryEntry instanceof PDFString ? summaryEntry.decodeText() : 'None';
      target.set(PDFName.of('Summary'), PDFString.of(summary));

      logger.info(`[PdfModifier] Set summary on Table (page ${targetPage}, index ${targetIndex})`);

      return {
        success: true,
        description: `Set summary on Table element (page ${targetPage}, index ${targetIndex})`,
        pageNumber: targetPage,
        before,
        after: summary,
      };
    } catch (error) {
      return {
        success: false,
        description: 'Failed to set table summary',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get the StructTreeRoot PDFDict, resolving indirect references.
   * Adobe AutoTag PDFs store StructTreeRoot as an indirect PDFRef in the catalog.
   */
  private getStructTreeRoot(doc: PDFDocument): PDFDict | null {
    const raw = doc.catalog.get(PDFName.of('StructTreeRoot'));
    if (!raw) return null;
    const resolved = raw instanceof PDFDict ? raw : doc.context.lookup(raw);
    return resolved instanceof PDFDict ? resolved : null;
  }

  /**
   * Collect all structure elements of specific types from the structure tree.
   */
  private findStructureElementsByType(
    root: PDFDict,
    types: Set<string>,
    context: import('pdf-lib').PDFContext
  ): PDFDict[] {
    const results: PDFDict[] = [];
    this.traverseStructTree(root, types, context, results);
    return results;
  }

  private traverseStructTree(
    element: unknown,
    types: Set<string>,
    context: import('pdf-lib').PDFContext,
    results: PDFDict[]
  ): void {
    if (element instanceof PDFRef) {
      const resolved = context.lookup(element);
      if (resolved) this.traverseStructTree(resolved, types, context, results);
      return;
    }

    if (element instanceof PDFArray) {
      for (let i = 0; i < element.size(); i++) {
        this.traverseStructTree(element.get(i), types, context, results);
      }
      return;
    }

    if (element instanceof PDFDict) {
      const sType = element.get(PDFName.of('S'));
      if (sType instanceof PDFName) {
        const typeName = sType.asString().replace(/^\//, '');
        if (types.has(typeName)) {
          results.push(element);
        }
      }
      // Recurse into children
      const k = element.get(PDFName.of('K'));
      if (k) this.traverseStructTree(k, types, context, results);
    }
  }

  // ─── XMP / PDF-UA ─────────────────────────────────────────────────────────

  /**
   * Write or patch the PDF /Metadata XMP stream.
   * Path A (no existing metadata): uses MINIMAL_XMP_TEMPLATE with string patching.
   * Path B (existing metadata): parses with fast-xml-parser, applies patches, serialises back.
   * Falls back to Path A if parsing fails (logs warning).
   */
  async writeXmpStream(doc: PDFDocument, patches: Record<string, string>): Promise<void> {
    const existingRef = doc.catalog.get(PDFName.of('Metadata'));
    let xmpXml: string;

    if (existingRef) {
      try {
        const rawStream = doc.context.lookup(existingRef);
        if (!(rawStream instanceof PDFRawStream)) throw new Error('Metadata is not a raw stream');
        const raw = Buffer.from(rawStream.contents).toString('utf8');

        const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
        const parsed = parser.parse(raw) as Record<string, unknown>;

        // Locate the rdf:Description node and apply patches as child elements
        const xmpmeta = parsed['x:xmpmeta'] as Record<string, unknown> | undefined;
        const rdfRdf = xmpmeta?.['rdf:RDF'] as Record<string, unknown> | undefined;
        if (rdfRdf) {
          let desc = rdfRdf['rdf:Description'] as Record<string, unknown> | undefined;
          if (!desc) { desc = {}; rdfRdf['rdf:Description'] = desc; }
          for (const [key, value] of Object.entries(patches)) {
            desc[key] = value;
          }
        }

        const builder = new XMLBuilder({ ignoreAttributes: false, attributeNamePrefix: '@_', format: true });
        xmpXml = builder.build(parsed) as string;
      } catch (e) {
        logger.warn(`[XMP] Failed to parse existing metadata stream, overwriting with template: ${e instanceof Error ? e.message : String(e)}`);
        xmpXml = applyXmpPatchesToTemplate(MINIMAL_XMP_TEMPLATE, patches);
      }
    } else {
      xmpXml = applyXmpPatchesToTemplate(MINIMAL_XMP_TEMPLATE, patches);
    }

    const bytes = Buffer.from(xmpXml, 'utf8');
    const stream = doc.context.stream(bytes, {
      Type: PDFName.of('Metadata'),
      Subtype: PDFName.of('XML'),
      Length: bytes.length,
    });
    doc.catalog.set(PDFName.of('Metadata'), doc.context.register(stream));
  }

  /**
   * Write PDF/UA-1 identifier into the XMP metadata stream.
   * PDF/UA-1 only defines pdfuaid:part — no conformance qualifier (that's PDF/A, not PDF/UA).
   * PAC 2024 validates on pdfuaid:part=1 alone.
   * Matterhorn 28-002.
   */
  async writePdfUaIdentifier(doc: PDFDocument): Promise<ModificationResult> {
    try {
      await this.writeXmpStream(doc, { 'pdfuaid:part': '1' });
      logger.info('[PdfModifier] Written PDF/UA-1 identifier (pdfuaid:part=1)');
      return { success: true, description: 'Written PDF/UA-1 identifier (pdfuaid:part=1)' };
    } catch (error) {
      return { success: false, description: 'Failed to write PDF/UA identifier', error: String(error) };
    }
  }

  /**
   * Derive a meaningful document title and apply it to:
   *   - PDF Info dictionary (doc.setTitle)
   *   - ViewerPreferences.DisplayDocTitle = true
   *   - XMP dc:title
   * Covers Matterhorn 01-001, 01-002, 01-003, 01-004.
   *
   * Title priority: existing meaningful title → first H1 text → filename stem.
   */
  async deriveAndSetTitle(doc: PDFDocument, fileNameStem: string): Promise<ModificationResult> {
    try {
      const existing = doc.getTitle();
      const before = existing || 'Not set';

      let derivedTitle: string;
      if (existing && !isFilenameLike(existing)) {
        // Existing title is already meaningful — still ensure DisplayDocTitle and dc:title are set
        derivedTitle = existing;
      } else {
        // Try to extract first H1 text from structure tree
        const h1Text = this.extractFirstH1Text(doc);
        derivedTitle = h1Text ?? fileNameStem;
      }

      // Apply to all three locations
      doc.setTitle(derivedTitle);
      await this.setDisplayDocTitle(doc, true);
      await this.writeXmpStream(doc, { 'dc:title': derivedTitle });

      logger.info(`[PdfModifier] Derived and set title: "${derivedTitle}"`);
      return {
        success: true,
        description: `Set document title to '${derivedTitle}'`,
        before,
        after: derivedTitle,
      };
    } catch (error) {
      return { success: false, description: 'Failed to derive and set title', error: String(error) };
    }
  }

  /**
   * Extract the text content of the first H1 structure element.
   * Reads ActualText or Alt attribute; MCID content stream parsing is deferred.
   * Returns null if no H1 found or text cannot be determined.
   */
  extractFirstH1Text(doc: PDFDocument): string | null {
    try {
      const structRoot = this.getStructTreeRoot(doc);
      if (!structRoot) return null;

      const h1Elements = this.findStructureElementsByType(structRoot, new Set(['H1', 'H']), doc.context);
      if (h1Elements.length === 0) return null;

      const first = h1Elements[0];

      // Try ActualText attribute
      const actualText = first.get(PDFName.of('ActualText'));
      if (actualText instanceof PDFString) {
        const text = actualText.decodeText().trim();
        if (text.length > 0) return text;
      }

      // Try Alt attribute
      const alt = first.get(PDFName.of('Alt'));
      if (alt instanceof PDFString) {
        const text = alt.decodeText().trim();
        if (text.length > 0) return text;
      }

      return null;
    } catch {
      return null;
    }
  }
}

// Export singleton instance
export const pdfModifierService = new PdfModifierService();
