import { PDFDocument } from 'pdf-lib';
import { pdfModifierService } from '@/services/pdf/pdf-modifier.service';

describe('PdfModifierService', () => {
  let testPdfBuffer: Buffer;
  let pdfDoc: PDFDocument;

  beforeAll(async () => {
    // Create a minimal test PDF
    const doc = await PDFDocument.create();
    doc.addPage();
    const bytes = await doc.save();
    testPdfBuffer = Buffer.from(bytes);
  });

  beforeEach(async () => {
    pdfDoc = await pdfModifierService.loadPDF(testPdfBuffer);
  });

  describe('loadPDF', () => {
    it('should load PDF from buffer', async () => {
      expect(pdfDoc).toBeDefined();
      expect(pdfDoc.getPageCount()).toBeGreaterThan(0);
    });
  });

  describe('savePDF', () => {
    it('should save PDF to buffer', async () => {
      const buffer = await pdfModifierService.savePDF(pdfDoc);
      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(0);
    });
  });

  describe('addLanguage', () => {
    it('should add language to PDF', async () => {
      const result = await pdfModifierService.addLanguage(pdfDoc, 'en-US');

      expect(result.success).toBe(true);
      expect(result.field).toBe('language');
      expect(result.newValue).toBe('en-US');
      expect(result.message).toContain('en-US');
    });

    it('should use default language if not specified', async () => {
      const result = await pdfModifierService.addLanguage(pdfDoc);

      expect(result.success).toBe(true);
      expect(result.newValue).toBe('en-US');
    });
  });

  describe('addTitle', () => {
    it('should add title to PDF', async () => {
      const result = await pdfModifierService.addTitle(pdfDoc, 'Test Document');

      expect(result.success).toBe(true);
      expect(result.field).toBe('title');
      expect(result.newValue).toBe('Test Document');
    });

    it('should track old title value', async () => {
      pdfDoc.setTitle('Old Title');
      const result = await pdfModifierService.addTitle(pdfDoc, 'New Title');

      expect(result.oldValue).toBe('Old Title');
      expect(result.newValue).toBe('New Title');
    });
  });

  describe('addMetadata', () => {
    it('should add accessibility metadata', async () => {
      const result = await pdfModifierService.addMetadata(pdfDoc);

      expect(result.success).toBe(true);
      expect(result.field).toBe('metadata');
      expect(result.message).toContain('MarkInfo');
    });
  });

  describe('addCreator', () => {
    it('should add creator to PDF', async () => {
      const result = await pdfModifierService.addCreator(pdfDoc);

      expect(result.success).toBe(true);
      expect(result.field).toBe('creator');
      expect(result.newValue).toBe('Ninja Accessibility Tool');
    });

    it('should use custom creator if provided', async () => {
      const result = await pdfModifierService.addCreator(pdfDoc, 'Custom Creator');

      expect(result.newValue).toBe('Custom Creator');
    });
  });

  describe('integration', () => {
    it('should apply multiple modifications and save', async () => {
      await pdfModifierService.addLanguage(pdfDoc, 'en-US');
      await pdfModifierService.addTitle(pdfDoc, 'Accessible Document');
      await pdfModifierService.addMetadata(pdfDoc);
      await pdfModifierService.addCreator(pdfDoc);

      const buffer = await pdfModifierService.savePDF(pdfDoc);

      // Verify saved PDF can be loaded again
      const reloadedDoc = await pdfModifierService.loadPDF(buffer);
      expect(reloadedDoc.getTitle()).toBe('Accessible Document');
    });
  });
});
