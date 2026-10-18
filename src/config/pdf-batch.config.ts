/**
 * PDF Batch Processing Config
 *
 * Weight tiers and budget defaults for the weighted concurrency budget
 * (concurrency-budget.service.ts) -- gates how many batch items can be
 * actively auditing/auto-remediating at once, per tenant, weighted by file
 * size/page count rather than a flat file count. Mirrors pdf.config.ts's
 * own env-var-overridable style.
 *
 * Tier boundaries and weight values originally came from the approved
 * batch-processing plan (small <50MB=1, medium 50-500MB=3, large
 * 500MB-2GB=8; ceiling 10 units/tenant). Retuned 2026-10-18 after a real
 * incident: two tenant-admitted items (a 330MB "medium" file at weight 3
 * and a 20MB "small" file at weight 1, summing to 4 of the 10-unit
 * ceiling) ran their audit phases concurrently and OOM-killed the worker
 * container twice in one window (confirmed via `aws ecs describe-tasks`:
 * exitCode 137 / "OutOfMemoryError"). The old 500MB medium ceiling and
 * weight-3 cost badly understated a mid-sized real document's actual
 * memory footprint during the audit phase -- PdfComprehensiveParser holds
 * the whole buffer plus every extracted page/image in memory at once, and
 * PdfAltTextValidator (PR #686) runs an 8-way parallel image pool on top of
 * that -- so the tenant budget let two memory-heavy audits share one
 * process instead of serializing them. mediumMaxMb lowered to 150MB (a
 * document FMHE_PDF.pdf's size now correctly falls under "large"), and
 * weightUnits.large raised to equal defaultBudgetUnits (10) so any
 * large-tier item's audit/remediation lease fully monopolizes its tenant's
 * budget -- no other item, regardless of size, is admitted alongside it
 * until it releases. Paired with an ECS worker memory/CPU increase
 * (infrastructure/ecs/ninja-backend-worker-task-definition.json) as
 * defense in depth for a single huge file alone. Page-count tiers mirror
 * the same size-tier boundaries -- not independently specified, but the
 * same reasoning applies (a small-byte-size PDF can still be page-heavy,
 * e.g. mostly text or vector-heavy scans, and per-page validators scale
 * with page count independent of file size -- see pdf.config.ts's own
 * documented OOM incident on a 377-page document). Both easy to retune via
 * env vars once real batch load data exists.
 */

/** Parses a positive-integer env var, failing fast on a malformed value
 *  (e.g. a typo'd `PDF_BATCH_WEIGHT_LARGE=abc`) rather than silently
 *  falling through to `parseInt`'s NaN, which would corrupt the Prisma
 *  `lte`/`increment` arguments built from these values (CodeRabbit
 *  finding on PR #635) or, for admitPollMs, turn into an ~1ms retry loop. */
function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(`Invalid ${name}: "${raw}" is not a positive integer`);
  }
  const value = Number(trimmed);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`Invalid ${name}: "${raw}" is not a positive integer`);
  }
  return value;
}

export const pdfBatchConfig = {
  /** Default per-tenant concurrency budget ceiling, in weight units. */
  defaultBudgetUnits: positiveIntEnv('PDF_BATCH_BUDGET_TOTAL_UNITS', 10),

  sizeTiers: {
    /** Below this: 'small' weight. */
    smallMaxMb: positiveIntEnv('PDF_BATCH_SIZE_TIER_SMALL_MAX_MB', 50),
    /** Below this (and >= smallMaxMb): 'medium' weight. >= this: 'large'. */
    mediumMaxMb: positiveIntEnv('PDF_BATCH_SIZE_TIER_MEDIUM_MAX_MB', 150),
  },
  pageTiers: {
    smallMaxPages: positiveIntEnv('PDF_BATCH_PAGE_TIER_SMALL_MAX', 50),
    mediumMaxPages: positiveIntEnv('PDF_BATCH_PAGE_TIER_MEDIUM_MAX', 300),
  },
  weightUnits: {
    small: positiveIntEnv('PDF_BATCH_WEIGHT_SMALL', 1),
    medium: positiveIntEnv('PDF_BATCH_WEIGHT_MEDIUM', 3),
    // Equal to defaultBudgetUnits below -- a large-tier item's lease always
    // fully saturates its tenant's budget, serializing it against every
    // other item (see this file's own header comment for the incident that
    // motivated this).
    large: positiveIntEnv('PDF_BATCH_WEIGHT_LARGE', 10),
  },

  /** A lease whose heartbeat is older than this is presumed abandoned (the
   *  process holding it died without releasing it) and is reconciled by the
   *  watchdog. Reuses the same 20-minute value remediation-cycle-lock.service.ts
   *  established for the analogous problem, for consistency rather than a
   *  new, independently-tuned number. */
  leaseStaleMs: positiveIntEnv('PDF_BATCH_LEASE_STALE_MS', 20 * 60 * 1000),

  /** Base poll interval for waitForLease while budget is unavailable. Actual
   *  delay adds up to 30% jitter to avoid a thundering herd of queued items
   *  all retrying in lockstep the moment budget frees up. */
  admitPollMs: positiveIntEnv('PDF_BATCH_ADMIT_POLL_MS', 5000),
};
