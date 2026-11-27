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
 *   npx tsx scripts/qc-regression/run-corpus.ts compare           --titles T1,T2 [--from 1 --to 2]
 *     -- diffs two already-captured runs directly (no pipeline run, no
 *        network call) -- defaults to capture1 vs capture2.
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
  // measure.py v0.3: a content ref no /Pg or the /ParentTree can resolve
  // to a real page -- see MUST_BE_ZERO_METRICS' own comment for why this
  // is additionally gated at an unconditional zero, not just tracked here.
  'mcrs_page_unresolved',
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
// alt_over_250_chars joins it 2026-11-27: confirmed real on T1/T4/T5's own
// post-fix double captures -- a 1-off swing on EVERY title despite zero
// alt_cross_run_divergent/alt_missing_one_run, i.e. genuine wording-length
// variance on otherwise-grounded, non-fabricated alt text, not a defect.
// It was previously uncategorized (neither list), which finalizeBaseline's
// own exact-match gate treated as a real structural mismatch and refused
// to baseline over -- the same false-alarm shape this whole list exists to
// avoid for alt_median_chars.
const NOISE_TOLERANT_METRICS = ['alt_median_chars', 'alt_over_250_chars'] as const;

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

// Must-be-zero (2026-11-25, see git log) -- a STRONGER bar than
// REGRESSION_METRICS' own "don't exceed whatever the baseline measured":
// these two must be exactly 0 on every capture, baseline or not, full
// stop. figures_content_empty: a Figure with no image/vector/text/
// annotation content at all is always a defect (either it shouldn't have
// been tagged a Figure in the first place, or something dropped its real
// content) -- confirmed live, T4's own page-90 divergence was exactly
// this shape, and it got hallucinated, page-irrelevant alt text once
// created. mcrs_page_unresolved: measure.py v0.3's own new metric -- a
// content ref (/MCID) neither its own /Pg, an ancestor's /Pg, nor the
// document's /ParentTree can resolve to a real page is content a screen
// reader can never place at all, a real PDF/UA defect regardless of how
// it happened. Both are ALSO in REGRESSION_METRICS/tracked as tolerant
// (so finalize-baseline still records a tolerance for them, in case this
// bar is ever relaxed) -- this list adds the additional, unconditional
// zero requirement on top, checked separately in both finalize-baseline
// and checkAgainstBaseline.
const MUST_BE_ZERO_METRICS = ['figures_content_empty', 'mcrs_page_unresolved'] as const;

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
  // Seam C's zone-detection cache outcome for this job (hit/miss/lookup_failed/
  // store_failed/skipped_mismatch/skipped_no_tenant -- see SeamCTagResult),
  // null when the title didn't go through Seam C tagging at all. Added
  // 2026-11-26 (see git log) specifically to make this cache's own silent
  // failure mode (falls through to normal, non-deterministic detection)
  // observable per capture, without AWS log access.
  zoneDetectionCache?: unknown;
  // Forward-looking, not populated by anything today (2026-11-26): the
  // separately-planned AI response cache (approved in principle, not yet
  // built) would make capture2's Gemini calls reuse capture1's own cached
  // responses on a cache hit -- exactly the "not an independent sample"
  // case assertIndependentSamples below must refuse on, once this field
  // exists and starts getting populated (mirrors zoneDetectionCache's own
  // {outcome: ...} shape by convention; whatever the real field ends up
  // being called, wire it here rather than silently trusting a hit).
  aiResponseCache?: { outcome?: string } | null;
  // Per-job count of draftComplexImageBaseline's hasGroundedWordOverlap
  // guard rejecting an otherwise-real drafted shortAlt (2026-11-26, see
  // AiSuggestionResult.altTextGuardRejected in ai-analysis.service.ts) --
  // fetched so the guard's real false-reject rate can be measured per
  // title in this double capture, not assumed.
  altTextGuardRejections?: number | null;
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

/**
 * Both fields come from the SAME GET /pdf/job/:jobId/audit/result response
 * -- one fetch, not two. Non-fatal by design (same reasoning as each
 * field's own backend code): an observability read must never fail the
 * capture itself.
 */
