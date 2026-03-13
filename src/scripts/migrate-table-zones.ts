import { zoneService } from '../services/zone.service';
import { logger } from '../lib/logger';

async function main() {
  logger.info('Starting table zone migration...');
  const result = await zoneService.migrateExistingTableZones();
  logger.info(`Migration complete: ${result.migrated} migrated, ${result.skipped} skipped out of ${result.total} orphan TABLE zones`);
  logger.info(JSON.stringify(result, null, 2));
  process.exit(0);
}

main().catch((err) => {
  logger.error('Migration failed:', err);
  process.exit(1);
});
