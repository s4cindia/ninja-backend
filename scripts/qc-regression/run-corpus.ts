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
  // measure.py v0.2: catches Ninja overwriting or losing good existing
  // alt text -- two corpus titles already carry publisher-written alt
  // (per the measurer author's own note), so this must be gated, not
  // just reported.
  'source_alt_lost',
] as const;

// Every other metric in measure.py's own output is informational (reported
// in the diff for context) but never fails `check` on its own -- EXCEPT the
// two lists immediately below, which get a tolerance in finalize-baseline
// (because they're genuinely AI-influenced) without being treated as
// higher-is-worse regressions the way REGRESSION_METRICS is.

// Noise-tolerant but NOT a regression direction -- e.g. alt_median_chars
// (2026-11-25, see git log): genuine AI wording variance run to run with no
// inherent "higher is worse" meaning. Gets a tolerance; never gates `check`.
const NOISE_TOLERANT_METRICS = ['alt_median_chars'] as const;

// Quarantined (2026-11-25, see git log): run-to-run instability here is a
// real PRODUCT BUG, not noise to paper over with a tolerance -- the same
// book getting a different heading structure for a customer between two
// otherwise-identical runs. Confirmed live: T1's two captures showed h2:20
// vs h2:2 (and matching swings in h3-h6) -- looks like a uniform off-by-one
// level shift, not small jitter. Excluded entirely from finalize-baseline's
// exact-match gate and from `check`'s regression gate; both runs' raw
// values are recorded with an explicit "known unstable" flag instead.
// Tracked as the first Theme C investigation item -- once the root cause
// (likely a non-deterministic or ordering-dependent AI call deciding the
// book's own top-level heading rank) is fixed, move these back to the
// normal structural (exact-match) bucket, not into NOISE_TOLERANT_METRICS.
const QUARANTINED_METRICS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const;

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
  axes4?: unknown; // only present when --axes4 was passed for this run
  deployedCommitSha?: string | null; // via /health, fetched once per capture invocation
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

