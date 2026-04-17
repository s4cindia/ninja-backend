#!/usr/bin/env node
/**
 * Spot-check script for annotation quality verification (Phase 3, Stage 3A).
 *
 * Designed to run as an ECS task inside the VPC where the staging RDS is accessible.
 * Plan files are stored in S3 so they persist between ECS task invocations.
 *
 * Usage (via ECS run-task command override):
 *   node scripts/spot-check-ecs.js list
 *   node scripts/spot-check-ecs.js pick  <runId> [pages=30] [seed=42]
 *   node scripts/spot-check-ecs.js reset <runId>
 *   node scripts/spot-check-ecs.js compare <runId>
 *   node scripts/spot-check-ecs.js restore <runId>
 *
 * Environment (injected by ECS task definition):
 *   DATABASE_URL  — PostgreSQL connection string (from Secrets Manager)
 *
 * Plan files stored at: s3://ninja-epub-staging/spot-checks/<runId>.json
 */

'use strict';

const { PrismaClient } = require('@prisma/client');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');

const prisma = new PrismaClient();
const s3 = new S3Client({ region: 'ap-south-1' });

const S3_BUCKET = 'ninja-epub-staging';
const S3_PREFIX = 'spot-checks';
const PASS_THRESHOLD = 85.0;

// ---------------------------------------------------------------------------
// YOLO label normalisation
// ---------------------------------------------------------------------------
const LABEL_TO_YOLO = {
  'paragraph': 'paragraph', 'p': 'paragraph',
  'section-header': 'section-header',
  'h1': 'section-header', 'h2': 'section-header', 'h3': 'section-header',
  'h4': 'section-header', 'h5': 'section-header', 'h6': 'section-header',
  'table': 'table', 'tbl': 'table',
  'figure': 'figure', 'fig': 'figure',
  'caption': 'caption', 'cap': 'caption',
  'footnote': 'footnote', 'fn': 'footnote',
  'header': 'header', 'hdr': 'header',
  'footer': 'footer', 'ftr': 'footer',
  'list-item': 'list-item', 'li': 'list-item',
  'toci': 'toci',
  'formula': 'formula',
};

function normalizeLabel(label) {
  if (!label) return null;
  return LABEL_TO_YOLO[label.trim().toLowerCase()] || null;
}

// ---------------------------------------------------------------------------
// S3 helpers for plan files
// ---------------------------------------------------------------------------
function planKey(runId) {
  return `${S3_PREFIX}/spot-check-${runId}.json`;
}

async function savePlan(runId, plan) {
  const key = planKey(runId);
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: JSON.stringify(plan, null, 2),
    ContentType: 'application/json',
  }));
  console.log(`Plan saved to s3://${S3_BUCKET}/${key}`);
}

