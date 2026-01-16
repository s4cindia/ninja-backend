import { PrismaClient, Prisma } from '@prisma/client';

declare global {
  var prisma: PrismaClient | undefined;
}

const logLevels: Prisma.LogLevel[] = process.env.NODE_ENV === 'development' 
  ? ['query', 'error', 'warn'] 
  : ['error'];

const prisma = global.prisma || new PrismaClient({
  log: logLevels,
});

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

async function gracefulShutdown() {
  await prisma.$disconnect();
}

process.on('beforeExit', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

export default prisma;
