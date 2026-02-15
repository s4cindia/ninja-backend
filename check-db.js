const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function check() {
  const docId = 'eac539d3-eb00-4b85-b18e-afc0c457b9a5'; // Note: extra 'c' in afc0c457

  const doc = await prisma.editorialDocument.findUnique({
    where: { id: docId },
    include: { citations: true }
  });

  const refs = await prisma.referenceListEntry.findMany({
    where: { documentId: docId },
    orderBy: { sortKey: 'asc' }
  });

  console.log('=== DATABASE CHECK ===');
  console.log('Document ID:', docId);
  console.log('Document Status:', doc?.status);
  console.log('Citations in DB:', doc?.citations?.length || 0);
  console.log('References in DB:', refs.length);

  if (doc?.citations?.[0]) {
    console.log('\nFirst Citation:', {
      id: doc.citations[0].id,
      rawText: doc.citations[0].rawText,
      paragraphIndex: doc.citations[0].paragraphIndex
    });
  }

  if (refs[0]) {
    console.log('\nFirst Reference:', {
      sortKey: refs[0].sortKey,
      citationIds: refs[0].citationIds,
      authors: refs[0].authors,
      year: refs[0].year
    });
  }

  await prisma.$disconnect();
}

check().catch(console.error);
