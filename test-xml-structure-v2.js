/**
 * Check XML structure with proper tag matching
 */
const { PrismaClient } = require('@prisma/client');
const JSZip = require('jszip');
const fs = require('fs').promises;
const path = require('path');

const prisma = new PrismaClient();

async function checkStructure() {
  const docId = '7c9dfb8c-bd1f-40fb-84e9-2985585bf81e';

  const doc = await prisma.editorialDocument.findUnique({
    where: { id: docId }
  });

  const filePath = path.join(process.cwd(), 'uploads', doc.storagePath);
  const originalBuffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(originalBuffer);
  const documentXML = await zip.file('word/document.xml').async('string');

  console.log('=== ORIGINAL XML STRUCTURE ===');

  // Count tags with word boundary to avoid matching w:rPr as w:r
  const tags = [
    { name: 'w:r', openPattern: /<w:r[\s>]/g, closePattern: /<\/w:r>/g },
    { name: 'w:t', openPattern: /<w:t[\s>]/g, closePattern: /<\/w:t>/g },
    { name: 'w:p', openPattern: /<w:p[\s>]/g, closePattern: /<\/w:p>/g },
    { name: 'w:rPr', openPattern: /<w:rPr[\s>\/]/g, closePattern: /<\/w:rPr>/g },
    { name: 'w:pPr', openPattern: /<w:pPr[\s>\/]/g, closePattern: /<\/w:pPr>/g },
  ];

  for (const { name, openPattern, closePattern } of tags) {
    const opens = (documentXML.match(openPattern) || []).length;
    const closes = (documentXML.match(closePattern) || []).length;
    const status = opens === closes ? 'OK' : `DIFF: ${opens - closes}`;
    console.log(`<${name}>: ${opens} open, ${closes} close - ${status}`);
  }

  // Now let's check a modified file
  console.log('\n=== NOW TESTING MODIFIED FILE ===');

  // Simple test - just replace one citation
  let testXML = documentXML;

  const revisionDate = new Date().toISOString();
  const author = 'Test';

  // Find and replace (1) with track changes
  // First, let's see the exact structure around (1)
  const citation1Match = testXML.match(/<w:t[^>]*>\(1\)<\/w:t>/);
  if (citation1Match) {
    console.log('\nFound (1) in its own w:t element: ', citation1Match[0]);

    // This is the cleanest case - replace the entire w:t content
    const replacement =
      `<w:del w:id="1" w:author="${author}" w:date="${revisionDate}">` +
      `<w:r><w:delText>(1)</w:delText></w:r></w:del>`;

    testXML = testXML.replace(/<w:t[^>]*>\(1\)<\/w:t>/, replacement);
    console.log('Replaced with:', replacement);
  } else {
    // Check if (1) is part of larger text
    const partialMatch = testXML.match(/<w:t[^>]*>[^<]*\(1\)[^<]*<\/w:t>/);
    if (partialMatch) {
      console.log('\nFound (1) as part of larger text:', partialMatch[0]);
    }
  }

  // Check structure after modification
  console.log('\n=== AFTER MODIFICATION ===');
  for (const { name, openPattern, closePattern } of tags) {
    const opens = (testXML.match(openPattern) || []).length;
    const closes = (testXML.match(closePattern) || []).length;
    const status = opens === closes ? 'OK' : `DIFF: ${opens - closes}`;
    console.log(`<${name}>: ${opens} open, ${closes} close - ${status}`);
  }

  // Save test file
  zip.file('word/document.xml', testXML);
  const modifiedBuffer = await zip.generateAsync({ type: 'nodebuffer' });
  const outputPath = path.join(process.cwd(), 'test-simple-replace.docx');
  await fs.writeFile(outputPath, modifiedBuffer);
  console.log(`\nSaved to: ${outputPath}`);

  await prisma.$disconnect();
}

checkStructure().catch(console.error);
