/**
 * PDF certification for the EPUB-from-certified-PDF gate (B3a).
 *
 * A certification says: this exact remediated PDF (pdfSha256) was checked
 * in Acrobat Pro and PAC, with this exact evidence (the uploaded reports,
 * pinned by s3Key + updatedAt), and every remaining failure was waived with
 * a recorded reason. Rules (all must hold; certify reports every unmet one
 * at once as 422 CERTIFICATION_BLOCKED):
 *
 *   - the job has a remediated file;
 *   - an Acrobat report and a PAC report are uploaded, each bound to the
 *     current remediated file (remediatedSha256 non-null and equal);
 *   - Acrobat: every Failed / Failed manually rule is waived (by rule id),
 *     with no waivers for rules that didn't fail; the failures must be
 *     identifiable from the report (a parsed rule table);
 *   - PAC: the fail count is known; the operator attests 0 PDF/UA errors;
 *     if fail > 0, one waiver per failed PAC CHECK -- { check name as shown
 *     in PAC, count, reason } -- whose counts sum to the fail count. PAC's
 *     `fail` counts occurrences, not checks (e.g. 13 occurrences of one
 *     list error), hence count per check. Since PDF/UA errors must be 0,
 *     these waivers cover WCAG-side failures only.
 *
 * Validity is re-checked whenever the certification is read or used: a
 * changed PDF or a replaced/deleted report revokes it automatically. Who
 * certified is recorded and is NOT re-checked against the current team
 * later -- only new actions (certify/revoke/release) check the team, via
 * authorizeJobForTeamLeaderAction on the routes.
 *
 * axes4 PAC Cloud is not an evidence source here (disabled for cost); the
 * uploaded PAC report is required.
 */

