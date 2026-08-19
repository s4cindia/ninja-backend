#!/usr/bin/env node
/**
 * estimate-gpu-blended-rate.js
 *
 * Computes the blended $/document GPU cost for Seam-C's on-demand
 * zone-detector (EC2 g4dn.xlarge, scale-to-zero) over a time window, by
 * pairing up [YoloScaler] scale-up/scale-down log lines into intervals,
 * summing GPU-hours, multiplying by the documented hourly rate, and
 * dividing by PDF_ACCESSIBILITY jobs created in the same window.
 *
 * This is a periodic, human-run tool — not a live per-request
 * computation (see infrastructure/gpu/README.md's cost table, which is
 * itself only a blended monthly estimate). It PRINTS the result; it does
 * not write .env or touch any deployed config. An operator reviews the
 * number and sets NINJA_GPU_BLENDED_COST_PER_DOC_USD accordingly.
 *
 * Usage:
 *   node scripts/estimate-gpu-blended-rate.js --file path/to/logs.txt
 *   node scripts/estimate-gpu-blended-rate.js --since 7d
 *   node scripts/estimate-gpu-blended-rate.js --since 7d --rate 1.20
 *
 * --file    Parse an existing log dump (e.g. `aws logs tail
 *           /ecs/ninja-backend-task --since 7d > logs.txt` run earlier,
 *           or one of the backend-logs*.txt dumps already in this repo).
 * --since   Pull fresh logs via `aws logs tail` for this window instead
 *           of reading a file (requires AWS CLI + credentials configured
 *           in this environment). Accepts anything `aws logs tail
 *           --since` accepts, e.g. "7d", "24h".
 * --rate    Override the $/GPU-hour rate. Default is derived from
 *           infrastructure/gpu/README.md's documented spot-pricing
 *           estimate (~$75/month at 2-3 hr/day => ~$1.00/hr) — pass the
 *           real On-Demand or Spot rate once you have current AWS
 *           Cost Explorer or Savings Plan numbers.
 */

const fs = require('fs');
const { execFileSync } = require('child_process');
const { PrismaClient } = require('@prisma/client');

const LOG_GROUP = '/ecs/ninja-backend-task';
// Derived from infrastructure/gpu/README.md: "$75/month at 2-3 hr/day"
// => $75 / (2.5 hr * 30 days) ~= $1.00/hr. Override with --rate once real
// AWS Cost Explorer / Savings Plan numbers are available.
const DEFAULT_HOURLY_RATE_USD = 1.0;

const LINE_PATTERN =
  /\[(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\].*\[YoloScaler\] scaling zone-detector service to (0|1)/;

function parseArgs(argv) {
  const args = { file: null, since: null, rate: DEFAULT_HOURLY_RATE_USD };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--file') args.file = argv[++i];
    else if (argv[i] === '--since') args.since = argv[++i];
    else if (argv[i] === '--rate') args.rate = parseFloat(argv[++i]);
  }
  return args;
}

function fetchLogText(args) {
  if (args.file) {
    return fs.readFileSync(args.file, 'utf8');
  }
  if (!args.since) {
    throw new Error('Pass --file <path> or --since <window> (e.g. 7d, 24h)');
  }
  console.log(`Pulling logs from ${LOG_GROUP} (since ${args.since}) via AWS CLI...`);
  return execFileSync(
    'aws',
    ['logs', 'tail', LOG_GROUP, '--since', args.since, '--filter-pattern', 'YoloScaler', '--format', 'short'],
    { encoding: 'utf8', maxBuffer: 200 * 1024 * 1024 },
  );
}

/** Pair scale-up (to 1) / scale-down (to 0) lines chronologically into [start, end] intervals. */
function parseScalerIntervals(logText) {
  const events = [];
  for (const line of logText.split('\n')) {
    const match = line.match(LINE_PATTERN);
    if (!match) continue;
    events.push({ at: new Date(match[1]).getTime(), toState: match[2] });
  }
  events.sort((a, b) => a.at - b.at);

  const intervals = [];
  let pendingStart = null;
  for (const event of events) {
    if (event.toState === '1') {
      if (pendingStart !== null) {
        console.warn(`Two scale-ups in a row at ${new Date(event.at).toISOString()} — ignoring the earlier one`);
      }
      pendingStart = event.at;
    } else if (event.toState === '0' && pendingStart !== null) {
      intervals.push({ start: pendingStart, end: event.at });
      pendingStart = null;
    }
  }
  if (pendingStart !== null) {
    console.warn(`Unmatched scale-up at ${new Date(pendingStart).toISOString()} (no scale-down found) — excluded from the total`);
  }

  return intervals;
}

async function countJobsInWindow(prisma, windowStart, windowEnd) {
  return prisma.job.count({
    where: {
      type: 'PDF_ACCESSIBILITY',
      createdAt: { gte: new Date(windowStart), lte: new Date(windowEnd) },
    },
  });
}

async function main() {
  const args = parseArgs(process.argv);
  const logText = fetchLogText(args);
  const intervals = parseScalerIntervals(logText);

  if (intervals.length === 0) {
    console.log('No complete [YoloScaler] scale-up/scale-down pairs found in the given window.');
    console.log('(Zero GPU activity is a valid outcome, not necessarily an error — but double-check the input if unexpected.)');
    return;
  }

  const totalGpuMs = intervals.reduce((sum, i) => sum + (i.end - i.start), 0);
  const totalGpuHours = totalGpuMs / 3_600_000;
  const windowStart = Math.min(...intervals.map((i) => i.start));
  const windowEnd = Math.max(...intervals.map((i) => i.end));

  const prisma = new PrismaClient();
  let documentCount;
  try {
    documentCount = await countJobsInWindow(prisma, windowStart, windowEnd);
  } finally {
    await prisma.$disconnect();
  }

  const totalGpuCostUsd = totalGpuHours * args.rate;
  const blendedCostPerDocUsd = documentCount > 0 ? totalGpuCostUsd / documentCount : null;

  console.log('');
  console.log(`Window:              ${new Date(windowStart).toISOString()} -> ${new Date(windowEnd).toISOString()}`);
  console.log(`Scale-up intervals:  ${intervals.length}`);
  console.log(`Total GPU time:      ${totalGpuHours.toFixed(2)} hr`);
  console.log(`Hourly rate used:    $${args.rate.toFixed(2)}/hr`);
  console.log(`Total GPU cost:      $${totalGpuCostUsd.toFixed(2)}`);
  console.log(`PDF jobs in window:  ${documentCount}`);
  console.log('');

  if (blendedCostPerDocUsd === null) {
    console.log('No PDF_ACCESSIBILITY jobs found in this window — cannot compute a blended per-document rate.');
    return;
  }

  console.log(`Blended GPU cost/doc: $${blendedCostPerDocUsd.toFixed(4)}`);
  console.log('');
  console.log('To apply this estimate, set:');
  console.log(`  NINJA_GPU_BLENDED_COST_PER_DOC_USD=${blendedCostPerDocUsd.toFixed(4)}`);
  console.log('in the environment Comparison Study trials are validated in (see src/config/index.ts).');
}

main().catch((err) => {
  console.error('ERR', err.message);
  process.exit(1);
});
