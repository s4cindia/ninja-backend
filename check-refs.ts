import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const docId = '28285944-a3fc-4a72-94f8-2f52a619d82b';
  
  const refs = await prisma.referenceListEntry.findMany({
    where: { documentId: docId },
    orderBy: { sortKey: 'asc' },
    take: 2
  });
  
  console.log('Reference 1:');
  console.log('  formattedText:', refs[0]?.formattedText?.substring(0, 80));
  console.log('  formattedApa:', refs[0]?.formattedApa?.substring(0, 80));
  console.log('  formattedChicago:', refs[0]?.formattedChicago?.substring(0, 80));
  
  // Check style conversion changes
  const styleChanges = await prisma.citationChange.findMany({
    where: { 
      documentId: docId,
      changeType: 'REFERENCE_STYLE_CONVERSION'
    },
    take: 2
  });
  
  console.log('\nREFERENCE_STYLE_CONVERSION changes:');
  styleChanges.forEach(c => {
    console.log('  Before:', c.beforeText?.substring(0, 60));
    console.log('  After:', c.afterText?.substring(0, 60));
  });
}

main().catch(console.error).finally(() => prisma.$disconnect());
