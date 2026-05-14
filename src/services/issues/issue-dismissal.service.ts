/**
 * Audit-issue dismissal service.
 *
 * An operator can mark a single audit-issue INSTANCE as a known
 * false-positive / accepted exception. Dismissals are per-instance
 * (not per-code) — heuristic codes legitimately fire on a mix of
 * real and false-positive instances within the same book, so a
 * per-code suppression would hide real bugs.
 *
 * The `instanceKey` is content-derived — `sha256(code|location|message)`
 * — so the SAME issue content re-hashes to the SAME key across
 * re-audits. That's how a dismissal carries through automatically:
 * the audit pipeline looks up each freshly-produced issue's key in
 * the dismissal map and attaches the dismissal metadata. If the
 * content changes, the key changes, and the issue re-fires.
 *
 * Blast radius is per-job — the `IssueDismissal` row cascades on
 * job delete. One author's "this #brand hashtag is fine" decision
 * does not leak across jobs.
 */

import { createHash } from 'crypto';
import prisma from '../../lib/prisma';
import { Prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { AppError } from '../../utils/app-error';
import type { IssueDismissal } from '@prisma/client';

/**
 * Content-derived per-instance identity — `sha256` of the three
 * fields. Pure + exported so it can be unit-tested directly and
 * reused by the audit pipeline when matching freshly-produced issues
 * to dismissals.
 *
 * The fields are serialised via `JSON.stringify([...])` rather than a
 * delimiter join: a literal `|` (or any delimiter) appearing inside a
 * `code` / `location` / `message` could otherwise make two different
 * tuples serialise identically and collide. JSON-array serialisation
 * is unambiguous because the values are individually quoted + escaped.
 */
export function computeInstanceKey(code: string, location: string, message: string): string {
  const canonical = JSON.stringify([code, location, message]);
  return createHash('sha256').update(canonical).digest('hex');
}

export interface CreateDismissalInput {
  jobId: string;
  userId: string;
  code: string;
  location: string;
  message: string;
  reason?: string;
}

/**
 * Create a dismissal for one issue instance. Idempotent: re-POSTing
 * the same `{ jobId, code, location, message }` returns the EXISTING
 * row rather than throwing — the `@@unique([jobId, instanceKey])`
 * constraint surfaces as a Prisma `P2002`, which we catch and resolve
 * to the existing row.
 */
export async function createDismissal(input: CreateDismissalInput): Promise<IssueDismissal> {
  const instanceKey = computeInstanceKey(input.code, input.location, input.message);

  try {
    const dismissal = await prisma.issueDismissal.create({
      data: {
        jobId: input.jobId,
        code: input.code,
        location: input.location,
        instanceKey,
        dismissedBy: input.userId,
        reason: input.reason ?? null,
      },
    });
    logger.info(
      `[issue-dismissal] created dismissal ${dismissal.id} for job ${input.jobId} (${input.code})`,
    );
    return dismissal;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Unique-violation on (jobId, instanceKey) — the operator
      // dismissed this exact instance already. Return the existing
      // row so the endpoint is idempotent.
      const existing = await prisma.issueDismissal.findUnique({
        where: { jobId_instanceKey: { jobId: input.jobId, instanceKey } },
      });
      if (existing) {
        logger.info(
          `[issue-dismissal] idempotent re-create for job ${input.jobId} (${input.code}) — returning existing ${existing.id}`,
        );
        return existing;
      }
    }
    throw err;
  }
}

/**
 * Delete a dismissal. Verifies the dismissal belongs to `jobId`
 * before deleting — defence-in-depth against IDOR. A dismissal that
 * exists but belongs to a DIFFERENT job is reported as 404 (not
 * 403): a 403 would confirm the id exists, leaking information.
 */
export async function deleteDismissal(
  jobId: string,
  dismissalId: string,
  _userId: string,
): Promise<void> {
  const dismissal = await prisma.issueDismissal.findUnique({
    where: { id: dismissalId },
  });
  if (!dismissal || dismissal.jobId !== jobId) {
    throw AppError.notFound(`Dismissal ${dismissalId} not found`);
  }
  await prisma.issueDismissal.delete({ where: { id: dismissalId } });
  logger.info(`[issue-dismissal] deleted dismissal ${dismissalId} from job ${jobId}`);
}

/**
 * List dismissals for a job, optionally filtered by issue code.
 * Newest first.
 */
export async function listDismissals(
  jobId: string,
  opts?: { code?: string },
): Promise<IssueDismissal[]> {
  return prisma.issueDismissal.findMany({
    where: {
      jobId,
      ...(opts?.code ? { code: opts.code } : {}),
    },
    orderBy: { dismissedAt: 'desc' },
  });
}

/**
 * Build a `Map<instanceKey, IssueDismissal>` for a job. The audit
 * pipeline calls this once at the end of a run and looks up each
 * freshly-produced issue's `instanceKey` to attach dismissal info.
 */
export async function getDismissalMap(jobId: string): Promise<Map<string, IssueDismissal>> {
  const dismissals = await prisma.issueDismissal.findMany({ where: { jobId } });
  return new Map(dismissals.map((d) => [d.instanceKey, d]));
}

/**
 * Resolve the job a dismissal lookup should target.
 *
 * A re-audit creates a NEW job whose `input.sourceJobId` points back
 * at the job the operator actually dismissed against (see
 * `remediation.service.ts` `reauditEpub`). Dismissals live on the
 * SOURCE job, so a re-audit must look them up there — otherwise the
 * carry-through promise breaks and dismissed issues reappear.
 *
 * Returns `input.sourceJobId` when present, else the job itself.
 */
export async function resolveDismissalJobId(jobId: string): Promise<string> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { input: true },
  });
  const input = job?.input;
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const sourceJobId = (input as Record<string, unknown>).sourceJobId;
    if (typeof sourceJobId === 'string' && sourceJobId.length > 0) {
      return sourceJobId;
    }
  }
  return jobId;
}

/** Minimal issue shape the dismissal-attachment step needs. */
export interface DismissableIssue {
  code: string;
  location?: string;
  message: string;
  dismissedAt?: string | null;
  dismissedBy?: string | null;
}

/**
 * Attach per-instance dismissal metadata to a freshly-produced issue
 * list. Mutates each issue in place: a matching dismissal sets
 * `dismissedAt` / `dismissedBy`; a non-match sets them explicitly to
 * `null` so the response shape is consistent (and so a deleted
 * dismissal correctly reverts the issue to `dismissedAt: null` on the
 * next audit). Returns the number of issues that carried an active
 * dismissal.
 *
 * The audit pipeline calls this at the very END of a run — dismissed
 * issues are STILL returned in the response (the FE renders them at
 * reduced opacity rather than hiding them).
 */
export async function attachDismissals(
  jobId: string,
  issues: DismissableIssue[],
): Promise<number> {
  // A re-audit runs under a fresh job id; resolve back to the source
  // job so dismissals made against the original carry through.
  const dismissalJobId = await resolveDismissalJobId(jobId);
  const dismissalMap = await getDismissalMap(dismissalJobId);
  let matched = 0;
  for (const issue of issues) {
    const instanceKey = computeInstanceKey(issue.code, issue.location ?? '', issue.message);
    const dismissal = dismissalMap.get(instanceKey);
    if (dismissal) {
      issue.dismissedAt = dismissal.dismissedAt.toISOString();
      issue.dismissedBy = dismissal.dismissedBy;
      matched++;
    } else {
      issue.dismissedAt = null;
      issue.dismissedBy = null;
    }
  }
  return matched;
}
