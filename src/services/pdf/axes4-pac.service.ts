/**
 * axes4 PAC Cloud API client
 *
 * Calls axes4's real, authoritative PAC (PDF Accessibility Checker) as a
 * cloud service -- the same checker behind the desktop PAC application this
 * project has been cross-referencing by hand all session (a user runs it,
 * pastes a screenshot or exports a report PDF, and a human reconciles it
 * against Ninja's own audit). This automates that loop.
 *
 * Modeled on TWO existing precedents, deliberately combined:
 *   - verapdf.service.ts / pdfa11y.service.ts's `{ ran, failures }` shape
 *     and graceful-degradation discipline (ran is false for EVERY
 *     non-happy-path -- unavailable, quota exhausted, timeout, malformed
 *     response -- so a caller can never confuse "checked, found nothing"
 *     with "never ran"; see VeraPdfValidationResult's own doc comment for
 *     why that distinction matters for pac-report.service.ts specifically).
 *   - pdfxt-client.ts's HTTP+API-key+retry shape (AbortController timeout,
 *     retry on 5xx, fail fast on 4xx) -- axes4 is a cloud API, not a local
 *     binary, so veraPDF/pdfa11y's execFile+isAvailable-via-existsSync
 *     pattern doesn't apply; this is the closer precedent for THAT part.
 *
 * NOT wired into the automatic audit pipeline (unlike veraPDF/pdfa11y,
 * which are free and run on every audit) -- axes4 bills per page, so it's
 * on-demand only, triggered by an explicit endpoint. See the axes4
 * integration plan for the full phasing; this file is Phase 1: the HTTP
 * client itself, with NO Matterhorn condition mapping yet (axes4's real
 * `checkId` taxonomy is opaque until real API responses are harvested --
 * the OpenAPI spec's own example payloads use placeholder IDs like
 * "Check-Id-1"). `Axes4Failure.checkId` is axes4's own raw ID, not yet a
 * matterhornCheckpoint.
 *
 * Graceful degradation (never throws):
 *   - AXES4_API_KEY/AXES4_SUBSCRIPTION_ID unset -> isAvailable() false;
 *                                                   validate() logs one info, returns ran:false
 *   - Local page-count read fails (not a valid PDF) -> logs a warning, returns ran:false
 *   - Local quota tracker reports the period budget would be exceeded -> logs a
 *     warning, returns ran:false (see axes4-quota.service.ts's own header for
 *     why this is a local, non-authoritative pre-check)
 *   - 401 (bad key) / 403 (axes4's own page-limit reached) / 413 (too large) /
 *     422 (invalid document) -> logs distinctly per code, returns ran:false
 *   - Timeout / network error / non-JSON response -> logs a warning, returns ran:false
 */

import { PDFDocument } from 'pdf-lib';
import { logger } from '../../lib/logger';
import { axes4Config } from '../../config/axes4.config';
import { axes4QuotaService } from './axes4-quota.service';

export interface Axes4Failure {
  /** axes4's own check ID (e.g. from the real API's `checkId` field) --
   *  NOT yet a Matterhorn condition ID. See this file's own header:
   *  mapping is a separate, later piece of work. */
  checkId: string;
  /** Human-readable caption from the issue. */
  description: string;
  /** 1-based page number of the first reported occurrence, if the API
   *  supplied one (converted from the API's own pageIndex, ASSUMED 0-based
   *  to match veraPDF/pdfa11y's own convention -- unconfirmed against real
   *  axes4 output yet; revisit once Phase 2 harvests real responses). */
  pageNumber?: number;
  /** Real bounding-box location of the first occurrence, in the API's own
   *  coordinate units -- unique among this codebase's three external
   *  validators (veraPDF/pdfa11y report no per-occurrence geometry at all).
   *  Kept for a future (Phase 4) automatic cross-check against Ninja's own
   *  AuditIssue.boundingBox for the same page/check. */
  rectangle?: { top: number; bottom: number; left: number; right: number };
  /** How many total occurrences axes4 reports for this check (its own
   *  `count` field) -- this service surfaces only the first occurrence's
   *  location, same "first check/finding only" convention veraPDF/pdfa11y
   *  already established, but keeps the real total for context. */
  count: number;
}

