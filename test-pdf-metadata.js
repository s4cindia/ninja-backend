/**
 * Quick script to check PDF metadata
 */
const fs = require('fs');
const { PDFDocument } = require('pdf-lib');

async function checkMetadata() {
  const pdfPath = process.argv[2];

  if (!pdfPath) {
    console.error('Usage: node test-pdf-metadata.js <path-to-pdf>');
    process.exit(1);
  }

  const pdfBytes = fs.readFileSync(pdfPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);

  console.log('\n=== PDF Metadata ===');
  console.log('Title:', pdfDoc.getTitle() || '(not set)');
  console.log('Author:', pdfDoc.getAuthor() || '(not set)');
  console.log('Creator:', pdfDoc.getCreator() || '(not set)');
  console.log('Producer:', pdfDoc.getProducer() || '(not set)');
  console.log('Subject:', pdfDoc.getSubject() || '(not set)');
  console.log('Keywords:', pdfDoc.getKeywords() || '(not set)');

  // Check for language in catalog
  const catalog = pdfDoc.catalog;
  const langObj = catalog.get('Lang');
  console.log('Language (from catalog):', langObj ? langObj.toString() : '(not set)');

  console.log('\n');
}

checkMetadata().catch(console.error);
