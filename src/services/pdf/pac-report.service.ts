/**
 * PAC-Equivalent Report Service
 *
 * Generates a Matterhorn Protocol 1.1 compliance report for a completed
 * PDF audit job, covering all 137 conditions across 31 checkpoints.
 *
 * Core principle: UNTESTED ≠ PASS
 *   - Machine conditions with no test are marked UNTESTED, not PASS.
 *   - Human-only conditions are marked HUMAN_REQUIRED.
 *   - Conditions not relevant to this document are NOT_APPLICABLE.
 *
 * Matterhorn Coverage Plan — Step 5
 */

import { Prisma } from '@prisma/client';
import { logger } from '../../lib/logger';
import prisma from '../../lib/prisma';
import {
  MATTERHORN_CONDITIONS,
  MatterhornCondition,
} from '../../data/matterhorn-1.1.data';
import type { AuditIssue } from '../audit/base-audit.service';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PacConditionStatus =
  | 'PASS'
  | 'FAIL'
  | 'UNTESTED'
  | 'HUMAN_REQUIRED'
  | 'NOT_APPLICABLE';

export type PacCheckpointStatus = 'PASS' | 'FAIL' | 'UNTESTED' | 'HUMAN_REQUIRED';

export interface PacConditionResult {
  id: string;
  description: string;
  how: 'M' | 'H' | '--';
  status: PacConditionStatus;
  /** IDs of AuditIssues that caused this FAIL */
  issueIds?: string[];
  /** Which validator sourced the failing issue */
  source?: 'ninja' | 'verapdf' | 'pdfa11y';
}

export interface PacCheckpointResult {
  id: string;
  title: string;
  status: PacCheckpointStatus;
  conditions: PacConditionResult[];
}

export interface PacReportSummary {
  total: number;
  pass: number;
  fail: number;
  untested: number;
  humanRequired: number;
  notApplicable: number;
}

export interface PacReport {
  jobId: string;
  fileName: string;
  generatedAt: string;
  ninjaVersion: string;
  isTagged: boolean;
  summary: PacReportSummary;
  checkpoints: PacCheckpointResult[];
}

// ─── Testable conditions ──────────────────────────────────────────────────────

/**
 * Matterhorn condition IDs that Ninja's OWN validators can test —
 * unconditionally testable, since Ninja's own code always runs as part of
 * every audit (no external binary/availability dependency).
 *
 * A condition in this set but with no corresponding failing issue → PASS.
 * A machine condition in NEITHER this set nor the veraPDF/pdfa11y sets
 * below (or in one of those sets but that tool didn't run for this
 * specific audit — see generateReport's own buildEffectiveTestableSet) →
 * UNTESTED.
 *
 * Update this set whenever a new Ninja-native validator is added.
 */
