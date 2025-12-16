import { v4 as uuidv4 } from 'uuid';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
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
  Header,
  Footer,
  PageNumber
} from 'docx';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AcrDocument } from './acr-generator.service';
import { TOOL_VERSION } from './attribution.service';

export type ExportFormat = 'docx' | 'pdf' | 'html';

export interface BrandingOptions {
  companyName?: string;
  logoUrl?: string;
  primaryColor?: string;
  footerText?: string;
}

export interface ExportOptions {
  format: ExportFormat;
  includeMethodology: boolean;
  includeAttribution: boolean;
  branding?: BrandingOptions;
}

export interface ExportResult {
  downloadUrl: string;
  expiresAt: Date;
  filename: string;
  format: ExportFormat;
  size: number;
}

const EXPORTS_DIR = path.join(process.cwd(), 'exports');

async function ensureExportsDir(): Promise<void> {
  try {
    await fs.access(EXPORTS_DIR);
  } catch {
    await fs.mkdir(EXPORTS_DIR, { recursive: true });
  }
}

function formatConformanceLevel(level: string): string {
  return level || 'Not Evaluated';
}

async function exportToDocx(
  acr: AcrDocument,
  options: ExportOptions
): Promise<Buffer> {
  const tableRows: TableRow[] = [
    new TableRow({
      tableHeader: true,
      children: [
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Criteria', bold: true })] })],
          width: { size: 20, type: WidthType.PERCENTAGE }
        }),
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Conformance Level', bold: true })] })],
          width: { size: 20, type: WidthType.PERCENTAGE }
        }),
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Remarks and Explanations', bold: true })] })],
          width: { size: 60, type: WidthType.PERCENTAGE }
        })
      ]
    })
  ];

  for (const criterion of acr.criteria) {
    const remarksText = options.includeAttribution && criterion.attributedRemarks
      ? criterion.attributedRemarks
      : criterion.remarks || '';

    tableRows.push(
      new TableRow({
        children: [
          new TableCell({
            children: [new Paragraph({ text: `${criterion.id}: ${criterion.name}` })]
          }),
          new TableCell({
            children: [new Paragraph({ text: formatConformanceLevel(criterion.conformanceLevel) })]
          }),
          new TableCell({
            children: [new Paragraph({ text: remarksText })]
          })
        ]
      })
    );
  }

  const sections: Paragraph[] = [
    new Paragraph({
      text: 'Voluntary Product Accessibility Template (VPAT)',
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER
    }),
    new Paragraph({
      text: `Version 2.5 - ${acr.edition}`,
      alignment: AlignmentType.CENTER
    }),
    new Paragraph({ text: '' }),
    new Paragraph({
      text: 'Product Information',
      heading: HeadingLevel.HEADING_1
    }),
    new Paragraph({ text: `Name: ${acr.productInfo.name}` }),
    new Paragraph({ text: `Version: ${acr.productInfo.version}` }),
    new Paragraph({ text: `Vendor: ${acr.productInfo.vendor}` }),
    new Paragraph({ text: `Contact: ${acr.productInfo.contactEmail}` }),
    new Paragraph({ text: `Evaluation Date: ${acr.productInfo.evaluationDate.toISOString().split('T')[0]}` }),
    new Paragraph({ text: '' }),
    new Paragraph({
      text: 'Evaluation Methods',
      heading: HeadingLevel.HEADING_1
    })
  ];

  for (const method of acr.evaluationMethods) {
    sections.push(new Paragraph({ text: `• ${method}` }));
  }

  sections.push(new Paragraph({ text: '' }));
  sections.push(new Paragraph({
    text: 'Accessibility Conformance Report',
    heading: HeadingLevel.HEADING_1
  }));

  const table = new Table({
    rows: tableRows,
    width: { size: 100, type: WidthType.PERCENTAGE }
  });

  const docChildren: (Paragraph | Table)[] = [...sections, table];

  if (options.includeMethodology && acr.methodology) {
    docChildren.push(new Paragraph({ text: '' }));
    docChildren.push(new Paragraph({
      text: 'Assessment Methodology',
      heading: HeadingLevel.HEADING_1
    }));
    docChildren.push(new Paragraph({ text: `Tool Version: ${acr.methodology.toolVersion}` }));
    docChildren.push(new Paragraph({ text: `AI Model: ${acr.methodology.aiModelInfo}` }));
    docChildren.push(new Paragraph({ text: `Assessment Date: ${acr.methodology.assessmentDate.toISOString().split('T')[0]}` }));
  }

  if (acr.footerDisclaimer) {
    docChildren.push(new Paragraph({ text: '' }));
    docChildren.push(new Paragraph({
      text: 'Legal Disclaimer',
      heading: HeadingLevel.HEADING_2
    }));
    docChildren.push(new Paragraph({ text: acr.footerDisclaimer }));
  }

  const doc = new Document({
    sections: [{
      properties: {},
      headers: {
        default: new Header({
          children: [
            new Paragraph({
              children: [
                new TextRun({ text: options.branding?.companyName || 'Accessibility Conformance Report' })
              ],
              alignment: AlignmentType.RIGHT
            })
          ]
        })
      },
      footers: {
        default: new Footer({
          children: [
            new Paragraph({
              children: [
                new TextRun({ text: options.branding?.footerText || `Generated by ${TOOL_VERSION}` }),
                new TextRun({ text: ' | Page ' }),
                new TextRun({ children: [PageNumber.CURRENT] }),
                new TextRun({ text: ' of ' }),
                new TextRun({ children: [PageNumber.TOTAL_PAGES] })
              ],
              alignment: AlignmentType.CENTER
            })
          ]
        })
      },
      children: docChildren
    }]
  });

  return await Packer.toBuffer(doc);
}