async function loadPlan(runId) {
  const key = planKey(runId);
  try {
    const resp = await s3.send(new GetObjectCommand({ Bucket: S3_BUCKET, Key: key }));
    const body = await resp.Body.transformToString();
    return JSON.parse(body);
  } catch (err) {
    if (err.name === 'NoSuchKey') {
      console.error(`ERROR: No plan file found at s3://${S3_BUCKET}/${key}`);
      console.error('Run "pick" first to create a plan.');
      process.exit(1);
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Seeded random sampling (simple LCG for reproducibility)
// ---------------------------------------------------------------------------
function seededSample(arr, n, seed) {
  if (seed == null) {
    // Fisher-Yates with Math.random
    const copy = [...arr];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy.slice(0, n);
  }
  // Seeded: use a simple mulberry32 PRNG
  let s = seed | 0;
  function rand() {
    s |= 0; s = s + 0x6D2B79F5 | 0;
    let t = Math.imul(s ^ s >>> 15, 1 | s);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  }
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

// ---------------------------------------------------------------------------
// list — show calibration runs
// ---------------------------------------------------------------------------
async function cmdList() {
  const runs = await prisma.calibrationRun.findMany({
    where: { isArchived: false },
    include: { corpusDocument: true },
    orderBy: { runDate: 'desc' },
  });

  if (runs.length === 0) {
    console.log('No calibration runs found.');
    return;
  }

  console.log('');
  console.log(`${'Run ID'.padEnd(28)} ${'Title'.padEnd(45)} ${'Green'.padStart(6)} ${'Amber'.padStart(6)} ${'Red'.padStart(6)}`);
  console.log('-'.repeat(100));

  for (const r of runs) {
    const total = await prisma.zone.count({ where: { calibrationRunId: r.id } });
    const labeled = await prisma.zone.count({
      where: { calibrationRunId: r.id, operatorLabel: { not: null } },
    });
    const title = (r.corpusDocument?.filename || '?').substring(0, 44);
    console.log(
      `${r.id.padEnd(28)} ${title.padEnd(45)} ${String(r.greenCount || 0).padStart(6)} ${String(r.amberCount || 0).padStart(6)} ${String(r.redCount || 0).padStart(6)}  zones=${total} labeled=${labeled}`
    );
  }
  console.log('');
}

// ---------------------------------------------------------------------------
// pick — select random pages and snapshot baseline
// ---------------------------------------------------------------------------
async function cmdPick(runId, numPages, seed) {
  // Verify run exists
  const run = await prisma.calibrationRun.findUnique({
    where: { id: runId },
    include: { corpusDocument: true },
  });
  if (!run) {
    console.error(`ERROR: CalibrationRun '${runId}' not found.`);
    process.exit(1);
  }

  console.log(`Title: ${run.corpusDocument?.filename || '?'}`);
  console.log(`Run ID: ${runId}`);

  // Find all page numbers with at least one human-labeled zone
  const pages = await prisma.zone.findMany({
    where: { calibrationRunId: runId, operatorLabel: { not: null } },
    select: { pageNumber: true },
    distinct: ['pageNumber'],
    orderBy: { pageNumber: 'asc' },
  });
  const annotatedPages = pages.map(p => p.pageNumber);

  if (annotatedPages.length === 0) {
    console.error('ERROR: No annotated pages found for this run.');
    process.exit(1);
  }

  const n = Math.min(numPages, annotatedPages.length);
  if (n < numPages) {
    console.log(`WARNING: Only ${annotatedPages.length} annotated pages available, using all.`);
  }

  const selectedPages = seededSample(annotatedPages, n, seed).sort((a, b) => a - b);
  console.log(`Selected ${selectedPages.length} pages from ${annotatedPages.length} annotated pages`);
  console.log(`Pages: ${JSON.stringify(selectedPages)}`);

  // Snapshot all zones on selected pages
  const zones = await prisma.zone.findMany({
    where: {
      calibrationRunId: runId,
      pageNumber: { in: selectedPages },
    },
    select: {
      id: true,
      pageNumber: true,
      operatorLabel: true,
      decision: true,
      verifiedAt: true,
      verifiedBy: true,
      operatorVerified: true,
      type: true,
      reconciliationBucket: true,
      aiLabel: true,
      aiConfidence: true,
    },
    orderBy: [{ pageNumber: 'asc' }, { id: 'asc' }],
  });

  const baseline = zones.map(z => ({
    id: z.id,
    pageNumber: z.pageNumber,
    operatorLabel: z.operatorLabel,
    decision: z.decision,
    verifiedAt: z.verifiedAt ? z.verifiedAt.toISOString() : null,
    verifiedBy: z.verifiedBy,
    operatorVerified: z.operatorVerified,
    type: z.type,
    reconciliationBucket: z.reconciliationBucket,
    aiLabel: z.aiLabel,
    aiConfidence: z.aiConfidence,
  }));

  const labeledCount = baseline.filter(z => z.operatorLabel).length;

  const plan = {
    version: 1,
    runId,
    title: run.corpusDocument?.filename || null,
    createdAt: new Date().toISOString(),
    seed,
    selectedPages,
    totalAnnotatedPages: annotatedPages.length,
    totalZonesOnPages: baseline.length,
    labeledZonesOnPages: labeledCount,
    baseline,
    status: 'picked',
  };

  await savePlan(runId, plan);

  console.log(`\nTotal zones on selected pages: ${baseline.length}`);
  console.log(`Zones with operator labels:    ${labeledCount}`);
  console.log(`Zones without operator labels:  ${baseline.length - labeledCount}`);
  console.log(`\nNext: run "reset ${runId}" to clear those pages for the second annotator.`);
}

// ---------------------------------------------------------------------------
// reset — clear operator decisions on spot-check pages
// ---------------------------------------------------------------------------
async function cmdReset(runId) {
  const plan = await loadPlan(runId);

  if (plan.status !== 'picked') {
    console.error(`ERROR: Plan status is '${plan.status}', expected 'picked'.`);
    if (plan.status === 'reset') {
      console.error('Reset already applied. Use "compare" after second annotator reviews.');
    }
    process.exit(1);
  }

  const pages = plan.selectedPages;
  console.log(`Run ID:        ${runId}`);
  console.log(`Title:         ${plan.title || '?'}`);
  console.log(`Pages:         ${JSON.stringify(pages)}`);
  console.log(`Zones to reset: ${plan.labeledZonesOnPages}`);
  console.log('');
  console.log('Clearing operatorLabel, decision, verifiedAt, verifiedBy on selected pages...');

  const result = await prisma.zone.updateMany({
    where: {
      calibrationRunId: runId,
      pageNumber: { in: pages },
      operatorLabel: { not: null },
    },
    data: {
      operatorLabel: null,
      decision: null,
      verifiedAt: null,
      verifiedBy: null,
      operatorVerified: false,
    },
  });

  plan.status = 'reset';
  plan.resetAt = new Date().toISOString();
  plan.zonesReset = result.count;

  await savePlan(runId, plan);

  console.log(`\nReset ${result.count} zones on ${pages.length} pages.`);
  console.log('');
  console.log('Next steps:');
  console.log(`  1. Assign a DIFFERENT annotator to review pages: ${JSON.stringify(pages)}`);
  console.log(`  2. After they finish, run: "compare ${runId}"`);
  console.log(`  3. If something goes wrong:  "restore ${runId}"`);
}

// ---------------------------------------------------------------------------
// compare — compare new annotations against baseline
// ---------------------------------------------------------------------------
async function cmdCompare(runId) {
  const plan = await loadPlan(runId);

  if (!['reset', 'compared'].includes(plan.status)) {
    console.error(`ERROR: Plan status is '${plan.status}', expected 'reset'.`);
    process.exit(1);
  }

  const pages = plan.selectedPages;
  const baselineById = {};
  for (const z of plan.baseline) {
    baselineById[z.id] = z;
  }

  // Get current state
  const currentZones = await prisma.zone.findMany({
    where: {
      calibrationRunId: runId,
      pageNumber: { in: pages },
    },
    select: { id: true, pageNumber: true, operatorLabel: true, decision: true },
    orderBy: [{ pageNumber: 'asc' }, { id: 'asc' }],
  });
  const currentById = {};
  for (const z of currentZones) {
    currentById[z.id] = z;
  }

  // Compare zone by zone
  let agreements = 0;
  let disagreements = 0;
  let notReviewed = 0;
  let noOriginal = 0;
  const details = [];

  for (const [zoneId, old] of Object.entries(baselineById)) {
    const oldLabel = old.operatorLabel;
    const oldDecision = old.decision;

    if (!oldLabel) { noOriginal++; continue; }

    const cur = currentById[zoneId];
    if (!cur) { notReviewed++; continue; }

    const newLabel = cur.operatorLabel;
    const newDecision = cur.decision;

    if (!newLabel && !newDecision) { notReviewed++; continue; }

    // Both rejected
    if (oldDecision === 'REJECTED' && newDecision === 'REJECTED') { agreements++; continue; }

    // One rejected, one not
    if ((oldDecision === 'REJECTED') !== (newDecision === 'REJECTED')) {
      disagreements++;
      details.push({
        zoneId, pageNumber: old.pageNumber, type: old.type, bucket: old.reconciliationBucket,
        original: oldDecision === 'REJECTED' ? 'REJECTED' : oldLabel,
        spotCheck: newDecision === 'REJECTED' ? 'REJECTED' : newLabel,
        originalYolo: oldDecision === 'REJECTED' ? 'REJECTED' : normalizeLabel(oldLabel),
        spotCheckYolo: newDecision === 'REJECTED' ? 'REJECTED' : normalizeLabel(newLabel),
      });
      continue;
    }

    // Both have labels
    const oldYolo = normalizeLabel(oldLabel);
    const newYolo = normalizeLabel(newLabel);
    if (oldYolo === newYolo) {
      agreements++;
    } else {
      disagreements++;
      details.push({
        zoneId, pageNumber: old.pageNumber, type: old.type, bucket: old.reconciliationBucket,
        original: oldLabel, spotCheck: newLabel,
        originalYolo: oldYolo || `UNMAPPED(${oldLabel})`,
        spotCheckYolo: newYolo || `UNMAPPED(${newLabel})`,
      });
    }
  }

  const totalCompared = agreements + disagreements;
  const agreementPct = totalCompared > 0 ? (agreements / totalCompared * 100) : 0;
  const passed = agreementPct >= PASS_THRESHOLD;

  // Breakdowns
  const patternCounts = {};
  const pageDisagreeCounts = {};
  const bucketStats = { GREEN: [0, 0], AMBER: [0, 0], RED: [0, 0] };

  for (const d of details) {
    const pattern = `${d.originalYolo} -> ${d.spotCheckYolo}`;
    patternCounts[pattern] = (patternCounts[pattern] || 0) + 1;
    pageDisagreeCounts[d.pageNumber] = (pageDisagreeCounts[d.pageNumber] || 0) + 1;
  }

  // Bucket-level agreement
  for (const [zoneId, old] of Object.entries(baselineById)) {
    if (!old.operatorLabel) continue;
    const cur = currentById[zoneId] || {};
    if (!cur.operatorLabel && !cur.decision) continue;
    const bucket = ['GREEN', 'AMBER', 'RED'].includes(old.reconciliationBucket)
      ? old.reconciliationBucket : 'RED';
    if (old.decision === 'REJECTED' && cur.decision === 'REJECTED') {
      bucketStats[bucket][0]++;
    } else if ((old.decision === 'REJECTED') !== (cur.decision === 'REJECTED')) {
      bucketStats[bucket][1]++;
    } else {
      const oY = normalizeLabel(old.operatorLabel);
      const nY = normalizeLabel(cur.operatorLabel);
      if (oY === nY) bucketStats[bucket][0]++;
      else bucketStats[bucket][1]++;
    }
  }

  // Print report
  console.log('');
  console.log('='.repeat(65));
  console.log('  SPOT-CHECK COMPARISON REPORT');
  console.log('='.repeat(65));
  console.log(`  Run ID:             ${runId}`);
  console.log(`  Title:              ${plan.title || '?'}`);
  console.log(`  Pages checked:      ${pages.length}`);
  console.log(`  Zones compared:     ${totalCompared}`);
  console.log(`  Not yet reviewed:   ${notReviewed}`);
  console.log(`  No original label:  ${noOriginal}`);
  console.log('');
  console.log(`  Agreements:         ${agreements}`);
  console.log(`  Disagreements:      ${disagreements}`);
  console.log(`  Agreement rate:     ${agreementPct.toFixed(1)}%`);
  console.log(`  Threshold:          ${PASS_THRESHOLD.toFixed(0)}%`);
  console.log('');
  console.log(`  VERDICT:  ${passed ? 'PASS' : 'FAIL'}`);
  console.log('');

  if (notReviewed > 0) {
    const reviewedPct = totalCompared / (totalCompared + notReviewed) * 100;
    console.log(`  WARNING: ${notReviewed} zones not reviewed by second annotator.`);
    console.log(`           Coverage: ${reviewedPct.toFixed(0)}% of labeled zones.`);
    if (reviewedPct < 80) {
      console.log('           Coverage below 80% — results may not be representative.');
    }
    console.log('');
  }

  console.log('-'.repeat(65));
  console.log('  AGREEMENT BY RECONCILIATION BUCKET');
  console.log('-'.repeat(65));
  for (const bucket of ['GREEN', 'AMBER', 'RED']) {
    const [a, d] = bucketStats[bucket];
    const total = a + d;
    if (total > 0) {
      console.log(`  ${bucket.padStart(6)}: ${String(a).padStart(5)} agree / ${String(d).padStart(3)} disagree = ${(a / total * 100).toFixed(1)}%  (n=${total})`);
    } else {
      console.log(`  ${bucket.padStart(6)}: no zones compared`);
    }
  }
  console.log('');

  if (disagreements > 0) {
    console.log('-'.repeat(65));
    console.log('  DISAGREEMENT PATTERNS  (original -> spot-check)');
    console.log('-'.repeat(65));
    const sorted = Object.entries(patternCounts).sort((a, b) => b[1] - a[1]).slice(0, 15);
    for (const [pattern, count] of sorted) {
      console.log(`    ${pattern}: ${count}`);
    }
    console.log('');

    console.log('-'.repeat(65));
    console.log('  PAGES WITH MOST DISAGREEMENTS');
    console.log('-'.repeat(65));
    const pgSorted = Object.entries(pageDisagreeCounts).sort((a, b) => b[1] - a[1]).slice(0, 10);
    for (const [pg, count] of pgSorted) {
      console.log(`    Page ${pg}: ${count} disagreement(s)`);
    }
    console.log('');
  }

  // Save results
  plan.status = 'compared';
  plan.comparedAt = new Date().toISOString();
  plan.result = {
    zonesCompared: totalCompared,
    notReviewed,
    noOriginalLabel: noOriginal,
    agreements,
    disagreements,
    agreementPct: Math.round(agreementPct * 10) / 10,
    passed,
    threshold: PASS_THRESHOLD,
    bucketAgreement: Object.fromEntries(
      Object.entries(bucketStats).map(([b, [a, d]]) => [b, {
        agree: a, disagree: d,
        pct: (a + d) > 0 ? Math.round(a / (a + d) * 1000) / 10 : null,
      }])
    ),
    disagreementPatterns: patternCounts,
    disagreementDetails: details,
  };

  await savePlan(runId, plan);

  if (passed) {
    console.log("Title PASSED. Second annotator's labels are kept.");
    console.log('Proceed to complete remaining pages (Stage 3B).');
  } else {
    console.log('Title FAILED. Original annotation is unreliable.');
    console.log(`Options: reset entire title (Stage 3C), or "restore ${runId}" first.`);
  }
}

// ---------------------------------------------------------------------------
// restore — undo the reset by writing back original labels
// ---------------------------------------------------------------------------
async function cmdRestore(runId) {
  const plan = await loadPlan(runId);

  if (!['reset', 'compared'].includes(plan.status)) {
    console.error(`ERROR: Plan status is '${plan.status}' — nothing to restore.`);
    process.exit(1);
  }

  const zonesToRestore = plan.baseline.filter(z => z.operatorLabel);
  console.log(`Run ID:            ${runId}`);
  console.log(`Title:             ${plan.title || '?'}`);
  console.log(`Pages:             ${JSON.stringify(plan.selectedPages)}`);
  console.log(`Zones to restore:  ${zonesToRestore.length}`);
  console.log('');
  console.log('Restoring original labels...');

  let restored = 0;
  // Batch in groups of 50 to avoid overwhelming the DB
  for (let i = 0; i < zonesToRestore.length; i += 50) {
    const batch = zonesToRestore.slice(i, i + 50);
    await Promise.all(batch.map(z =>
      prisma.zone.update({
        where: { id: z.id },
        data: {
          operatorLabel: z.operatorLabel,
          decision: z.decision,
          verifiedAt: z.verifiedAt ? new Date(z.verifiedAt) : null,
          verifiedBy: z.verifiedBy,
          operatorVerified: z.operatorVerified ?? true,
        },
      })
    ));
    restored += batch.length;
  }

  plan.status = 'restored';
  plan.restoredAt = new Date().toISOString();
  plan.zonesRestored = restored;

  await savePlan(runId, plan);

  console.log(`\nRestored ${restored} zones to original labels.`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
  const [,, command, ...args] = process.argv;

  if (!command || command === '--help' || command === '-h') {
    console.log(`
Spot-check annotation quality for YOLO training data.

Usage:
  node scripts/spot-check-ecs.js list
  node scripts/spot-check-ecs.js pick  <runId> [pages] [seed]
  node scripts/spot-check-ecs.js reset <runId>
  node scripts/spot-check-ecs.js compare <runId>
  node scripts/spot-check-ecs.js restore <runId>

Plan files stored at: s3://${S3_BUCKET}/${S3_PREFIX}/spot-check-<runId>.json
    `);
    return;
  }

  try {
    switch (command) {
      case 'list':
        await cmdList();
        break;
      case 'pick': {
        const runId = args[0];
        const numPages = parseInt(args[1]) || 30;
        const seed = args[2] != null ? parseInt(args[2]) : null;
        if (!runId) { console.error('Usage: pick <runId> [pages] [seed]'); process.exit(1); }
        await cmdPick(runId, numPages, seed);
        break;
      }
      case 'reset': {
        const runId = args[0];
        if (!runId) { console.error('Usage: reset <runId>'); process.exit(1); }
        await cmdReset(runId);
        break;
      }
      case 'compare': {
        const runId = args[0];
        if (!runId) { console.error('Usage: compare <runId>'); process.exit(1); }
        await cmdCompare(runId);
        break;
      }
      case 'restore': {
        const runId = args[0];
        if (!runId) { console.error('Usage: restore <runId>'); process.exit(1); }
        await cmdRestore(runId);
        break;
      }
      default:
        console.error(`Unknown command: ${command}`);
        process.exit(1);
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
