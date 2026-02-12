import { describe, it, expect, beforeEach } from 'vitest';
import { pdfAcrExportService } from './acr-export.service';
import { ACRReport, ProductInfo } from './acr-generator.service';

describe('PdfAcrExportService', () => {
  let mockAcrReport: ACRReport;

  beforeEach(() => {
    const mockProductInfo: ProductInfo = {
      name: 'Test PDF Document',
      version: '1.0',
      vendor: 'Test Vendor',
      evaluationDate: '2024-01-30',
      evaluator: 'Automated Audit System',
    };

    mockAcrReport = {
      id: 'acr-123',
      productInfo: mockProductInfo,
      wcagResults: [
        {
          criterion: '1.1.1',
          name: 'Non-text Content',
          level: 'A',
          conformance: 'Does Not Support',
          remarks: 'Found 1 issue(s): 1 critical. Examples: - Image missing alternative text (Page 1). Immediate remediation required to meet this criterion.',
          issueCount: 1,
        },
        {
          criterion: '1.4.3',
          name: 'Contrast (Minimum)',
          level: 'AA',
          conformance: 'Partially Supports',
          remarks: 'Found 1 issue(s): 1 moderate. Examples: - Text has insufficient contrast ratio (Page 2). Minor improvements recommended to fully support this criterion.',
          issueCount: 1,
        },
        {
          criterion: '2.4.2',
          name: 'Page Titled',
          level: 'A',
          conformance: 'Supports',
          remarks: 'The PDF document meets all requirements for this criterion. No issues detected.',
          issueCount: 0,
        },
        {
          criterion: '3.1.1',
          name: 'Language of Page',
          level: 'A',
          conformance: 'Does Not Support',
          remarks: 'Found 1 issue(s): 1 serious. Examples: - PDF document does not specify a language. Immediate remediation required to meet this criterion.',
          issueCount: 1,
        },
      ],
      summary: 'Accessibility audit of "test-document.pdf" completed on 1/30/2024. Overall accessibility score: 85/100. Total issues found: 3 (Critical: 1, Serious: 1, Moderate: 1, Minor: 0). WCAG 2.1 Conformance: - Level A: Does Not Support - Level AA: Does Not Support Out of 45 applicable criteria: 40 fully supported, 3 partially supported, 2 not supported.',
      notes: [
        'This report was automatically generated using PDF accessibility audit tools.',
        'Conformance levels are based on automated testing and may require manual verification.',
      ],
      generatedAt: new Date('2024-01-30T10:00:00Z'),
      overallConformance: {
        levelA: 'Does Not Support',
        levelAA: 'Does Not Support',
        levelAAA: 'Not Applicable',
      },
    };
  });

  describe('exportToDocx', () => {
    it('should export ACR report to DOCX format', async () => {
      const buffer = await pdfAcrExportService.exportToDocx(mockAcrReport);

      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(0);
    });

    it('should generate valid DOCX buffer', async () => {
      const buffer = await pdfAcrExportService.exportToDocx(mockAcrReport);

      // DOCX files start with PK (zip format)
      expect(buffer[0]).toBe(0x50); // 'P'
      expect(buffer[1]).toBe(0x4B); // 'K'
    });

    it('should handle reports with no issues', async () => {
      const cleanReport: ACRReport = {
        ...mockAcrReport,
        wcagResults: mockAcrReport.wcagResults.map(r => ({
          ...r,
          conformance: 'Supports',
          issueCount: 0,
          remarks: 'The PDF document meets all requirements for this criterion. No issues detected.',
        })),
        overallConformance: {
          levelA: 'Supports',
          levelAA: 'Supports',
          levelAAA: 'Not Applicable',
        },
      };

      const buffer = await pdfAcrExportService.exportToDocx(cleanReport);

      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(0);
    });

    it('should handle reports with many issues', async () => {
      const manyIssuesReport: ACRReport = {
        ...mockAcrReport,
        wcagResults: Array.from({ length: 50 }, (_, i) => ({
          criterion: `${Math.floor(i / 10) + 1}.${(i % 10) + 1}.1`,
          name: `Test Criterion ${i + 1}`,
          level: (i % 2 === 0 ? 'A' : 'AA') as 'A' | 'AA',
          conformance: 'Does Not Support',
          remarks: `Issue found for criterion ${i + 1}`,
          issueCount: 1,
        })),
      };

      const buffer = await pdfAcrExportService.exportToDocx(manyIssuesReport);

      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(0);
    });
  });

  describe('exportToPdf', () => {
    it('should export ACR report to PDF format (stubbed)', async () => {
      const buffer = await pdfAcrExportService.exportToPdf(mockAcrReport);

      expect(buffer).toBeInstanceOf(Buffer);
      expect(buffer.length).toBeGreaterThan(0);
    });

    it('should return valid buffer (currently DOCX placeholder)', async () => {
      const buffer = await pdfAcrExportService.exportToPdf(mockAcrReport);

      // Currently returns DOCX as placeholder
      expect(buffer[0]).toBe(0x50); // 'P'
      expect(buffer[1]).toBe(0x4B); // 'K'
    });
  });

  describe('exportToHtml', () => {
    it('should export ACR report to HTML format', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      expect(typeof html).toBe('string');
      expect(html.length).toBeGreaterThan(0);
    });

    it('should generate valid HTML document', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<html lang="en">');
      expect(html).toContain('</html>');
      expect(html).toContain('<head>');
      expect(html).toContain('<body>');
    });

    it('should include product information in HTML', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      expect(html).toContain('Test PDF Document');
      expect(html).toContain('1.0');
      expect(html).toContain('Test Vendor');
      expect(html).toContain('2024-01-30');
      expect(html).toContain('Automated Audit System');
    });

    it('should include WCAG results in HTML', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      expect(html).toContain('1.1.1');
      expect(html).toContain('Non-text Content');
      expect(html).toContain('Does Not Support');
      expect(html).toContain('Partially Supports');
      expect(html).toContain('Supports');
    });

    it('should include summary in HTML', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      expect(html).toContain('Executive Summary');
      expect(html).toContain('test-document.pdf');
      expect(html).toContain('85/100');
    });

    it('should include notes in HTML', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      expect(html).toContain('Notes');
      expect(html).toContain('automatically generated');
      expect(html).toContain('manual verification');
    });

    it('should include CSS styles in HTML', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      expect(html).toContain('<style>');
      expect(html).toContain('</style>');
      expect(html).toContain('font-family');
      expect(html).toContain('table');
    });

    it('should escape HTML special characters', async () => {
      const reportWithSpecialChars: ACRReport = {
        ...mockAcrReport,
        productInfo: {
          ...mockAcrReport.productInfo,
          name: 'Test <Document> & "Report"',
        },
      };

      const html = await pdfAcrExportService.exportToHtml(reportWithSpecialChars);

      expect(html).toContain('&lt;Document&gt;');
      expect(html).toContain('&amp;');
      expect(html).toContain('&quot;Report&quot;');
      expect(html).not.toContain('Test <Document>');
    });

    it('should be print-friendly', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      expect(html).toContain('@media print');
    });

    it('should have color-coded conformance levels', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      // Check for conformance CSS classes
      expect(html).toContain('conformance-');
    });
  });

  describe('document structure', () => {
    it('should include cover page information in DOCX', async () => {
      const buffer = await pdfAcrExportService.exportToDocx(mockAcrReport);

      // Verify buffer is created (content verification would require DOCX parsing)
      expect(buffer.length).toBeGreaterThan(1000); // Reasonable size for document
    });

    it('should include executive summary in exports', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      expect(html).toContain('Executive Summary');
      expect(html).toContain('Overall WCAG 2.1 Conformance');
      expect(html).toContain('Level A:');
      expect(html).toContain('Level AA:');
    });

    it('should group WCAG results by level', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      expect(html).toContain('Level A Criteria');
      expect(html).toContain('Level AA Criteria');
    });

    it('should include detailed findings section', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      expect(html).toContain('Detailed Findings');
      expect(html).toContain('Critical Issues');
      expect(html).toContain('Minor Issues');
    });

    it('should separate critical and minor issues', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      const criticalIndex = html.indexOf('Critical Issues');
      const minorIndex = html.indexOf('Minor Issues');

      expect(criticalIndex).toBeGreaterThan(0);
      expect(minorIndex).toBeGreaterThan(criticalIndex);
    });
  });

  describe('formatting', () => {
    it('should create WCAG results table in HTML', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      expect(html).toContain('<table>');
      expect(html).toContain('<thead>');
      expect(html).toContain('<tbody>');
      expect(html).toContain('<th>Criterion</th>');
      expect(html).toContain('<th>Name</th>');
      expect(html).toContain('<th>Conformance</th>');
      expect(html).toContain('<th>Issues</th>');
      expect(html).toContain('<th>Remarks</th>');
    });

    it('should format conformance levels with colors', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      // Check that HTML contains conformance classes for styling
      expect(html).toMatch(/class="conformance-/);
    });

    it('should format dates consistently', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      expect(html).toContain('2024-01-30');
    });
  });

  describe('edge cases', () => {
    it('should handle empty notes array', async () => {
      const reportWithoutNotes: ACRReport = {
        ...mockAcrReport,
        notes: [],
      };

      const html = await pdfAcrExportService.exportToHtml(reportWithoutNotes);

      expect(html).toContain('Notes');
    });

    it('should handle very long remarks', async () => {
      const longRemarks = 'A'.repeat(5000);
      const reportWithLongRemarks: ACRReport = {
        ...mockAcrReport,
        wcagResults: [
          {
            criterion: '1.1.1',
            name: 'Test',
            level: 'A',
            conformance: 'Does Not Support',
            remarks: longRemarks,
            issueCount: 1,
          },
        ],
      };

      const html = await pdfAcrExportService.exportToHtml(reportWithLongRemarks);

      expect(html).toContain(longRemarks);
    });

    it('should handle special characters in all fields', async () => {
      const reportWithSpecialChars: ACRReport = {
        ...mockAcrReport,
        productInfo: {
          name: '<Script>Alert("XSS")</Script>',
          version: '1.0 & 2.0',
          vendor: 'Test "Vendor" & Co.',
          evaluationDate: '2024-01-30',
          evaluator: '<Evaluator>',
        },
      };

      const html = await pdfAcrExportService.exportToHtml(reportWithSpecialChars);

      expect(html).not.toContain('<Script>');
      expect(html).toContain('&lt;Script&gt;');
      expect(html).toContain('&amp;');
      expect(html).toContain('&quot;');
    });

    it('should handle empty WCAG results', async () => {
      const emptyReport: ACRReport = {
        ...mockAcrReport,
        wcagResults: [],
      };

      const html = await pdfAcrExportService.exportToHtml(emptyReport);

      expect(html).toContain('WCAG 2.1 Conformance Details');
    });
  });

  describe('accessibility', () => {
    it('should include lang attribute in HTML', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      expect(html).toContain('lang="en"');
    });

    it('should include proper heading hierarchy', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      expect(html).toContain('<h1>');
      expect(html).toContain('<h2>');
    });

    it('should use semantic HTML table structure', async () => {
      const html = await pdfAcrExportService.exportToHtml(mockAcrReport);

      expect(html).toContain('<thead>');
      expect(html).toContain('<tbody>');
      expect(html).toContain('<th>');
      expect(html).toContain('<td>');
    });
  });
});
