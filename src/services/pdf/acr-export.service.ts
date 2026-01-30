/**
 * PDF ACR Export Service
 *
 * Exports ACR reports to various formats (DOCX, PDF, HTML).
 * Implements US-PDF-3.2 requirements.
 */

import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableRow,
  TableCell,
  TextRun,
  HeadingLevel,
  WidthType,
  AlignmentType,
  BorderStyle,
  ShadingType,
} from 'docx';
import { logger } from '../../lib/logger';
import { ACRReport, WcagCriterionResult } from './acr-generator.service';

/**
 * Color scheme for conformance levels
 */
const CONFORMANCE_COLORS = {
  Supports: { fill: '90EE90', text: '006400' }, // Light green / Dark green
  'Partially Supports': { fill: 'FFD700', text: '8B4513' }, // Gold / Brown
  'Does Not Support': { fill: 'FFB6C1', text: '8B0000' }, // Light red / Dark red
  'Not Applicable': { fill: 'D3D3D3', text: '696969' }, // Light gray / Dark gray
};

/**
 * PDF ACR Export Service
 */
class PdfAcrExportService {
  /**
   * Export ACR report to DOCX format
   *
   * @param report - ACR report
   * @returns DOCX file buffer
   */
  async exportToDocx(report: ACRReport): Promise<Buffer> {
    logger.info('[PdfAcrExport] Exporting to DOCX...');

    try {
      const doc = this.createDocxDocument(report);
      const buffer = await Packer.toBuffer(doc);

      logger.info(`[PdfAcrExport] DOCX generated: ${buffer.length} bytes`);
      return buffer;
    } catch (error) {
      logger.error('[PdfAcrExport] DOCX export failed:', error);
      throw error;
    }
  }

  /**
   * Export ACR report to PDF format
   *
   * Note: This is a stub. In production, you would either:
   * 1. Convert DOCX to PDF using libreoffice or similar
   * 2. Use pdfkit/pdf-lib to generate PDF directly
   *
   * @param report - ACR report
   * @returns PDF file buffer
   */
  async exportToPdf(report: ACRReport): Promise<Buffer> {
    logger.info('[PdfAcrExport] Exporting to PDF...');

    try {
      // Stub: In production, convert DOCX to PDF or generate directly
      // For now, generate DOCX and indicate it needs conversion
      const docxBuffer = await this.exportToDocx(report);

      logger.warn('[PdfAcrExport] PDF export is stubbed - returns DOCX buffer');
      logger.info('[PdfAcrExport] To implement: Use LibreOffice or pdf-lib for conversion');

      // Return DOCX buffer as placeholder
      // In production, convert this to PDF
      return docxBuffer;
    } catch (error) {
      logger.error('[PdfAcrExport] PDF export failed:', error);
      throw error;
    }
  }

  /**
   * Export ACR report to HTML format
   *
   * @param report - ACR report
   * @returns HTML string
   */
  async exportToHtml(report: ACRReport): Promise<string> {
    logger.info('[PdfAcrExport] Exporting to HTML...');

    try {
      const html = this.createHtmlDocument(report);

      logger.info(`[PdfAcrExport] HTML generated: ${html.length} characters`);
      return html;
    } catch (error) {
      logger.error('[PdfAcrExport] HTML export failed:', error);
      throw error;
    }
  }

  /**
   * Create DOCX document from ACR report
   *
   * @param report - ACR report
   * @returns DOCX document
   */
  private createDocxDocument(report: ACRReport): Document {
    const sections = [
      ...this.createCoverPage(report),
      ...this.createExecutiveSummary(report),
      ...this.createWcagTable(report),
      ...this.createDetailedFindings(report),
      ...this.createNotes(report),
    ];

    return new Document({
      creator: report.productInfo.evaluator,
      title: `ACR - ${report.productInfo.name}`,
      description: 'Accessibility Conformance Report (VPAT 2.4 Rev)',
      sections: [
        {
          properties: {},
          children: sections,
        },
      ],
    });
  }

