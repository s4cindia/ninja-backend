/**
 * Check all citation contexts in the document
 */
const { PrismaClient } = require('@prisma/client');
const JSZip = require('jszip');
const fs = require('fs').promises;
const path = require('path');

const prisma = new PrismaClient();

async function checkCitations() {
  const docId = '7c9dfb8c-bd1f-40fb-84e9-2985585bf81e';

  const doc = await prisma.editorialDocument.findUnique({
    where: { id: docId }
  });

  const filePath = path.join(process.cwd(), 'uploads', doc.storagePath);
  const originalBuffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(originalBuffer);
  const documentXML = await zip.file('word/document.xml').async('string');

  console.log('=== CITATION CONTEXTS ===\n');

  const citations = ['(1)', '(2)', '(3)', '(4)', '(5)'];

  for (const citation of citations) {
    const escaped = citation.replace(/[()]/g, '\\$&');

    // Check if citation is in its own <w:t> element
    const ownElement = new RegExp(`<w:t[^>]*>${escaped}</w:t>`, 'g');
    const ownMatches = documentXML.match(ownElement) || [];

    // Check if citation is part of larger text
    const partOfLarger = new RegExp(`<w:t[^>]*>[^<]*${escaped}[^<]*</w:t>`, 'g');
    const largerMatches = (documentXML.match(partOfLarger) || []).filter(m => !ownElement.test(m));

    console.log(`${citation}:`);
    if (ownMatches.length > 0) {
      console.log(`  Own element: ${ownMatches.length}x`);
      ownMatches.forEach(m => console.log(`    ${m}`));
    }
    if (largerMatches.length > 0) {
      console.log(`  Part of larger text: ${largerMatches.length}x`);
      largerMatches.forEach(m => console.log(`    ${m.substring(0, 100)}...`));
    }
    if (ownMatches.length === 0 && largerMatches.length === 0) {
      console.log(`  Not found in body (may be in References section)`);
    }
    console.log('');
  }

  await prisma.$disconnect();
}

checkCitations().catch(console.error);
