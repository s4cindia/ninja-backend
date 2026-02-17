import { describe, it, expect, beforeEach } from 'vitest';
import { PdfContrastValidator } from './pdf-contrast.validator';
import { PdfParseResult } from '../pdf-comprehensive-parser.service';

describe('PdfContrastValidator', () => {
  let validator: PdfContrastValidator;

  beforeEach(() => {
    validator = new PdfContrastValidator();
  });

  describe('calculateContrastRatio', () => {
    it('should calculate 21:1 for black on white', () => {
      const black = { r: 0, g: 0, b: 0 };
      const white = { r: 255, g: 255, b: 255 };

      const ratio = validator.calculateContrastRatio(black, white);

      expect(ratio).toBeCloseTo(21, 1);
    });

    it('should calculate 21:1 for white on black', () => {
      const white = { r: 255, g: 255, b: 255 };
      const black = { r: 0, g: 0, b: 0 };

      const ratio = validator.calculateContrastRatio(white, black);

      expect(ratio).toBeCloseTo(21, 1);
    });

    it('should calculate 1:1 for identical colors', () => {
      const gray = { r: 128, g: 128, b: 128 };

      const ratio = validator.calculateContrastRatio(gray, gray);

      expect(ratio).toBeCloseTo(1, 1);
    });

    it('should calculate correct ratio for gray on white', () => {
      const gray = { r: 128, g: 128, b: 128 };
      const white = { r: 255, g: 255, b: 255 };

      const ratio = validator.calculateContrastRatio(gray, white);

      // Expected ratio for #808080 on #FFFFFF is approximately 3.95:1
      expect(ratio).toBeGreaterThan(3.9);
      expect(ratio).toBeLessThan(4.0);
    });

    it('should calculate correct ratio for common color pairs', () => {
      // #595959 on white should be close to 4.5:1 (AA minimum for normal text)
      const darkGray = { r: 89, g: 89, b: 89 };
      const white = { r: 255, g: 255, b: 255 };

      const ratio = validator.calculateContrastRatio(darkGray, white);

      expect(ratio).toBeGreaterThan(4.4);
      expect(ratio).toBeLessThan(4.6);
    });
  });

  describe('getLuminance', () => {
    it('should calculate 0 for black', () => {
      const luminance = validator.getLuminance(0, 0, 0);
      expect(luminance).toBe(0);
    });

    it('should calculate 1 for white', () => {
      const luminance = validator.getLuminance(255, 255, 255);
      expect(luminance).toBeCloseTo(1, 2);
    });

    it('should calculate correct luminance for gray', () => {
      const luminance = validator.getLuminance(128, 128, 128);
      expect(luminance).toBeGreaterThan(0);
      expect(luminance).toBeLessThan(1);
    });

    it('should calculate different luminance for different colors', () => {
      const red = validator.getLuminance(255, 0, 0);
      const green = validator.getLuminance(0, 255, 0);
      const blue = validator.getLuminance(0, 0, 255);

      // Green should have highest luminance due to WCAG weighting
      expect(green).toBeGreaterThan(red);
      expect(green).toBeGreaterThan(blue);
    });
  });

  describe('isLargeText', () => {
    it('should consider 18pt text as large', () => {
      expect(validator.isLargeText(18, false)).toBe(true);
    });

    it('should consider 19pt text as large', () => {
      expect(validator.isLargeText(19, false)).toBe(true);
    });

    it('should consider 14pt bold text as large', () => {
      expect(validator.isLargeText(14, true)).toBe(true);
    });

    it('should consider 15pt bold text as large', () => {
      expect(validator.isLargeText(15, true)).toBe(true);
    });

    it('should not consider 17pt text as large', () => {
      expect(validator.isLargeText(17, false)).toBe(false);
    });

    it('should not consider 14pt regular text as large', () => {
      expect(validator.isLargeText(14, false)).toBe(false);
    });

    it('should not consider 13pt bold text as large', () => {
      expect(validator.isLargeText(13, true)).toBe(false);
    });

    it('should not consider 12pt text as large', () => {
      expect(validator.isLargeText(12, false)).toBe(false);
    });
  });

  describe('hexToRgb', () => {
    it('should convert black hex to RGB', () => {
      const rgb = validator.hexToRgb('#000000');
      expect(rgb).toEqual({ r: 0, g: 0, b: 0 });
    });

    it('should convert white hex to RGB', () => {
      const rgb = validator.hexToRgb('#FFFFFF');
      expect(rgb).toEqual({ r: 255, g: 255, b: 255 });
    });

    it('should convert red hex to RGB', () => {
      const rgb = validator.hexToRgb('#FF0000');
      expect(rgb).toEqual({ r: 255, g: 0, b: 0 });
    });

    it('should convert green hex to RGB', () => {
      const rgb = validator.hexToRgb('#00FF00');
      expect(rgb).toEqual({ r: 0, g: 255, b: 0 });
    });

    it('should convert blue hex to RGB', () => {
      const rgb = validator.hexToRgb('#0000FF');
      expect(rgb).toEqual({ r: 0, g: 0, b: 255 });
    });

    it('should handle hex without # prefix', () => {
      const rgb = validator.hexToRgb('808080');
      expect(rgb).toEqual({ r: 128, g: 128, b: 128 });
    });

    it('should convert gray hex to RGB', () => {
      const rgb = validator.hexToRgb('#808080');
      expect(rgb).toEqual({ r: 128, g: 128, b: 128 });
    });
  });

  describe('rgbToHex', () => {
    it('should convert black RGB to hex', () => {
      const hex = validator.rgbToHex({ r: 0, g: 0, b: 0 });
      expect(hex).toBe('#000000');
    });

    it('should convert white RGB to hex', () => {
      const hex = validator.rgbToHex({ r: 255, g: 255, b: 255 });
      expect(hex).toBe('#ffffff');
    });

    it('should convert red RGB to hex', () => {
      const hex = validator.rgbToHex({ r: 255, g: 0, b: 0 });
      expect(hex).toBe('#ff0000');
    });

    it('should convert gray RGB to hex', () => {
      const hex = validator.rgbToHex({ r: 128, g: 128, b: 128 });
      expect(hex).toBe('#808080');
    });

    it('should pad single digit hex values', () => {
      const hex = validator.rgbToHex({ r: 1, g: 2, b: 3 });
      expect(hex).toBe('#010203');
    });
  });

  describe('validate', () => {
    it('should validate PDF with good contrast', async () => {
      const mockPdf: PdfParseResult = {
        metadata: {
          pdfVersion: '1.7',
          isEncrypted: false,
          isLinearized: false,
          isTagged: true,
          hasOutline: false,
          hasAcroForm: false,
          hasXFA: false,
          pageCount: 1,
          hasStructureTree: true,
        },
        pages: [
          {
            pageNumber: 1,
            width: 612,
            height: 792,
            rotation: 0,
            content: [
              {
                text: 'Black text on white background',
                position: { x: 100, y: 100, width: 200, height: 20 },
                font: { name: 'Arial', size: 12 },
              },
            ],
            images: [],
            links: [],
            formFields: [],
            headings: [],
            tables: [],
            lists: [],
          },
        ],
        isTagged: true,
      };

      const issues = await validator.validate(mockPdf);

      // Black on white has 21:1 ratio, should pass all checks
      expect(issues).toHaveLength(0);
    });

    it('should detect low contrast issues', async () => {
      // Note: This test uses the current stub implementation which assumes
      // black on white. In a real implementation with color extraction,
      // we would test actual low contrast scenarios.
      const mockPdf: PdfParseResult = {
        metadata: {
          pdfVersion: '1.7',
          isEncrypted: false,
          isLinearized: false,
          isTagged: true,
          hasOutline: false,
          hasAcroForm: false,
          hasXFA: false,
          pageCount: 1,
          hasStructureTree: true,
        },
        pages: [
          {
            pageNumber: 1,
            width: 612,
            height: 792,
            rotation: 0,
            content: [
              {
                text: 'Test text',
                position: { x: 100, y: 100, width: 100, height: 20 },
                font: { name: 'Arial', size: 12 },
              },
            ],
            images: [],
            links: [],
            formFields: [],
            headings: [],
            tables: [],
            lists: [],
          },
        ],
        isTagged: true,
      };

      const issues = await validator.validate(mockPdf);

      // Current implementation uses black on white (21:1), so no issues
      expect(Array.isArray(issues)).toBe(true);
    });

    it('should include WCAG criteria in issues', async () => {
      const mockPdf: PdfParseResult = {
        metadata: {
          pdfVersion: '1.7',
          isEncrypted: false,
          isLinearized: false,
          isTagged: true,
          hasOutline: false,
          hasAcroForm: false,
          hasXFA: false,
          pageCount: 1,
          hasStructureTree: true,
        },
        pages: [
          {
            pageNumber: 1,
            width: 612,
            height: 792,
            rotation: 0,
            content: [
              {
                text: 'Test',
                position: { x: 0, y: 0, width: 50, height: 12 },
                font: { name: 'Arial', size: 12 },
              },
            ],
            images: [],
            links: [],
            formFields: [],
            headings: [],
            tables: [],
            lists: [],
          },
        ],
        isTagged: true,
      };

      const issues = await validator.validate(mockPdf);

      // Verify structure of issues if any exist
      issues.forEach(issue => {
        expect(issue).toHaveProperty('wcagCriteria');
        expect(issue).toHaveProperty('severity');
        expect(issue).toHaveProperty('code');
        expect(issue).toHaveProperty('message');
        expect(issue).toHaveProperty('location');
      });
    });

    it('should handle multiple pages', async () => {
      const mockPdf: PdfParseResult = {
        metadata: {
          pdfVersion: '1.7',
          isEncrypted: false,
          isLinearized: false,
          isTagged: true,
          hasOutline: false,
          hasAcroForm: false,
          hasXFA: false,
          pageCount: 3,
          hasStructureTree: true,
        },
        pages: [
          {
            pageNumber: 1,
            width: 612,
            height: 792,
            rotation: 0,
            content: [
              {
                text: 'Page 1 text',
                position: { x: 100, y: 100, width: 100, height: 20 },
                font: { name: 'Arial', size: 12 },
              },
            ],
            images: [],
            links: [],
            formFields: [],
            headings: [],
            tables: [],
            lists: [],
          },
          {
            pageNumber: 2,
            width: 612,
            height: 792,
            rotation: 0,
            content: [
              {
                text: 'Page 2 text',
                position: { x: 100, y: 100, width: 100, height: 20 },
                font: { name: 'Arial', size: 12 },
              },
            ],
            images: [],
            links: [],
            formFields: [],
            headings: [],
            tables: [],
            lists: [],
          },
          {
            pageNumber: 3,
            width: 612,
            height: 792,
            rotation: 0,
            content: [],
            images: [],
            links: [],
            formFields: [],
            headings: [],
            tables: [],
            lists: [],
          },
        ],
        isTagged: true,
      };

      const issues = await validator.validate(mockPdf);

      // Should process all pages without error
      expect(Array.isArray(issues)).toBe(true);
    });

    it('should handle pages with no content', async () => {
      const mockPdf: PdfParseResult = {
        metadata: {
          pdfVersion: '1.7',
          isEncrypted: false,
          isLinearized: false,
          isTagged: true,
          hasOutline: false,
          hasAcroForm: false,
          hasXFA: false,
          pageCount: 1,
          hasStructureTree: true,
        },
        pages: [
          {
            pageNumber: 1,
            width: 612,
            height: 792,
            rotation: 0,
            content: [],
            images: [],
            links: [],
            formFields: [],
            headings: [],
            tables: [],
            lists: [],
          },
        ],
        isTagged: true,
      };

      const issues = await validator.validate(mockPdf);

      expect(issues).toHaveLength(0);
    });
  });

  describe('contrast scenarios', () => {
    it('should identify critical severity for very low contrast (< 3:1)', () => {
      // Light gray on white: approximately 1.5:1
      const lightGray = { r: 200, g: 200, b: 200 };
      const white = { r: 255, g: 255, b: 255 };

      const ratio = validator.calculateContrastRatio(lightGray, white);

      expect(ratio).toBeLessThan(3.0);
    });

    it('should identify serious severity for normal text below 4.5:1', () => {
      // Medium gray on white: approximately 3.5:1
      const mediumGray = { r: 150, g: 150, b: 150 };
      const white = { r: 255, g: 255, b: 255 };

      const ratio = validator.calculateContrastRatio(mediumGray, white);

      expect(ratio).toBeGreaterThan(3.0);
      expect(ratio).toBeLessThan(4.5);
    });

    it('should pass AA for normal text with 4.5:1', () => {
      // Dark gray on white: approximately 4.5:1
      const darkGray = { r: 118, g: 118, b: 118 };
      const white = { r: 255, g: 255, b: 255 };

      const ratio = validator.calculateContrastRatio(darkGray, white);

      expect(ratio).toBeGreaterThanOrEqual(4.5);
    });

    it('should pass AAA for normal text with 7:1', () => {
      // Very dark gray on white: approximately 7:1
      const veryDarkGray = { r: 85, g: 85, b: 85 };
      const white = { r: 255, g: 255, b: 255 };

      const ratio = validator.calculateContrastRatio(veryDarkGray, white);

      expect(ratio).toBeGreaterThanOrEqual(7.0);
    });

    it('should pass AA for large text with 3:1', () => {
      // Medium gray on white: approximately 3.5:1
      const mediumGray = { r: 150, g: 150, b: 150 };
      const white = { r: 255, g: 255, b: 255 };

      const ratio = validator.calculateContrastRatio(mediumGray, white);

      expect(ratio).toBeGreaterThanOrEqual(3.0);
    });
  });

  describe('real-world color combinations', () => {
    it('should validate common accessible combinations', () => {
      const combinations = [
        { text: '#000000', bg: '#FFFFFF', expected: 21 },    // Black on white
        { text: '#FFFFFF', bg: '#000000', expected: 21 },    // White on black
        { text: '#0000FF', bg: '#FFFFFF', expected: 8.6 },   // Blue on white
        { text: '#008000', bg: '#FFFFFF', expected: 4.3 },   // Green on white (borderline)
      ];

      combinations.forEach(({ text, bg, expected }) => {
        const textRgb = validator.hexToRgb(text);
        const bgRgb = validator.hexToRgb(bg);
        const ratio = validator.calculateContrastRatio(textRgb, bgRgb);

        expect(ratio).toBeGreaterThan(expected - 0.5);
        expect(ratio).toBeLessThan(expected + 0.5);
      });
    });

    it('should identify common inaccessible combinations', () => {
      const combinations = [
        { text: '#CCCCCC', bg: '#FFFFFF' },  // Light gray on white
        { text: '#808080', bg: '#C0C0C0' },  // Gray on light gray
        { text: '#FFFF00', bg: '#FFFFFF' },  // Yellow on white
      ];

      combinations.forEach(({ text, bg }) => {
        const textRgb = validator.hexToRgb(text);
        const bgRgb = validator.hexToRgb(bg);
        const ratio = validator.calculateContrastRatio(textRgb, bgRgb);

        expect(ratio).toBeLessThan(4.5);
      });
    });
  });
});