import { JobCertification, Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { AppError } from '../../utils/app-error';
import { getCurrentRemediatedFileHash } from './remediated-file-hash';
import { revokeActiveCertification, type AutoRevokeReason } from './certification-revoke';
import type { AcrobatRuleResult } from './acrobat-report-parser';

export interface AcrobatWaiverInput { ruleKey: string; reason: string }
/** One failed PAC check (WCAG side), as named in PAC, with its occurrence count. */
export interface PacWaiverInput { check: string; count: number; reason: string }

export interface CertifyInput {
  certifiedById: string;
  acrobatNotes?: string;
  acrobatWaivers: AcrobatWaiverInput[];
  /** Operator-attested PDF/UA error count from PAC; must be 0. */
  pacPdfUaErrors: number;
  pacWaivers: PacWaiverInput[];
}

export interface CertificationProblem { code: string; message: string }

/** Stable key for an Acrobat rule: its language-independent id, else category / rule. */
export function acrobatRuleKey(rule: Pick<AcrobatRuleResult, 'ruleId' | 'category' | 'rule'>): string {
  return rule.ruleId ?? `${rule.category} / ${rule.rule}`;
}

type ReportPin = { id: string; s3Key: string; updatedAt: Date; remediatedSha256: string | null };

async function loadEvidence(jobId: string) {
  const [acrobat, pac] = await Promise.all([
    prisma.jobExternalAcrobatReport.findUnique({ where: { jobId } }),
    prisma.jobExternalPacReport.findUnique({ where: { jobId } }),
  ]);
  return { acrobat, pac };
}

function samePin(report: ReportPin | null, s3Key: string, updatedAt: Date): boolean {
  return !!report && report.s3Key === s3Key && report.updatedAt.getTime() === updatedAt.getTime();
}

/**
 * Why the active certification is no longer valid, or null if it still is.
 * `currentSha256` is passed in so callers hash the PDF at most once.
 */
async function invalidationReason(
  cert: JobCertification,
  currentSha256: string | null,
): Promise<AutoRevokeReason | null> {
  if (currentSha256 !== cert.pdfSha256) return 'pdf-changed';
  const { acrobat, pac } = await loadEvidence(cert.jobId);
  if (!acrobat) return 'acrobat-report-deleted';
  if (!samePin(acrobat, cert.acrobatReportS3Key, cert.acrobatReportUpdatedAt)) return 'acrobat-report-replaced';
  if (!pac) return 'pac-report-deleted';
  if (!samePin(pac, cert.pacReportS3Key, cert.pacReportUpdatedAt)) return 'pac-report-replaced';
  return null;
}

export interface CertificationState {
  /** The active, still-valid certification, or null. */
  active: JobCertification | null;
  /** Every certification for the job, newest first (including revoked ones). */
  history: JobCertification[];
}

/**
 * Current state, re-validating the active certification first: if the PDF
 * or the evidence changed since it was issued, it is revoked here (with the
 * matching reason) and reported as not active. This read-time check is the
 * guarantee; save-time revocation (B3b) only makes it prompt.
 */
export async function getCertificationState(jobId: string): Promise<CertificationState> {
  const active = await prisma.jobCertification.findFirst({ where: { jobId, revokedAt: null } });
  if (active) {
    const current = await getCurrentRemediatedFileHash(jobId);
    const reason = await invalidationReason(active, current?.sha256 ?? null);
    if (reason) await revokeActiveCertification(jobId, reason, null, active.id);
  }
  const history = await prisma.jobCertification.findMany({ where: { jobId }, orderBy: { certifiedAt: 'desc' } });
  return { active: history.find((c) => c.revokedAt === null) ?? null, history };
}

function blocked(problems: CertificationProblem[]): AppError {
  return new AppError(
    `Certification blocked: ${problems.length} requirement(s) not met`,
    422,
    'CERTIFICATION_BLOCKED',
    { problems },
  );
}

export async function certifyJob(jobId: string, input: CertifyInput): Promise<JobCertification> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { id: true, type: true } });
  if (!job) throw AppError.notFound('Job not found');
  if (job.type !== 'PDF_ACCESSIBILITY') {
    throw AppError.badRequest('Only PDF accessibility jobs can be certified', 'NOT_A_PDF_JOB');
  }

  const current = await getCurrentRemediatedFileHash(jobId);

  // An existing active certification: still valid -> conflict; stale -> revoke and carry on.
  const existing = await prisma.jobCertification.findFirst({ where: { jobId, revokedAt: null } });
  if (existing) {
    const reason = await invalidationReason(existing, current?.sha256 ?? null);
    if (!reason) {
      throw AppError.conflict('This job is already certified for its current file; revoke it first', 'ALREADY_CERTIFIED');
    }
    await revokeActiveCertification(jobId, reason, null, existing.id);
  }

  const problems: CertificationProblem[] = [];
  const { acrobat, pac } = await loadEvidence(jobId);

  if (!current) {
    problems.push({ code: 'NO_REMEDIATED_FILE', message: 'The job has no remediated PDF to certify.' });
  }

  const checkBinding = (report: ReportPin | null, label: string, prefix: string) => {
    if (!report) {
      problems.push({ code: `${prefix}_MISSING`, message: `Upload the ${label} report.` });
      return false;
    }
    if (!report.remediatedSha256) {
      problems.push({
        code: `${prefix}_NOT_BOUND`,
        message: `The ${label} report was uploaded before any remediated PDF existed; upload it again for the current file.`,
      });
      return false;
    }
    if (current && report.remediatedSha256 !== current.sha256) {
      problems.push({
        code: `${prefix}_STALE`,
        message: `The ${label} report was produced for an earlier version of the PDF; re-run the check and upload it again.`,
      });
      return false;
    }
    return true;
  };

  // --- Acrobat ---
  const acrobatWaivers: Prisma.InputJsonValue[] = [];
  let acrobatFailedTotal = 0;
  if (checkBinding(acrobat, 'Acrobat', 'ACROBAT_REPORT') && acrobat) {
    acrobatFailedTotal = (acrobat.failed ?? 0) + (acrobat.failedManually ?? 0);
    const failedRules = (Array.isArray(acrobat.failedRules) ? acrobat.failedRules : []) as unknown as AcrobatRuleResult[];
    const failedByKey = new Map(failedRules.map((r) => [acrobatRuleKey(r), r]));
    const waiverByKey = new Map(input.acrobatWaivers.map((w) => [w.ruleKey, w]));

    if (acrobat.failed === null) {
      problems.push({ code: 'ACROBAT_COUNTS_MISSING', message: 'The Acrobat report has no Failed count.' });
    } else if (acrobatFailedTotal > 0 && failedByKey.size !== acrobatFailedTotal) {
      problems.push({
        code: 'ACROBAT_FAILURES_UNIDENTIFIED',
        message: `The Acrobat report shows ${acrobatFailedTotal} failed rule(s) but they couldn't be identified from it, so they can't be waived; upload an unedited Acrobat HTML report.`,
      });
    } else {
      for (const [key, rule] of failedByKey) {
        const waiver = waiverByKey.get(key);
        if (!waiver) {
          problems.push({
            code: 'ACROBAT_FAILURE_NOT_WAIVED',
            message: `Acrobat rule "${rule.category} / ${rule.rule}" failed; fix it or record a waiver with a reason.`,
          });
        } else {
          acrobatWaivers.push({
            ruleKey: key, ruleId: rule.ruleId, category: rule.category, rule: rule.rule,
            reason: waiver.reason.trim(), waivedById: input.certifiedById, waivedAt: new Date().toISOString(),
          });
        }
      }
      for (const key of waiverByKey.keys()) {
        if (!failedByKey.has(key)) {
          problems.push({ code: 'ACROBAT_WAIVER_FOR_PASSING_RULE', message: `Waiver given for "${key}", which did not fail.` });
        }
      }
    }
  }

  // --- PAC ---
  const pacWaivers: Prisma.InputJsonValue[] = [];
  if (input.pacPdfUaErrors !== 0) {
    problems.push({ code: 'PAC_PDFUA_ERRORS', message: 'PAC must show 0 PDF/UA errors for the current file.' });
  }
  if (checkBinding(pac, 'PAC', 'PAC_REPORT') && pac) {
    if (pac.fail === null) {
      problems.push({ code: 'PAC_FAIL_COUNT_MISSING', message: "Enter the PAC report's Failed count when uploading it." });
    } else {
      const seen = new Set<string>();
      let duplicate = false;
      for (const w of input.pacWaivers) {
        const name = w.check.trim().toLowerCase();
        if (seen.has(name)) {
          duplicate = true;
          problems.push({
            code: 'PAC_WAIVER_DUPLICATE_CHECK',
            message: `PAC check "${w.check.trim()}" is waived more than once; give it one waiver with its total count.`,
          });
        }
        seen.add(name);
      }
      const waived = input.pacWaivers.reduce((sum, w) => sum + w.count, 0);
      if (waived !== pac.fail) {
        problems.push({
          code: 'PAC_WAIVER_COUNT_MISMATCH',
          message: `PAC shows ${pac.fail} failed occurrence(s); the waived WCAG checks add up to ${waived}. ` +
            'Waive each failed check once, with its count as shown in PAC.',
        });
      } else if (!duplicate) {
        for (const w of input.pacWaivers) {
          pacWaivers.push({
            check: w.check.trim(), count: w.count, reason: w.reason.trim(),
            waivedById: input.certifiedById, waivedAt: new Date().toISOString(),
          });
        }
      }
    }
  }

  if (problems.length > 0) throw blocked(problems);

  try {
    const cert = await prisma.jobCertification.create({
      data: {
        jobId,
        pdfSha256: current!.sha256,
        remediatedFileRef: current!.fileRef,
        certifiedById: input.certifiedById,
        acrobatNotes: input.acrobatNotes?.trim() || null,
        acrobatReportId: acrobat!.id,
        acrobatReportS3Key: acrobat!.s3Key,
        acrobatReportUpdatedAt: acrobat!.updatedAt,
        acrobatFailed: acrobatFailedTotal,
        acrobatWaivers,
        pacReportId: pac!.id,
        pacReportS3Key: pac!.s3Key,
        pacReportUpdatedAt: pac!.updatedAt,
        pacFail: pac!.fail!,
        pacPdfUaErrorsAttested: input.pacPdfUaErrors,
        pacWaivers,
      },
    });
    logger.info(
      `[Certification] Job ${jobId} certified by ${input.certifiedById} ` +
        `(acrobat waivers=${acrobatWaivers.length}, pac waivers=${pacWaivers.length})`,
    );
    return cert;
  } catch (err) {
    // The partial unique index: a concurrent certify won the race.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw AppError.conflict('This job was certified concurrently', 'ALREADY_CERTIFIED');
    }
    throw err;
  }
}

/** Manual revoke. 404 when there is no active certification. */
export async function revokeCertification(jobId: string, revokedById: string, reason: string): Promise<void> {
  const revoked = await revokeActiveCertification(jobId, `manual: ${reason.trim()}`, revokedById);
  if (!revoked) throw AppError.notFound('No active certification to revoke', 'NO_ACTIVE_CERTIFICATION');
}
