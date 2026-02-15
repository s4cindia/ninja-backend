/**
 * Check document citations and reference mapping
 */
const { PrismaClient } = require('@prisma/client');
const JSZip = require('jszip');
const fs = require('fs').promises;
const path = require('path');

const prisma = new PrismaClient();

async function checkDocument() {
  const docId = '7acbe299-7b59-478b-b468-e8a4829e58f7';

  console.log('=== LOADING DOCUMENT ===');
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

  console.log(`\n=== REFERENCES (${doc.referenceListEntries.length}) ===`);
  doc.referenceListEntries.forEach((ref, idx) => {
    const newNumber = idx + 1;
    console.log(`[${newNumber}] sortKey=${ref.sortKey}, authors=${ref.authors?.[0] || 'N/A'}, citationIds=${ref.citationIds?.length || 0}`);
  });

  console.log(`\n=== CITATIONS (${doc.citations.length}) ===`);
  // Group by rawText to see unique patterns
  const citationPatterns = new Map();
  doc.citations.forEach(c => {
    const pattern = c.rawText || 'null';
    if (!citationPatterns.has(pattern)) {
      citationPatterns.set(pattern, []);
    }
    citationPatterns.get(pattern).push(c.id);
  });

  for (const [pattern, ids] of citationPatterns) {
    console.log(`"${pattern}": ${ids.length}x`);
  }

  // Build mapping
  const citationToRefMap = new Map();
  doc.referenceListEntries.forEach((ref, index) => {
    const refNumber = index + 1;
    if (ref.citationIds && ref.citationIds.length > 0) {
      ref.citationIds.forEach(citationId => {
        citationToRefMap.set(citationId, refNumber);
      });
    }
  });

  console.log(`\n=== CITATION CHANGES ===`);
  const changedCitations = [];
  const orphanedCitations = [];
  const orphanedSet = new Set();

  doc.citations.forEach(citation => {
    const newRefNumber = citationToRefMap.get(citation.id);
    if (citation.rawText) {
      const oldMatch = citation.rawText.match(/\d+/);
      if (oldMatch) {
        const oldNumber = parseInt(oldMatch[0]);
        if (newRefNumber && oldNumber !== newRefNumber) {
          changedCitations.push({
            oldText: citation.rawText,
            newText: citation.rawText.replace(String(oldNumber), String(newRefNumber)),
            oldNum: oldNumber,
            newNum: newRefNumber
          });
        } else if (!newRefNumber) {
          if (!orphanedSet.has(citation.rawText)) {
            orphanedCitations.push(citation.rawText);
            orphanedSet.add(citation.rawText);
          }
        }
      }
    }
  });

  console.log('Changed:');
  changedCitations.forEach(c => console.log(`  ${c.oldText} → ${c.newText}`));
  console.log('Orphaned:');
  orphanedCitations.forEach(o => console.log(`  ${o}`));

  // Check DOCX for citation patterns
  console.log(`\n=== CITATION PATTERNS IN DOCX ===`);
  const filePath = path.join(process.cwd(), 'uploads', doc.storagePath);
  const buffer = await fs.readFile(filePath);
  const zip = await JSZip.loadAsync(buffer);
  const xml = await zip.file('word/document.xml').async('string');

  // Find all citation-like patterns
  const patterns = [
    { name: 'Single (N)', regex: /\((\d+)\)/g },
    { name: 'Multiple (N,M)', regex: /\((\d+(?:\s*,\s*\d+)+)\)/g },
    { name: 'Range (N-M)', regex: /\((\d+)\s*[-–]\s*(\d+)\)/g },
    { name: 'Bracket [N]', regex: /\[(\d+)\]/g },
    { name: 'Superscript', regex: /<w:vertAlign w:val="superscript"[^>]*>[\s\S]*?<w:t[^>]*>(\d+)/g },
  ];

  for (const { name, regex } of patterns) {
    const matches = xml.match(regex) || [];
    if (matches.length > 0) {
      console.log(`${name}: ${matches.length} matches`);
      // Show unique examples
      const unique = [...new Set(matches)].slice(0, 5);
      unique.forEach(m => {
        // Extract just the text content
        const textContent = m.replace(/<[^>]+>/g, '');
        console.log(`  - "${textContent}"`);
      });
    }
  }

  await prisma.$disconnect();
}

checkDocument().catch(console.error);
