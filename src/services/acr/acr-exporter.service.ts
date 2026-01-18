;
  
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
