/**
 * Diagnostic utility to track issues through the pipeline
 * Use this to identify where issues are being lost
 */

import { logger } from '../lib/logger';

interface IssueSnapshot {
  stage: string;
  timestamp: string;
  count: number;
  bySource: Record<string, number>;
  byCode: Record<string, number>;
  issues: Array<{
    code: string;
    source: string;
    location?: string;
  }>;
}

const issueSnapshots: IssueSnapshot[] = [];

function normalizeSource(source: string): string {
  if (!source) return 'unknown';
  const s = source.toLowerCase();
  if (s.includes('epubcheck')) return 'epubcheck';
  if (s.includes('ace')) return 'ace';
  if (s.includes('js') || s.includes('auditor')) return 'jsauditor';
  return source;
}

export function captureIssueSnapshot(
  stage: string,
  issues: Record<string, unknown>[],
  verbose: boolean = false
): IssueSnapshot {
  const bySource: Record<string, number> = {};
  const byCode: Record<string, number> = {};

  const issueDetails = issues.map(issue => {
    const source = normalizeSource((issue.source as string) || (issue.ruleSource as string) || 'unknown');
    const code = (issue.code as string) || (issue.issueCode as string) || (issue.ruleId as string) || 'UNKNOWN';

    bySource[source] = (bySource[source] || 0) + 1;
    byCode[code] = (byCode[code] || 0) + 1;

    return {
      code,
      source,
      location: (issue.location as string) || (issue.file as string),
    };
  });

  const snapshot: IssueSnapshot = {
    stage,
    timestamp: new Date().toISOString(),
    count: issues.length,
    bySource,
    byCode,
    issues: issueDetails,
  };

  issueSnapshots.push(snapshot);

  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`ISSUE SNAPSHOT: ${stage}`);
  logger.info(`${'='.repeat(60)}`);
  logger.info(`Total: ${snapshot.count}`);
  logger.info(`By Source: ${JSON.stringify(bySource)}`);
  logger.info(`By Code: ${JSON.stringify(byCode)}`);

  if (verbose) {
    logger.info(`\nAll Issues:`);
    issueDetails.forEach((issue, i) => {
      logger.info(`  ${i + 1}. [${issue.source}] ${issue.code} @ ${issue.location || 'N/A'}`);
    });
  }

  return snapshot;
}

export function compareSnapshots(stage1: string, stage2: string): void {
  const snap1 = issueSnapshots.find(s => s.stage === stage1);
  const snap2 = issueSnapshots.find(s => s.stage === stage2);

  if (!snap1 || !snap2) {
    logger.error(`Cannot compare: missing snapshot for ${!snap1 ? stage1 : stage2}`);
    return;
  }

  logger.info(`\n${'='.repeat(60)}`);
  logger.info(`COMPARISON: ${stage1} → ${stage2}`);
  logger.info(`${'='.repeat(60)}`);
  logger.info(`Count: ${snap1.count} → ${snap2.count} (${snap2.count - snap1.count})`);

  const snap2Codes = new Set(snap2.issues.map(i => `${i.source}:${i.code}:${i.location}`));
  const missing = snap1.issues.filter(i => !snap2Codes.has(`${i.source}:${i.code}:${i.location}`));

  if (missing.length > 0) {
    logger.warn(`\nMISSING ISSUES (${missing.length}):`);
    missing.forEach((issue, i) => {
      logger.warn(`  ${i + 1}. [${issue.source}] ${issue.code} @ ${issue.location || 'N/A'}`);
    });
  } else {
    logger.info(`\nNo issues lost`);
  }

  const snap1Codes = new Set(snap1.issues.map(i => `${i.source}:${i.code}:${i.location}`));
  const added = snap2.issues.filter(i => !snap1Codes.has(`${i.source}:${i.code}:${i.location}`));

  if (added.length > 0) {
    logger.info(`\nADDED ISSUES (${added.length}):`);
    added.forEach((issue, i) => {
      logger.info(`  ${i + 1}. [${issue.source}] ${issue.code} @ ${issue.location || 'N/A'}`);
    });
  }
}

export function clearSnapshots(): void {
  issueSnapshots.length = 0;
}

export function getAllSnapshots(): IssueSnapshot[] {
  return [...issueSnapshots];
}
