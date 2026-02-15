/**
 * Reset document and delete reference 1 (Henseler)
 * Then shift all remaining references up
 */
const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function resetAndDeleteRef1() {
  const docId = '7c9dfb8c-bd1f-40fb-84e9-2985585bf81e';

  console.log('=== CURRENT STATE ===');
  let doc = await prisma.editorialDocument.findUnique({
    where: { id: docId },
    include: {
      citations: true,
      referenceListEntries: { orderBy: { sortKey: 'asc' } }
    }
  });

  console.log('References:', doc.referenceListEntries.length);
  doc.referenceListEntries.forEach((ref, idx) => {
    console.log(`  [${idx+1}] ${ref.authors?.[0]} - sortKey=${ref.sortKey}`);
  });

  // Find Henseler reference to delete
  const henselerId = doc.referenceListEntries.find(r => r.authors?.[0]?.includes('Henseler'))?.id;

  if (!henselerId) {
    console.log('\nHenseler reference not found!');
    await prisma.$disconnect();
    return;
  }

  console.log('\n=== DELETING HENSELER (Reference with ID:', henselerId, ') ===');

  // Delete the Henseler reference
  await prisma.referenceListEntry.delete({
    where: { id: henselerId }
  });

  // Reload and renumber remaining references
  doc = await prisma.editorialDocument.findUnique({
    where: { id: docId },
    include: {
      citations: true,
      referenceListEntries: { orderBy: { sortKey: 'asc' } }
    }
  });

  console.log('\n=== RENUMBERING REMAINING REFERENCES ===');

  // Update sortKeys to be sequential (0001, 0002, ...)
  for (let i = 0; i < doc.referenceListEntries.length; i++) {
    const ref = doc.referenceListEntries[i];
    const newSortKey = String(i + 1).padStart(4, '0');

    console.log(`  ${ref.authors?.[0]}: sortKey ${ref.sortKey} -> ${newSortKey}`);

    await prisma.referenceListEntry.update({
      where: { id: ref.id },
      data: { sortKey: newSortKey }
    });
  }

  // Final state
  doc = await prisma.editorialDocument.findUnique({
    where: { id: docId },
    include: {
      citations: true,
      referenceListEntries: { orderBy: { sortKey: 'asc' } }
    }
  });

  console.log('\n=== FINAL STATE ===');
  console.log('References:', doc.referenceListEntries.length);
  doc.referenceListEntries.forEach((ref, idx) => {
    console.log(`  [${idx+1}] ${ref.authors?.[0]} - sortKey=${ref.sortKey}, citationIds=${ref.citationIds?.length || 0}`);
  });

  console.log('\n=== EXPECTED CITATION CHANGES ===');
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

  doc.citations.forEach(cit => {
    const newRefNumber = citationToRefMap.get(cit.id);
    if (cit.rawText) {
      const oldMatch = cit.rawText.match(/\d+/);
      if (oldMatch) {
        const oldNumber = parseInt(oldMatch[0]);
        if (newRefNumber && oldNumber !== newRefNumber) {
          console.log(`  "${cit.rawText}" -> "(${newRefNumber})"`);
        } else if (!newRefNumber) {
          console.log(`  "${cit.rawText}" -> ORPHANED (reference deleted)`);
        } else {
          console.log(`  "${cit.rawText}" -> "(${newRefNumber})" (no change)`);
        }
      }
    }
  });

  await prisma.$disconnect();
}

resetAndDeleteRef1().catch(console.error);