async function fetchAuditResultObservability(jobId: string): Promise<{ zoneDetectionCache: unknown; altTextGuardRejections: number | null }> {
  try {
    const res = await api('GET', `/pdf/job/${jobId}/audit/result`);
    return {
      zoneDetectionCache: res.data?.zoneDetectionCache ?? null,
      altTextGuardRejections: res.data?.altTextGuardRejections ?? null,
    };
  } catch (err) {
    console.error(`  [${jobId}] failed to fetch audit-result observability fields (non-fatal): ${err instanceof Error ? err.message : err}`);
    return { zoneDetectionCache: null, altTextGuardRejections: null };
  }
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

  const { zoneDetectionCache, altTextGuardRejections } = await fetchAuditResultObservability(jobId);
  if (zoneDetectionCache) {
    console.log(`  [${id}] zoneDetectionCache: ${JSON.stringify(zoneDetectionCache)}`);
  }
  if (altTextGuardRejections) {
    // See AiSuggestionResult.altTextGuardRejected's own doc comment
    // (ai-analysis.service.ts) -- a real, drafted shortAlt that
    // hasGroundedWordOverlap rejected for sharing no word with the
    // Figure's own overlaid labels. Some are expected to be false
    // rejects (a real axis-tick label legitimately shares no vocabulary
    // with an accurate description) -- this is a rate to watch, not an
    // unconditional defect count.
    console.log(`  [${id}] altTextGuardRejections: ${altTextGuardRejections}`);
  }

  return {
    id, axis: entry.axis, jobId, wallSeconds, aiCostUsd, rounds, stopReason, measured,
    zoneDetectionCache, altTextGuardRejections, ...(axes4 ? { axes4 } : {}),
  };
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
  // alt_cross_run_divergent / alt_missing_one_run (2026-11-26): two
  // separately-gated counts from the SAME same-page, content-matched
  // Figure alt-text pairing -- see computeAltCrossRunDivergence's own doc
  // comment for the full design, the split, and the validation data. Both
  // must-not-increase (not exact-match, unlike `structural`): a future
  // re-baseline refuses outright if EITHER count exceeds what this one
  // recorded, checked independently (they're unrelated root causes).
  altCrossRunDivergence?: { count: number; missingOneRunCount: number; shortPairsCount: number };
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

// ---------------------------------------------------------------------------
// alt_cross_run_divergent
// ---------------------------------------------------------------------------
//
// Real bug, 2026-11-26: draftComplexImageBaseline (ai-analysis.service.ts)
// called Gemini's TEXT-ONLY generation method for a "describe this image"
// prompt with no image attached at all -- a different, confidently-worded,
// completely unrelated fabrication every run, since nothing grounded it
// (T4: "AWS architecture diagram showing a VPC with public and private
// subnets, ECS Fargate..." for an actual conception/implantation diagram).
// Two earlier designs tried and rejected (see git log, same date): whole-
// book and same-page literal word-overlap against the PDF's own prose both
// failed to separate real fabrications from legitimate alt text -- most
// photo alt text (correctly) shares no vocabulary with surrounding prose at
// all, since it describes a visual scene, not a paraphrase of the page.
//
// This design instead compares the SAME Figure's own alt text ACROSS TWO
// INDEPENDENT RUNS of the same code against the same source: a genuinely
// accurate description's key nouns stay stable even when reworded
// ("Human Kinetics logo" vs "Human Kinetics logo featuring a stylized human
// figure icon..."), while an ungrounded fabrication has no reason to agree
// with itself at all run to run. Validated directly against the real T4
// capture pair that found this bug, plus T1 (independently rediscovering
// the already-known Karsaklian p155 case with zero tuning) and T5: every
// known-real fabrication scored EXACTLY 0.00 Jaccard; the lowest score among
// legitimate (reworded-but-accurate) pairs was 0.04 across all three
// documents. ALT_CROSS_RUN_JACCARD_THRESHOLD sits well inside that gap.
const ALT_CROSS_RUN_JACCARD_THRESHOLD = 0.02;

// Same whole-word, stopword-filtered, lightly-stemmed convention as the
// backend's own hasGroundedWordOverlap (ai-analysis.service.ts), kept
// independent here (no shared import -- this tool's own "no Ninja code"
// rule) since the exact word set doesn't need to match byte-for-byte, only
// the general approach.
const ALT_CROSS_RUN_STOPWORDS = new Set([
  'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'her', 'was',
  'one', 'our', 'out', 'day', 'get', 'has', 'him', 'his', 'how', 'man', 'new',
  'now', 'old', 'see', 'two', 'way', 'who', 'boy', 'did', 'its', 'let', 'put',
  'say', 'she', 'too', 'use', 'with', 'this', 'that', 'from', 'have', 'been',
  'into', 'over', 'under', 'between', 'showing', 'depicting', 'shows', 'image',
  'figure', 'photo', 'diagram', 'illustration', 'picture', 'graphic',
]);

function stem(word: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (word.endsWith(suffix) && word.length > suffix.length + 2) {
      return word.slice(0, -suffix.length);
    }
  }
  return word;
}

