const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const citations = await prisma.citation.findMany({
    where: { documentId: '3f5168c1-1317-45f2-a0cb-ef28876be71f' },
    select: { rawText: true, citationType: true, detectedStyle: true }
  });
  console.log('Detected citations:', citations.length);
  citations.forEach(c => console.log('  ', c.rawText, '| type:', c.citationType, '| style:', c.detectedStyle));
}
main().catch(console.error).finally(() => prisma.\());
