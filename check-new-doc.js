/**
 * Check new document citations
 */
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

async function checkDocument() {
  const docId = '396765e7-1b62-4312-b4d0-7651c26cf682';

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
    const linkedCitations = doc.citations.filter(c => ref.citationIds?.includes(c.id));
    const citationTexts = [...new Set(linkedCitations.map(c => c.rawText))].join(', ');
    console.log(`[${newNumber}] ${ref.authors?.[0] || 'N/A'} - citations: ${citationTexts || 'none'}`);
  });

  console.log(`\n=== UNIQUE CITATION PATTERNS ===`);
  const patterns = new Map();
  doc.citations.forEach(c => {
    if (c.rawText) {
      if (!patterns.has(c.rawText)) patterns.set(c.rawText, 0);
      patterns.set(c.rawText, patterns.get(c.rawText) + 1);
    }
  });

  // Sort by the first number in each pattern
  const sortedPatterns = [...patterns.entries()].sort((a, b) => {
    const numA = parseInt(a[0].match(/\d+/)?.[0] || '0');
    const numB = parseInt(b[0].match(/\d+/)?.[0] || '0');
    return numA - numB;
  });

  sortedPatterns.forEach(([pattern, count]) => {
    const numbers = pattern.match(/\d+/g) || [];
    console.log(`"${pattern}" (${count}x) - numbers: [${numbers.join(', ')}]`);
  });

  // Build mapping using the new logic
  console.log(`\n=== BUILDING NUMBER MAPPING ===`);
  const oldToNewNumberMap = new Map();

  // PASS 1: Single-number citations
  console.log('Pass 1: Single-number citations');
  doc.referenceListEntries.forEach((ref, index) => {
    const newNumber = index + 1;
    if (ref.citationIds && ref.citationIds.length > 0) {
      const linkedCitations = doc.citations.filter(c => ref.citationIds.includes(c.id));
      for (const citation of linkedCitations) {
        if (citation.rawText) {
          const numbers = citation.rawText.match(/\d+/g) || [];
          if (numbers.length === 1) {
            const oldNum = parseInt(numbers[0]);
            if (!oldToNewNumberMap.has(oldNum)) {
              oldToNewNumberMap.set(oldNum, newNumber);
              console.log(`  ${oldNum} → ${newNumber} (from "${citation.rawText}")`);
            }
          }
        }
      }
    }
  });

  // PASS 2: Multi-number citations
  console.log('Pass 2: Multi-number citations');
  doc.referenceListEntries.forEach((ref, index) => {
    const newNumber = index + 1;
    const alreadyMapped = [...oldToNewNumberMap.entries()].some(([_, newNum]) => newNum === newNumber);
    if (alreadyMapped) return;

    if (ref.citationIds && ref.citationIds.length > 0) {
      const linkedCitations = doc.citations.filter(c => ref.citationIds.includes(c.id));
      for (const citation of linkedCitations) {
        if (citation.rawText) {
          const numbers = citation.rawText.match(/\d+/g) || [];
          for (const numStr of numbers) {
            const oldNum = parseInt(numStr);
            if (!oldToNewNumberMap.has(oldNum)) {
              oldToNewNumberMap.set(oldNum, newNumber);
              console.log(`  ${oldNum} → ${newNumber} (from "${citation.rawText}")`);
              break;
            }
          }
        }
      }
    }
  });

  console.log(`\n=== FINAL MAPPING ===`);
  const sortedMap = [...oldToNewNumberMap.entries()].sort((a, b) => a[0] - b[0]);
  sortedMap.forEach(([old, newNum]) => console.log(`  ${old} → ${newNum}`));

  // Test replacement on multi-number citations
  console.log(`\n=== TEST REPLACEMENTS ===`);
  const multiNumberCitations = sortedPatterns.filter(([p]) => (p.match(/\d+/g) || []).length > 1);
  multiNumberCitations.forEach(([pattern]) => {
    let newText = pattern;
    const numbers = [...new Set(pattern.match(/\d+/g) || [])].sort((a, b) => b.length - a.length || parseInt(b) - parseInt(a));
    for (const numStr of numbers) {
      const oldNum = parseInt(numStr);
      const newNum = oldToNewNumberMap.get(oldNum);
      if (newNum && newNum !== oldNum) {
        const regex = new RegExp(`\\b${oldNum}\\b`, 'g');
        newText = newText.replace(regex, String(newNum));
      }
    }
    console.log(`"${pattern}" → "${newText}"`);
  });

  await prisma.$disconnect();
}

checkDocument().catch(console.error);
