const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const docId = 'be25f336-b761-404a-937a-b8222ffcc157';

  // Get citations
  const citations = await prisma.citation.findMany({
    where: { documentId: docId },
    select: { id: true, rawText: true, citationType: true }
  });
  console.log('=== CITATIONS ===');
  citations.forEach((c, i) => console.log((i+1) + '. [' + c.citationType + '] "' + c.rawText + '"'));

  // Get references
  const refs = await prisma.referenceListEntry.findMany({
    where: { documentId: docId },
    orderBy: { sortKey: 'asc' },
    select: { id: true, sortKey: true, authors: true, title: true }
  });
  console.log('\n=== REFERENCES ===');
  refs.forEach((r, i) => console.log((i+1) + '. [sortKey=' + r.sortKey + '] ' + (Array.isArray(r.authors) ? r.authors.join(', ') : '') + ' - ' + ((r.title||'').substring(0,50)) + '...'));

  // Get citation changes
  const changes = await prisma.citationChange.findMany({
    where: { documentId: docId, isReverted: false },
    orderBy: { appliedAt: 'desc' }
  });
  console.log('\n=== CITATION CHANGES ===');
  changes.forEach(ch => console.log('[' + ch.changeType + '] "' + ch.beforeText + '" -> "' + ch.afterText + '"'));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
