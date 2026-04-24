#!/usr/bin/env node
/**
 * Backfill script — populate CalibrationRun.summary.{emptyPages, emptyPageCount,
 * pagesWithZonesCount} for runs that completed before the fields were introduced.
 *
 * Idempotent: running twice produces the same result.
 * Safe: processes one run at a time; failure on one run does not affect others.
 *
 * Designed to run as an ECS task inside the VPC where staging RDS is accessible.
 *
 * Usage (via ECS run-task command override):
 *   node scripts/backfill-empty-pages.js --dry-run
 *   node scripts/backfill-empty-pages.js
 *   node scripts/backfill-empty-pages.js --filter=Aulakh,Govoni_Lovell
 *   node scripts/backfill-empty-pages.js --force
 *
 * Environment (injected by ECS task definition):
 *   DATABASE_URL — PostgreSQL connection string (from Secrets Manager)
 */

'use strict';

const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const FORCE = argv.includes('--force');
const filterArg = argv.find((a) => a.startsWith('--filter='));
const filenameFilter = filterArg
  ? filterArg
      .replace('--filter=', '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : null;

function computeEmptyPages(pageCount, zonePages) {
  const empty = [];
  for (let p = 1; p <= pageCount; p++) {
    if (!zonePages.has(p)) empty.push(p);
  }
  return {
    emptyPages: empty,
    emptyPageCount: empty.length,
    pagesWithZonesCount: zonePages.size,
  };
}

async function main() {
  const runs = await prisma.calibrationRun.findMany({
    where: {
      completedAt: { not: null },
      ...(filenameFilter
        ? {
            corpusDocument: {
              filename: {
                in: filenameFilter,
                mode: 'insensitive',
              },
            },
          }
        : {}),
    },
    include: {
      corpusDocument: { select: { id: true, filename: true, pageCount: true } },
    },
    orderBy: { runDate: 'asc' },
  });

  console.log(
    `Found ${runs.length} completed run(s)` +
      (filenameFilter ? ` matching filter [${filenameFilter.join(', ')}]` : '') +
      '.',
  );
  if (DRY_RUN) console.log('DRY RUN — no writes will be performed.\n');

  let updated = 0;
  let skipped = 0;
  let failed = 0;

  for (const run of runs) {
    const docName = run.corpusDocument?.filename ?? '<unknown>';
    const pageCount = run.corpusDocument?.pageCount ?? 0;

    if (!pageCount) {
      console.warn(`[skip] ${docName} (run ${run.id}) — document has no pageCount`);
      skipped++;
      continue;
    }

    const existingSummary = run.summary ?? {};
    if (!FORCE && typeof existingSummary.emptyPageCount === 'number') {
      skipped++;
      continue;
    }

    try {
      const zoneRows = await prisma.zone.findMany({
        where: { calibrationRunId: run.id },
        select: { pageNumber: true },
        distinct: ['pageNumber'],
      });
      const zonePages = new Set(zoneRows.map((r) => r.pageNumber));

      const patch = computeEmptyPages(pageCount, zonePages);
      const nextSummary = { ...existingSummary, ...patch };

      console.log(
        `[${DRY_RUN ? 'would update' : 'update'}] ${docName} — pageCount=${pageCount}, ` +
          `pagesWithZones=${patch.pagesWithZonesCount}, emptyPages=${patch.emptyPageCount}`,
      );

      if (!DRY_RUN) {
        await prisma.calibrationRun.update({
          where: { id: run.id },
          data: { summary: nextSummary },
        });
      }
      updated++;
    } catch (err) {
      failed++;
      console.error(`[fail] ${docName} (run ${run.id}):`, err);
    }
  }

  console.log(
    `\nDone. updated=${updated} skipped=${skipped} failed=${failed}` +
      (DRY_RUN ? ' (dry run)' : ''),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
