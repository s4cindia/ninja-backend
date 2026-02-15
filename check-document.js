const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkDocument() {
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

  console.log('=== DOCUMENT ===');
  console.log(`ID: ${doc.id}`);
  console.log(`Status: ${doc.status}`);
  console.log(`Citations: ${doc.citations.length}`);
  console.log(`References: ${doc.referenceListEntries.length}`);

  console.log('\n=== REFERENCES ===');
  doc.referenceListEntries.forEach((ref, idx) => {
    console.log(`[${idx}] sortKey=${ref.sortKey}, citationIds=${JSON.stringify(ref.citationIds)}, authors=${ref.authors?.[0]}`);
  });

  console.log('\n=== CITATIONS (first 10) ===');
  doc.citations.slice(0, 10).forEach((cit, idx) => {
    console.log(`[${idx}] rawText="${cit.rawText}", id=${cit.id.substring(0, 8)}...`);
  });

  console.log('\n=== MAPPING TEST ===');
  const citationToRefMap = new Map();
  doc.referenceListEntries.forEach((ref, index) => {
    const refNumber = index + 1;
    if (ref.citationIds && ref.citationIds.length > 0) {
      ref.citationIds.forEach(citationId => {
        citationToRefMap.set(citationId, refNumber);
      });
    }
  });
  console.log(`citationToRefMap has ${citationToRefMap.size} entries`);

  // Check what replacements would be generated
  console.log('\n=== WOULD GENERATE REPLACEMENTS ===');
  let replacements = 0;
  doc.citations.forEach(cit => {
    const newRefNumber = citationToRefMap.get(cit.id);
    if (cit.rawText) {
      const oldMatch = cit.rawText.match(/\d+/);
      if (oldMatch) {
        const oldNumber = parseInt(oldMatch[0]);
        if (newRefNumber && oldNumber !== newRefNumber) {
          console.log(`  "${cit.rawText}" -> "(${newRefNumber})"`);
          replacements++;
        } else if (!newRefNumber) {
          console.log(`  "${cit.rawText}" -> ORPHANED (no mapping)`);
        }
      }
    }
  });
  console.log(`Total replacements: ${replacements}`);

  await prisma.$disconnect();
}

checkDocument().catch(console.error);
