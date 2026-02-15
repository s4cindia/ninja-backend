/**
 * Check where (19) appears in the DOCX
 */
const { PrismaClient } = require('@prisma/client');
const JSZip = require('jszip');
const fs = require('fs').promises;
const path = require('path');

const prisma = new PrismaClient();

async function check() {
  const docId = '396765e7-1b62-4312-b4d0-7651c26cf682';

  const doc = await prisma.editorialDocument.findUnique({
    where: { id: docId }
  });

  const filePath = path.join(process.cwd(), 'uploads', doc.storagePath);
  const buffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');

  // Find References section
  const refMatch = xml.match(/<w:t[^>]*>References<\/w:t>/i);
  if (refMatch && refMatch.index) {
    const beforeRef = xml.substring(0, refMatch.index);
    const lastPStart = beforeRef.lastIndexOf('<w:p');

    const bodyXML = xml.substring(0, lastPStart);
    const refsXML = xml.substring(lastPStart);

    console.log('=== BODY SECTION ===');
    console.log(`Length: ${bodyXML.length} chars`);

    // Check citations in body
    for (let i = 1; i <= 21; i++) {
      const pattern = new RegExp(`\\(${i}\\)`, 'g');
      const matches = bodyXML.match(pattern) || [];
      if (matches.length > 0) {
        console.log(`  (${i}): ${matches.length}x in body`);
      }
    }

    console.log('\n=== REFERENCES SECTION ===');
    console.log(`Length: ${refsXML.length} chars`);

    // Check citations in references
    for (let i = 1; i <= 21; i++) {
      const pattern = new RegExp(`\\(${i}\\)`, 'g');
      const matches = refsXML.match(pattern) || [];
      if (matches.length > 0) {
        console.log(`  (${i}): ${matches.length}x in references`);
      }
    }

    // Count reference paragraphs
    const refParagraphs = refsXML.match(/<w:p[^>]*>[\s\S]*?<\/w:p>/g) || [];
    console.log(`\nTotal paragraphs in References section: ${refParagraphs.length}`);

  } else {
    console.log('References section not found!');
  }

  await prisma.$disconnect();
}

check().catch(console.error);
