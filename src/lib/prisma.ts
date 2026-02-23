/**
 * @fileoverview Prisma database client configuration and lifecycle management.
 * Implements singleton pattern to prevent multiple client instances in development.
 * Handles graceful shutdown to properly close database connections.
 */

import { PrismaClient, Prisma } from '@prisma/client';

declare global {
  var prisma: PrismaClient | undefined;
}

/**
 * Log levels based on environment.
 * Development: query, error, warn for debugging
 * Production: error only for performance
 */
const logLevels: Prisma.LogLevel[] = process.env.NODE_ENV === 'development' 
  ? ['query', 'error', 'warn'] 
  : ['error'];

/**
 * Singleton Prisma client instance.
 * Reuses existing global instance in development to prevent connection exhaustion.
 */
const prisma = global.prisma || new PrismaClient({
  log: logLevels,
});

if (process.env.NODE_ENV !== 'production') {
  global.prisma = prisma;
}

/**
 * Gracefully disconnects Prisma client before process exit.
 * Ensures all pending queries complete and connections are properly closed.
 */
async function gracefulShutdown() {
  await prisma.$disconnect();
}

process.on('beforeExit', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

export default prisma;
export { Prisma };
