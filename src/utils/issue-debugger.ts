/**
 * Deep debugging utility to track every single issue through the pipeline
 */

import { logger } from '../lib/logger';

interface TrackedIssue {
  id: string;
  code: string;
  source: string;
  location: string;
  hash: string;
  seenAt: string[];
}

const trackedIssues = new Map<string, TrackedIssue>();

/**
 * Generate a unique hash for an issue
 */
function generateIssueHash(issue: Record<string, unknown>): string {
  const code = String(issue.code || issue.ruleId || 'UNKNOWN');
  const source = String(issue.source || 'unknown').toLowerCase();
  const location = String(issue.location || issue.file || issue.path || '');
  const message = String(issue.message || issue.description || '').substring(0, 50);

  return `${code}|${source}|${location}|${message}`;
}

/**
 * Register issues at a specific stage
 */
export function trackIssuesAtStage(stage: string, issues: Record<string, unknown>[]): void {
  logger.info(`\nTRACKING ISSUES AT: ${stage}`);
  logger.info(`   Count: ${issues.length}`);

  const stageHashes = new Set<string>();

  issues.forEach((issue) => {
    const hash = generateIssueHash(issue);
    stageHashes.add(hash);

    if (!trackedIssues.has(hash)) {
      trackedIssues.set(hash, {
        id: `issue-${trackedIssues.size}`,
        code: String(issue.code || issue.ruleId || 'UNKNOWN'),
        source: String(issue.source || 'unknown'),
        location: String(issue.location || issue.file || ''),
        hash,
        seenAt: [stage],
      });
    } else {
      trackedIssues.get(hash)!.seenAt.push(stage);
    }
  });

  logger.info(`   Unique hashes at this stage: ${stageHashes.size}`);
}

/**
 * Find issues that were seen at stage1 but not at stage2
 */
export function findMissingIssues(stage1: string, stage2: string): TrackedIssue[] {
  const missing: TrackedIssue[] = [];

  trackedIssues.forEach((issue) => {
    const seenAtStage1 = issue.seenAt.includes(stage1);
    const seenAtStage2 = issue.seenAt.includes(stage2);

    if (seenAtStage1 && !seenAtStage2) {
      missing.push(issue);
    }
  });

  return missing;
}

/**
 * Print detailed report of all tracked issues
 */
export function printTrackingReport(): void {
  logger.info('\n' + '='.repeat(80));
  logger.info('ISSUE TRACKING REPORT');
  logger.info('='.repeat(80));

  const stageGroups = new Map<string, TrackedIssue[]>();

  trackedIssues.forEach((issue) => {
    const lastStage = issue.seenAt[issue.seenAt.length - 1];
    if (!stageGroups.has(lastStage)) {
      stageGroups.set(lastStage, []);
    }
    stageGroups.get(lastStage)!.push(issue);
  });

  logger.info(`\nTotal unique issues tracked: ${trackedIssues.size}`);
  logger.info('\nIssues by last seen stage:');

  stageGroups.forEach((issues, stage) => {
    logger.info(`\n  ${stage}: ${issues.length} issues`);
    issues.forEach((issue) => {
      logger.info(`    - [${issue.source}] ${issue.code} @ ${issue.location || 'N/A'}`);
      logger.info(`      Journey: ${issue.seenAt.join(' -> ')}`);
    });
  });

  const finalStage = 'PLAN_TASKS';
  const missingFromFinal = Array.from(trackedIssues.values()).filter(
    issue => !issue.seenAt.includes(finalStage)
  );

  if (missingFromFinal.length > 0) {
    logger.warn('\nISSUES THAT DID NOT REACH FINAL STAGE:');
    missingFromFinal.forEach((issue) => {
      logger.warn(`  - [${issue.source}] ${issue.code}`);
      logger.warn(`    Location: ${issue.location || 'N/A'}`);
      logger.warn(`    Last seen: ${issue.seenAt[issue.seenAt.length - 1]}`);
      logger.warn(`    Full journey: ${issue.seenAt.join(' -> ')}`);
    });
  }
}

/**
 * Clear tracking data
 */
export function clearTracking(): void {
  trackedIssues.clear();
}

/**
 * Get all tracked issues
 */
export function getAllTrackedIssues(): TrackedIssue[] {
  return Array.from(trackedIssues.values());
}

/**
 * Get tracking summary
 */
export function getTrackingSummary(): {
  total: number;
  bySource: Record<string, number>;
  byStage: Record<string, number>;
  missingFromFinal: TrackedIssue[];
} {
  const bySource: Record<string, number> = {};
  const byStage: Record<string, number> = {};

  trackedIssues.forEach((issue) => {
    bySource[issue.source] = (bySource[issue.source] || 0) + 1;
    const lastStage = issue.seenAt[issue.seenAt.length - 1];
    byStage[lastStage] = (byStage[lastStage] || 0) + 1;
  });

  const missingFromFinal = Array.from(trackedIssues.values()).filter(
    issue => !issue.seenAt.includes('PLAN_TASKS')
  );

  return {
    total: trackedIssues.size,
    bySource,
    byStage,
    missingFromFinal,
  };
}
