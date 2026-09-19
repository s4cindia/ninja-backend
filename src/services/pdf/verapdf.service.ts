/**
 * veraPDF CLI wrapper service
 *
 * Runs veraPDF in PDF/UA-1 (ua1) mode and parses the Machine Readable Report
 * (MRR) XML output into VeraPdfFailure[].
 *
 * Matterhorn Coverage Plan — Step 4b
 *
 * Graceful degradation (never throws):
 *   - VERAPDF_PATH unset or binary missing → isAvailable() false;
 *                                             validate() logs one logger.info, returns []
 *   - Java not found / exec fails           → logger.info('[veraPDF] not available'), returns []
 *   - Timeout (120 s)                       → logger.warn, returns []
 *   - Non-zero exit but XML in stdout       → parse what we can, return failures
 *   - Non-zero exit without XML             → logger.warn, returns []
 *   - ruleId absent from mapping table      → logger.warn per ruleId; failure still returned
 */

import { execFile } from 'child_process';
import { promisify } from 'util';
import { existsSync } from 'fs';
import { XMLParser } from 'fast-xml-parser';
import { logger } from '../../lib/logger';
import { VERAPDF_MATTERHORN_MAP } from '../../data/verapdf-matterhorn.map';

const execFileAsync = promisify(execFile);

/** A single veraPDF rule failure parsed from the MRR XML report. */
export interface VeraPdfFailure {
  /** veraPDF rule ID in the format returned by the MRR, e.g. "1:6.2-1" */
  ruleId: string;
  /** Human-readable rule description from the MRR */
  description: string;
  /** 1-based page number of the first occurrence, if the MRR includes location info */
  pageNumber?: number;
  /** Raw context string from the MRR check element (e.g. a PDF object reference) */
  context?: string;
}

export interface VeraPdfValidationResult {
  /**
   * True only when veraPDF actually executed and produced parseable MRR
   * output — false for every graceful-degradation path (unavailable,
   * timeout, exec error, unparseable stdout), even though those also
   * return an empty `failures` array. Codex finding, confirmed real: a
   * caller that only looked at `failures.length === 0` couldn't tell "ran
   * and found nothing" apart from "never ran at all", which let
   * pac-report.service.ts classify a condition as PASS purely because
   * veraPDF happened not to be available for that audit — a false
   * PDF/UA-compliance result. Callers MUST check `ran` before treating an
   * empty `failures` array as a genuine pass.
   */
  ran: boolean;
  failures: VeraPdfFailure[];
}

const TIMEOUT_MS = 120_000;

class VeraPdfService {
  private readonly binaryPath: string;

  constructor() {
    this.binaryPath = process.env.VERAPDF_PATH ?? '';
  }

  /**
   * Returns true only when VERAPDF_PATH is set and the binary exists on disk.
   * Does not verify Java availability (that is handled gracefully in validate()).
   */
  isAvailable(): boolean {
    if (!this.binaryPath) return false;
    return existsSync(this.binaryPath);
  }

  /**
   * Run veraPDF against filePath in PDF/UA-1 MRR mode.
   * Never throws — always returns a VeraPdfValidationResult. See that
   * type's own doc comment for why `ran` matters and must not be ignored.
   * Logs one logger.info when not available; logger.warn on timeout or exec error.
   */
  async validate(filePath: string): Promise<VeraPdfValidationResult> {
    if (!this.isAvailable()) {
      logger.info('[veraPDF] Not available (VERAPDF_PATH unset or binary missing) — skipping');
      return { ran: false, failures: [] };
    }

    let stdout: string;

    try {
      const result = await execFileAsync(
        this.binaryPath,
        ['--flavour', 'ua1', '--format', 'mrr', '--maxfailuresdisplayed', '99999', filePath],
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
        logger.warn(`[veraPDF] Validation timed out after ${TIMEOUT_MS}ms — skipping: ${filePath}`);
        return { ran: false, failures: [] };
      }

      // Java not found or binary not executable — treat as unavailable.
      if (error.code === 'ENOENT' || error.code === 'EACCES') {
        logger.info(`[veraPDF] Not available (binary not executable or Java missing, code=${error.code}) — skipping`);
        return { ran: false, failures: [] };
      }

      // veraPDF exits non-zero when it finds failures but still emits valid MRR XML to stdout.
      const captured = error.stdout ?? '';
      if (captured.includes('<report')) {
        stdout = captured;
      } else {
        logger.warn(
          `[veraPDF] Execution error (code=${error.code}) — skipping: ${filePath}`,
          error,
        );
        return { ran: false, failures: [] };
      }
    }

    if (!stdout?.includes('<report')) {
      logger.warn(`[veraPDF] Output did not look like MRR XML — skipping: ${filePath}`);
      return { ran: false, failures: [] };
    }

    const failures = this.parseMrrXml(stdout, filePath);

    // Log a warning for each ruleId that has no Matterhorn mapping.
    // These should be added to src/data/verapdf-matterhorn.map.ts.
    for (const failure of failures) {
      if (!VERAPDF_MATTERHORN_MAP.has(failure.ruleId)) {
        logger.warn(
          `[veraPDF] Unmapped ruleId: ${failure.ruleId} — description: ${failure.description}`,
        );
      }
    }

    return { ran: true, failures };
  }

