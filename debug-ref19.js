/**
 * Debug reference 19 and swapping issue
 */
const { PrismaClient } = require('@prisma/client');
const JSZip = require('jszip');
const fs = require('fs').promises;
const path = require('path');

const prisma = new PrismaClient();

async function debug() {
  const docId = '396765e7-1b62-4312-b4d0-7651c26cf682';

  const doc = await prisma.editorialDocument.findUnique({
    where: { id: docId },
    include: {
      citations: true,
      referenceListEntries: { orderBy: { sortKey: 'asc' } }
    }
  });

  console.log('=== CURRENT DATABASE STATE ===');
  console.log(`Total references in DB: ${doc.referenceListEntries.length}`);
  console.log(`Total citations in DB: ${doc.citations.length}`);

  // Show last few references to understand swap
  console.log('\n=== LAST 5 REFERENCES (positions 15-19) ===');
  doc.referenceListEntries.slice(-5).forEach((ref, i) => {
    const pos = doc.referenceListEntries.length - 5 + i + 1;
    const linkedCits = doc.citations.filter(c => ref.citationIds?.includes(c.id));
    const citTexts = [...new Set(linkedCits.map(c => c.rawText))].join(', ');
    console.log(`[${pos}] ${ref.authors?.[0]} - sortKey: ${ref.sortKey}, citations: ${citTexts}`);
  });

  // Check citation (19) specifically
  console.log('\n=== CITATION (19) DETAILS ===');
  const cit19 = doc.citations.filter(c => c.rawText === '(19)');
  console.log(`Found ${cit19.length} citation(s) with rawText "(19)"`);
  cit19.forEach(c => {
    const linkedRef = doc.referenceListEntries.find(r => r.citationIds?.includes(c.id));
    if (linkedRef) {
      const refPos = doc.referenceListEntries.indexOf(linkedRef) + 1;
      console.log(`  Citation ID: ${c.id} → linked to ref at position ${refPos} (${linkedRef.authors?.[0]})`);
    } else {
      console.log(`  Citation ID: ${c.id} → NOT LINKED to any reference (orphaned)`);
    }
  });

  // Check citation (20) specifically
  console.log('\n=== CITATION (20) DETAILS ===');
  const cit20 = doc.citations.filter(c => c.rawText === '(20)');
  console.log(`Found ${cit20.length} citation(s) with rawText "(20)"`);
  cit20.forEach(c => {
    const linkedRef = doc.referenceListEntries.find(r => r.citationIds?.includes(c.id));
    if (linkedRef) {
      const refPos = doc.referenceListEntries.indexOf(linkedRef) + 1;
      console.log(`  Citation ID: ${c.id} → linked to ref at position ${refPos} (${linkedRef.authors?.[0]})`);
    } else {
      console.log(`  Citation ID: ${c.id} → NOT LINKED to any reference (orphaned)`);
    }
  });

  // Check citation (21) - does it exist?
  console.log('\n=== CITATION (21) CHECK ===');
  const cit21 = doc.citations.filter(c => c.rawText === '(21)');
  console.log(`Found ${cit21.length} citation(s) with rawText "(21)"`);

  // Check the DOCX for actual citations
  console.log('\n=== CHECKING DOCX FOR (19), (20), (21) ===');
  const filePath = path.join(process.cwd(), 'uploads', doc.storagePath);
  const buffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');

  ['(19)', '(20)', '(21)'].forEach(cit => {
    const escaped = cit.replace(/[()]/g, '\\$&');
    const matches = xml.match(new RegExp(escaped, 'g')) || [];
    console.log(`"${cit}" appears ${matches.length} times in DOCX`);
  });

  // What SHOULD happen based on current logic
  console.log('\n=== EXPECTED CHANGES ===');
  const mapping = new Map([
    [2, 1], [3, 2], [4, 3], [5, 4], [6, 5], [7, 6], [8, 7],
    [9, 8], [10, 9], [11, 10], [12, 11], [13, 12], [14, 13],
    [15, 14], [16, 15], [17, 16], [18, 17], [19, 19], [20, 18]
  ]);

  console.log('Number mapping:');
  mapping.forEach((newNum, oldNum) => {
    if (oldNum !== newNum) {
      console.log(`  (${oldNum}) → (${newNum})`);
    } else {
      console.log(`  (${oldNum}) → (${newNum}) [NO CHANGE - won't show in Track Changes]`);
    }
  });

  console.log('\nDeleted (orphaned): (1)');

  // The issue: 19→19 means no visible change!
  console.log('\n=== THE PROBLEM ===');
  console.log('Citation (19) maps to new number 19 (no change)');
  console.log('This is because:');
  console.log('- Original ref 19 (Nuzzi) was at position 19');
  console.log('- After deleting ref 1, it would be at position 18');
  console.log('- After swapping with original ref 20, it is at position 19');
  console.log('- Net effect: 19 → 19 (no visible change in number)');
  console.log('');
  console.log('But the CONTENT at position 19 changed:');
  console.log('- Before: whatever was originally at 19');
  console.log('- After: Nuzzi (who was originally at 19, but got swapped)');

  await prisma.$disconnect();
}

debug().catch(console.error);