  /**
   * Create cover page sections
   *
   * @param report - ACR report
   * @returns Array of paragraphs
   */
  private createCoverPage(report: ACRReport): Paragraph[] {
    return [
      new Paragraph({
        text: 'Accessibility Conformance Report',
        heading: HeadingLevel.TITLE,
        alignment: AlignmentType.CENTER,
        spacing: { after: 400 },
      }),
      new Paragraph({
        text: 'VPAT® Version 2.4 Rev',
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
      }),
      new Paragraph({
        text: report.productInfo.name,
        heading: HeadingLevel.HEADING_1,
        alignment: AlignmentType.CENTER,
        spacing: { after: 200 },
      }),
      new Paragraph({
        text: `Version ${report.productInfo.version}`,
        alignment: AlignmentType.CENTER,
        spacing: { after: 600 },
      }),
      new Paragraph({
        children: [
          new TextRun({ text: 'Product: ', bold: true }),
          new TextRun(report.productInfo.name),
        ],
        spacing: { after: 100 },
      }),
      new Paragraph({
        children: [
          new TextRun({ text: 'Version: ', bold: true }),
          new TextRun(report.productInfo.version),
        ],
        spacing: { after: 100 },
      }),
      new Paragraph({
        children: [
          new TextRun({ text: 'Vendor: ', bold: true }),
          new TextRun(report.productInfo.vendor),
        ],
        spacing: { after: 100 },
      }),
      new Paragraph({
        children: [
          new TextRun({ text: 'Evaluation Date: ', bold: true }),
          new TextRun(report.productInfo.evaluationDate),
        ],
        spacing: { after: 100 },
      }),
      new Paragraph({
        children: [
          new TextRun({ text: 'Evaluator: ', bold: true }),
          new TextRun(report.productInfo.evaluator),
        ],
        spacing: { after: 100 },
      }),
      new Paragraph({
        children: [
          new TextRun({ text: 'Report Generated: ', bold: true }),
          new TextRun(report.generatedAt.toLocaleString()),
        ],
        spacing: { after: 600 },
      }),
    ];
  }