async function exportToPdf(
  acr: AcrDocument,
  options: ExportOptions
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  
  pdfDoc.setTitle(`Accessibility Conformance Report - ${acr.productInfo.name}`);
  pdfDoc.setAuthor(acr.productInfo.vendor);
  pdfDoc.setSubject(`VPAT 2.5 ${acr.edition} Edition`);
  pdfDoc.setCreator(TOOL_VERSION);
  pdfDoc.setProducer('Ninja Platform');
  pdfDoc.setKeywords(['accessibility', 'VPAT', 'WCAG', 'Section 508', 'ACR']);
  pdfDoc.setLanguage('en-US');

  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let page = pdfDoc.addPage([612, 792]);
  const { width, height } = page.getSize();
  let yPosition = height - 50;
  const margin = 50;
  const lineHeight = 14;

  page.drawText('Voluntary Product Accessibility Template (VPAT)', {
    x: margin,
    y: yPosition,
    size: 16,
    font: helveticaBold,
    color: rgb(0, 0, 0)
  });
  yPosition -= 25;

  page.drawText(`Version 2.5 - ${acr.edition}`, {
    x: margin,
    y: yPosition,
    size: 12,
    font: helvetica,
    color: rgb(0.3, 0.3, 0.3)
  });
  yPosition -= 35;

  page.drawText('Product Information', {
    x: margin,
    y: yPosition,
    size: 14,
    font: helveticaBold
  });
  yPosition -= 20;

  const productInfo = [
    `Name: ${acr.productInfo.name}`,
    `Version: ${acr.productInfo.version}`,
    `Vendor: ${acr.productInfo.vendor}`,
    `Contact: ${acr.productInfo.contactEmail}`,
    `Evaluation Date: ${acr.productInfo.evaluationDate.toISOString().split('T')[0]}`
  ];

  for (const info of productInfo) {
    page.drawText(info, { x: margin, y: yPosition, size: 10, font: helvetica });
    yPosition -= lineHeight;
  }
  yPosition -= 20;

  page.drawText('Accessibility Conformance Report', {
    x: margin,
    y: yPosition,
    size: 14,
    font: helveticaBold
  });
  yPosition -= 20;

  const colWidths = [120, 90, width - margin * 2 - 210];
  
  page.drawText('Criterion', { x: margin, y: yPosition, size: 10, font: helveticaBold });
  page.drawText('Level', { x: margin + colWidths[0], y: yPosition, size: 10, font: helveticaBold });
  page.drawText('Remarks', { x: margin + colWidths[0] + colWidths[1], y: yPosition, size: 10, font: helveticaBold });
  yPosition -= 5;
  
  page.drawLine({
    start: { x: margin, y: yPosition },
    end: { x: width - margin, y: yPosition },
    thickness: 1,
    color: rgb(0.7, 0.7, 0.7)
  });
  yPosition -= lineHeight;

  for (const criterion of acr.criteria) {
    if (yPosition < 80) {
      page = pdfDoc.addPage([612, 792]);
      yPosition = height - 50;
    }

    const criterionText = `${criterion.id}`.substring(0, 15);
    const levelText = formatConformanceLevel(criterion.conformanceLevel).substring(0, 12);
    const remarksText = (options.includeAttribution && criterion.attributedRemarks
      ? criterion.attributedRemarks
      : criterion.remarks || '').substring(0, 70);

    page.drawText(criterionText, { x: margin, y: yPosition, size: 8, font: helvetica });
    page.drawText(levelText, { x: margin + colWidths[0], y: yPosition, size: 8, font: helvetica });
    page.drawText(remarksText, { x: margin + colWidths[0] + colWidths[1], y: yPosition, size: 7, font: helvetica });
    yPosition -= lineHeight;
  }

  if (options.includeMethodology && acr.methodology) {
    if (yPosition < 150) {
      page = pdfDoc.addPage([612, 792]);
      yPosition = height - 50;
    }
    yPosition -= 20;
    page.drawText('Assessment Methodology', { x: margin, y: yPosition, size: 14, font: helveticaBold });
    yPosition -= 20;
    page.drawText(`Tool: ${acr.methodology.toolVersion}`, { x: margin, y: yPosition, size: 10, font: helvetica });
    yPosition -= lineHeight;
    page.drawText(`AI Model: ${acr.methodology.aiModelInfo}`, { x: margin, y: yPosition, size: 10, font: helvetica });
    yPosition -= lineHeight;
  }

  if (yPosition < 200) {
    page = pdfDoc.addPage([612, 792]);
    yPosition = height - 50;
  }
  yPosition -= 30;
  page.drawText('Digital Signature', { x: margin, y: yPosition, size: 12, font: helveticaBold });
  yPosition -= 20;
  page.drawText('Authorized Representative: _________________________________', { x: margin, y: yPosition, size: 10, font: helvetica });
  yPosition -= 20;
  page.drawText('Date: _________________', { x: margin, y: yPosition, size: 10, font: helvetica });
  yPosition -= 20;
  page.drawText('Title: _________________', { x: margin, y: yPosition, size: 10, font: helvetica });
  yPosition -= 30;

  if (acr.footerDisclaimer) {
    if (yPosition < 120) {
      page = pdfDoc.addPage([612, 792]);
      yPosition = height - 50;
    }
    page.drawText('Legal Disclaimer', { x: margin, y: yPosition, size: 12, font: helveticaBold });
    yPosition -= 15;
    
    const disclaimerLines = acr.footerDisclaimer.split('\n');
    for (const line of disclaimerLines) {
      if (yPosition < 30) {
        page = pdfDoc.addPage([612, 792]);
        yPosition = height - 50;
      }
      page.drawText(line.substring(0, 100), { x: margin, y: yPosition, size: 8, font: helvetica, color: rgb(0.4, 0.4, 0.4) });
      yPosition -= 10;
    }
  }

  return Buffer.from(await pdfDoc.save());
}

