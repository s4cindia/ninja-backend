const fs = require('fs').promises;
const path = require('path');
const JSZip = require('jszip');
const { PrismaClient } = require('@prisma/client');

async function checkOccurrences() {
  const prisma = new PrismaClient();
  const doc = await prisma.editorialDocument.findUnique({
    where: { id: '7c9dfb8c-bd1f-40fb-84e9-2985585bf81e' }
  });

  const filePath = path.join(process.cwd(), 'uploads', doc.storagePath);
  const buffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');

  // Count occurrences of each citation
  const citations = ['(1)', '(2)', '(3)', '(4)', '(5)'];
  console.log('=== OCCURRENCES IN ORIGINAL DOCUMENT ===');
  citations.forEach(c => {
    const regex = new RegExp(c.replace(/[()]/g, '\\$&'), 'g');
    const count = (xml.match(regex) || []).length;
    console.log(`${c}: ${count} occurrences`);
  });

  // Now check the modified file
  try {
    const modifiedPath = path.join(process.cwd(), 'test-track-changes.docx');
    const modBuffer = await fs.readFile(modifiedPath);
    const modZip = await JSZip.loadAsync(modBuffer);
    const modXml = await modZip.file('word/document.xml').async('string');

    console.log('\n=== TRACK CHANGES IN MODIFIED DOCUMENT ===');
    const delCount = (modXml.match(/<w:del /g) || []).length;
    const insCount = (modXml.match(/<w:ins /g) || []).length;
    console.log(`Deletions (w:del): ${delCount}`);
    console.log(`Insertions (w:ins): ${insCount}`);

    // Check remaining citations
    console.log('\n=== REMAINING PLAIN CITATIONS (should be 0) ===');
    citations.forEach(c => {
      const regex = new RegExp(c.replace(/[()]/g, '\\$&'), 'g');
      const count = (modXml.match(regex) || []).length;
      if (count > 0) {
        console.log(`${c}: ${count} NOT replaced!`);
      }
    });
  } catch (e) {
    console.log('Modified file not found:', e.message);
  }

  await prisma.$disconnect();
}
checkOccurrences();
