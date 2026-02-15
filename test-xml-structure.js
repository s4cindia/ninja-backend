/**
 * Check XML structure before and after modifications
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

  // Count all tag types
  const tags = ['w:r', 'w:t', 'w:p', 'w:del', 'w:ins', 'w:body', 'w:document'];

  for (const tag of tags) {
    const openPattern = new RegExp(`<${tag}[^>]*>`, 'g');
    const closePattern = new RegExp(`</${tag}>`, 'g');
    const selfClosePattern = new RegExp(`<${tag}[^>]*/>`, 'g');

    const opens = (documentXML.match(openPattern) || []).length;
    const closes = (documentXML.match(closePattern) || []).length;
    const selfCloses = (documentXML.match(selfClosePattern) || []).length;

    // Self-closing tags are counted in opens but shouldn't need closes
    const effectiveOpens = opens - selfCloses;

    const status = effectiveOpens === closes ? 'OK' : 'MISMATCH!';
    console.log(`<${tag}>: ${opens} open (${selfCloses} self-closing), ${closes} close - ${status}`);
  }

  // Check for a sample citation to understand structure
  console.log('\n=== SAMPLE CITATION CONTEXT ===');
  const citationMatch = documentXML.match(/.{0,200}\(1\).{0,200}/);
  if (citationMatch) {
    console.log('Context around (1):');
    console.log(citationMatch[0].replace(/</g, '\n<').substring(0, 500));
  }

  await prisma.$disconnect();
}

checkStructure().catch(console.error);
