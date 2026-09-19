/**
 * pdfa11y CLI wrapper service
 *
 * Runs speedata/pdfa11y (https://github.com/speedata/pdfa11y) in PDF/UA-1
 * mode and parses its JSON report into Pdfa11yFailure[].
 *
 * Matterhorn Coverage Plan — Step 6 (second free/open external validator,
 * alongside veraPDF — see verapdf.service.ts's own header).
 *
 * pdfa11y's own rule IDs (e.g. "UA-10-004") do NOT correspond to Matterhorn
 * Protocol 1.1 condition numbers despite superficially similar formatting —
 * confirmed by cross-referencing every candidate against the real Matterhorn
 * condition text before adding it to pdfa11y-matterhorn.map.ts (see that
 * file's own header for the validation methodology and a concrete example
 * of a false-by-number-alone match this caught).
 *
 * Graceful degradation (never throws):
 *   - PDFA11Y_PATH unset or binary missing → isAvailable() false;
 *                                             validate() logs one logger.info, returns []
 *   - Binary not executable / exec fails    → logger.info, returns []
 *   - Timeout (120 s)                       → logger.warn, returns []
 *   - Non-zero exit but JSON in stdout       → parse what we can, return failures
 *     (pdfa11y exits non-zero whenever verdict is FAIL, same convention as veraPDF)
 *   - Non-zero exit without parseable JSON   → logger.warn, returns []
 *   - ruleId absent from mapping table       → logger.warn per ruleId; failure still returned
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { logger } from '../../lib/logger';
import { PDFA11Y_MATTERHORN_MAP } from '../../data/pdfa11y-matterhorn.map';

const execFileAsync = promisify(execFile);

/** A single pdfa11y rule failure parsed from its JSON report. */
export interface Pdfa11yFailure {
  /** pdfa11y's own rule ID, e.g. "UA-10-004" -- NOT a Matterhorn condition ID */
  ruleId: string;
  /** Human-readable finding message from the report (first finding only) */
  description: string;
  /** 1-based page number of the first finding, if the report includes one */
  pageNumber?: number;
  /** struct_path or other location context from the first finding, if present */
  context?: string;
}

export interface Pdfa11yValidationResult {
  /**
   * True only when pdfa11y actually executed and produced parseable JSON
   * output — false for every graceful-degradation path (unavailable,
   * timeout, exec error, unparseable stdout), even though those also
   * return an empty `failures` array. See VeraPdfValidationResult's own
   * doc comment (verapdf.service.ts) for why this distinction is required:
   * a caller must never treat "found nothing" the same as "never ran" when
   * deciding whether a Matterhorn condition genuinely passed.
   */
  ran: boolean;
  failures: Pdfa11yFailure[];
}

const TIMEOUT_MS = 120_000;

interface Pdfa11yFinding {
  severity?: string;
  message?: string;
  hint?: string;
  location?: { page?: number; struct_path?: string };
}

interface Pdfa11yResult {
  id: string;
  state: string; // 'PASS' | 'FAIL' | 'WARN' | 'N/A'
  findings?: Pdfa11yFinding[];
}

interface Pdfa11yReport {
  path: string;
  verdict: string;
  results: Pdfa11yResult[];
}

class Pdfa11yService {
  private readonly binaryPath: string;

  constructor() {
    this.binaryPath = process.env.PDFA11Y_PATH ?? '';
  }

  /**
   * Returns true only when PDFA11Y_PATH is set and the binary exists on disk.
   */
  isAvailable(): boolean {
    if (!this.binaryPath) return false;
    return existsSync(this.binaryPath);
  }

