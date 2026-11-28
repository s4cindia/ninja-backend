/**
 * Revoking a job's active certification -- kept in its own tiny module
 * (prisma + logger only) so the evidence-report services can call it on
 * delete/replace without importing the certification service (no cycle).
 */

import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

export type AutoRevokeReason =
  | 'pdf-changed'
  | 'acrobat-report-replaced'
  | 'acrobat-report-deleted'
  | 'pac-report-replaced'
  | 'pac-report-deleted';

export interface RevokeMatch {
  /**
   * Only this certification. For a specific certification found stale: if
   * a concurrent request has meanwhile revoked it and issued a new, valid
   * one, the update matches nothing instead of revoking the new one.
   */
  certificationId?: string;
  /** Only a certification of this stored file ... */
  remediatedFileRef?: string;
  /** ... whose certified hash differs from this one. */
  pdfSha256Not?: string;
}

/**
 * Revokes the job's active certification, if any (narrowed by `match`).
 * Returns whether one was revoked. `revokedById` is null for automatic
 * revocations.
 */
export async function revokeActiveCertification(
  jobId: string,
  reason: AutoRevokeReason | `manual: ${string}`,
  revokedById: string | null = null,
  match: RevokeMatch = {},
): Promise<boolean> {
  const { count } = await prisma.jobCertification.updateMany({
    where: {
      jobId,
      revokedAt: null,
      ...(match.certificationId ? { id: match.certificationId } : {}),
      ...(match.remediatedFileRef ? { remediatedFileRef: match.remediatedFileRef } : {}),
      ...(match.pdfSha256Not ? { pdfSha256: { not: match.pdfSha256Not } } : {}),
    },
    data: { revokedAt: new Date(), revokedById, revokedReason: reason },
  });
  if (count > 0) logger.info(`[Certification] Revoked certification for job ${jobId}: ${reason}`);
  return count > 0;
}