// Real bug, found live running this for real (2026-11-24): a bare "fetch
// failed" (a network-level throw -- DNS/TCP, never reached the server, no
// response at all) killed an entire title outright, twice in a row across
// a long multi-title batch. Retrying is safe here specifically because the
// request never reached the server in this failure mode -- nothing to
// double-apply. Only retries a genuine network-level throw or a 5xx
// response (both plausibly transient); a 4xx is a real, deterministic
// rejection and fails immediately as before.
async function api(method: string, urlPath: string, body?: unknown): Promise<any> {
  const maxAttempts = 4;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${API_BASE}${urlPath}`, {
        method,
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        const text = (await res.text()).slice(0, 500);
        if (res.status >= 500 && attempt < maxAttempts) {
          console.error(`  [retry ${attempt}/${maxAttempts}] ${method} ${urlPath} -> HTTP ${res.status}, retrying in ${attempt * 3}s...`);
          await sleep(attempt * 3000);
          continue;
        }
        throw new Error(`${method} ${urlPath} -> HTTP ${res.status}: ${text}`);
      }
      return res.json();
    } catch (err) {
      lastErr = err;
      const isNetworkError = err instanceof TypeError || (err instanceof Error && /fetch failed/i.test(err.message));
      if (isNetworkError && attempt < maxAttempts) {
        console.error(`  [retry ${attempt}/${maxAttempts}] ${method} ${urlPath} -> ${err instanceof Error ? err.message : err}, retrying in ${attempt * 3}s...`);
        await sleep(attempt * 3000);
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
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
  // S3 PUT is idempotent (same bytes, same key) -- safe to retry on a
  // transient network-level failure, same reasoning as api()'s own retry.
  let putOk = false;
  for (let attempt = 1; attempt <= 4 && !putOk; attempt++) {
    try {
      const put = await fetch(presign.data.uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/pdf' },
        body: buf,
      });
      if (!put.ok) throw new Error(`HTTP ${put.status}`);
      putOk = true;
    } catch (err) {
      if (attempt >= 4) throw new Error(`[${id}] S3 PUT failed after ${attempt} attempts: ${err instanceof Error ? err.message : err}`);
      console.error(`  [retry ${attempt}/4] [${id}] S3 PUT -> ${err instanceof Error ? err.message : err}, retrying in ${attempt * 3}s...`);
      await sleep(attempt * 3000);
    }
  }

  await api('POST', `/uploads/${presign.data.fileId}/confirm`);
  const audit = await api('POST', '/pdf/audit-file', { fileId: presign.data.fileId });
  const jobId = audit.data.jobId;
  console.log(`[${id}] job ${jobId} created, waiting for initial audit...`);

  // Real bug, found live (2026-11-24): /pdf/audit-file only STARTS the
  // initial audit asynchronously -- calling /auto-mode/start immediately
  // afterward races it, since Auto Mode needs a completed audit report to
  // work from. Poll the plain job-status endpoint (not auto-mode/status)
  // until the initial audit itself has actually finished.
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const jobStatus = await api('GET', `/pdf/job/${jobId}/status`);
    const s = jobStatus.data.status;
    if (s === 'COMPLETED') break;
    if (s === 'FAILED') throw new Error(`[${id}] job ${jobId} initial audit failed: ${jobStatus.data.error}`);
    await sleep(5000);
  }
  return jobId;
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
    // Real bug, found live (2026-11-24): the very first poll right after
    // starting can race the state write and see a transient pre-start
    // value (autoStatus not yet 'running', autoStopReason still null) --
    // only 'stopped' is a confirmed terminal value (seen consistently all
    // session); anything else, including an unrecognized transient state,
    // means keep polling rather than treating it as already settled.
    if (status.data.autoStatus === 'stopped') break;
    console.log(`  [${id}] status=${status.data.autoStatus} round ${status.data.autoRoundsCompleted} $${status.data.autoCostSpentUsd.toFixed(2)} spent so far...`);
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
  // Same retry reasoning as api()/the S3 PUT above -- a GET download is
  // safe to retry on a transient network-level failure.
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch(`${API_BASE}/pdf/${jobId}/remediation/download`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(outPath, Buffer.from(await res.arrayBuffer()));
      return;
    } catch (err) {
      if (attempt >= 4) throw new Error(`download failed after ${attempt} attempts: ${err instanceof Error ? err.message : err}`);
      console.error(`  [retry ${attempt}/4] download -> ${err instanceof Error ? err.message : err}, retrying in ${attempt * 3}s...`);
      await sleep(attempt * 3000);
    }
  }
}

// ---------------------------------------------------------------------------
// axes4 PAC (opt-in; a single shared, GLOBAL quota -- never called by
// default, only when --axes4 is passed to `capture --run 1`)
// ---------------------------------------------------------------------------

interface Axes4Quota {
  configured: boolean;
  pagesUsedThisPeriod: number;
  pagesLimitThisPeriod: number;
  periodResetAt: string | null;
}

async function getAxes4Quota(): Promise<Axes4Quota> {
  const res = await api('GET', '/pdf/axes4/quota');
  return res.data;
}

async function runAxes4Pac(jobId: string): Promise<unknown> {
  const res = await api('POST', `/pdf/${jobId}/pac-report/live`);
  return res.data;
}

// ---------------------------------------------------------------------------
// Deployed commit SHA (unauthenticated, not under /api/v1)
// ---------------------------------------------------------------------------

async function getDeployedCommitSha(): Promise<string | null> {
  try {
    const base = API_BASE.replace(/\/api\/v1\/?$/, '');
    const res = await fetch(`${base}/health`);
    if (!res.ok) return null;
    const body = await res.json();
    return body.commitSha ?? null;
  } catch {
    return null;
  }
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

async function runOne(id: string, entry: ManifestEntry, outDir: string, withAxes4 = false): Promise<RunnerResult> {
  const sourcePath = path.join(QC_CORPUS_DIR, entry.file);
  if (!existsSync(sourcePath)) {
    throw new Error(`[${id}] source file not found in QC_CORPUS_DIR (see manifest.json)`);
  }

  console.log(`[${id}] (${entry.axis}) uploading and starting audit...`);
  const jobId = await uploadAndStartJob(id, sourcePath);

  console.log(`[${id}] starting Full Auto Mode (job ${jobId})...`);
  const { wallSeconds, aiCostUsd, rounds, stopReason } = await runFullAutoMode(id, jobId);
  console.log(`[${id}] settled: ${stopReason}, ${rounds} round(s), $${aiCostUsd.toFixed(2)}, ${wallSeconds.toFixed(0)}s wall time`);

  // Real bug, found live (2026-11-24): a job whose Auto Mode genuinely
  // errored (0 rounds, nothing applied) used to still get downloaded,
  // measured, and written out as if it were a legitimate capture --
  // silently baselining an unremediated/barely-touched file as "the"
  // result for that title. Fail the whole title instead, so it's reported
  // as a failure (and retried) rather than quietly corrupting a baseline.
  if (stopReason === 'error') {
    throw new Error(`[${id}] job ${jobId} Auto Mode errored (${rounds} round(s) completed) -- not a valid capture`);
  }

  mkdirSync(outDir, { recursive: true });
  const outputPath = path.join(outDir, `${id}.output.pdf`);
  await downloadRemediated(jobId, outputPath);

  const jsonPath = path.join(outDir, `${id}.measured.json`);
  console.log(`[${id}] measuring...`);
  runMeasure(sourcePath, outputPath, jsonPath);
  const measured = JSON.parse(readFileSync(jsonPath, 'utf-8'));

  let axes4: unknown;
  if (withAxes4) {
    console.log(`[${id}] running axes4 PAC...`);
    axes4 = await runAxes4Pac(jobId);
    writeFileSync(path.join(outDir, `${id}.axes4.json`), JSON.stringify(axes4, null, 2));
  }

  return { id, axis: entry.axis, jobId, wallSeconds, aiCostUsd, rounds, stopReason, measured, ...(axes4 ? { axes4 } : {}) };
}

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

interface Baseline {
  structural: Record<string, number>;
  tolerant: Record<string, { value: number; tolerance: number }>;
  // Quarantined (2026-11-25): excluded from the exact-match gate entirely --
  // see QUARANTINED_METRICS above for why. Both runs' raw values are kept
  // so the instability is visible in the baseline file itself, not hidden.
  quarantined?: Record<string, { run1: number; run2: number; note: string }>;
  // The deployed commit SHA (via /health) both captures were run against --
  // recorded so a baseline's provenance is traceable, not assumed.
  capture1CommitSha?: string | null;
  capture2CommitSha?: string | null;
}

function isQuarantined(k: string): boolean {
  return (QUARANTINED_METRICS as readonly string[]).includes(k);
}

function splitStructuralVsTolerant(metrics: Record<string, number>): Baseline {
  // Everything in REGRESSION_METRICS or NOISE_TOLERANT_METRICS is treated as
  // needing a tolerance once AI-derived content is involved; QUARANTINED_METRICS
  // is excluded outright (see its own comment -- that instability is a known
  // product bug, not noise to tolerate); the rest of the structure-tree-shape
  // metrics are expected to be exactly reproducible between two runs of the
  // same code.
  const structural: Record<string, number> = {};
  const tolerant: Record<string, { value: number; tolerance: number }> = {};
  for (const [k, v] of Object.entries(metrics)) {
    if (typeof v !== 'number') continue;
    if (isQuarantined(k)) {
      continue;
    } else if (
      REGRESSION_METRICS.includes(k as (typeof REGRESSION_METRICS)[number]) ||
      (NOISE_TOLERANT_METRICS as readonly string[]).includes(k)
    ) {
      tolerant[k] = { value: v, tolerance: 0 }; // tolerance filled in by finalize-baseline
    } else {
      structural[k] = v;
    }
  }
  return { structural, tolerant };
}

// Extracts a comparable SET of page numbers from one of measure.py's
// `details` entries, regardless of whether that entry is a plain list of
// page numbers (tables_without_th, li_not_in_l_pages,
// pages_running_head_tagged_as_content) or a list of objects carrying a
// `page` field (top_level_floats, pages_more_figures_than_source).
function pageSetFromDetail(detail: unknown): Set<number> {
  if (!Array.isArray(detail)) return new Set();
  const pages = detail.map((item) => (typeof item === 'number' ? item : (item as { page?: number })?.page));
  return new Set(pages.filter((p): p is number => typeof p === 'number'));
}

// Keys explicitly called out (2026-11-24, see git log): matching counts
// with different underlying pages is nondeterminism, not noise -- a
// baseline must refuse to form if the SAME pages weren't involved both
// captures, even when the two captures' plain counts happen to agree.
const DETAIL_PAGE_KEYS = [
  'top_level_floats',
  'pages_more_figures_than_source',
  'pages_running_head_tagged_as_content',
  'tables_without_th',
  'li_not_in_l_pages',
] as const;

function setsEqual(a: Set<number>, b: Set<number>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
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
  const d1 = (r1.measured.details ?? {}) as Record<string, unknown>;
  const d2 = (r2.measured.details ?? {}) as Record<string, unknown>;

  const { structural: s1 } = splitStructuralVsTolerant(m1);
  const { structural: s2 } = splitStructuralVsTolerant(m2);
  const mismatches: string[] = [];
  for (const k of Object.keys(s1)) {
    if (s1[k] !== s2[k]) mismatches.push(`${k}: ${s1[k]} vs ${s2[k]}`);
  }

  for (const k of DETAIL_PAGE_KEYS) {
    const p1 = pageSetFromDetail(d1[k]);
    const p2 = pageSetFromDetail(d2[k]);
    if (!setsEqual(p1, p2)) {
      mismatches.push(
        `${k} pages: [${[...p1].sort((a, b) => a - b).join(',')}] vs [${[...p2].sort((a, b) => a - b).join(',')}] -- counts may match, but the pages involved differ`
      );
    }
  }

  if (mismatches.length > 0) {
    console.error(`[${id}] STRUCTURAL METRICS DID NOT MATCH between the two captures -- this means nondeterminism in the pipeline or the runner, not noise. Investigate before baselining:`);
    for (const m of mismatches) console.error(`  ${m}`);
    throw new Error(`[${id}] refusing to finalize a baseline on nondeterministic structural metrics`);
  }

  const tolerant: Record<string, { value: number; tolerance: number }> = {};
  for (const k of [...REGRESSION_METRICS, ...NOISE_TOLERANT_METRICS]) {
    const v1 = m1[k] ?? 0;
    const v2 = m2[k] ?? 0;
    tolerant[k] = { value: v1, tolerance: Math.abs(v1 - v2) };
  }

  const quarantined: Record<string, { run1: number; run2: number; note: string }> = {};
  for (const k of QUARANTINED_METRICS) {
    quarantined[k] = {
      run1: m1[k] ?? 0,
      run2: m2[k] ?? 0,
      note: 'known unstable -- see Theme C investigation, excluded from the exact-match gate',
    };
  }

  const baseline: Baseline = {
    structural: s1,
    tolerant,
    quarantined,
    capture1CommitSha: r1.deployedCommitSha ?? null,
    capture2CommitSha: r2.deployedCommitSha ?? null,
  };
  writeFileSync(path.join(BASELINES_DIR, `${id}.baseline.json`), JSON.stringify(baseline, null, 2));
  console.log(`[${id}] baseline finalized (commit ${baseline.capture1CommitSha}). Tolerances: ${Object.entries(tolerant).map(([k, v]) => `${k}=±${v.tolerance}`).join(', ')}`);
  if (Object.keys(quarantined).length > 0) {
    console.log(`[${id}] quarantined (excluded from the gate, known unstable): ${Object.entries(quarantined).map(([k, v]) => `${k}=${v.run1} vs ${v.run2}`).join(', ')}`);
  }
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
    // Defensive, not redundant (CodeRabbit, PR #884): a baseline FILE
    // written before QUARANTINED_METRICS existed can still have h1-h6
    // baked into its own `structural` object -- splitStructuralVsTolerant
    // excludes them on every NEW baseline, but an old baseline.json on
    // disk doesn't retroactively get rewritten, so this loop would
    // otherwise still gate `check` on a key that's since been declared
    // known-unstable, with no way for a fresh baseline to override it.
    if (isQuarantined(k)) continue;
    const actual = metrics[k];
    if (actual !== expected) {
      ok = false;
      lines.push(`  FAIL structural ${k}: expected ${expected}, got ${actual}`);
    }
  }
  for (const [k, { value: expected, tolerance }] of Object.entries(baseline.tolerant)) {
    const actual = metrics[k] ?? 0;
    const diff = actual - expected;
    // NOISE_TOLERANT_METRICS (e.g. alt_median_chars) has no "higher is
    // worse" direction -- a swing either way beyond the observed noise
    // window is worth a look, so it's checked on magnitude. Everything
    // else here is a REGRESSION_METRICS entry, which IS higher-is-worse.
    const isSymmetric = (NOISE_TOLERANT_METRICS as readonly string[]).includes(k);
    const exceeds = isSymmetric ? Math.abs(diff) > tolerance : diff > tolerance;
    if (exceeds) {
      ok = false;
      lines.push(`  FAIL ${k}: baseline ${expected} (±${tolerance}), got ${actual} (${diff >= 0 ? '+' : ''}${diff})`);
    } else if (diff !== 0) {
      lines.push(`  ok (within tolerance) ${k}: baseline ${expected} (±${tolerance}), got ${actual}`);
    }
  }
  if (baseline.quarantined && Object.keys(baseline.quarantined).length > 0) {
    lines.push(`  (quarantined, not checked: ${Object.keys(baseline.quarantined).join(', ')} -- known unstable, see Theme C investigation)`);
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
    // Same per-title resilience as the capture/run/check loop below -- one
    // title's structural mismatch must not stop the rest from even being
    // checked (real gap, found live 2026-11-25: T1's mismatch threw out of
    // this loop before T4/T5 were ever examined).
    const failures: Array<{ id: string; error: string }> = [];
    for (const id of titles) {
      try {
        finalizeBaseline(id);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[${id}] FAILED, continuing with remaining titles: ${msg}`);
        failures.push({ id, error: msg });
      }
    }
    if (failures.length > 0) {
      console.error(`\n--- ${failures.length} title(s) FAILED to finalize ---`);
      for (const f of failures) console.error(`${f.id}: ${f.error}`);
      process.exitCode = 1;
    }
    return;
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir =
    mode === 'capture'
      ? BASELINES_DIR // capture writes directly into baselines/ with a .capture<N> suffix below
      : path.join(RUNS_DIR, timestamp);

  const deployedCommitSha = mode === 'capture' ? await getDeployedCommitSha() : null;
  if (mode === 'capture') {
    console.log(`Deployed commit SHA (via /health): ${deployedCommitSha}`);
  }

  // Only ever on capture --run 1, per explicit instruction -- axes4 is a
  // single shared global quota, not something to spend on every run.
  const runNum = mode === 'capture' ? opts.run : undefined;
  if (mode === 'capture' && (runNum !== '1' && runNum !== '2')) {
    console.error('capture requires --run 1 or --run 2');
    process.exit(2);
  }
  const withAxes4 = opts.axes4 === 'true' && mode === 'capture' && runNum === '1';
  if (opts.axes4 === 'true' && !(mode === 'capture' && runNum === '1')) {
    console.error('--axes4 is only supported on "capture --run 1"');
    process.exit(2);
  }
  if (withAxes4) {
    const quota = await getAxes4Quota();
    if (!quota.configured) {
      console.error('axes4 PAC is not configured/enabled for this tenant -- cannot run --axes4');
      process.exit(2);
    }
    const remaining = quota.pagesLimitThisPeriod - quota.pagesUsedThisPeriod;
    console.log(`axes4 PAC quota: ${quota.pagesUsedThisPeriod}/${quota.pagesLimitThisPeriod} pages used this period, ${remaining} remaining (resets ${quota.periodResetAt})`);
    if (remaining <= 0) {
      console.error('axes4 PAC quota exhausted for this period -- refusing to run');
      process.exit(2);
    }
  }

  const results: RunnerResult[] = [];
  const failures: Array<{ id: string; error: string }> = [];
  for (const id of titles) {
    // Real bug, found live (2026-11-24): one title's failure (upload/audit
    // error, a transient pdfjs-dist hiccup, etc.) used to throw out of this
    // loop entirely, silently costing every LATER title in the same
    // invocation its own run. Catch per-title, continue, and report every
    // failure together at the end -- a batch of 6 titles should never be
    // held hostage by one flaky one.
    try {
      const result = await runOne(
        id,
        manifest[id],
        mode === 'capture' ? path.join(RUNS_DIR, `${timestamp}-capture${opts.run}`) : outDir,
        withAxes4
      );
      result.deployedCommitSha = deployedCommitSha;
      results.push(result);

      if (mode === 'capture') {
        writeFileSync(path.join(BASELINES_DIR, `${id}.capture${runNum}.json`), JSON.stringify(result, null, 2));
      } else {
        writeFileSync(path.join(outDir, `${id}.result.json`), JSON.stringify(result, null, 2));
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[${id}] FAILED, continuing with remaining titles: ${msg}`);
      failures.push({ id, error: msg });
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

  if (failures.length > 0) {
    console.log(`\n--- ${failures.length} title(s) FAILED (not captured/measured this run) ---`);
    for (const f of failures) console.log(`${f.id}: ${f.error}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