function exportToHtml(
  acr: AcrDocument,
  options: ExportOptions
): string {
  const brandColor = options.branding?.primaryColor || '#2563eb';
  const companyName = options.branding?.companyName || 'Accessibility Report';

  let criteriaRows = '';
  for (const criterion of acr.criteria) {
    const remarksText = options.includeAttribution && criterion.attributedRemarks
      ? criterion.attributedRemarks
      : criterion.remarks || '';
    
    const escapedRemarks = remarksText
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/\[AUTOMATED\]/g, '<span class="tag automated">[AUTOMATED]</span>')
      .replace(/\[AI-SUGGESTED\]/g, '<span class="tag ai-suggested">[AI-SUGGESTED]</span>')
      .replace(/\[HUMAN-VERIFIED\]/g, '<span class="tag human-verified">[HUMAN-VERIFIED]</span>');

    criteriaRows += `
      <tr>
        <td><strong>${criterion.id}</strong><br><small>${criterion.name}</small></td>
        <td class="level-${criterion.conformanceLevel?.toLowerCase().replace(/\s+/g, '-') || 'unknown'}">${formatConformanceLevel(criterion.conformanceLevel)}</td>
        <td>${escapedRemarks}</td>
      </tr>`;
  }

  let methodologySection = '';
  if (options.includeMethodology && acr.methodology) {
    methodologySection = `
    <section class="methodology">
      <h2>Assessment Methodology</h2>
      <dl>
        <dt>Tool Version</dt>
        <dd>${acr.methodology.toolVersion}</dd>
        <dt>AI Model</dt>
        <dd>${acr.methodology.aiModelInfo}</dd>
        <dt>Assessment Date</dt>
        <dd>${acr.methodology.assessmentDate.toISOString().split('T')[0]}</dd>
      </dl>
    </section>`;
  }

  let disclaimerSection = '';
  if (acr.footerDisclaimer) {
    disclaimerSection = `
    <footer class="disclaimer">
      <h3>Legal Disclaimer</h3>
      <p>${acr.footerDisclaimer.replace(/\n/g, '<br>')}</p>
    </footer>`;
  }

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Accessibility Conformance Report - ${acr.productInfo.name}</title>
  <style>
    :root { --primary: ${brandColor}; }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; max-width: 1200px; margin: 0 auto; padding: 2rem; }
    header { border-bottom: 3px solid var(--primary); padding-bottom: 1rem; margin-bottom: 2rem; }
    h1 { color: var(--primary); font-size: 1.75rem; }
    h2 { color: var(--primary); margin: 2rem 0 1rem; border-bottom: 1px solid #ddd; padding-bottom: 0.5rem; }
    .product-info { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; background: #f8f9fa; padding: 1.5rem; border-radius: 8px; margin-bottom: 2rem; }
    .product-info dt { font-weight: 600; color: #666; font-size: 0.875rem; }
    .product-info dd { margin: 0 0 0.5rem; }
    table { width: 100%; border-collapse: collapse; margin: 1rem 0; }
    th, td { border: 1px solid #ddd; padding: 0.75rem; text-align: left; vertical-align: top; }
    th { background: var(--primary); color: white; font-weight: 600; }
    tr:nth-child(even) { background: #f8f9fa; }
    .tag { display: inline-block; padding: 0.125rem 0.5rem; border-radius: 4px; font-size: 0.75rem; font-weight: 600; margin-right: 0.25rem; }
    .tag.automated { background: #e0e7ff; color: #3730a3; }
    .tag.ai-suggested { background: #fef3c7; color: #92400e; }
    .tag.human-verified { background: #d1fae5; color: #065f46; }
    .level-supports { color: #065f46; }
    .level-partially-supports { color: #92400e; }
    .level-does-not-support { color: #dc2626; }
    .level-not-applicable { color: #6b7280; }
    .methodology { background: #f0f9ff; padding: 1.5rem; border-radius: 8px; margin: 2rem 0; }
    .methodology dl { display: grid; grid-template-columns: auto 1fr; gap: 0.5rem 1rem; }
    .methodology dt { font-weight: 600; }
    .disclaimer { margin-top: 3rem; padding: 1.5rem; background: #fefce8; border: 1px solid #fef08a; border-radius: 8px; font-size: 0.875rem; color: #713f12; }
    .disclaimer h3 { margin-bottom: 0.5rem; }
    @media print { body { max-width: none; } .no-print { display: none; } }
  </style>
</head>
<body>
  <header>
    <h1>Voluntary Product Accessibility Template (VPAT)</h1>
    <p>Version 2.5 - ${acr.edition} | ${companyName}</p>
  </header>

  <section>
    <h2>Product Information</h2>
    <dl class="product-info">
      <div><dt>Product Name</dt><dd>${acr.productInfo.name}</dd></div>
      <div><dt>Version</dt><dd>${acr.productInfo.version}</dd></div>
      <div><dt>Vendor</dt><dd>${acr.productInfo.vendor}</dd></div>
      <div><dt>Contact</dt><dd>${acr.productInfo.contactEmail}</dd></div>
      <div><dt>Evaluation Date</dt><dd>${acr.productInfo.evaluationDate.toISOString().split('T')[0]}</dd></div>
    </dl>
  </section>

  <section>
    <h2>Accessibility Conformance Report</h2>
    <table>
      <thead>
        <tr>
          <th style="width: 25%">Criteria</th>
          <th style="width: 15%">Conformance Level</th>
          <th style="width: 60%">Remarks and Explanations</th>
        </tr>
      </thead>
      <tbody>
        ${criteriaRows}
      </tbody>
    </table>
  </section>

  ${methodologySection}
  ${disclaimerSection}
</body>
</html>`;
}

async function exportAcr(
  acr: AcrDocument,
  options: ExportOptions
): Promise<ExportResult> {
  await ensureExportsDir();

  const fileId = uuidv4();
  const timestamp = new Date().toISOString().split('T')[0];
  const productSlug = acr.productInfo.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').substring(0, 30);
  
  let buffer: Buffer;
  let extension: string;

  switch (options.format) {
    case 'docx':
      buffer = await exportToDocx(acr, options);
      extension = 'docx';
      break;
    case 'pdf':
      buffer = await exportToPdf(acr, options);
      extension = 'pdf';
      break;
    case 'html':
      buffer = Buffer.from(exportToHtml(acr, options), 'utf-8');
      extension = 'html';
      break;
    default:
      throw new Error(`Unsupported export format: ${options.format}`);
  }

  const filename = `acr-${productSlug}-${timestamp}-${fileId.substring(0, 8)}.${extension}`;
  const filepath = path.join(EXPORTS_DIR, filename);

  await fs.writeFile(filepath, buffer);

  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24);

  return {
    downloadUrl: `/api/v1/exports/${filename}`,
    expiresAt,
    filename,
    format: options.format,
    size: buffer.length
  };
}

export const acrExporterService = {
  exportAcr,
  exportToDocx,
  exportToPdf,
  exportToHtml
};

export { exportAcr };
