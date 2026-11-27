/**
 * @fileoverview Prisma database client configuration and lifecycle management.
 * Implements singleton pattern to prevent multiple client instances in development.
 * Handles graceful shutdown to properly close database connections.
 */

import { PrismaClient, Prisma } from '@prisma/client';
import { logger } from './logger';

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
const basePrisma = global.prisma || new PrismaClient({
  log: logLevels,
});

if (process.env.NODE_ENV !== 'production') {
  global.prisma = basePrisma;
}

/**
 * Strips NUL bytes (U+0000) from every string value in a write payload,
 * recursively through plain objects and arrays.
 *
 * Real production incident (2026-11-27): a PDF's extracted text contained
 * a literal NUL character (a real, if rare, byte a PDF's own text-show
 * operators can legally encode -- not a parsing bug), which reached
 * job.output as part of the post-remediation audit report. Postgres's
 * text/JSON types reject NUL bytes outright (error 22P05, "unsupported
 * Unicode escape sequence" / "\u0000 cannot be converted to text") -- this
 * is a genuine PG limitation (its text type is NUL-terminated C strings
 * under the hood), not something any amount of valid-JSON-ness on the JS
 * side avoids. The write threw, uncaught, inside startAutoLoop's own
 * re-audit step on a 377-page document (Math_Weir_PDF.pdf) -- no
 * catchable-looking signature at all from the caller's side, since
 * `JSON.stringify` itself never complains about U+0000.
 *
 * Applied as a client extension (not at each individual call site) so no
 * future write path -- any model, any field -- can reintroduce this by
 * skipping a sanitizer call. Does not descend into Date, Buffer, or other
 * non-plain-object values (Decimal, etc.), which Prisma's own query
 * engine needs to receive untouched.
 */
export function stripNulBytes<T>(value: T): T {
  if (typeof value === 'string') {
    return (value.indexOf('\u0000') === -1 ? value : value.replace(/\u0000/g, '')) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => stripNulBytes(v)) as T;
  }
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      result[k] = stripNulBytes(v);
    }
    return result as T;
  }
  return value;
}

/**
 * Counts NUL bytes stripNulBytes would remove, without mutating anything --
 * kept separate from stripNulBytes itself so that function's existing
 * simple `(value) => value` signature and tests stay untouched. Used only
 * to decide whether a write actually needed stripping, for the log line
 * below -- this incident (see stripNulBytes's own doc comment) has only
 * ever been observed once; logging a count each time it recurs tells us
 * whether it's a one-off or an ongoing, measurable rate worth deeper
 * investigation (which model/field it keeps showing up on).
 */
export function countNulBytes(value: unknown): number {
  if (typeof value === 'string') {
    let count = 0;
    for (let i = 0; i < value.length; i++) {
      if (value.charCodeAt(i) === 0) count++;
    }
    return count;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum: number, v) => sum + countNulBytes(v), 0);
  }
  if (value !== null && typeof value === 'object' && value.constructor === Object) {
    return Object.values(value as Record<string, unknown>).reduce((sum: number, v) => sum + countNulBytes(v), 0);
  }
  return 0;
}

// Cast back to the plain PrismaClient type every existing call site in this
// codebase already declares (constructor params, test doubles, etc.) --
// $extends's own return type structurally drops the legacy $on/$use methods
// (superseded by extensions; confirmed via grep that nothing here calls
// either), which otherwise makes it fail assignability against every one
// of those sites for no functional reason. Every model operation actually
// used anywhere (create/update/findUnique/etc.) exists identically on the
// extended client, with this file's own sanitizer now running underneath
// each one transparently.
const prisma = basePrisma.$extends({
  name: 'strip-nul-bytes',
  query: {
    $allModels: {
      async $allOperations({ model, operation, args, query }) {
        if (args && typeof args === 'object' && 'data' in args) {
          const data = (args as { data: unknown }).data;
          const nulCount = countNulBytes(data);
          if (nulCount > 0) {
            logger.warn(`[Prisma] strip-nul-bytes: removed ${nulCount} NUL byte(s) from ${model}.${operation}'s write payload`);
          }
          (args as { data: unknown }).data = stripNulBytes(data);
        }
        return query(args);
      },
    },
  },
}) as unknown as PrismaClient;

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