const NINJA_TESTABLE_CONDITIONS: ReadonlySet<string> = new Set([
  // ── Structure validator ──────────────────────────────────────────────────
  '01-004', // Tagged content inside Artifact
  // NOTE: 01-005 ("Content is neither marked as Artifact nor tagged as real
  // content") is deliberately NOT listed here despite pdf-structure.validator.ts
  // emitting UNTAGGED-CONTENT issues with matterhornCheckpoint: '01-005'.
  // CodeRabbit finding, confirmed real: that validator only scans painted
  // *paths* (pdf-artifact-tagger.ts) -- a tagged PDF whose only untagged
  // content is text, an image/XObject, an inline image, or a shading
  // produces no issue there at all, so treating 01-005 as fully Ninja-
  // tested would make a document with an untagged IMAGE (a real 01-005
  // violation this codebase doesn't check for) wrongly report PASS. A real
  // UNTAGGED-CONTENT failure still correctly reports FAIL regardless (see
  // classifyCondition: a present failing issue always wins over testable-
  // set membership) -- omitting this from the testable set only affects
  // the no-failure-found case, correctly falling back to UNTESTED instead
  // of a false PASS. Add it here only once detection covers every
  // applicable content type (Do/BI/sh, including nested Form XObjects).
  '06-002', // pdfuaid:part missing from XMP metadata
  '07-001', // ViewerPreferences/DisplayDocTitle not set (if emitted)
  '11-001', // Document language is not specified (stale comment fixed: this
            // is Matterhorn's real language condition, not a table check —
            // tables are CP15, listed separately below)
  '12-001', // Logical reading order cannot be determined
  '14-002', // First heading tag is not H1
  '14-003', // Numbered heading levels skip (e.g. H3 directly follows H1) --
            // was miswired to 'missing-h1' (no H1 anywhere) instead of the
            // real skipped-level detector; fixed alongside adding this
            // checkpoint's other two conditions below.
  '14-006', // A single structure element has more than one direct H tag
  '14-007', // Document uses both the generic H tag and numbered H1-H9 tags

  // ── Alt text validator ───────────────────────────────────────────────────
  '13-001', // Figure has no /Alt AND no /ActualText
  '13-004', // Figure /Alt value is empty string

  // ── Supplemental validator (CP19/20/21/25/26/30) ─────────────────────────
  '19-003', // Note structure element with duplicate ID
  '19-004', // Note structure element without ID
  '20-001', // OC Config Dict in /Configs missing /Name
  '20-002', // OC Config Dict in /D missing /Name
  '20-003', // OC Config Dict missing /AS entry
  '21-001', // Embedded file spec missing /F or /UF entry
  '25-001', // XFA dynamicRender set to required
  '26-001', // Encryption dictionary present
  '26-002', // Encryption /P flag does not allow text extraction
  '30-001', // Reference XObject present in page resources

  // ── Table validator ──────────────────────────────────────────────────────
  // Note: table validator sets code='MATTERHORN-15-00X' but not matterhornCheckpoint.
  // The PAC service resolves these via the code fallback below.
  '15-001',
  '15-002',
  '15-003',
  '15-004',
  '15-005',
]);

/**
 * Matterhorn condition IDs testable via veraPDF (Matterhorn Coverage Plan
 * Step 4) — only counted as testable for a given report when that report's
 * audit actually ran veraPDF (see PdfValidationResult.veraPdfRan / Codex
 * finding on PR #577: a condition here must NOT be classified PASS just
 * because veraPDF happened to be unavailable for this particular audit).
 *
 * Only conditions with a VALIDATED entry in verapdf-matterhorn.map.ts — see
 * that file for how each was confirmed against real MRR output.
 */
const VERAPDF_TESTABLE_CONDITIONS: ReadonlySet<string> = new Set([
  '31-009', // font program not embedded
  '31-027', // font missing ToUnicode entry
  '31-012', // Type1 font CharSet omits a glyph present in the font program
]);

/**
 * Matterhorn condition IDs testable via pdfa11y (Matterhorn Coverage Plan
 * Step 6) — only counted as testable for a given report when that report's
 * audit actually ran pdfa11y (see PdfValidationResult.pdfa11yRan / the same
 * Codex finding as VERAPDF_TESTABLE_CONDITIONS above).
 *
 * Only conditions with a VALIDATED entry in pdfa11y-matterhorn.map.ts — see
 * that file's header for why pdfa11y's own rule-ID numbers can't be
 * trusted by number alone, and how each entry below was confirmed against
 * real Matterhorn condition text instead.
 */
const PDFA11Y_TESTABLE_CONDITIONS: ReadonlySet<string> = new Set([
  // CodeRabbit finding on PR #577, confirmed real: pdfa11y-matterhorn.map.ts
  // ALSO maps UA-09-001/UA-10-001 to these same two conditions as a
  // redundant cross-validating fallback (see that file's own comments) --
  // but veraPdfRan and pdfa11yRan are tracked independently, so an audit
  // where pdfa11y ran but veraPDF did not (different binary availability,
  // one timed out, etc.) must still be able to mark these PASS from
  // pdfa11y's own result, not just from VERAPDF_TESTABLE_CONDITIONS.
  '31-009', // font program not embedded (also in VERAPDF_TESTABLE_CONDITIONS)
  '31-027', // font missing ToUnicode entry (also in VERAPDF_TESTABLE_CONDITIONS)
  '11-002', // Alt/ActualText/E language cannot be determined
  '11-003', // Outline entry language cannot be determined
  '11-004', // Annotation /Contents language cannot be determined
  '11-005', // Form field /TU language cannot be determined
  '11-006', // Document metadata language cannot be determined
  '28-004', // Annotation missing /Contents and no enclosing /Alt
  '28-005', // Form field missing /TU and no enclosing /Alt
  '28-007', // TrapNet annotation present
  '28-010', // Widget annotation not nested within a Form structure element
  '28-011', // Link annotation not nested within a Link structure element
  '28-014', // Media clip data dictionary missing /CT entry
  '28-015', // Media clip data dictionary missing /Alt entry
  '31-030', // Text-showing operator references the .notdef glyph
  '10-001', // Character code cannot be mapped to Unicode (ToUnicode CMap exists but incomplete)
]);

