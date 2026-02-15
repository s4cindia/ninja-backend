/**
 * Data Migration: Sync citationIds to ReferenceListEntryCitation
 *
 * This script migrates data from the deprecated citationIds String[] field
 * in ReferenceListEntry to the ReferenceListEntryCitation junction table.
 *
 * Usage:
 *   npx tsx scripts/migrate-citation-links.ts
 *   # or
 *   npm run script:migrate-citation-links
 *
 * Options:
 *   --dry-run    Preview changes without applying them
 *   --verbose    Show detailed progress
 *
 * See: TECHNICAL-DEBT.md TD-006
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

interface MigrationStats {
  totalEntries: number;
  entriesWithCitations: number;
  linksCreated: number;
  linksSkipped: number;
  errors: number;
}

async function migrateCitationLinks(options: { dryRun: boolean; verbose: boolean }): Promise<MigrationStats> {
  const { dryRun, verbose } = options;

  const stats: MigrationStats = {
    totalEntries: 0,
    entriesWithCitations: 0,
    linksCreated: 0,
    linksSkipped: 0,
    errors: 0,
  };

  console.log('\n=== Citation Links Migration ===');
  console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE'}`);
  console.log('');

  // Get all ReferenceListEntry records with their existing citationLinks
  const entries = await prisma.referenceListEntry.findMany({
    include: {
      citationLinks: true,
    },
  });

  stats.totalEntries = entries.length;
  console.log(`Found ${entries.length} ReferenceListEntry records`);

  for (const entry of entries) {
    // Skip entries without citationIds
    if (!entry.citationIds || entry.citationIds.length === 0) {
      continue;
    }

    stats.entriesWithCitations++;

    // Get existing linked citation IDs
    const existingLinkedIds = new Set(entry.citationLinks.map(link => link.citationId));

    // Find citation IDs that need to be linked
    const idsToLink = entry.citationIds.filter(id => !existingLinkedIds.has(id));

    if (idsToLink.length === 0) {
      if (verbose) {
        console.log(`  Entry ${entry.id}: Already synced (${entry.citationIds.length} citations)`);
      }
      stats.linksSkipped += entry.citationIds.length;
      continue;
    }

    if (verbose) {
      console.log(`  Entry ${entry.id}: Creating ${idsToLink.length} new links`);
    }

    // Verify citations exist before creating links
    const existingCitations = await prisma.citation.findMany({
      where: {
        id: { in: idsToLink },
      },
      select: { id: true },
    });

    const validCitationIds = new Set(existingCitations.map(c => c.id));
    const invalidIds = idsToLink.filter(id => !validCitationIds.has(id));

    if (invalidIds.length > 0) {
      console.warn(`  Entry ${entry.id}: ${invalidIds.length} citation IDs not found: ${invalidIds.join(', ')}`);
      stats.errors += invalidIds.length;
    }

    // Create links for valid citations
    const validIdsToLink = idsToLink.filter(id => validCitationIds.has(id));

    if (validIdsToLink.length === 0) {
      continue;
    }

    if (!dryRun) {
      try {
        await prisma.referenceListEntryCitation.createMany({
          data: validIdsToLink.map(citationId => ({
            referenceListEntryId: entry.id,
            citationId,
          })),
          skipDuplicates: true,
        });
        stats.linksCreated += validIdsToLink.length;
      } catch (error) {
        console.error(`  Entry ${entry.id}: Failed to create links:`, error);
        stats.errors += validIdsToLink.length;
      }
    } else {
      stats.linksCreated += validIdsToLink.length;
    }
  }

  return stats;
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const verbose = args.includes('--verbose');

  try {
    const stats = await migrateCitationLinks({ dryRun, verbose });

    console.log('\n=== Migration Summary ===');
    console.log(`Total ReferenceListEntry records: ${stats.totalEntries}`);
    console.log(`Entries with citationIds: ${stats.entriesWithCitations}`);
    console.log(`Links created: ${stats.linksCreated}${dryRun ? ' (would be created)' : ''}`);
    console.log(`Links skipped (already exist): ${stats.linksSkipped}`);
    console.log(`Errors: ${stats.errors}`);

    if (dryRun && stats.linksCreated > 0) {
      console.log('\nTo apply these changes, run without --dry-run');
    }

    if (stats.errors > 0) {
      console.log('\nNote: Some citationIds referenced non-existent citations.');
      console.log('These orphaned references should be cleaned up manually.');
    }

  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    await prisma.$disconnect();
  }
}

main();
