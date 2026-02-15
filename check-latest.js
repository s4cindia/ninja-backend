const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const doc = await prisma.editorialDocument.findFirst({
    orderBy: { createdAt: 'desc' }
  });
  
  console.log('Most recent document:', doc.id);
  console.log('File:', doc.originalName);
  
  const citations = await prisma.citation.findMany({
    where: { documentId: doc.id },
    take: 5,
    orderBy: { startOffset: 'asc' }
  });
  
  console.log('\nFirst 5 citations:');
  citations.forEach((c, i) => {
    console.log(`${i+1}. rawText: "${c.rawText}" | start: ${c.startOffset} | end: ${c.endOffset}`);
  });
  
  const refs = await prisma.referenceListEntry.findMany({
    where: { documentId: doc.id },
    take: 5,
    orderBy: { sortKey: 'asc' }
  });
  
  console.log('\nFirst 5 references:');
  refs.forEach(r => {
    console.log(`Position ${r.sortKey}: ${r.authors[0]} (${r.year})`);
  });
  
  await prisma.$disconnect();
})().catch(console.error);