export interface Axes4ValidationResult {
  /** True only when axes4 actually ran and returned a parseable report --
   *  false for every graceful-degradation path. See this file's own header
   *  and VeraPdfValidationResult's doc comment (verapdf.service.ts) for why
   *  this distinction is required. */
  ran: boolean;
  failures: Axes4Failure[];
  /** axes4's own PDF/UA compliance index (0-100), when available -- purely
   *  informational; not used by any Matterhorn-condition logic. */
  uaIndex?: number;
}

interface Axes4IssueDetail {
  pageIndex: number | null;
  rectangle: { top: number; bottom: number; left: number; right: number } | null;
}

interface Axes4Issue {
  issueId: string;
  severity: string;
  severityId: number;
  checkId: string;
  caption: string;
  count: number;
  details: Axes4IssueDetail[];
}

interface Axes4IssueGroup {
  type: string;
  issues: Axes4Issue[];
}

interface Axes4SummaryResponse {
  body: {
    jobId: string;
    name: string;
    reports: Array<{ type: string; uaIndex: number }>;
  };
}

interface Axes4DetailResponse {
  body: {
    jobId: string;
    issues: Axes4IssueGroup[];
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class Axes4PacService {
  /** True only when both credentials are configured. No filesystem check
   *  (unlike veraPDF/pdfa11y) -- there is no local binary to probe. */
  isAvailable(): boolean {
    return !!axes4Config.apiKey && !!axes4Config.subscriptionId;
  }

  /**
   * Submit `buffer` to axes4's real PAC Cloud checker and return its
   * findings. Never throws -- always returns an Axes4ValidationResult.
   */
  async validate(buffer: Buffer, fileName: string): Promise<Axes4ValidationResult> {
    if (!this.isAvailable()) {
      logger.info('[axes4] Not available (AXES4_API_KEY/AXES4_SUBSCRIPTION_ID unset) -- skipping');
      return { ran: false, failures: [] };
    }

    let pageCount: number;
    try {
      const doc = await PDFDocument.load(buffer, { updateMetadata: false });
      pageCount = doc.getPageCount();
    } catch (err) {
      logger.warn(`[axes4] Could not read page count locally -- skipping: ${fileName}`, err);
      return { ran: false, failures: [] };
    }

    let reserved: boolean;
    try {
      reserved = await axes4QuotaService.tryReservePages(pageCount);
    } catch (err) {
      logger.warn(`[axes4] Quota tracker threw while reserving pages -- skipping: ${fileName}`, err);
      return { ran: false, failures: [] };
    }
    if (!reserved) {
      logger.warn(`[axes4] Skipping ${fileName} -- local quota tracker reports the period budget would be exceeded (${pageCount} pages)`);
      return { ran: false, failures: [] };
    }

    try {
      const { jobId, uaIndex } = await this.submitJob(buffer, fileName);
      const failures = await this.fetchDetails(jobId);
      return { ran: true, failures, uaIndex };
    } catch (err) {
      const error = err as Error & { axes4Status?: number };
      if (error.axes4Status === 401) {
        logger.warn(`[axes4] Unauthorized (401) -- AXES4_API_KEY is invalid or expired. Skipping: ${fileName}`);
      } else if (error.axes4Status === 403) {
        logger.warn(`[axes4] Page limit reached for this API key (403, axes4's own quota, independent of the local tracker) -- skipping: ${fileName}`);
      } else if (error.axes4Status === 413) {
        logger.warn(`[axes4] Document too large for axes4's API (413) -- skipping: ${fileName}`);
      } else if (error.axes4Status === 422) {
        logger.warn(`[axes4] Document could not be processed (422, may be invalid) -- skipping: ${fileName}`);
      } else if (error.name === 'AbortError') {
        logger.warn(`[axes4] Request timed out after ${axes4Config.timeoutMs}ms -- skipping: ${fileName}`);
      } else {
        logger.warn(`[axes4] Request failed -- skipping: ${fileName}`, error);
      }
      return { ran: false, failures: [] };
    }
  }

  private async submitJob(buffer: Buffer, fileName: string): Promise<{ jobId: string; uaIndex?: number }> {
    const params = new URLSearchParams({ name: fileName });
    for (const checkset of axes4Config.checksets) params.append('checksets', checkset);
    const url = `${axes4Config.apiUrl}/v3/subscription/${encodeURIComponent(axes4Config.subscriptionId)}/jobs?${params.toString()}`;

    const response = await this.fetchWithRetry(url, {
      method: 'POST',
      headers: {
        'x-api-key': axes4Config.apiKey,
        'Content-Type': 'application/octet-stream',
      },
      body: buffer,
    });

    const parsed = (await response.json()) as Axes4SummaryResponse;
    const uaReport = parsed.body.reports.find((r) => r.type === 'PDF/UA');
    return { jobId: parsed.body.jobId, uaIndex: uaReport?.uaIndex };
  }

  private async fetchDetails(jobId: string): Promise<Axes4Failure[]> {
    const url = `${axes4Config.apiUrl}/v3/subscription/${encodeURIComponent(axes4Config.subscriptionId)}/jobs/${encodeURIComponent(jobId)}/report/details`;

    const response = await this.fetchWithRetry(url, {
      method: 'GET',
      headers: { 'x-api-key': axes4Config.apiKey },
    });

    const parsed = (await response.json()) as Axes4DetailResponse;
    const failures: Axes4Failure[] = [];

    for (const group of parsed.body.issues) {
      for (const issue of group.issues) {
        // First occurrence only -- same "first check/finding only"
        // convention verapdf.service.ts/pdfa11y.service.ts already
        // established (Ninja surfaces one representative AuditIssue per
        // condition, not one per raw occurrence).
        const firstDetail = issue.details[0];
        const pageNumber = firstDetail?.pageIndex != null ? firstDetail.pageIndex + 1 : undefined;
        const rectangle = firstDetail?.rectangle ?? undefined;

        failures.push({
          checkId: issue.checkId,
          description: issue.caption,
          pageNumber,
          rectangle,
          count: issue.count,
        });
      }
    }

    return failures;
  }

  /** AbortController-timeout + retry-on-5xx/fail-fast-on-4xx, the same
   *  shape pdfxt-client.ts's detectWithPdfxt already establishes for this
   *  codebase's other cloud-HTTP-API integration. Throws an Error with an
   *  `axes4Status` property set on a terminal 4xx response, so validate()'s
   *  catch block can log a specific, actionable message per documented
   *  code (401/403/413/422) rather than a generic failure.
   *
   *  POST is NOT retried on a 5xx response: a job-creation POST that fails
   *  with a 5xx may have already created the job server-side (and consumed
   *  a paid page-quota unit) before the error -- retrying risks submitting
   *  a duplicate job. Only a genuine pre-response connection failure (the
   *  request never reached axes4) is retried for POST. GET (idempotent --
   *  fetching an already-created job's details) keeps retrying on 5xx as
   *  before. */
  private async fetchWithRetry(url: string, init: RequestInit): Promise<Response> {
    const maxAttempts = 3;
    const retryOn5xx = (init.method ?? 'GET').toUpperCase() === 'GET';

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), axes4Config.timeoutMs);

      let response: Response;
      try {
        response = await fetch(url, { ...init, signal: controller.signal });
      } catch (err) {
        clearTimeout(timer);
        if (err instanceof Error && err.name === 'AbortError') throw err;
        if (attempt < maxAttempts) {
          await sleep(3000);
          continue;
        }
        throw err;
      }
      clearTimeout(timer);

      if (response.ok) return response;

      if (response.status >= 400 && response.status < 500) {
        const error = new Error(`AXES4_CLIENT_ERROR: ${response.status}`) as Error & { axes4Status: number };
        error.axes4Status = response.status;
        throw error;
      }

      // 5xx -- retry only when safe (see this method's own doc comment).
      if (retryOn5xx && attempt < maxAttempts) {
        await sleep(3000);
        continue;
      }
      throw new Error(`AXES4_SERVICE_ERROR: ${response.status}${retryOn5xx ? ' after retries' : ' (not retried -- non-idempotent request)'}`);
    }

    // Unreachable, but TypeScript needs it.
    throw new Error('AXES4_SERVICE_ERROR: unexpected');
  }
}

export const axes4PacService = new Axes4PacService();
