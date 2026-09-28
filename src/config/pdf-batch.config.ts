/**
 * PDF Batch Processing Config
 *
 * Weight tiers and budget defaults for the weighted concurrency budget
 * (concurrency-budget.service.ts) -- gates how many batch items can be
 * actively auditing/auto-remediating at once, per tenant, weighted by file
 * size/page count rather than a flat file count. Mirrors pdf.config.ts's
 * own env-var-overridable style.
 *
 * Tier boundaries and weight values are the user's own explicit numbers
 * from the approved batch-processing plan (small <50MB=1, medium
 * 50-500MB=3, large 500MB-2GB=8; ceiling 10 units/tenant). Page-count tiers
 * mirror the same boundaries -- not independently specified, but the same
 * reasoning applies (a small-byte-size PDF can still be page-heavy, e.g.
 * mostly text or vector-heavy scans, and per-page validators scale with
 * page count independent of file size -- see pdf.config.ts's own
 * documented OOM incident on a 377-page document). Both easy to retune via
 * env vars once real batch load data exists.
 */
export const pdfBatchConfig = {
  /** Default per-tenant concurrency budget ceiling, in weight units. */
  defaultBudgetUnits: parseInt(process.env.PDF_BATCH_BUDGET_TOTAL_UNITS || '10', 10),

  sizeTiers: {
    /** Below this: 'small' weight. */
    smallMaxMb: parseInt(process.env.PDF_BATCH_SIZE_TIER_SMALL_MAX_MB || '50', 10),
    /** Below this (and >= smallMaxMb): 'medium' weight. >= this: 'large'. */
    mediumMaxMb: parseInt(process.env.PDF_BATCH_SIZE_TIER_MEDIUM_MAX_MB || '500', 10),
  },
  pageTiers: {
    smallMaxPages: parseInt(process.env.PDF_BATCH_PAGE_TIER_SMALL_MAX || '50', 10),
    mediumMaxPages: parseInt(process.env.PDF_BATCH_PAGE_TIER_MEDIUM_MAX || '300', 10),
  },
  weightUnits: {
    small: parseInt(process.env.PDF_BATCH_WEIGHT_SMALL || '1', 10),
    medium: parseInt(process.env.PDF_BATCH_WEIGHT_MEDIUM || '3', 10),
    large: parseInt(process.env.PDF_BATCH_WEIGHT_LARGE || '8', 10),
  },

  /** A lease whose heartbeat is older than this is presumed abandoned (the
   *  process holding it died without releasing it) and is reconciled by the
   *  watchdog. Reuses the same 20-minute value remediation-cycle-lock.service.ts
   *  established for the analogous problem, for consistency rather than a
   *  new, independently-tuned number. */
  leaseStaleMs: parseInt(process.env.PDF_BATCH_LEASE_STALE_MS || String(20 * 60 * 1000), 10),

  /** Base poll interval for waitForLease while budget is unavailable. Actual
   *  delay adds up to 30% jitter to avoid a thundering herd of queued items
   *  all retrying in lockstep the moment budget frees up. */
  admitPollMs: parseInt(process.env.PDF_BATCH_ADMIT_POLL_MS || '5000', 10),
};
