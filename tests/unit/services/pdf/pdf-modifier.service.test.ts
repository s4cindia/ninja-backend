/**
 * Tests for PDF Modifier Service
 *
 * Tests PDF modification operations including metadata changes,
 * backup/rollback, and validation.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { pdfModifierService, type ModificationResult } from '../../../../src/services/pdf/pdf-modifier.service';
import { PDFDocument, PDFName } from 'pdf-lib';
import * as fs from 'fs/promises';

// Mock dependencies
vi.mock('fs/promises');
vi.mock('nanoid', () => ({
  nanoid: vi.fn(() => 'test-id-12345'),
}));

describe('PdfModifierService', () => {
  let mockPdfDoc: PDFDocument;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockCatalog: any;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create mock context
    const mockContext = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      obj: vi.fn((nameOrObj: any) => {
        // If it's an object (like {Marked: true}), return it wrapped
        if (typeof nameOrObj === 'object') {
          return nameOrObj;
        }
        // If it's a string, return PDFName
        return PDFName.of(nameOrObj);
      }),
    };

    // Create mock catalog with proper pdf-lib structure
    mockCatalog = {
      get: vi.fn().mockReturnValue(undefined), // No existing value by default
      set: vi.fn().mockImplementation(() => undefined),
      lookup: vi.fn().mockReturnValue(null),
      context: mockContext,
    };

    // Create mock PDF document with proper pdf-lib API
    mockPdfDoc = {
      catalog: mockCatalog,
      context: mockContext,
      getInfoDict: vi.fn().mockReturnValue({}), // Add this missing method
      setLanguage: vi.fn().mockImplementation(() => undefined),
      setTitle: vi.fn().mockImplementation(() => undefined),
      setAuthor: vi.fn().mockImplementation(() => undefined),
      setSubject: vi.fn().mockImplementation(() => undefined),
      setCreator: vi.fn().mockImplementation(() => undefined),
      setProducer: vi.fn().mockImplementation(() => undefined),
      setKeywords: vi.fn().mockImplementation(() => undefined),
      setCreationDate: vi.fn().mockImplementation(() => undefined),
      setModificationDate: vi.fn().mockImplementation(() => undefined),
      getTitle: vi.fn().mockReturnValue(undefined),
      getAuthor: vi.fn().mockReturnValue(undefined),
      getSubject: vi.fn().mockReturnValue(undefined),
      getCreator: vi.fn().mockReturnValue(undefined),
      getProducer: vi.fn().mockReturnValue(undefined),
      getKeywords: vi.fn().mockReturnValue(undefined),
      getPageCount: vi.fn().mockReturnValue(1),
      getVersion: vi.fn().mockReturnValue({ major: 1, minor: 7 }),
      save: vi.fn().mockResolvedValue(Buffer.from('modified-pdf')),
    } as unknown as PDFDocument;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('addLanguage', () => {
    it('should successfully add language to PDF catalog', async () => {
      const result = await pdfModifierService.addLanguage(mockPdfDoc, 'en');

      expect(result.success).toBe(true);
      expect(result.description).toContain('Set document language');
      expect(result.before).toBe('Not set');
      expect(result.after).toBe('en');
      expect(mockCatalog.set).toHaveBeenCalled();
    });

    it('should default to "en" if no language specified', async () => {
      const result = await pdfModifierService.addLanguage(mockPdfDoc);

      expect(result.success).toBe(true);
      expect(result.after).toBe('en');
    });

    it('should detect existing language', async () => {
      // Mock existing language value
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(mockCatalog.get).mockReturnValue({ toString: () => 'fr' } as any);

      const result = await pdfModifierService.addLanguage(mockPdfDoc, 'en');

      expect(result.success).toBe(true);
      expect(result.before).toBeDefined();
      expect(result.before).not.toBe('Not set');
    });

    it('should handle errors gracefully', async () => {
      mockCatalog.set.mockImplementation(() => {
        throw new Error('Catalog error');
      });

      const result = await pdfModifierService.addLanguage(mockPdfDoc, 'en');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Catalog error');
    });
  });

  describe('addTitle', () => {
    it('should successfully add title to PDF', async () => {
      const result = await pdfModifierService.addTitle(mockPdfDoc, 'Test Document');

      expect(result.success).toBe(true);
      expect(result.description).toContain('Set document title');
      expect(result.after).toBe('Test Document');
      expect(mockPdfDoc.setTitle).toHaveBeenCalledWith('Test Document');
    });

    it('should detect existing title', async () => {
      vi.mocked(mockPdfDoc.getTitle).mockReturnValue('Old Title');

      const result = await pdfModifierService.addTitle(mockPdfDoc, 'New Title');

      expect(result.success).toBe(true);
      expect(result.before).toBe('Old Title');
      expect(result.after).toBe('New Title');
    });

    it('should accept empty title', async () => {
      const result = await pdfModifierService.addTitle(mockPdfDoc, '');

      // Service doesn't validate for empty titles - it just sets them
      expect(result.success).toBe(true);
      expect(mockPdfDoc.setTitle).toHaveBeenCalledWith('');
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(mockPdfDoc.setTitle).mockImplementation(() => {
        throw new Error('Set title error');
      });

      const result = await pdfModifierService.addTitle(mockPdfDoc, 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Set title error');
    });
  });

  describe('addMetadata', () => {
    it('should successfully add all metadata fields', async () => {
      const metadata = {
        title: 'Test Title',
        author: 'Test Author',
        subject: 'Test Subject',
        keywords: 'accessibility, pdf',
        creator: 'Test Creator',
        producer: 'Test Producer',
        marked: true,
      };

      const result = await pdfModifierService.addMetadata(mockPdfDoc, metadata);

      expect(result.success).toBe(true);
      expect(result.description).toContain('Updated PDF metadata');
      expect(mockPdfDoc.setTitle).toHaveBeenCalledWith('Test Title');
      expect(mockPdfDoc.setAuthor).toHaveBeenCalledWith('Test Author');
      expect(mockPdfDoc.setSubject).toHaveBeenCalledWith('Test Subject');
      expect(mockPdfDoc.setCreator).toHaveBeenCalledWith('Test Creator');
      expect(mockPdfDoc.setProducer).toHaveBeenCalledWith('Test Producer');
    });

    it('should handle partial metadata', async () => {
      const metadata = {
        title: 'Test Title',
      };

      const result = await pdfModifierService.addMetadata(mockPdfDoc, metadata);

      expect(result.success).toBe(true);
      expect(mockPdfDoc.setTitle).toHaveBeenCalledWith('Test Title');
      expect(mockPdfDoc.setAuthor).not.toHaveBeenCalled();
    });

    it('should set marked flag for PDF/UA compliance', async () => {
      const metadata = { marked: true };

      const result = await pdfModifierService.addMetadata(mockPdfDoc, metadata);

      expect(result.success).toBe(true);
      expect(result.description).toContain('Updated PDF metadata');
      expect(mockCatalog.set).toHaveBeenCalled();
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(mockPdfDoc.setTitle).mockImplementation(() => {
        throw new Error('Metadata error');
      });

      const result = await pdfModifierService.addMetadata(mockPdfDoc, { title: 'Test' });

      expect(result.success).toBe(false);
      expect(result.error).toBe('Metadata error');
    });
  });

  describe('addCreator', () => {
    it('should successfully add creator', async () => {
      const result = await pdfModifierService.addCreator(mockPdfDoc, 'Ninja Platform');

      expect(result.success).toBe(true);
      expect(result.description).toContain('Set document creator');
      expect(result.after).toBe('Ninja Platform');
      expect(mockPdfDoc.setCreator).toHaveBeenCalledWith('Ninja Platform');
    });

    it('should use default creator if not specified', async () => {
      const result = await pdfModifierService.addCreator(mockPdfDoc);

      expect(result.success).toBe(true);
      expect(result.after).toBe('Ninja Accessibility Platform');
    });

    it('should detect existing creator', async () => {
      vi.mocked(mockPdfDoc.getCreator).mockReturnValue('Old Creator');

      const result = await pdfModifierService.addCreator(mockPdfDoc, 'New Creator');

      expect(result.success).toBe(true);
      expect(result.before).toBe('Old Creator');
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(mockPdfDoc.setCreator).mockImplementation(() => {
        throw new Error('Creator error');
      });

      const result = await pdfModifierService.addCreator(mockPdfDoc, 'Test');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Creator error');
    });
  });

  describe('loadPDF', () => {
    it('should load PDF from buffer', async () => {
      const mockBuffer = Buffer.from('pdf-content');

      // Mock PDFDocument.load to return a properly structured mock with required methods
      const mockLoadedDoc = {
        getPageCount: vi.fn().mockReturnValue(5),
        getVersion: vi.fn().mockReturnValue({ major: 1, minor: 7 }),
      } as unknown as PDFDocument;

      vi.spyOn(PDFDocument, 'load').mockResolvedValue(mockLoadedDoc);

      const result = await pdfModifierService.loadPDF(mockBuffer);

      expect(result).toBe(mockLoadedDoc);
      expect(PDFDocument.load).toHaveBeenCalledWith(mockBuffer, {
        updateMetadata: false,
        ignoreEncryption: true,
      });
    });

    it('should throw error for invalid PDF', async () => {
      const mockBuffer = Buffer.from('invalid');

      vi.spyOn(PDFDocument, 'load').mockRejectedValue(new Error('Invalid PDF'));

      await expect(pdfModifierService.loadPDF(mockBuffer)).rejects.toThrow('Invalid PDF');
    });
  });

  describe('savePDF', () => {
    it('should save PDF and return buffer', async () => {
      const result = await pdfModifierService.savePDF(mockPdfDoc);

      expect(result).toBeInstanceOf(Buffer);
      expect(mockPdfDoc.save).toHaveBeenCalled();
    });

    it('should handle save errors', async () => {
      vi.mocked(mockPdfDoc.save).mockRejectedValue(new Error('Save error'));

      await expect(pdfModifierService.savePDF(mockPdfDoc)).rejects.toThrow('Save error');
    });
  });

  describe('validatePDF', () => {
    it('should validate a valid PDF buffer', async () => {
      const mockBuffer = Buffer.from('%PDF-1.7\nvalid content');
      vi.spyOn(pdfModifierService, 'loadPDF').mockResolvedValue(mockPdfDoc);

      const result = await pdfModifierService.validatePDF(mockBuffer);

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('should reject empty buffer', async () => {
      const mockBuffer = Buffer.from('');
      vi.spyOn(pdfModifierService, 'loadPDF').mockRejectedValue(new Error('Empty buffer'));

      const result = await pdfModifierService.validatePDF(mockBuffer);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('empty') || e.includes('Validation error'))).toBe(true);
    });

    it('should reject buffer without PDF header', async () => {
      const mockBuffer = Buffer.from('Not a PDF file content here');

      const result = await pdfModifierService.validatePDF(mockBuffer);

      expect(result.valid).toBe(false);
      expect(result.errors.some(e => e.includes('header'))).toBe(true);
    });

    it('should reject invalid PDF structure', async () => {
      const mockBuffer = Buffer.from('%PDF-1.7 but invalid content');
      vi.spyOn(pdfModifierService, 'loadPDF').mockRejectedValue(new Error('Corrupted PDF'));

      const result = await pdfModifierService.validatePDF(mockBuffer);

      expect(result.valid).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('createBackup', () => {
    it('should create backup file and return path', async () => {
      const mockBuffer = Buffer.from('pdf-content');
      const fileName = 'test.pdf';

      vi.mocked(fs.writeFile).mockResolvedValue(undefined);

      const backupPath = await pdfModifierService.createBackup(mockBuffer, fileName);

      expect(backupPath).toContain('backup');
      expect(backupPath).toContain('.pdf');
      expect(fs.writeFile).toHaveBeenCalled();
    });

    it('should handle backup creation errors', async () => {
      const mockBuffer = Buffer.from('pdf-content');
      vi.mocked(fs.writeFile).mockRejectedValue(new Error('Write error'));

      await expect(
        pdfModifierService.createBackup(mockBuffer, 'test.pdf')
      ).rejects.toThrow('Write error');
    });
  });

  describe('rollback', () => {
    it('should restore from backup file', async () => {
      const backupPath = '/path/to/backup.pdf';
      const mockBuffer = Buffer.from('backup-content');

      vi.mocked(fs.readFile).mockResolvedValue(mockBuffer);

      const result = await pdfModifierService.rollback(backupPath);

      expect(result).toEqual(mockBuffer);
      expect(fs.readFile).toHaveBeenCalledWith(backupPath);
    });

    it('should throw error if backup file not found', async () => {
      const backupPath = '/path/to/missing.pdf';

      vi.mocked(fs.readFile).mockRejectedValue(new Error('File not found'));

      await expect(pdfModifierService.rollback(backupPath)).rejects.toThrow('File not found');
    });

    it('should return buffer when rollback succeeds', async () => {
      const backupPath = '/path/to/backup.pdf';
      const mockBuffer = Buffer.from('backup-content');

      vi.mocked(fs.readFile).mockResolvedValue(mockBuffer);

      const result = await pdfModifierService.rollback(backupPath);

      expect(result).toEqual(mockBuffer);
      expect(result).toBeInstanceOf(Buffer);
    });
  });

  describe('integration scenarios', () => {
    it('should handle full modification workflow', async () => {
      // Add language
      const langResult = await pdfModifierService.addLanguage(mockPdfDoc, 'en');
      expect(langResult.success).toBe(true);

      // Add title
      const titleResult = await pdfModifierService.addTitle(mockPdfDoc, 'Test Doc');
      expect(titleResult.success).toBe(true);

      // Add metadata
      const metaResult = await pdfModifierService.addMetadata(mockPdfDoc, {
        author: 'Test Author',
      });
      expect(metaResult.success).toBe(true);

      // Add creator
      const creatorResult = await pdfModifierService.addCreator(mockPdfDoc);
      expect(creatorResult.success).toBe(true);

      // Save
      const buffer = await pdfModifierService.savePDF(mockPdfDoc);
      expect(buffer).toBeInstanceOf(Buffer);
    });

    it('should maintain modification history', async () => {
      const modifications: ModificationResult[] = [];

      modifications.push(await pdfModifierService.addLanguage(mockPdfDoc, 'en'));
      modifications.push(await pdfModifierService.addTitle(mockPdfDoc, 'Test'));
      modifications.push(await pdfModifierService.addCreator(mockPdfDoc));

      expect(modifications).toHaveLength(3);
      expect(modifications.every(m => m.success)).toBe(true);
    });
  });
});
