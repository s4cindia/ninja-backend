const { PrismaClient } = require('@prisma/client');
const JSZip = require('jszip');
const fs = require('fs').promises;
const path = require('path');

const prisma = new PrismaClient();

async function testExport() {
  const docId = '7c9dfb8c-bd1f-40fb-84e9-2985585bf81e';

  const doc = await prisma.editorialDocument.findUnique({
    where: { id: docId },
    include: {
      citations: true,
      referenceListEntries: { orderBy: { sortKey: 'asc' } }
    }
  });

  if (!doc) {
    console.log('Document not found!');
    await prisma.$disconnect();
    return;
  }

  console.log('=== LOADING DOCX ===');
  const filePath = path.join(process.cwd(), 'uploads', doc.storagePath);
  console.log('File path:', filePath);

  const buffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const documentXML = await zip.file('word/document.xml').async('string');

  console.log('\n=== SEARCHING FOR CITATIONS IN XML ===');

  // Search for different patterns
  const patterns = [
    '(1)', '(2)', '(3)', '(4)', '(5)',
    '&#40;1&#41;', '&#40;2&#41;',  // HTML entities for parentheses
    '<w:t>(1)</w:t>', '<w:t>(2)</w:t>',
    '>1<', '>2<', '>3<', '>4<',  // Just the number between tags
  ];

  patterns.forEach(pattern => {
    const count = (documentXML.match(new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    if (count > 0) {
      console.log(`Found "${pattern}": ${count} times`);
    }
  });

  // Extract text content to see what's there
  console.log('\n=== EXTRACTING TEXT NODES ===');
  const textMatches = documentXML.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
  const citationLikeTexts = textMatches.filter(m => m.match(/\(\d\)|^\d$/));
  console.log('Text nodes that look like citations:');
  citationLikeTexts.forEach(t => console.log('  ', t));

  // Look for patterns around parentheses - maybe split across runs
  console.log('\n=== LOOKING FOR SPLIT PATTERNS ===');
  const splitPatterns = documentXML.match(/<w:t[^>]*>\([^<]*<\/w:t>|<w:t[^>]*>\d\)[^<]*<\/w:t>|<w:t[^>]*>\d[^<]*<\/w:t>/g) || [];
  console.log('Possible split citation parts:');
  splitPatterns.slice(0, 20).forEach(t => console.log('  ', t));

  // Show a snippet of XML around first "(1)" or "1"
  console.log('\n=== XML SNIPPET AROUND CITATIONS ===');
  const idx1 = documentXML.indexOf('(1)');
  if (idx1 >= 0) {
    console.log('Found "(1)" at index', idx1);
    console.log('Context:', documentXML.substring(Math.max(0, idx1 - 100), idx1 + 100));
  } else {
    // Try to find just "1" near a parenthesis
    const idx2 = documentXML.indexOf('>1<');
    if (idx2 >= 0) {
      console.log('Found ">1<" at index', idx2);
      console.log('Context:', documentXML.substring(Math.max(0, idx2 - 200), idx2 + 200));
    }
  }

  await prisma.$disconnect();
}

testExport().catch(console.error);