  /**
   * Parse a veraPDF MRR XML string into VeraPdfFailure[].
   *
   * Real MRR structure, confirmed against veraPDF 1.30.2 CLI output
   * (`<check>` is a direct child of `<rule>` — there is no wrapping
   * `<checks>` element, and there is no `<location>` element; the page
   * index is embedded in `<context>` instead, e.g. ".../pages[0](...)"):
   *   <report>
   *     <jobs>
   *       <job>
   *         <validationReport>
   *           <details>
   *             <rule status="failed" specification="ISO 14289-1:2014"
   *                   clause="7.21.4.1" testNumber="1">
   *               <description>…</description>
   *               <check status="failed">
   *                 <context>root/document[0]/pages[0](27 0 obj PDPage)/…</context>
   *                 <errorMessage>…</errorMessage>
   *               </check>
   *             </rule>
   *           </details>
   *         </validationReport>
   *       </job>
   *     </jobs>
   *   </report>
   *
   * ruleId format: "{specMajor}:{clause}-{testNumber}"
   * e.g. specification="ISO 14289-1:2014" clause="7.21.4.1" testNumber="1"
   *      → "1:7.21.4.1-1"
   */
  private parseMrrXml(xml: string, filePath: string): VeraPdfFailure[] {
    if (!xml?.includes('<report')) return [];

    const parser = new XMLParser({
      ignoreAttributes: false,
      attributeNamePrefix: '@_',
      isArray: (tagName) => ['rule', 'check', 'job'].includes(tagName),
    });

    let parsed: Record<string, unknown>;
    try {
      parsed = parser.parse(xml) as Record<string, unknown>;
    } catch (err) {
      logger.warn(`[veraPDF] Failed to parse MRR XML for ${filePath}`, err);
      return [];
    }

    const failures: VeraPdfFailure[] = [];

    try {
      const report = parsed['report'] as Record<string, unknown> | undefined;
      const jobsWrapper = report?.['jobs'] as Record<string, unknown> | undefined;
      const jobs = jobsWrapper?.['job'];
      if (!Array.isArray(jobs)) return [];

      for (const job of jobs) {
        const valReport = (job as Record<string, unknown>)['validationReport'] as
          | Record<string, unknown>
          | undefined;
        const details = valReport?.['details'] as Record<string, unknown> | undefined;
        const rules = details?.['rule'];
        if (!Array.isArray(rules)) continue;

        for (const rule of rules) {
          const r = rule as Record<string, unknown>;
          if ((r['@_status'] as string | undefined) !== 'failed') continue;

          const specification = (r['@_specification'] as string | undefined) ?? '';
          const clause = (r['@_clause'] as string | undefined) ?? '';
          const testNumber = (r['@_testNumber'] as string | undefined) ?? '';
          const description = ((r['description'] as string | undefined) ?? '').trim();

          // Extract the PDF/UA part number from the specification string.
          // Real values look like "ISO 14289-1:2014" — the trailing ":2014"
          // year would wrongly win a naive /\d+$/ match, so strip it first
          // and pull the digit after the last hyphen (the "-1" part number).
          const specMajor =
            specification.replace(/:\d{4}$/, '').match(/-(\d+)$/)?.[1] ??
            specification.match(/\d+$/)?.[0] ??
            '1';
          const ruleId = `${specMajor}:${clause}-${testNumber}`;

          // `<check>` is a direct child of `<rule>` — no `<checks>` wrapper.
          const checkList = r['check'];
          const firstCheck = Array.isArray(checkList) ? checkList[0] : undefined;

          let pageNumber: number | undefined;
          let context: string | undefined;

          if (firstCheck) {
            const fc = firstCheck as Record<string, unknown>;
            const location = fc['location'] as Record<string, unknown> | undefined;
            const rawPage = location?.['@_page'] ?? location?.['@_pageNumber'];
            if (rawPage != null) {
              const p = parseInt(String(rawPage), 10);
              if (!isNaN(p)) pageNumber = p;
            }
            const rawContext = fc['context'] as string | undefined;
            if (rawContext) {
              context = String(rawContext).trim().slice(0, 200);
              // No <location> element is present in real MRR output — the
              // 0-based page index lives inside the context path instead,
              // e.g. "root/document[0]/pages[0](27 0 obj PDPage)/…".
              if (pageNumber === undefined) {
                const pageMatch = /\bpages\[(\d+)\]/.exec(context);
                if (pageMatch) pageNumber = parseInt(pageMatch[1], 10) + 1;
              }
            }
          }

          failures.push({ ruleId, description, pageNumber, context });
        }
      }
    } catch (err) {
      logger.warn(`[veraPDF] Error traversing MRR XML for ${filePath}`, err);
    }

    return failures;
  }
}

export const veraPdfService = new VeraPdfService();
