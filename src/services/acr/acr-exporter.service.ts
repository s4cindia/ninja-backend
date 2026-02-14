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
  AlignmentType
} from 'docx';
import * as fs from 'fs/promises';
import * as path from 'path';
import { AcrDocument } from './acr-generator.service';

export type ExportFormat = 'docx' | 'pdf' | 'html';

export interface BrandingOptions {
  companyName?: string;
  logoUrl?: string;
  primaryColor?: string;
  footerText?: string;
}

export interface ProductInfo {
  vendorName?: string;
  contactEmail?: string;
}

export interface ExportOptions {
  format: ExportFormat;
  includeMethodology: boolean;
  includeAttribution: boolean;
  productInfo?: ProductInfo;
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

function formatEdition(edition: string, preserveExact: boolean = false): string {
  // If preserveExact is true, return the edition string exactly as provided
  if (preserveExact) {
    return edition;
  }
  
  // For backwards compatibility, transform canonical codes to display format
  const editionMap: Record<string, string> = {
    'VPAT2.5-INT': 'VPAT 2.5 INT',
    'VPAT2.5-508': 'VPAT 2.5 Section 508',
    'VPAT2.5-WCAG': 'VPAT 2.5 WCAG',
    'VPAT2.5-EU': 'VPAT 2.5 EU',
    'section508': 'VPAT 2.5 Section 508',
    'WCAG': 'VPAT 2.5 WCAG',
    'EU': 'VPAT 2.5 EU',
    'INT': 'VPAT 2.5 INT',
    'wcag': 'VPAT 2.5 WCAG',
    'eu': 'VPAT 2.5 EU',
    'int': 'VPAT 2.5 INT',
    'international': 'VPAT 2.5 INT',
    '508': 'VPAT 2.5 Section 508',
  };
  
  // Check direct mapping
  if (editionMap[edition]) {
    return editionMap[edition];
  }
  
  // If it already looks like a display format (contains "VPAT"), return as-is
  if (edition.toLowerCase().includes('vpat')) {
    return edition;
  }
  
  return `VPAT 2.5 ${edition}`;
}

function formatEvaluationMethod(method: { type: string; description?: string }): string {
  const typeMap: Record<string, string> = {
    'hybrid': 'Hybrid',
    'automated': 'Automated',
    'manual': 'Manual'
  };
  const formattedType = typeMap[method.type] || method.type.charAt(0).toUpperCase() + method.type.slice(1);
  const description = method.description || 'Human verification and AI-assisted analysis';
  return `${formattedType}: ${description}`;
}

function wrapText(text: string, maxWidth: number, fontSize: number): string[] {
  const avgCharWidth = fontSize * 0.5;
  const charsPerLine = Math.floor(maxWidth / avgCharWidth);
  const lines: string[] = [];
  
  // Normalize line breaks and collapse multiple spaces
  const normalizedText = text
    .replace(/\r\n/g, '\n')
    .replace(/\n+/g, '\n')
    .trim();
  
  // Split by paragraphs (double newline or single newline followed by specific content)
  const paragraphs = normalizedText.split(/\n\s*\n|\n(?=Assessment Tool:|AI Model:)/);
  
  for (const paragraph of paragraphs) {
    // Normalize whitespace within paragraph
    const cleanParagraph = paragraph.replace(/\s+/g, ' ').trim();
    if (!cleanParagraph) continue;
    
    const words = cleanParagraph.split(' ');
    let currentLine = '';

    for (const word of words) {
      if (currentLine.length + word.length + 1 <= charsPerLine) {
        currentLine += (currentLine ? ' ' : '') + word;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }
    if (currentLine) lines.push(currentLine);
    
    // Add blank line between paragraphs
    lines.push('');
  }
  
  // Remove trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1] === '') {
    lines.pop();
  }
  
  return lines.length > 0 ? lines : [''];
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
          width: { size: 2500, type: WidthType.DXA }
        }),
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Conformance Level', bold: true })] })],
          width: { size: 1500, type: WidthType.DXA }
        }),
        new TableCell({
          children: [new Paragraph({ children: [new TextRun({ text: 'Remarks and Explanations', bold: true })] })],
          width: { size: 5000, type: WidthType.DXA }
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
            children: [
              new Paragraph({ children: [new TextRun({ text: criterion.id, bold: true })] }),
              new Paragraph({ children: [new TextRun({ text: criterion.name })] })
            ]
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: formatConformanceLevel(criterion.conformanceLevel) })] })]
          }),
          new TableCell({
            children: [new Paragraph({ children: [new TextRun({ text: remarksText })] })]
          })
        ]
      })
    );
  }

  // Use exact edition string if it already looks like a display format
  const editionDisplayDocx = formatEdition(acr.edition, acr.edition.toLowerCase().includes('vpat'));
  
  const children: (Paragraph | Table)[] = [
    new Paragraph({
      children: [new TextRun({ text: `Accessibility Conformance Report`, bold: true, size: 48 })],
      heading: HeadingLevel.TITLE,
      alignment: AlignmentType.CENTER
    }),
    new Paragraph({
      children: [new TextRun({ text: acr.productInfo.name, bold: true, size: 36 })],
      alignment: AlignmentType.CENTER
    }),
    new Paragraph({
      children: [new TextRun({ text: editionDisplayDocx })],
      alignment: AlignmentType.CENTER
    }),
    new Paragraph({ children: [] }),
    new Paragraph({
      children: [new TextRun({ text: 'Product Information', bold: true, size: 28 })],
      heading: HeadingLevel.HEADING_1
    }),
    new Paragraph({ children: [new TextRun({ text: 'Product Name: ', bold: true }), new TextRun({ text: acr.productInfo.name })] }),
    new Paragraph({ children: [new TextRun({ text: 'Version: ', bold: true }), new TextRun({ text: acr.productInfo.version })] }),
    new Paragraph({ children: [new TextRun({ text: 'Vendor: ', bold: true }), new TextRun({ text: acr.productInfo.vendor })] }),
    new Paragraph({ children: [new TextRun({ text: 'Contact: ', bold: true }), new TextRun({ text: acr.productInfo.contactEmail })] }),
    new Paragraph({ children: [new TextRun({ text: 'Evaluation Date: ', bold: true }), new TextRun({ text: acr.productInfo.evaluationDate.toISOString().split('T')[0] })] }),
    new Paragraph({ children: [] })
  ];
  
  // Add Products Evaluated section for batch ACRs (DOCX)
  const batchInfoDocx = (acr as unknown as Record<string, unknown>).batchInfo as any;
  if (batchInfoDocx && batchInfoDocx.documentList && Array.isArray(batchInfoDocx.documentList) && batchInfoDocx.documentList.length > 0) {
    children.push(new Paragraph({
      children: [new TextRun({ text: 'Products Evaluated', bold: true, size: 28 })],
      heading: HeadingLevel.HEADING_1
    }));

    for (let i = 0; i < batchInfoDocx.documentList.length; i++) {
      const doc = batchInfoDocx.documentList[i];
      const fileText = `${i + 1}. ${doc.fileName}`;
      children.push(new Paragraph({ children: [new TextRun({ text: fileText })] }));
      
      if (doc.status || doc.issuesFound !== undefined) {
        const detailParts = [];
        if (doc.status) detailParts.push(`Status: ${doc.status}`);
        if (doc.issuesFound !== undefined) detailParts.push(`Issues: ${doc.issuesFound}`);
        if (doc.score) detailParts.push(`Score: ${doc.score}`);
        const detailText = detailParts.join(' | ');
        children.push(new Paragraph({ children: [new TextRun({ text: `   ${detailText}`, italics: true, size: 18 })] }));
      }
    }
    children.push(new Paragraph({ children: [] }));
  }
  
  children.push(new Paragraph({
    children: [new TextRun({ text: 'Evaluation Methods', bold: true, size: 28 })],
    heading: HeadingLevel.HEADING_1
  }));

  for (const method of acr.evaluationMethods) {
    const methodText = typeof method === 'string' ? method : formatEvaluationMethod(method);
    children.push(new Paragraph({ children: [new TextRun({ text: `• ${methodText}` })] }));
  }

  children.push(new Paragraph({ children: [] }));
  children.push(new Paragraph({
    children: [new TextRun({ text: 'Accessibility Conformance Report', bold: true, size: 28 })],
    heading: HeadingLevel.HEADING_1
  }));
  children.push(new Table({ 
    rows: tableRows,
    width: { size: 100, type: WidthType.PERCENTAGE }
  }));

  if (options.includeMethodology && acr.methodology) {
    children.push(new Paragraph({ children: [] }));
    children.push(new Paragraph({
      children: [new TextRun({ text: 'Assessment Methodology', bold: true, size: 28 })],
      heading: HeadingLevel.HEADING_1
    }));
    children.push(new Paragraph({ children: [new TextRun({ text: 'Tool Version: ', bold: true }), new TextRun({ text: acr.methodology.toolVersion })] }));
    children.push(new Paragraph({ children: [new TextRun({ text: 'AI Model: ', bold: true }), new TextRun({ text: acr.methodology.aiModelInfo })] }));
    children.push(new Paragraph({ children: [new TextRun({ text: 'Assessment Date: ', bold: true }), new TextRun({ text: acr.methodology.assessmentDate.toISOString().split('T')[0] })] }));
  }

  if (acr.footerDisclaimer) {
    children.push(new Paragraph({ children: [] }));
    children.push(new Paragraph({
      children: [new TextRun({ text: 'Legal Disclaimer', bold: true, size: 24 })],
      heading: HeadingLevel.HEADING_2
    }));
    children.push(new Paragraph({ children: [new TextRun({ text: acr.footerDisclaimer, italics: true })] }));
  }

  const doc = new Document({
    sections: [{
      children: children
    }]
  });

  const buffer = await Packer.toBuffer(doc);
  return Buffer.from(buffer);
}

