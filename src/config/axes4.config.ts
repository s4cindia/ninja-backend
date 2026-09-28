/**
 * axes4 PAC Cloud API config
 *
 * axes4 (https://www.axes4.com) publishes a PDF/UA-1 accessibility checker
 * as a paid, metered, HTTP+API-key cloud service ("PAC Cloud") -- the same
 * checker behind their desktop PAC application this project has been
 * cross-referencing by hand all session. Unlike veraPDF/pdfa11y (free local
 * binaries, gated on a filesystem path -- see verapdf.service.ts/
 * pdfa11y.service.ts), this is gated on an API key + subscription ID, and
 * costs real money per page checked, so it is NOT wired into the automatic
 * audit pipeline -- see axes4-pac.service.ts's own header for why it's
 * on-demand only.
 *
 * As of this integration landing, no real axes4 subscription exists yet --
 * S4C is meeting axes4 to discuss pricing first. AXES4_API_KEY/
 * AXES4_SUBSCRIPTION_ID are unset in every environment until then, which
 * makes isAvailable() false and the whole integration a safe no-op -- see
 * axes4-pac.service.ts's isAvailable(). Nothing here needs to change once a
 * real key exists; only the env vars do.
 */

/** Parses a positive-integer env var, failing fast on a malformed value
 *  rather than silently falling through to parseInt's NaN -- same
 *  reasoning/pattern as pdf-batch.config.ts's own positiveIntEnv. */
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

export const axes4Config = {
  /** Credentials -- both required for isAvailable() to return true. Real
   *  values are provisioned via an ECS `secrets` + Secrets Manager ARN at
   *  deploy time, the same pattern ANTHROPIC_API_KEY/GEMINI_API_KEY already
   *  use (a real paid credential, not a config value like a binary path). */
  apiKey: process.env.AXES4_API_KEY ?? '',
  subscriptionId: process.env.AXES4_SUBSCRIPTION_ID ?? '',

  /** Base URL for the PAC Cloud v3 API. */
  apiUrl: process.env.AXES4_API_URL ?? 'https://api.axes4.com/pac',

  /** A cloud round-trip for a large, multi-hundred-page document plausibly
   *  takes minutes, not seconds -- deliberately longer than pdfxt-client.ts's
   *  90s (a lighter-weight zone-detection call) and longer than veraPDF/
   *  pdfa11y's 120s local-binary timeout, since this adds real network +
   *  queueing time on top of the check itself. */
  timeoutMs: positiveIntEnv('AXES4_TIMEOUT_MS', 5 * 60 * 1000),

  /** Checksets requested per job -- 'pdfua' matches this codebase's own
   *  Matterhorn/PDF-UA-centric issue model; kept to just this one for the
   *  initial integration rather than also requesting 'wcag2', to keep scope
   *  (and page cost) tight until real usage patterns are known. */
  checksets: ['pdfua'],

  quota: {
    /** Placeholder default until the real plan is known from the pricing
     *  meeting -- deliberately conservative so an unconfigured/default
     *  ceiling can't silently rack up an unexpectedly large bill. Override
     *  via env once real numbers exist. */
    defaultPagesPerPeriod: positiveIntEnv('AXES4_QUOTA_PAGES_PER_PERIOD', 500),
    /** Quota resets on a rolling basis this many days after it was last
     *  reset -- a simple fixed-window model; swap for a real billing-cycle
     *  anchor once axes4 confirms their actual reset cadence. */
    periodDays: positiveIntEnv('AXES4_QUOTA_PERIOD_DAYS', 30),
  },
};
