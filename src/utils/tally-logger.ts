/**
 * Utility for logging tally information for debugging
 */

export function logTallyComparison(
  stage1Name: string,
  stage1Total: number,
  stage2Name: string,
  stage2Total: number
): void {
  const match = stage1Total === stage2Total;
  const symbol = match ? '✅' : '❌';
  const diff = stage1Total - stage2Total;

  console.log(`\n${symbol} Tally Check: ${stage1Name} → ${stage2Name}`);
  console.log(`   ${stage1Name}: ${stage1Total}`);
  console.log(`   ${stage2Name}: ${stage2Total}`);

  if (!match) {
    console.log(`   DIFFERENCE: ${diff > 0 ? '-' : '+'}${Math.abs(diff)} issues`);
  }
}

export function logFullTally(label: string, tally: {
  total: number;
  bySource?: { epubCheck: number; ace: number; jsAuditor: number };
  bySeverity?: { critical: number; serious: number; moderate: number; minor: number };
  byClassification?: { autoFixable: number; quickFix: number; manual: number };
}): void {
  console.log(`\n📊 ${label}`);
  console.log(`   Total: ${tally.total}`);

  if (tally.bySource) {
    const sum = tally.bySource.epubCheck + tally.bySource.ace + tally.bySource.jsAuditor;
    console.log(`   By Source: EPUBCheck=${tally.bySource.epubCheck}, ACE=${tally.bySource.ace}, JS=${tally.bySource.jsAuditor} (sum=${sum})`);
  }

  if (tally.bySeverity) {
    const sum = tally.bySeverity.critical + tally.bySeverity.serious + tally.bySeverity.moderate + tally.bySeverity.minor;
    console.log(`   By Severity: Crit=${tally.bySeverity.critical}, Ser=${tally.bySeverity.serious}, Mod=${tally.bySeverity.moderate}, Min=${tally.bySeverity.minor} (sum=${sum})`);
  }

  if (tally.byClassification) {
    const sum = tally.byClassification.autoFixable + tally.byClassification.quickFix + tally.byClassification.manual;
    console.log(`   By Classification: Auto=${tally.byClassification.autoFixable}, QF=${tally.byClassification.quickFix}, Manual=${tally.byClassification.manual} (sum=${sum})`);
  }
}