async function exportToPdf(
  acr: AcrDocument,
  options: ExportOptions
): Promise<Buffer> {
  const pdfDoc = await PDFDocument.create();
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaBold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  let page = pdfDoc.addPage([612, 792]);
  const { width, height } = page.getSize();
  const margin = 50;
  const lineHeight = 14;
  let yPosition = height - 50;

  page.drawText(`Accessibility Conformance Report`, {
    x: margin,
    y: yPosition,
    size: 20,
    font: helveticaBold,
    color: rgb(0.15, 0.39, 0.92)
  });
  yPosition -= 25;

  page.drawText(acr.productInfo.name, {
    x: margin,
    y: yPosition,
    size: 16,
    font: helveticaBold,
    color: rgb(0.2, 0.2, 0.2)
  });
  yPosition -= 20;

  // Use exact edition string if it already looks like a display format
  const editionDisplay = formatEdition(acr.edition, acr.edition.toLowerCase().includes('vpat'));
  page.drawText(editionDisplay, {
    x: margin,
    y: yPosition,
    size: 10,
    font: helvetica,
    color: rgb(0.4, 0.4, 0.4)
  });
  yPosition -= 30;

  page.drawLine({
    start: { x: margin, y: yPosition },
    end: { x: width - margin, y: yPosition },
    thickness: 2,
    color: rgb(0.15, 0.39, 0.92)
  });
  yPosition -= 25;

  page.drawText('Product Information', { x: margin, y: yPosition, size: 14, font: helveticaBold });
  yPosition -= 20;

  const productInfo = [
    `Product Name: ${acr.productInfo.name}`,
    `Version: ${acr.productInfo.version}`,
    `Vendor: ${acr.productInfo.vendor}`,
    `Contact: ${acr.productInfo.contactEmail}`,
    `Evaluation Date: ${acr.productInfo.evaluationDate.toISOString().split('T')[0]}`
  ];

  for (const info of productInfo) {
    page.drawText(info, { x: margin, y: yPosition, size: 10, font: helvetica });
    yPosition -= lineHeight;
  }
  yPosition -= 15;

  // Add Products Evaluated section for batch ACRs
  const batchInfo = (acr as unknown as Record<string, unknown>).batchInfo as any;
  if (batchInfo && batchInfo.documentList && Array.isArray(batchInfo.documentList) && batchInfo.documentList.length > 0) {
    page.drawText('Products Evaluated', { x: margin, y: yPosition, size: 14, font: helveticaBold });
    yPosition -= 18;

    for (let i = 0; i < batchInfo.documentList.length; i++) {
      const doc = batchInfo.documentList[i];
      const fileText = `${i + 1}. ${doc.fileName}`;
      page.drawText(fileText, { x: margin + 10, y: yPosition, size: 9, font: helvetica });
      yPosition -= lineHeight;
      
      // Check for additional details (status, issues)
      if (doc.status || doc.issuesFound !== undefined) {
        const detailParts = [];
        if (doc.status) detailParts.push(`Status: ${doc.status}`);
        if (doc.issuesFound !== undefined) detailParts.push(`Issues: ${doc.issuesFound}`);
        if (doc.score) detailParts.push(`Score: ${doc.score}`);
        const detailText = detailParts.join(' | ');
        page.drawText(detailText, { x: margin + 25, y: yPosition, size: 8, font: helvetica, color: rgb(0.4, 0.4, 0.4) });
        yPosition -= lineHeight;
      }
      
      // Check for page overflow
      if (yPosition < 100) {
        page = pdfDoc.addPage([612, 792]);
        yPosition = height - 50;
      }
    }
    yPosition -= 10;
  }

  page.drawText('Evaluation Methods', { x: margin, y: yPosition, size: 14, font: helveticaBold });
  yPosition -= 18;

  for (const method of acr.evaluationMethods) {
    const methodText = typeof method === 'string' ? method : formatEvaluationMethod(method);
    page.drawText(`• ${methodText}`, { x: margin + 10, y: yPosition, size: 9, font: helvetica });
    yPosition -= lineHeight;
  }
  yPosition -= 20;

  page.drawText('Accessibility Conformance Report', { x: margin, y: yPosition, size: 14, font: helveticaBold });
  yPosition -= 20;

  const colWidths = [120, 80, width - margin * 2 - 200];

  page.drawRectangle({
    x: margin,
    y: yPosition - 5,
    width: width - margin * 2,
    height: 18,
    color: rgb(0.15, 0.39, 0.92)
  });

  page.drawText('Criteria', { x: margin + 5, y: yPosition, size: 10, font: helveticaBold, color: rgb(1, 1, 1) });
  page.drawText('Level', { x: margin + colWidths[0] + 5, y: yPosition, size: 10, font: helveticaBold, color: rgb(1, 1, 1) });
  page.drawText('Remarks', { x: margin + colWidths[0] + colWidths[1] + 5, y: yPosition, size: 10, font: helveticaBold, color: rgb(1, 1, 1) });
  yPosition -= 20;

  for (const criterion of acr.criteria) {
    const remarksText = options.includeAttribution && criterion.attributedRemarks
      ? criterion.attributedRemarks
      : criterion.remarks || '';

    const remarksLines = wrapText(remarksText, colWidths[2] - 10, 7);
    const nameLines = wrapText(criterion.name, colWidths[0] - 10, 7);
    
    // Calculate row height based on all content (ID line + name lines + padding)
    const nameHeight = 12 + (Math.min(nameLines.length, 2) * 9); // ID + name lines
    const remarksHeight = remarksLines.length * 10;
    const rowHeight = Math.max(nameHeight, remarksHeight, 28) + 8; // Minimum 28px + padding

    if (yPosition - rowHeight < 80) {
      page = pdfDoc.addPage([612, 792]);
      yPosition = height - 50;
    }

    // Draw row separator line
    page.drawLine({
      start: { x: margin, y: yPosition + 3 },
      end: { x: width - margin, y: yPosition + 3 },
      thickness: 0.5,
      color: rgb(0.85, 0.85, 0.85)
    });

    // Draw criterion ID
    page.drawText(criterion.id, { x: margin + 5, y: yPosition - 12, size: 9, font: helveticaBold });
    
    // Draw criterion name (wrapped)
    let nameY = yPosition - 24;
    for (const line of nameLines.slice(0, 2)) {
      page.drawText(line, { x: margin + 5, y: nameY, size: 7, font: helvetica, color: rgb(0.4, 0.4, 0.4) });
      nameY -= 10;
    }

    // Draw conformance level
    page.drawText(formatConformanceLevel(criterion.conformanceLevel), { 
      x: margin + colWidths[0] + 5, 
      y: yPosition - 12, 
      size: 9, 
      font: helvetica 
    });

    // Draw remarks (wrapped)
    let remarksY = yPosition - 12;
    for (const line of remarksLines) {
      page.drawText(line, { x: margin + colWidths[0] + colWidths[1] + 5, y: remarksY, size: 7, font: helvetica });
      remarksY -= 10;
    }

    yPosition -= rowHeight;
  }

  if (options.includeMethodology && acr.methodology) {
    if (yPosition < 150) {
      page = pdfDoc.addPage([612, 792]);
      yPosition = height - 50;
    }
    yPosition -= 25;
    page.drawText('Assessment Methodology', { x: margin, y: yPosition, size: 14, font: helveticaBold });
    yPosition -= 20;
    page.drawText(`Tool Version: ${acr.methodology.toolVersion}`, { x: margin, y: yPosition, size: 10, font: helvetica });
    yPosition -= lineHeight;
    page.drawText(`AI Model: ${acr.methodology.aiModelInfo}`, { x: margin, y: yPosition, size: 10, font: helvetica });
    yPosition -= lineHeight;
    page.drawText(`Assessment Date: ${acr.methodology.assessmentDate.toISOString().split('T')[0]}`, { x: margin, y: yPosition, size: 10, font: helvetica });
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
    yPosition -= 18;

    const disclaimerLines = wrapText(acr.footerDisclaimer, width - margin * 2, 8);
    for (const line of disclaimerLines) {
      if (yPosition < 30) {
        page = pdfDoc.addPage([612, 792]);
        yPosition = height - 50;
      }
      page.drawText(line, { x: margin, y: yPosition, size: 8, font: helvetica, color: rgb(0.4, 0.4, 0.4) });
      yPosition -= 12;
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
    <p>${formatEdition(acr.edition)} | ${companyName}</p>
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
