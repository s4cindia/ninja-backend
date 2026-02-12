/**
 * Utility for logging tally information for debugging
 */

import { logger } from '../lib/logger';

export function logTallyComparison(
  stage1Name: string,
  stage1Total: number,
  stage2Name: string,
  stage2Total: number
): void {
  const match = stage1Total === stage2Total;
  const symbol = match ? 'OK' : 'MISMATCH';
  const diff = stage1Total - stage2Total;

  logger.info(`\n${symbol} Tally Check: ${stage1Name} → ${stage2Name}`);
  logger.info(`   ${stage1Name}: ${stage1Total}`);
  logger.info(`   ${stage2Name}: ${stage2Total}`);

  if (!match) {
    logger.warn(`   DIFFERENCE: ${diff > 0 ? '-' : '+'}${Math.abs(diff)} issues`);
  }
}

export function logFullTally(label: string, tally: {
  total: number;
  bySource?: { epubCheck: number; ace: number; jsAuditor: number };
  bySeverity?: { critical: number; serious: number; moderate: number; minor: number };
  byClassification?: { autoFixable: number; quickFix: number; manual: number };
}): void {
  logger.info(`\n${label}`);
  logger.info(`   Total: ${tally.total}`);

  if (tally.bySource) {
    const sum = tally.bySource.epubCheck + tally.bySource.ace + tally.bySource.jsAuditor;
    logger.info(`   By Source: EPUBCheck=${tally.bySource.epubCheck}, ACE=${tally.bySource.ace}, JS=${tally.bySource.jsAuditor} (sum=${sum})`);
  }

  if (tally.bySeverity) {
    const sum = tally.bySeverity.critical + tally.bySeverity.serious + tally.bySeverity.moderate + tally.bySeverity.minor;
    logger.info(`   By Severity: Crit=${tally.bySeverity.critical}, Ser=${tally.bySeverity.serious}, Mod=${tally.bySeverity.moderate}, Min=${tally.bySeverity.minor} (sum=${sum})`);
  }

  if (tally.byClassification) {
    const sum = tally.byClassification.autoFixable + tally.byClassification.quickFix + tally.byClassification.manual;
    logger.info(`   By Classification: Auto=${tally.byClassification.autoFixable}, QF=${tally.byClassification.quickFix}, Manual=${tally.byClassification.manual} (sum=${sum})`);
  }
}
