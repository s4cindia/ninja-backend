const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const docId = '1161b2f1-7e5c-47d5-90e9-f8d36568d60c';
  
  const citations = await prisma.citation.findMany({
    where: { documentId: docId },
    orderBy: { startOffset: 'asc' },
    take: 10
  });
  
  console.log('=== CITATION DATA (New Upload) ===');
  console.log('Total citations:', citations.length);
  console.log('\nFirst 10 citations:');
  citations.forEach((c, i) => {
    console.log(`${i+1}. Text: "${c.rawText}" at position ${c.startOffset}-${c.endOffset}`);
  });
  
  await prisma.$disconnect();
})().catch(console.error);