function contentWords(text: string): Set<string> {
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  const words = new Set<string>();
  for (const t of tokens) {
    if (t.length < 3 || ALT_CROSS_RUN_STOPWORDS.has(t)) continue;
    words.add(stem(t));
  }
  return words;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const w of a) if (b.has(w)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

interface FigureRow {
  page: number;
  kind: string;
  alt: string;
  alt_len: number;
  has_actual_text: boolean;
}

interface AltCrossRunPair {
  page: number;
  altA: string;
  altB: string;
  jaccard: number;
}

/**
 * Greedy same-page, highest-Jaccard matching between two independent runs'
 * Figure lists -- no MCID/struct-position data needed (measure.py's own
 * `details.figures` doesn't carry one, and validation showed content-based
 * matching alone already self-selects correctly: identical/near-identical
 * text always wins the greedy pick for its true counterpart, confirmed
 * against T4's own "Chemistry"/"Closeness"/"Commitment" same-page labels).
 * A page where the two runs have different Figure counts leaves the extra,
 * unmatched entries uncompared -- that's a real signal too, but a DIFFERENT
 * one (the existing figures/figures_without_alt/pages_more_figures_than_source
 * tolerance metrics already cover a count change; this function's only job
 * is Figures present on both sides).
 */
function matchFiguresGreedy(figsA: FigureRow[], figsB: FigureRow[]): AltCrossRunPair[] {
  // Deliberately does NOT filter out figures with an empty alt -- one run
  // drafting nothing while the other drafts something real for the SAME
  // Figure is itself a real cross-run inconsistency (confirmed real, T4
  // p50 and T1 p82), not noise to exclude. jaccard()'s own empty-vs-real
  // case already scores that correctly (0).
  const byPageA = new Map<number, FigureRow[]>();
  const byPageB = new Map<number, FigureRow[]>();
  for (const f of figsA) {
    (byPageA.get(f.page) ?? byPageA.set(f.page, []).get(f.page)!).push(f);
  }
  for (const f of figsB) {
    (byPageB.get(f.page) ?? byPageB.set(f.page, []).get(f.page)!).push(f);
  }

  const pairs: AltCrossRunPair[] = [];
  for (const [page, listA] of byPageA) {
    const pool = [...(byPageB.get(page) ?? [])];
    for (const a of listA) {
      if (pool.length === 0) break;
      const wordsA = contentWords(a.alt);
      let bestIdx = 0;
      let bestScore = -1;
      for (let i = 0; i < pool.length; i++) {
        const score = jaccard(wordsA, contentWords(pool[i].alt));
        if (score > bestScore) {
          bestScore = score;
          bestIdx = i;
        }
      }
      const [b] = pool.splice(bestIdx, 1);
      pairs.push({ page, altA: a.alt, altB: b.alt, jaccard: bestScore });
    }
  }
  return pairs;
}

interface AltCrossRunResult {
  // Both sides non-empty, Jaccard < threshold -- the fabrication signal
  // (confirmed real: T4's "AWS architecture diagram..." vs "Flowchart
  // illustrating the decision process...", T1's Karsaklian p155, T5's
  // SWOT/MLOps/Strategic-Planning fabrications). This is the metric the
  // draftComplexImageBaseline vision fix targets -- expected to reach 0
  // once that fix is live.
  divergentCount: number;
  divergentPairs: AltCrossRunPair[];
  // Exactly one side empty, the other real -- a DIFFERENT defect (one run's
  // drafting declined/failed/was rejected entirely for a Figure the other
  // run drafted something real for), not ungrounded fabrication. Confirmed
  // real on T1 (p82, a parked drafting-failure item, separate from the
  // vision-call bug) and T4 (p50). Tracked and gated SEPARATELY -- counting
  // it as "divergent" would conflate two unrelated root causes under one
  // number, and the vision fix's own acceptance test (alt_cross_run_divergent
  // == 0) should not have to wait on this unrelated, already-parked issue.
  missingOneRunCount: number;
  missingOneRunPairs: AltCrossRunPair[];
  shortPairsCount: number;
  shortPairs: AltCrossRunPair[];
}

/**
 * Pairs where either side has a short-but-NONZERO content-word count (1-2
 * words, e.g. a single label like "Chemistry") are reported separately and
 * excluded from both gated counts -- a short label's Jaccard score is
 * dominated by chance (one shared/unshared word swings it by 0.5+), not a
 * meaningful signal either way, so gating on it would be noise rather than
 * a real check.
 */
function computeAltCrossRunDivergence(figsA: FigureRow[], figsB: FigureRow[]): AltCrossRunResult {
  const pairs = matchFiguresGreedy(figsA, figsB);
  const divergentPairs: AltCrossRunPair[] = [];
  const missingOneRunPairs: AltCrossRunPair[] = [];
  const shortPairs: AltCrossRunPair[] = [];
  const isShortNonzero = (n: number) => n > 0 && n <= 2;

  for (const pair of pairs) {
    const wordsA = contentWords(pair.altA);
    const wordsB = contentWords(pair.altB);
    const emptyA = wordsA.size === 0;
    const emptyB = wordsB.size === 0;

    if (emptyA && emptyB) continue; // both drafted nothing -- not interesting either way
    if (emptyA !== emptyB) {
      missingOneRunPairs.push(pair); // exactly one side empty -- drafting failure, not fabrication
      continue;
    }
    // Both sides non-empty from here.
    const shortSide = isShortNonzero(wordsA.size) || isShortNonzero(wordsB.size);
    if (shortSide) {
      shortPairs.push(pair);
    } else if (pair.jaccard < ALT_CROSS_RUN_JACCARD_THRESHOLD) {
      divergentPairs.push(pair);
    }
  }

  return {
    divergentCount: divergentPairs.length,
    divergentPairs,
    missingOneRunCount: missingOneRunPairs.length,
    missingOneRunPairs,
    shortPairsCount: shortPairs.length,
    shortPairs,
  };
}

/**
 * Refuses (throws) rather than silently computing a misleading 0 when
 * either run was served from an AI response cache -- a cache hit means
 * capture2 never independently re-asked the model at all, so agreement
 * between the two captures proves nothing about whether the model's own
 * output is grounded. Not reachable today (no such cache exists yet, see
 * RunnerResult.aiResponseCache's own doc comment) -- exists so this check
 * can't silently go blind the moment that separately-planned cache ships.
 */
function assertIndependentSamples(rA: RunnerResult, rB: RunnerResult, id: string): void {
  for (const [label, r] of [['capture A', rA] as const, ['capture B', rB] as const]) {
    if (r.aiResponseCache && r.aiResponseCache.outcome === 'hit') {
      throw new Error(
        `[${id}] refusing to compute alt_cross_run_divergent: ${label} was served from the AI response cache ` +
        `(outcome: hit) -- it needs two INDEPENDENT model samples to mean anything, not a cached replay of the ` +
        `other run's own answer. Re-capture with the cache disabled (or on a cache miss) before comparing.`
      );
    }
  }
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

  const mustBeZeroViolations = MUST_BE_ZERO_METRICS.flatMap((k) => {
    const v1 = m1[k] ?? 0;
    const v2 = m2[k] ?? 0;
    return v1 !== 0 || v2 !== 0 ? [`${k}: ${v1} (run1) / ${v2} (run2), expected 0 on both`] : [];
  });
  if (mustBeZeroViolations.length > 0) {
    console.error(`[${id}] MUST-BE-ZERO METRIC(S) NONZERO -- a real defect, not something to baseline around:`);
    for (const v of mustBeZeroViolations) console.error(`  ${v}`);
    throw new Error(`[${id}] refusing to finalize a baseline while a must-be-zero metric is nonzero`);
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

  assertIndependentSamples(r1, r2, id);
  const figs1 = (d1.figures ?? []) as FigureRow[];
  const figs2 = (d2.figures ?? []) as FigureRow[];
  const crossRun = computeAltCrossRunDivergence(figs1, figs2);

  // must-not-increase, not exact-match: a prior baseline's own count is the
  // ceiling for this one, same spirit as REGRESSION_METRICS but computed
  // from a genuinely different shape of data (a cross-run comparison, not
  // a single capture's own metric), so it can't just reuse that mechanism.
  // Checked independently -- divergentCount (fabrication) and
  // missingOneRunCount (drafting failure, e.g. T1's parked p82 item) are
  // unrelated root causes; one regressing must never be masked by the
  // other improving.
  const existingBaselinePath = path.join(BASELINES_DIR, `${id}.baseline.json`);
  if (existsSync(existingBaselinePath)) {
    const prior: Baseline = JSON.parse(readFileSync(existingBaselinePath, 'utf-8'));
    const priorDivergent = prior.altCrossRunDivergence?.count ?? 0;
    const priorMissingOneRun = prior.altCrossRunDivergence?.missingOneRunCount ?? 0;
    const violations: string[] = [];
    if (crossRun.divergentCount > priorDivergent) {
      violations.push(`alt_cross_run_divergent INCREASED: baseline had ${priorDivergent}, this capture pair has ${crossRun.divergentCount}`);
      for (const p of crossRun.divergentPairs) {
        violations.push(`  p${p.page} (jaccard ${p.jaccard.toFixed(2)}): "${p.altA.slice(0, 80)}" vs "${p.altB.slice(0, 80)}"`);
      }
    }
    if (crossRun.missingOneRunCount > priorMissingOneRun) {
      violations.push(`alt_missing_one_run INCREASED: baseline had ${priorMissingOneRun}, this capture pair has ${crossRun.missingOneRunCount}`);
      for (const p of crossRun.missingOneRunPairs) {
        violations.push(`  p${p.page}: "${p.altA.slice(0, 80)}" vs "${p.altB.slice(0, 80)}"`);
      }
    }
    if (violations.length > 0) {
      console.error(`[${id}] cross-run alt-text metric(s) increased:`);
      for (const v of violations) console.error(`  ${v}`);
      throw new Error(`[${id}] refusing to finalize a baseline with more cross-run-divergent or missing-one-run alt text than the existing baseline recorded`);
    }
  }
  if (crossRun.divergentCount > 0) {
    console.log(`[${id}] alt_cross_run_divergent: ${crossRun.divergentCount} (see baseline.json for the pairs)`);
  }
  if (crossRun.missingOneRunCount > 0) {
    console.log(`[${id}] alt_missing_one_run: ${crossRun.missingOneRunCount} (see baseline.json for the pairs)`);
  }

  const baseline: Baseline = {
    structural: s1,
    tolerant,
    quarantined,
    capture1CommitSha: r1.deployedCommitSha ?? null,
    capture2CommitSha: r2.deployedCommitSha ?? null,
    altCrossRunDivergence: {
      count: crossRun.divergentCount,
      missingOneRunCount: crossRun.missingOneRunCount,
      shortPairsCount: crossRun.shortPairsCount,
    },
  };
  writeFileSync(path.join(BASELINES_DIR, `${id}.baseline.json`), JSON.stringify(baseline, null, 2));
  // Pairs/short-pairs are detail-shaped (contain real alt text, same hygiene
  // rule as measure.py's own `details`) -- written alongside the baseline,
  // outside git just like everything else in QC_CORPUS_DIR, never folded
  // into baseline.json's own metrics-only shape.
  writeFileSync(
    path.join(BASELINES_DIR, `${id}.alt-cross-run.details.json`),
    JSON.stringify(
      { divergentPairs: crossRun.divergentPairs, missingOneRunPairs: crossRun.missingOneRunPairs, shortPairs: crossRun.shortPairs },
      null,
      2
    )
  );
  console.log(`[${id}] baseline finalized (commit ${baseline.capture1CommitSha}). Tolerances: ${Object.entries(tolerant).map(([k, v]) => `${k}=±${v.tolerance}`).join(', ')}`);
  if (Object.keys(quarantined).length > 0) {
    console.log(`[${id}] quarantined (excluded from the gate, known unstable): ${Object.entries(quarantined).map(([k, v]) => `${k}=${v.run1} vs ${v.run2}`).join(', ')}`);
  }
}

// Diffs two already-captured runs directly against each other -- no
// pipeline run, no network call, just the two JSON files already on disk.
// Distinct from `check` (which launches a FRESH pipeline run and compares
// it to `finalize-baseline`'s saved baseline.json) and from
// `finalize-baseline` (which refuses outright on any structural mismatch
// rather than reporting one). Built for exactly the workaround this
// session needed repeatedly by hand: "capture ran twice already, just
// show me what differs between them" -- previously required a one-off
// scratch script each time.
function compareCaptures(id: string, nA: string, nB: string): string[] {
  const pathA = path.join(BASELINES_DIR, `${id}.capture${nA}.json`);
  const pathB = path.join(BASELINES_DIR, `${id}.capture${nB}.json`);
  if (!existsSync(pathA) || !existsSync(pathB)) {
    return [`[${id}] missing capture${nA} or capture${nB} -- run "capture --run ${nA}" and "capture --run ${nB}" first`];
  }
  const rA: RunnerResult = JSON.parse(readFileSync(pathA, 'utf-8'));
  const rB: RunnerResult = JSON.parse(readFileSync(pathB, 'utf-8'));
  const mA = rA.measured.metrics as Record<string, number>;
  const mB = rB.measured.metrics as Record<string, number>;
  const dA = (rA.measured.details ?? {}) as Record<string, unknown>;
  const dB = (rB.measured.details ?? {}) as Record<string, unknown>;

  const lines: string[] = [];
  lines.push(`[${id}] (${rA.axis})`);
  lines.push(`  capture${nA}: ${rA.stopReason}, ${rA.rounds} round(s), $${rA.aiCostUsd.toFixed(2)}, ${Math.round(rA.wallSeconds)}s (commit ${rA.deployedCommitSha ?? 'unknown'})`);
  lines.push(`  capture${nB}: ${rB.stopReason}, ${rB.rounds} round(s), $${rB.aiCostUsd.toFixed(2)}, ${Math.round(rB.wallSeconds)}s (commit ${rB.deployedCommitSha ?? 'unknown'})`);

  const mustBeZero = MUST_BE_ZERO_METRICS.flatMap((k) => {
    const vA = mA[k] ?? 0;
    const vB = mB[k] ?? 0;
    return vA !== 0 || vB !== 0 ? [`    ${k}: capture${nA}=${vA} capture${nB}=${vB} (expected 0 on both)`] : [];
  });
  lines.push(mustBeZero.length > 0 ? '  MUST-BE-ZERO VIOLATIONS:' : '  must-be-zero metrics: ok (0 in both)');
  lines.push(...mustBeZero);

  const quarantinedDiffs = QUARANTINED_METRICS.flatMap((k) => (mA[k] !== mB[k] ? [`    ${k}: capture${nA}=${mA[k] ?? 0} capture${nB}=${mB[k] ?? 0}`] : []));
  lines.push(quarantinedDiffs.length > 0 ? '  QUARANTINED (heading levels) DIFFS:' : '  quarantined heading-level metrics (h1-h6): identical');
  lines.push(...quarantinedDiffs);

  const { structural: sA } = splitStructuralVsTolerant(mA);
  const { structural: sB } = splitStructuralVsTolerant(mB);
  const structuralDiffs = Object.keys(sA).flatMap((k) => (sA[k] !== sB[k] ? [`    ${k}: capture${nA}=${sA[k]} capture${nB}=${sB[k]}`] : []));
  lines.push(structuralDiffs.length > 0 ? '  STRUCTURAL DIFFS (expected exact-match -- any entry here is a concern):' : '  structural metrics: all identical');
  lines.push(...structuralDiffs);

  for (const k of DETAIL_PAGE_KEYS) {
    const pA = pageSetFromDetail(dA[k]);
    const pB = pageSetFromDetail(dB[k]);
    if (!setsEqual(pA, pB)) {
      lines.push(`    ${k} pages: [${[...pA].sort((a, b) => a - b).join(',')}] vs [${[...pB].sort((a, b) => a - b).join(',')}] -- counts may match, but the pages involved differ`);
    }
  }

  const toleranceDiffs = [...REGRESSION_METRICS, ...NOISE_TOLERANT_METRICS].flatMap((k) => {
    const vA = mA[k] ?? 0;
    const vB = mB[k] ?? 0;
    return vA !== vB ? [`    ${k}: capture${nA}=${vA} capture${nB}=${vB}`] : [];
  });
  if (toleranceDiffs.length > 0) {
    lines.push('  noise-tolerant / AI-content diffs (expected to vary a little):');
    lines.push(...toleranceDiffs);
  }

  // Informational here (compareCaptures never throws -- "report, don't
  // gate" is this command's own existing character); finalize-baseline is
  // where this metric actually gates (must-not-increase vs. a prior
  // baseline). assertIndependentSamples still REFUSES to compute it (an
  // explicit line saying so, never a silent 0) on a cache-served run.
  try {
    assertIndependentSamples(rA, rB, id);
    const figsA = (dA.figures ?? []) as FigureRow[];
    const figsB = (dB.figures ?? []) as FigureRow[];
    const crossRun = computeAltCrossRunDivergence(figsA, figsB);
    lines.push(
      `  alt_cross_run_divergent: ${crossRun.divergentCount} (fabrication: both sides real, jaccard < ${ALT_CROSS_RUN_JACCARD_THRESHOLD})`
    );
    for (const p of crossRun.divergentPairs) {
      lines.push(`    p${p.page} (jaccard ${p.jaccard.toFixed(2)}): "${p.altA.slice(0, 80)}" vs "${p.altB.slice(0, 80)}"`);
    }
    lines.push(`  alt_missing_one_run: ${crossRun.missingOneRunCount} (drafting failure: one side empty, the other real)`);
    for (const p of crossRun.missingOneRunPairs) {
      lines.push(`    p${p.page}: "${p.altA.slice(0, 80)}" vs "${p.altB.slice(0, 80)}"`);
    }
    if (crossRun.shortPairsCount > 0) {
      lines.push(`  alt_cross_run_short_pairs: ${crossRun.shortPairsCount} (not gated, 1-2 content words on one side):`);
      for (const p of crossRun.shortPairs) {
        lines.push(`    p${p.page} (jaccard ${p.jaccard.toFixed(2)}): "${p.altA.slice(0, 50)}" vs "${p.altB.slice(0, 50)}"`);
      }
    }
  } catch (err) {
    lines.push(`  alt_cross_run_divergent / alt_missing_one_run: REFUSED -- ${err instanceof Error ? err.message : String(err)}`);
  }

  return lines;
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
  // Unconditional, independent of baseline/tolerance -- see
  // MUST_BE_ZERO_METRICS' own comment for why these never get a pass just
  // because the baseline itself happened to measure nonzero too.
  for (const k of MUST_BE_ZERO_METRICS) {
    const actual = metrics[k] ?? 0;
    if (actual !== 0) {
      ok = false;
      lines.push(`  FAIL ${k}: must be 0, got ${actual}`);
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
  if (!mode || !['run', 'capture', 'finalize-baseline', 'check', 'compare'].includes(mode)) {
    console.error('Usage: run-corpus.ts <run|capture|finalize-baseline|check|compare> [--titles T1,T2] [--run 1|2] [--from 1 --to 2]');
    process.exit(2);
  }

  mkdirSync(BASELINES_DIR, { recursive: true });
  const manifest = loadManifest();
  const titles = resolveTitles(manifest, opts.titles);

  if (mode === 'compare') {
    const nA = opts.from ?? '1';
    const nB = opts.to ?? '2';
    for (const id of titles) {
      for (const line of compareCaptures(id, nA, nB)) console.log(line);
      console.log('');
    }
    return;
  }

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
