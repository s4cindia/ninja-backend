const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function checkRefs() {
  const docId = '6a3f70b1-046a-4953-9405-6ce427faf3b9';
  
  const refs = await prisma.referenceListEntry.findMany({
    where: { documentId: docId },
    orderBy: { sortKey: 'asc' },
    take: 2
  });
  
  console.log('=== REFERENCE DATA CHECK ===');
  console.log('Total references:', refs.length);
  
  if (refs[0]) {
    console.log('\n=== First Reference ===');
    console.log('ID:', refs[0].id);
    console.log('SortKey:', refs[0].sortKey);
    console.log('Authors:', refs[0].authors);
    console.log('Year:', refs[0].year);
    console.log('Title:', refs[0].title);
    console.log('JournalName:', refs[0].journalName);
    console.log('Volume:', refs[0].volume);
    console.log('Issue:', refs[0].issue);
    console.log('Pages:', refs[0].pages);
    console.log('DOI:', refs[0].doi);
    console.log('URL:', refs[0].url);
    console.log('Publisher:', refs[0].publisher);
    console.log('FormattedApa:', refs[0].formattedApa);
  }
  
  await prisma.$disconnect();
}

checkRefs().catch(console.error);
