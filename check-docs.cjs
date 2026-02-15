const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const docs = await prisma.editorialDocument.findMany({
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: { id: true, originalName: true, createdAt: true }
  });
  console.log(JSON.stringify(docs, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