  /**
   * Run pdfa11y against filePath in PDF/UA-1 JSON mode.
   * Never throws — always returns a Pdfa11yValidationResult. See that
   * type's own doc comment for why `ran` matters and must not be ignored.
   * Logs one logger.info when not available; logger.warn on timeout or exec error.
   */
  async validate(filePath: string): Promise<Pdfa11yValidationResult> {
    if (!this.isAvailable()) {
      logger.info('[pdfa11y] Not available (PDFA11Y_PATH unset or binary missing) — skipping');
      return { ran: false, failures: [] };
    }

    let stdout: string;

    try {
      const result = await execFileAsync(
        this.binaryPath,
        ['--format=json', '--spec=pdfua1', filePath],
        { timeout: TIMEOUT_MS, maxBuffer: 50 * 1024 * 1024 },
      );
      stdout = result.stdout;
    } catch (err: unknown) {
      const error = err as Error & {
        killed?: boolean;
        code?: string;
        stdout?: string;
        stderr?: string;
      };

      if (error.killed) {
        logger.warn(`[pdfa11y] Validation timed out after ${TIMEOUT_MS}ms — skipping: ${filePath}`);
        return { ran: false, failures: [] };
      }

      if (error.code === 'ENOENT' || error.code === 'EACCES') {
        logger.info(`[pdfa11y] Not available (binary not executable or missing, code=${error.code}) — skipping`);
        return { ran: false, failures: [] };
      }

      // pdfa11y exits non-zero whenever the verdict is FAIL, same convention
      // as veraPDF -- the JSON report is still on stdout in that case.
      const captured = error.stdout ?? '';
      const trimmed = captured.trim();
      if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
        stdout = captured;
      } else {
        logger.warn(
          `[pdfa11y] Execution error (code=${error.code}) — skipping: ${filePath}`,
          error,
        );
        return { ran: false, failures: [] };
      }
    }

    const trimmedStdout = stdout?.trim() ?? '';
    if (!trimmedStdout.startsWith('[') && !trimmedStdout.startsWith('{')) {
      logger.warn(`[pdfa11y] Output did not look like JSON — skipping: ${filePath}`);
      return { ran: false, failures: [] };
    }

    const failures = this.parseJsonReport(stdout, filePath);

    for (const failure of failures) {
      if (!PDFA11Y_MATTERHORN_MAP.has(failure.ruleId)) {
        logger.warn(
          `[pdfa11y] Unmapped ruleId: ${failure.ruleId} — description: ${failure.description}`,
        );
      }
    }

    return { ran: true, failures };
  }

  /**
   * Parse a pdfa11y `--format=json` report (a JSON array, one entry per
   * input file -- exactly one here, since validate() always passes a
   * single filePath) into Pdfa11yFailure[].
   *
   * A rule in state FAIL or WARN is treated as a genuine failure: pdfa11y
   * downgrades some strictly-required PDF/UA-1 checks to WARN for leniency
   * (e.g. standard-14 fonts left unembedded, which most viewers tolerate
   * but PDF/UA-1 §7.21.3 still requires embedded) -- the underlying spec
   * requirement is still violated either way. Only the FIRST finding per
   * rule is kept, matching verapdf.service.ts's own "first check only"
   * precedent (Ninja surfaces one representative AuditIssue per Matterhorn
   * condition, not one per raw finding).
   */
  private parseJsonReport(json: string, filePath: string): Pdfa11yFailure[] {
    if (!json?.trim()) return [];

    let parsed: Pdfa11yReport[];
    try {
      parsed = JSON.parse(json) as Pdfa11yReport[];
    } catch (err) {
      logger.warn(`[pdfa11y] Failed to parse JSON report for ${filePath}`, err);
      return [];
    }

    const failures: Pdfa11yFailure[] = [];

    try {
      const doc = Array.isArray(parsed) ? parsed[0] : undefined;
      if (!doc || !Array.isArray(doc.results)) return [];

      for (const result of doc.results) {
        if (result.state !== 'FAIL' && result.state !== 'WARN') continue;

        const firstFinding = Array.isArray(result.findings) ? result.findings[0] : undefined;
        const description = firstFinding?.message ?? result.id;
        const pageNumber = firstFinding?.location?.page;
        const context = firstFinding?.location?.struct_path;

        failures.push({ ruleId: result.id, description, pageNumber, context });
      }
    } catch (err) {
      logger.warn(`[pdfa11y] Error traversing JSON report for ${filePath}`, err);
    }

    return failures;
  }
}

export const pdfa11yService = new Pdfa11yService();
