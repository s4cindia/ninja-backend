/**
 * Test if language modification works correctly
 */
const fs = require('fs');
const { PDFDocument, PDFName, PDFString } = require('pdf-lib');

async function testLanguageFix() {
  // Load original test PDF
  const originalPath = './quick_fix_test.pdf';
  const testOutputPath = './test_language_output.pdf';

  console.log('\n=== Testing Language Fix ===\n');

  // Load PDF
  const pdfBytes = fs.readFileSync(originalPath);
  const pdfDoc = await PDFDocument.load(pdfBytes);

  // Check current language
  const catalog = pdfDoc.catalog;
  const currentLang = catalog.get(PDFName.of('Lang'));
  console.log('Before - Language:', currentLang ? currentLang.toString() : '(not set)');
  console.log('Before - Title:', pdfDoc.getTitle() || '(not set)');

  // Set language
  catalog.set(PDFName.of('Lang'), PDFString.of('en-US'));
  console.log('\nApplied language fix: en-US');

  // Save PDF
  const modifiedBytes = await pdfDoc.save();
  fs.writeFileSync(testOutputPath, modifiedBytes);
  console.log(`Saved to: ${testOutputPath}`);

  // Re-load and verify
  const verifyBytes = fs.readFileSync(testOutputPath);
  const verifyDoc = await PDFDocument.load(verifyBytes);
  const verifyCatalog = verifyDoc.catalog;
  const verifyLang = verifyCatalog.get(PDFName.of('Lang'));

  console.log('\nAfter - Language:', verifyLang ? verifyLang.toString() : '(not set)');
  console.log('After - Title:', verifyDoc.getTitle() || '(not set)');

  if (verifyLang && verifyLang.toString().includes('en-US')) {
    console.log('\n✅ Language fix WORKS - saved correctly');
  } else {
    console.log('\n❌ Language fix FAILED - not saved');
  }
}

testLanguageFix().catch(console.error);
