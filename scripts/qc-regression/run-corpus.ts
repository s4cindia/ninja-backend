#!/usr/bin/env node
/**
 * QC regression corpus runner.
 *
 * Drives each corpus title through the REAL product path -- upload, start
 * Full Auto Mode, poll to completion, download the remediated PDF -- then
 * hands both the source and the output to the standalone measure.py
 * (pikepdf, no Ninja code imported) for independent structural metrics.
 * Deliberately does not trust Ninja's own validators/logs for these
 * numbers: QC finding F-22 was Ninja's own log saying "Applied" while the
 * file disagreed.
 *
 * Nothing here ever logs a real filename, title, or ISBN -- only the
 * anonymous corpus id (T1, T2, ...) from manifest.json, which itself lives
 * outside git in QC_CORPUS_DIR together with every baseline/run JSON. See
 * README.md in this directory for the manifest format and setup.
 *
 * Usage (see README.md for the full walkthrough):
 *   npx tsx scripts/qc-regression/run-corpus.ts run              --titles T1,T2
 *   npx tsx scripts/qc-regression/run-corpus.ts capture --run 1  --titles T1,T2
 *   npx tsx scripts/qc-regression/run-corpus.ts capture --run 2  --titles T1,T2
 *   npx tsx scripts/qc-regression/run-corpus.ts finalize-baseline --titles T1,T2
 *   npx tsx scripts/qc-regression/run-corpus.ts check             --titles T1,T2
 *
 * Required env vars: QC_CORPUS_DIR, QC_AUTH_TOKEN. Optional: QC_API_BASE
 * (defaults to the staging API), QC_PYTHON (defaults to "python").
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var ${name} -- see scripts/qc-regression/README.md`);
    process.exit(2);
  }
  return v;
}

const QC_CORPUS_DIR = requireEnv('QC_CORPUS_DIR');
const AUTH_TOKEN = requireEnv('QC_AUTH_TOKEN');
const API_BASE = process.env.QC_API_BASE || 'https://d1ruc3qmc844x9.cloudfront.net/api/v1';
const PYTHON = process.env.QC_PYTHON || 'python';
const MEASURE_PY = path.join(__dirname, 'measure.py');
const BASELINES_DIR = path.join(QC_CORPUS_DIR, 'baselines');
const RUNS_DIR = path.join(QC_CORPUS_DIR, 'runs');

// Metrics where a HIGHER value is a regression -- the gate's own concern.
// Mirrors measure.py's own DELTA_KEYS plus the additional metrics this
// corpus effort specifically asked for (noise/duplicate/generic alt text,
// empty-content Figures, more Figures on a page than the source has).
const REGRESSION_METRICS = [
  'figures_without_alt',
  'tables_without_th',
  'li_not_in_l',
  'top_level_floats',
  'reading_order_backward_jumps',
  'pages_running_head_tagged_as_content',
  'text_ops_untagged',
  'heading_level_skips',
  'alt_noise_words',
  'alt_generic',
  'alt_duplicate',
  'figures_content_empty',
  'pages_more_figures_than_source',
] as const;

// Every other metric in measure.py's output is informational (reported in
// the diff for context) but never fails `check` on its own.

interface ManifestEntry {
  file: string;
  axis: string;
}

interface RunnerResult {
  id: string;
  axis: string;
  jobId: string;
  wallSeconds: number;
  aiCostUsd: number;
  rounds: number;
  stopReason: string;
  measured: Record<string, unknown>; // measure.py's own top-level JSON, unmodified
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

function loadManifest(): Record<string, ManifestEntry> {
  const p = path.join(QC_CORPUS_DIR, 'manifest.json');
  if (!existsSync(p)) {
    console.error(`No manifest at ${p} -- see scripts/qc-regression/README.md`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(p, 'utf-8'));
}

function resolveTitles(manifest: Record<string, ManifestEntry>, arg?: string): string[] {
  const ids = arg ? arg.split(',').map((s) => s.trim()) : Object.keys(manifest);
  for (const id of ids) {
    if (!manifest[id]) {
      console.error(`Unknown corpus id "${id}" -- not in manifest.json`);
      process.exit(2);
    }
  }
  return ids;
}

// ---------------------------------------------------------------------------
// API
// ---------------------------------------------------------------------------

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(method: string, urlPath: string, body?: unknown): Promise<any> {
  const res = await fetch(`${API_BASE}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${AUTH_TOKEN}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${urlPath} -> HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  return res.json();
}

async function uploadAndStartJob(id: string, filePath: string): Promise<string> {
  const fileName = path.basename(filePath); // only ever used as a request param, never logged
  const size = statSync(filePath).size;

  const presign = await api('POST', '/uploads/presign', {
    fileName,
    contentType: 'application/pdf',
    fileSize: size,
  });

  const buf = readFileSync(filePath);
  const put = await fetch(presign.data.uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/pdf' },
    body: buf,
  });
  if (!put.ok) throw new Error(`[${id}] S3 PUT failed: HTTP ${put.status}`);

  await api('POST', `/uploads/${presign.data.fileId}/confirm`);
  const audit = await api('POST', '/pdf/audit-file', { fileId: presign.data.fileId });
  return audit.data.jobId;
}

async function runFullAutoMode(
  id: string,
  jobId: string
): Promise<{ wallSeconds: number; aiCostUsd: number; rounds: number; stopReason: string }> {
  await api('POST', `/pdf/${jobId}/auto-mode/start`, {});
  const start = Date.now();
  let status: any;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    status = await api('GET', `/pdf/${jobId}/auto-mode/status`);
    if (status.data.autoStatus !== 'running') break;
    console.log(`  [${id}] round ${status.data.autoRoundsCompleted} running, $${status.data.autoCostSpentUsd.toFixed(2)} spent so far...`);
    await sleep(15000);
  }
  return {
    wallSeconds: (Date.now() - start) / 1000,
    aiCostUsd: status.data.autoCostSpentUsd,
    rounds: status.data.autoRoundsCompleted,
    stopReason: status.data.autoStopReason,
  };
}

async function downloadRemediated(jobId: string, outPath: string) {
  const res = await fetch(`${API_BASE}/pdf/${jobId}/remediation/download`, {
    headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
  });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
}

// ---------------------------------------------------------------------------
// measure.py
// ---------------------------------------------------------------------------

function runMeasure(sourcePath: string, outputPath: string, jsonPath: string) {
  const r = spawnSync(PYTHON, [MEASURE_PY, '--source', sourcePath, '--output', outputPath, '--json', jsonPath], {
    encoding: 'utf-8',
  });
  if (r.status !== 0) {
    throw new Error(`measure.py failed (exit ${r.status}): ${r.stderr || r.stdout}`);
  }
}

// ---------------------------------------------------------------------------
// Core: run one title end to end
// ---------------------------------------------------------------------------

async function runOne(id: string, entry: ManifestEntry, outDir: string): Promise<RunnerResult> {
  const sourcePath = path.join(QC_CORPUS_DIR, entry.file);
  if (!existsSync(sourcePath)) {
    throw new Error(`[${id}] source file not found in QC_CORPUS_DIR (see manifest.json)`);
  }

  console.log(`[${id}] (${entry.axis}) uploading and starting audit...`);
  const jobId = await uploadAndStartJob(id, sourcePath);

  console.log(`[${id}] starting Full Auto Mode (job ${jobId})...`);
  const { wallSeconds, aiCostUsd, rounds, stopReason } = await runFullAutoMode(id, jobId);
  console.log(`[${id}] settled: ${stopReason}, ${rounds} round(s), $${aiCostUsd.toFixed(2)}, ${wallSeconds.toFixed(0)}s wall time`);

  mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(outDir, `${id}.output.pdf`);
  await downloadRemediated(jobId, outputPath);

  const jsonPath = path.join(outDir, `${id}.measured.json`);
  console.log(`[${id}] measuring...`);
  runMeasure(sourcePath, outputPath, jsonPath);
  const measured = JSON.parse(readFileSync(jsonPath, 'utf-8'));

  return { id, axis: entry.axis, jobId, wallSeconds, aiCostUsd, rounds, stopReason, measured };
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

interface Baseline {
  structural: Record<string, number>;
  tolerant: Record<string, { value: number; tolerance: number }>;
}

function splitStructuralVsTolerant(metrics: Record<string, number>): Baseline {
  // Everything in REGRESSION_METRICS (and a handful of count fields the same
  // code paths touch) is treated as needing a tolerance once AI-derived
  // content is involved; the rest of the structure-tree-shape metrics are
  // expected to be exactly reproducible between two runs of the same code.
  const structural: Record<string, number> = {};
  const tolerant: Record<string, { value: number; tolerance: number }> = {};
  for (const [k, v] of Object.entries(metrics)) {
    if (typeof v !== 'number') continue;
    if (REGRESSION_METRICS.includes(k as (typeof REGRESSION_METRICS)[number])) {
      tolerant[k] = { value: v, tolerance: 0 }; // tolerance filled in by finalize-baseline
    } else {
      structural[k] = v;
    }
  }
  return { structural, tolerant };
}

function finalizeBaseline(id: string) {
  const c1Path = path.join(BASELINES_DIR, `${id}.capture1.json`);
  const c2Path = path.join(BASELINES_DIR, `${id}.capture2.json`);
  if (!existsSync(c1Path) || !existsSync(c2Path)) {
    throw new Error(`[${id}] run "capture --run 1" and "capture --run 2" first`);
  }
  const r1: RunnerResult = JSON.parse(readFileSync(c1Path, 'utf-8'));
  const r2: RunnerResult = JSON.parse(readFileSync(c2Path, 'utf-8'));
  const m1 = r1.measured.metrics as Record<string, number>;
  const m2 = r2.measured.metrics as Record<string, number>;

  const { structural: s1 } = splitStructuralVsTolerant(m1);
  const { structural: s2 } = splitStructuralVsTolerant(m2);
  const mismatches: string[] = [];
  for (const k of Object.keys(s1)) {
    if (s1[k] !== s2[k]) mismatches.push(`${k}: ${s1[k]} vs ${s2[k]}`);
  }
  if (mismatches.length > 0) {
    console.error(`[${id}] STRUCTURAL METRICS DID NOT MATCH between the two captures -- this means nondeterminism in the pipeline or the runner, not noise. Investigate before baselining:`);
    for (const m of mismatches) console.error(`  ${m}`);
    throw new Error(`[${id}] refusing to finalize a baseline on nondeterministic structural metrics`);
  }

  const tolerant: Record<string, { value: number; tolerance: number }> = {};
  for (const k of REGRESSION_METRICS) {
    const v1 = m1[k] ?? 0;
    const v2 = m2[k] ?? 0;
    tolerant[k] = { value: v1, tolerance: Math.abs(v1 - v2) };
  }

  const baseline: Baseline = { structural: s1, tolerant };
  writeFileSync(path.join(BASELINES_DIR, `${id}.baseline.json`), JSON.stringify(baseline, null, 2));
  console.log(`[${id}] baseline finalized. Tolerances: ${Object.entries(tolerant).map(([k, v]) => `${k}=±${v.tolerance}`).join(', ')}`);
}

function checkAgainstBaseline(id: string, metrics: Record<string, number>): { ok: boolean; lines: string[] } {
  const bPath = path.join(BASELINES_DIR, `${id}.baseline.json`);
  if (!existsSync(bPath)) {
    return { ok: false, lines: [`[${id}] no baseline found -- run finalize-baseline first`] };
  }
  const baseline: Baseline = JSON.parse(readFileSync(bPath, 'utf-8'));
  const lines: string[] = [];
  let ok = true;

  for (const [k, expected] of Object.entries(baseline.structural)) {
    const actual = metrics[k];
    if (actual !== expected) {
      ok = false;
      lines.push(`  FAIL structural ${k}: expected ${expected}, got ${actual}`);
    }
  }
  for (const [k, { value: expected, tolerance }] of Object.entries(baseline.tolerant)) {
    const actual = metrics[k] ?? 0;
    const diff = actual - expected; // positive = worse (all REGRESSION_METRICS are higher-is-worse)
    if (diff > tolerance) {
      ok = false;
      lines.push(`  FAIL ${k}: baseline ${expected} (±${tolerance}), got ${actual} (+${diff})`);
    } else if (diff !== 0) {
      lines.push(`  ok (within tolerance) ${k}: baseline ${expected} (±${tolerance}), got ${actual}`);
    }
  }
  return { ok, lines };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv: string[]) {
  const mode = argv[2];
  const opts: Record<string, string> = {};
  for (let i = 3; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      opts[key] = val;
    }
  }
  return { mode, opts };
}

async function main() {
  const { mode, opts } = parseArgs(process.argv);
  if (!mode || !['run', 'capture', 'finalize-baseline', 'check'].includes(mode)) {
    console.error('Usage: run-corpus.ts <run|capture|finalize-baseline|check> [--titles T1,T2] [--run 1|2]');
    process.exit(2);
  }

  mkdirSync(BASELINES_DIR, { recursive: true });
  const manifest = loadManifest();
  const titles = resolveTitles(manifest, opts.titles);

  if (mode === 'finalize-baseline') {
    for (const id of titles) finalizeBaseline(id);
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir =
    mode === 'capture'
      ? BASELINES_DIR // capture writes directly into baselines/ with a .capture<N> suffix below
      : path.join(RUNS_DIR, timestamp);

  const results: RunnerResult[] = [];
  for (const id of titles) {
    const result = await runOne(id, manifest[id], mode === 'capture' ? path.join(RUNS_DIR, `${timestamp}-capture${opts.run}`) : outDir);
    results.push(result);

    if (mode === 'capture') {
      const runNum = opts.run;
      if (runNum !== '1' && runNum !== '2') {
        console.error('capture requires --run 1 or --run 2');
        process.exit(2);
      }
      writeFileSync(path.join(BASELINES_DIR, `${id}.capture${runNum}.json`), JSON.stringify(result, null, 2));
    } else {
      writeFileSync(path.join(outDir, `${id}.result.json`), JSON.stringify(result, null, 2));
    }
  }

  if (mode === 'check') {
    console.log('\n--- QC regression check ---');
    let allOk = true;
    for (const r of results) {
      const { ok, lines } = checkAgainstBaseline(r.id, r.measured.metrics as Record<string, number>);
      console.log(`\n${r.id} (${r.axis}): ${ok ? 'PASS' : 'FAIL'}  [$${r.aiCostUsd.toFixed(2)}, ${r.wallSeconds.toFixed(0)}s, ${r.rounds} round(s)]`);
      for (const l of lines) console.log(l);
      if (!ok) allOk = false;
    }
    console.log(`\n${allOk ? 'All titles passed.' : 'One or more titles regressed -- see FAIL lines above.'}`);
    if (!allOk) process.exitCode = 1;
  } else {
    console.log('\n--- Run summary ---');
    for (const r of results) {
      console.log(`${r.id} (${r.axis}): ${r.stopReason}, $${r.aiCostUsd.toFixed(2)}, ${r.wallSeconds.toFixed(0)}s, ${r.rounds} round(s)`);
    }
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