  /**
   * Create executive summary section
   *
   * @param report - ACR report
   * @returns Array of paragraphs
   */
  private createExecutiveSummary(report: ACRReport): Paragraph[] {
    return [
      new Paragraph({
        text: 'Executive Summary',
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 200 },
        pageBreakBefore: true,
      }),
      new Paragraph({
        text: report.summary,
        spacing: { after: 400 },
      }),
      new Paragraph({
        text: 'Overall WCAG 2.1 Conformance',
        heading: HeadingLevel.HEADING_2,
        spacing: { after: 200 },
      }),
      new Paragraph({
        children: [
          new TextRun({ text: 'Level A: ', bold: true }),
          new TextRun(report.overallConformance.levelA),
        ],
        spacing: { after: 100 },
      }),
      new Paragraph({
        children: [
          new TextRun({ text: 'Level AA: ', bold: true }),
          new TextRun(report.overallConformance.levelAA),
        ],
        spacing: { after: 400 },
      }),
    ];
  }

  /**
   * Create WCAG conformance table
   *
   * @param report - ACR report
   * @returns Array of paragraphs and tables
   */
  private createWcagTable(report: ACRReport): Array<Paragraph | Table> {
    const elements: Array<Paragraph | Table> = [
      new Paragraph({
        text: 'WCAG 2.1 Conformance Details',
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 200 },
        pageBreakBefore: true,
      }),
    ];

    // Group by level
    const levelA = report.wcagResults.filter(r => r.level === 'A');
    const levelAA = report.wcagResults.filter(r => r.level === 'AA');

    if (levelA.length > 0) {
      elements.push(
        new Paragraph({
          text: 'Level A Criteria',
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 200 },
        }),
        this.createWcagResultsTable(levelA)
      );
    }

    if (levelAA.length > 0) {
      elements.push(
        new Paragraph({
          text: 'Level AA Criteria',
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 },
        }),
        this.createWcagResultsTable(levelAA)
      );
    }

    return elements;
  }

  /**
   * Create WCAG results table
   *
   * @param results - WCAG criterion results
   * @returns Table
   */
  private createWcagResultsTable(results: WcagCriterionResult[]): Table {
    const headerRow = new TableRow({
      tableHeader: true,
      children: [
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Criterion', bold: true })] })],
          width: { size: 15, type: WidthType.PERCENTAGE },
        }),
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Name', bold: true })] })],
          width: { size: 30, type: WidthType.PERCENTAGE },
        }),
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Conformance', bold: true })] })],
          width: { size: 20, type: WidthType.PERCENTAGE },
        }),
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Issues', bold: true })] })],
          width: { size: 10, type: WidthType.PERCENTAGE },
        }),
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Remarks', bold: true })] })],
          width: { size: 25, type: WidthType.PERCENTAGE },
        }),
      ],
    });

    const dataRows = results.map(result => {
      const colors = CONFORMANCE_COLORS[result.conformance];

      return new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph(result.criterion)],
          }),
          new TableCell({
            children: [new Paragraph(result.name)],
          }),
          new TableCell({
            children: [new Paragraph(result.conformance)],
            shading: {
              type: ShadingType.CLEAR,
              fill: colors.fill,
            },
          }),
          new TableCell({
            children: [new Paragraph(result.issueCount.toString())],
          }),
          new TableCell({
            children: [new Paragraph(result.remarks)],
          }),
        ],
      });
    });

    return new Table({
      rows: [headerRow, ...dataRows],
      width: { size: 100, type: WidthType.PERCENTAGE },
      borders: {
        top: { style: BorderStyle.SINGLE, size: 1 },
        bottom: { style: BorderStyle.SINGLE, size: 1 },
        left: { style: BorderStyle.SINGLE, size: 1 },
        right: { style: BorderStyle.SINGLE, size: 1 },
        insideHorizontal: { style: BorderStyle.SINGLE, size: 1 },
        insideVertical: { style: BorderStyle.SINGLE, size: 1 },
      },
    });
  }

  /**
   * Create detailed findings section
   *
   * @param report - ACR report
   * @returns Array of paragraphs
   */
  private createDetailedFindings(report: ACRReport): Paragraph[] {
    const paragraphs: Paragraph[] = [
      new Paragraph({
        text: 'Detailed Findings',
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 200 },
        pageBreakBefore: true,
      }),
    ];

    // Group results by conformance level
    const doesNotSupport = report.wcagResults.filter(r => r.conformance === 'Does Not Support');
    const partiallySupports = report.wcagResults.filter(r => r.conformance === 'Partially Supports');

    if (doesNotSupport.length > 0) {
      paragraphs.push(
        new Paragraph({
          text: 'Critical Issues (Does Not Support)',
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 200 },
        })
      );

      for (const result of doesNotSupport) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({ text: `${result.criterion} ${result.name}: `, bold: true }),
              new TextRun(result.remarks),
            ],
            spacing: { after: 200 },
          })
        );
      }
    }

    if (partiallySupports.length > 0) {
      paragraphs.push(
        new Paragraph({
          text: 'Minor Issues (Partially Supports)',
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 400, after: 200 },
        })
      );

      for (const result of partiallySupports) {
        paragraphs.push(
          new Paragraph({
            children: [
              new TextRun({ text: `${result.criterion} ${result.name}: `, bold: true }),
              new TextRun(result.remarks),
            ],
            spacing: { after: 200 },
          })
        );
      }
    }

    return paragraphs;
  }

  /**
   * Create notes section
   *
   * @param report - ACR report
   * @returns Array of paragraphs
   */
  private createNotes(report: ACRReport): Paragraph[] {
    const paragraphs: Paragraph[] = [
      new Paragraph({
        text: 'Notes',
        heading: HeadingLevel.HEADING_1,
        spacing: { before: 400, after: 200 },
        pageBreakBefore: true,
      }),
    ];

    for (const note of report.notes) {
      paragraphs.push(
        new Paragraph({
          text: `• ${note}`,
          spacing: { after: 100 },
        })
      );
    }

    return paragraphs;
  }

  /**
   * Create HTML document from ACR report
   *
   * @param report - ACR report
   * @returns HTML string
   */
  private createHtmlDocument(report: ACRReport): string {
    const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ACR - ${this.escapeHtml(report.productInfo.name)}</title>
  <style>
    ${this.getHtmlStyles()}
  </style>
</head>
<body>
  <div class="container">
    ${this.createHtmlCoverPage(report)}
    ${this.createHtmlExecutiveSummary(report)}
    ${this.createHtmlWcagTable(report)}
    ${this.createHtmlDetailedFindings(report)}
    ${this.createHtmlNotes(report)}
  </div>
</body>
</html>
    `.trim();

    return html;
  }

  /**
   * Get HTML styles
   *
   * @returns CSS string
   */
  private getHtmlStyles(): string {
    return `
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; background: #f5f5f5; }
      .container { max-width: 1200px; margin: 0 auto; background: white; padding: 40px; }
      h1 { font-size: 32px; margin: 30px 0 20px; color: #2c3e50; page-break-before: always; }
      h1:first-child { page-break-before: auto; }
      h2 { font-size: 24px; margin: 25px 0 15px; color: #34495e; }
      p { margin: 10px 0; }
      .cover { text-align: center; padding: 60px 0; }
      .cover h1 { font-size: 42px; margin-bottom: 10px; }
      .cover .subtitle { font-size: 18px; color: #7f8c8d; margin-bottom: 40px; }
      .info-row { display: flex; justify-content: space-between; margin: 8px 0; }
      .info-label { font-weight: bold; }
      table { width: 100%; border-collapse: collapse; margin: 20px 0; }
      th, td { padding: 12px; text-align: left; border: 1px solid #ddd; }
      th { background: #34495e; color: white; font-weight: bold; }
      tr:nth-child(even) { background: #f9f9f9; }
      .conformance-supports { background: #90EE90; color: #006400; }
      .conformance-partial { background: #FFD700; color: #8B4513; }
      .conformance-does-not { background: #FFB6C1; color: #8B0000; }
      .conformance-na { background: #D3D3D3; color: #696969; }
      .notes ul { list-style-type: disc; margin-left: 30px; }
      .notes li { margin: 8px 0; }
      @media print {
        body { background: white; }
        .container { padding: 20px; }
        h1 { page-break-after: avoid; }
        table { page-break-inside: avoid; }
      }
    `;
  }

  /**
   * Create HTML cover page
   *
   * @param report - ACR report
   * @returns HTML string
   */
  private createHtmlCoverPage(report: ACRReport): string {
    return `
      <div class="cover">
        <h1>Accessibility Conformance Report</h1>
        <p class="subtitle">VPAT® Version 2.4 Rev</p>
        <h2>${this.escapeHtml(report.productInfo.name)}</h2>
        <p>Version ${this.escapeHtml(report.productInfo.version)}</p>
      </div>
      <div class="info-section">
        <div class="info-row">
          <span class="info-label">Product:</span>
          <span>${this.escapeHtml(report.productInfo.name)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Version:</span>
          <span>${this.escapeHtml(report.productInfo.version)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Vendor:</span>
          <span>${this.escapeHtml(report.productInfo.vendor)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Evaluation Date:</span>
          <span>${this.escapeHtml(report.productInfo.evaluationDate)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Evaluator:</span>
          <span>${this.escapeHtml(report.productInfo.evaluator)}</span>
        </div>
        <div class="info-row">
          <span class="info-label">Report Generated:</span>
          <span>${this.escapeHtml(report.generatedAt.toLocaleString())}</span>
        </div>
      </div>
    `;
  }

  /**
   * Create HTML executive summary
   *
   * @param report - ACR report
   * @returns HTML string
   */
  private createHtmlExecutiveSummary(report: ACRReport): string {
    return `
      <h1>Executive Summary</h1>
      <p>${this.escapeHtml(report.summary)}</p>
      <h2>Overall WCAG 2.1 Conformance</h2>
      <p><strong>Level A:</strong> ${this.escapeHtml(report.overallConformance.levelA)}</p>
      <p><strong>Level AA:</strong> ${this.escapeHtml(report.overallConformance.levelAA)}</p>
    `;
  }

  /**
   * Create HTML WCAG table
   *
   * @param report - ACR report
   * @returns HTML string
   */
  private createHtmlWcagTable(report: ACRReport): string {
    const levelA = report.wcagResults.filter(r => r.level === 'A');
    const levelAA = report.wcagResults.filter(r => r.level === 'AA');

    let html = '<h1>WCAG 2.1 Conformance Details</h1>';

    if (levelA.length > 0) {
      html += '<h2>Level A Criteria</h2>';
      html += this.createHtmlResultsTable(levelA);
    }

    if (levelAA.length > 0) {
      html += '<h2>Level AA Criteria</h2>';
      html += this.createHtmlResultsTable(levelAA);
    }

    return html;
  }

  /**
   * Create HTML results table
   *
   * @param results - WCAG criterion results
   * @returns HTML string
   */
  private createHtmlResultsTable(results: WcagCriterionResult[]): string {
    const rows = results.map(result => {
      // Map conformance value to CSS class
      const conformanceClassMap: Record<string, string> = {
        'Supports': 'supports',
        'Partially Supports': 'partial',
        'Does Not Support': 'does-not',
        'Not Applicable': 'na',
      };
      const conformanceClass = conformanceClassMap[result.conformance] || 'supports';

      return `
        <tr>
          <td>${this.escapeHtml(result.criterion)}</td>
          <td>${this.escapeHtml(result.name)}</td>
          <td class="conformance-${conformanceClass}">
            ${this.escapeHtml(result.conformance)}
          </td>
          <td>${result.issueCount}</td>
          <td>${this.escapeHtml(result.remarks)}</td>
        </tr>
      `;
    }).join('');

    return `
      <table>
        <thead>
          <tr>
            <th>Criterion</th>
            <th>Name</th>
            <th>Conformance</th>
            <th>Issues</th>
            <th>Remarks</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `;
  }

  /**
   * Create HTML detailed findings
   *
   * @param report - ACR report
   * @returns HTML string
   */
  private createHtmlDetailedFindings(report: ACRReport): string {
    const doesNotSupport = report.wcagResults.filter(r => r.conformance === 'Does Not Support');
    const partiallySupports = report.wcagResults.filter(r => r.conformance === 'Partially Supports');

    let html = '<h1>Detailed Findings</h1>';

    if (doesNotSupport.length > 0) {
      html += '<h2>Critical Issues (Does Not Support)</h2>';
      for (const result of doesNotSupport) {
        html += `<p><strong>${this.escapeHtml(result.criterion)} ${this.escapeHtml(result.name)}:</strong> ${this.escapeHtml(result.remarks)}</p>`;
      }
    }

    if (partiallySupports.length > 0) {
      html += '<h2>Minor Issues (Partially Supports)</h2>';
      for (const result of partiallySupports) {
        html += `<p><strong>${this.escapeHtml(result.criterion)} ${this.escapeHtml(result.name)}:</strong> ${this.escapeHtml(result.remarks)}</p>`;
      }
    }

    return html;
  }

  /**
   * Create HTML notes section
   *
   * @param report - ACR report
   * @returns HTML string
   */
  private createHtmlNotes(report: ACRReport): string {
    const notesList = report.notes
      .map(note => `<li>${this.escapeHtml(note)}</li>`)
      .join('');

    return `
      <h1>Notes</h1>
      <div class="notes">
        <ul>
          ${notesList}
        </ul>
      </div>
    `;
  }

  /**
   * Escape HTML special characters
   *
   * @param text - Text to escape
   * @returns Escaped text
   */
  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, m => map[m]);
  }
}

export const pdfAcrExportService = new PdfAcrExportService();