// ─── Service ──────────────────────────────────────────────────────────────────

class PacReportService {
  /**
   * Generate a PAC-equivalent Matterhorn Protocol 1.1 report for a job.
   *
   * @param jobId    Completed PDF audit job ID
   * @param tenantId Tenant ID for authorization check
   */
  async generateReport(jobId: string, tenantId: string): Promise<PacReport> {
    const job = await prisma.job.findFirst({
      where: { id: jobId, tenantId },
    });

    if (!job) {
      throw Object.assign(new Error('Job not found or access denied'), { statusCode: 404 });
    }

    if (job.status !== 'COMPLETED') {
      throw Object.assign(
        new Error('PAC report is only available for completed jobs'),
        { statusCode: 400 },
      );
    }

    // Extract audit issues from job output
    const output = job.output as Record<string, unknown> | null;
    const auditReport = output?.['auditReport'] as Record<string, unknown> | undefined;
    const rawIssues = (auditReport?.['issues'] as AuditIssue[] | undefined) ?? [];
    const metadata = auditReport?.['metadata'] as Record<string, unknown> | undefined;
    const isTagged = metadata?.['isTagged'] as boolean ?? false;
    const jobInput = job.input as Record<string, unknown> | null;
    const fileName = (auditReport?.['fileName'] as string | undefined) ?? (jobInput?.['fileName'] as string | undefined) ?? 'unknown.pdf';

    // A condition only veraPDF/pdfa11y can test must not be classified PASS
    // when that tool never actually ran for THIS audit (Codex finding on
    // PR #577) — build this report's effective testable set from what
    // genuinely ran, not just from the static per-tool condition lists.
    const veraPdfRan = metadata?.['veraPdfRan'] === true;
    const pdfa11yRan = metadata?.['pdfa11yRan'] === true;
    const effectiveTestableConditions = new Set(NINJA_TESTABLE_CONDITIONS);
    if (veraPdfRan) for (const id of VERAPDF_TESTABLE_CONDITIONS) effectiveTestableConditions.add(id);
    if (pdfa11yRan) for (const id of PDFA11Y_TESTABLE_CONDITIONS) effectiveTestableConditions.add(id);

    // Build a lookup: matterhornConditionId → [issue, ...]
    const failureMap = this.buildFailureMap(rawIssues);

    // Build checkpoint results across all 31 checkpoints
    const checkpointMap = new Map<string, PacCheckpointResult>();

    for (const [, condition] of MATTERHORN_CONDITIONS) {
      const conditionResult = this.classifyCondition(condition, failureMap, effectiveTestableConditions);

      let checkpoint = checkpointMap.get(condition.checkpoint);
      if (!checkpoint) {
        checkpoint = {
          id: condition.checkpoint,
          title: condition.title,
          status: 'PASS',
          conditions: [],
        };
        checkpointMap.set(condition.checkpoint, checkpoint);
      }

      checkpoint.conditions.push(conditionResult);
    }

    // Roll up condition statuses to checkpoint level
    for (const checkpoint of checkpointMap.values()) {
      checkpoint.status = this.rollupStatus(checkpoint.conditions);
    }

    const checkpoints = Array.from(checkpointMap.values()).sort(
      (a, b) => parseInt(a.id) - parseInt(b.id),
    );

    const summary = this.buildSummary(checkpoints);
    const generatedAt = new Date().toISOString();

    // Tracked for the guided-remediation checklist's step 6 gate — best-effort,
    // never fails the report itself if the write doesn't land. Re-fetches the
    // job immediately before writing rather than reusing the `output`
    // snapshot loaded at the top of this method — a concurrent write
    // elsewhere (an ACR generation, a background re-audit) could otherwise
    // be silently erased by this one replacing the whole output JSON blob
    // with a stale copy.
    try {
      const latestJob = await prisma.job.findUnique({ where: { id: jobId } });
      const latestOutput = (latestJob?.output ?? {}) as Record<string, unknown>;
      await prisma.job.update({
        where: { id: jobId },
        data: {
          output: {
            ...latestOutput,
            pacReportGenerated: true,
            pacReportGeneratedAt: generatedAt,
          } as Prisma.InputJsonObject,
        },
      });
    } catch (err) {
      logger.warn(`[PacReport] Failed to record pacReportGenerated for job ${jobId} (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      jobId,
      fileName,
      generatedAt,
      ninjaVersion: process.env.npm_package_version ?? '1.0.0',
      isTagged,
      summary,
      checkpoints,
    };
  }

  /**
   * Build a map from Matterhorn condition ID → AuditIssue[].
   *
   * Resolves condition IDs from two sources:
   *   1. issue.matterhornCheckpoint  (most validators)
   *   2. issue.code matching /^MATTERHORN-(\d{2}-\d{3})$/  (table validator fallback)
   */
  private buildFailureMap(issues: AuditIssue[]): Map<string, AuditIssue[]> {
    const map = new Map<string, AuditIssue[]>();

    for (const issue of issues) {
      let conditionId = issue.matterhornCheckpoint;

      // Fallback: extract from code like "MATTERHORN-15-001"
      if (!conditionId && issue.code) {
        const match = issue.code.match(/^MATTERHORN-(\d{2}-\d{3})$/);
        if (match) conditionId = match[1];
      }

      if (!conditionId) continue;

      const existing = map.get(conditionId);
      if (existing) {
        existing.push(issue);
      } else {
        map.set(conditionId, [issue]);
      }
    }

    return map;
  }

  /**
   * Classify a single Matterhorn condition as PASS/FAIL/UNTESTED/etc.
   */
  private classifyCondition(
    condition: MatterhornCondition,
    failureMap: Map<string, AuditIssue[]>,
    effectiveTestableConditions: ReadonlySet<string>,
  ): PacConditionResult {
    const base: PacConditionResult = {
      id: condition.id,
      description: condition.description,
      how: condition.how,
      status: 'UNTESTED',
    };

    // Human-only conditions cannot be machine-tested
    if (condition.how === 'H') {
      return { ...base, status: 'HUMAN_REQUIRED' };
    }

    // No-test conditions (spec defines no specific test)
    if (condition.how === '--') {
      return { ...base, status: 'NOT_APPLICABLE' };
    }

    // Machine condition (how === 'M')
    const failingIssues = failureMap.get(condition.id);
    if (failingIssues && failingIssues.length > 0) {
      return {
        ...base,
        status: 'FAIL',
        issueIds: failingIssues.map((i) => i.id),
        source: failingIssues[0].source === 'verapdf' || failingIssues[0].source === 'pdfa11y'
          ? failingIssues[0].source
          : 'ninja',
      };
    }

    if (effectiveTestableConditions.has(condition.id)) {
      return { ...base, status: 'PASS' };
    }

    return { ...base, status: 'UNTESTED' };
  }

  /**
   * Roll up condition statuses to a single checkpoint status.
   * Priority: FAIL > UNTESTED > HUMAN_REQUIRED > PASS
   */
  private rollupStatus(conditions: PacConditionResult[]): PacCheckpointStatus {
    const statuses = conditions.map((c) => c.status);
    if (statuses.includes('FAIL')) return 'FAIL';
    if (statuses.includes('UNTESTED')) return 'UNTESTED';
    if (statuses.every((s) => s === 'HUMAN_REQUIRED' || s === 'NOT_APPLICABLE')) {
      return 'HUMAN_REQUIRED';
    }
    return 'PASS';
  }

  private buildSummary(checkpoints: PacCheckpointResult[]): PacReportSummary {
    const allConditions = checkpoints.flatMap((cp) => cp.conditions);
    return {
      total: allConditions.length,
      pass: allConditions.filter((c) => c.status === 'PASS').length,
      fail: allConditions.filter((c) => c.status === 'FAIL').length,
      untested: allConditions.filter((c) => c.status === 'UNTESTED').length,
      humanRequired: allConditions.filter((c) => c.status === 'HUMAN_REQUIRED').length,
      notApplicable: allConditions.filter((c) => c.status === 'NOT_APPLICABLE').length,
    };
  }
}

export const pacReportService = new PacReportService();

logger.info('[PacReport] Service initialised');
