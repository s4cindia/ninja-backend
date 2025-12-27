/**
 * Diagnostic utility to track issues through the pipeline
 * Use this to identify where issues are being lost
 */

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
  issues: any[],
  verbose: boolean = false
): IssueSnapshot {
  const bySource: Record<string, number> = {};
  const byCode: Record<string, number> = {};

  const issueDetails = issues.map(issue => {
    const source = normalizeSource(issue.source || issue.ruleSource || 'unknown');
    const code = issue.code || issue.issueCode || issue.ruleId || 'UNKNOWN';

    bySource[source] = (bySource[source] || 0) + 1;
    byCode[code] = (byCode[code] || 0) + 1;

    return {
      code,
      source,
      location: issue.location || issue.file,
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

  console.log(`\n${'='.repeat(60)}`);
  console.log(`📸 ISSUE SNAPSHOT: ${stage}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Total: ${snapshot.count}`);
  console.log(`By Source:`, JSON.stringify(bySource, null, 2));
  console.log(`By Code:`, JSON.stringify(byCode, null, 2));

  if (verbose) {
    console.log(`\nAll Issues:`);
    issueDetails.forEach((issue, i) => {
      console.log(`  ${i + 1}. [${issue.source}] ${issue.code} @ ${issue.location || 'N/A'}`);
    });
  }

  return snapshot;
}

export function compareSnapshots(stage1: string, stage2: string): void {
  const snap1 = issueSnapshots.find(s => s.stage === stage1);
  const snap2 = issueSnapshots.find(s => s.stage === stage2);

  if (!snap1 || !snap2) {
    console.error(`Cannot compare: missing snapshot for ${!snap1 ? stage1 : stage2}`);
    return;
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log(`🔍 COMPARISON: ${stage1} → ${stage2}`);
  console.log(`${'='.repeat(60)}`);
  console.log(`Count: ${snap1.count} → ${snap2.count} (${snap2.count - snap1.count})`);

  const snap2Codes = new Set(snap2.issues.map(i => `${i.code}:${i.location}`));
  const missing = snap1.issues.filter(i => !snap2Codes.has(`${i.code}:${i.location}`));

  if (missing.length > 0) {
    console.log(`\n⚠️ MISSING ISSUES (${missing.length}):`);
    missing.forEach((issue, i) => {
      console.log(`  ${i + 1}. [${issue.source}] ${issue.code} @ ${issue.location || 'N/A'}`);
    });
  } else {
    console.log(`\n✅ No issues lost`);
  }

  const snap1Codes = new Set(snap1.issues.map(i => `${i.code}:${i.location}`));
  const added = snap2.issues.filter(i => !snap1Codes.has(`${i.code}:${i.location}`));

  if (added.length > 0) {
    console.log(`\n➕ ADDED ISSUES (${added.length}):`);
    added.forEach((issue, i) => {
      console.log(`  ${i + 1}. [${issue.source}] ${issue.code} @ ${issue.location || 'N/A'}`);
    });
  }
}

export function clearSnapshots(): void {
  issueSnapshots.length = 0;
}

export function getAllSnapshots(): IssueSnapshot[] {
  return [...issueSnapshots];
}
