import { Prisma } from '@prisma/client';
import prisma from '../../lib/prisma';
import type { AnnotationStatus } from '../../schemas/corpus-status.schema';

// System "users" that show up in Zone.verifiedBy but are not real annotators.
// Mirrors the SYSTEM_IDS set in annotation-timesheet.service.ts.
const SYSTEM_IDS = new Set(['auto-annotation', 'unknown']);

export interface PrimaryAnnotator {
  userId: string | null;
  displayName: string;
  email: string | null;
}

export interface CorpusStatusRow {
  serialNumber: number;
  documentId: string;
  filename: string;
  pageCount: number;
  pagesAnnotated: number;
  status: AnnotationStatus;
  statusOverride: AnnotationStatus | null;
  primaryAnnotator: PrimaryAnnotator | null;
  otherAnnotatorCount: number;
  hoursSpent: number;
  lastUpdatedAt: string | null;
  statusNote: string | null;
}

export interface CorpusStatusListResponse {
  rows: CorpusStatusRow[];
  generatedAt: string;
}

/** Apply the derivation rule from the spec. statusOverride wins when set. */
export function deriveStatus(
  pagesAnnotated: number,
  pageCount: number | null,
  statusOverride: string | null,
): AnnotationStatus {
  if (statusOverride && isAnnotationStatus(statusOverride)) {
    return statusOverride;
  }
  if (pagesAnnotated <= 0) return 'NOT_STARTED';
  if (pageCount == null || pageCount <= 0) return 'IN_PROGRESS';
  if (pagesAnnotated >= pageCount) return 'COMPLETED';
  return 'IN_PROGRESS';
}

function isAnnotationStatus(value: string): value is AnnotationStatus {
  return (
    value === 'NOT_STARTED' ||
    value === 'IN_PROGRESS' ||
    value === 'PENDING_REVIEW' ||
    value === 'COMPLETED' ||
    value === 'BLOCKED'
  );
}

function maxIso(...values: Array<Date | string | null | undefined>): string | null {
  let best: number | null = null;
  for (const v of values) {
    if (!v) continue;
    const t = v instanceof Date ? v.getTime() : new Date(v).getTime();
    if (Number.isFinite(t) && (best === null || t > best)) best = t;
  }
  return best === null ? null : new Date(best).toISOString();
}

/**
 * Build the Status Tracker rows for every CorpusDocument.
 *
 * One query per shape (documents, pages-annotated, hours, annotator counts,
 * latest zone update, user names) so the table stays O(documents) rather than
 * issuing per-document queries. For 17 documents this finishes well under the
 * 500ms target the spec calls for; revisit if the corpus grows past ~100 rows.
 */
export async function listCorpusStatus(): Promise<CorpusStatusListResponse> {
  const documents = await prisma.corpusDocument.findMany({
    orderBy: { uploadedAt: 'asc' },
    select: {
      id: true,
      filename: true,
      pageCount: true,
      uploadedAt: true,
      statusNote: true,
      statusOverride: true,
      statusUpdatedAt: true,
    },
  });

  if (documents.length === 0) {
    return { rows: [], generatedAt: new Date().toISOString() };
  }

  const documentIds = documents.map((d) => d.id);

  // Map of documentId -> [calibrationRunIds]. Also pull pagesReviewed +
  // completedAt so we can prefer the operator-stated page count from Mark
  // Complete over the operatorVerified-zone heuristic below.
  const runs = await prisma.calibrationRun.findMany({
    where: { documentId: { in: documentIds } },
    select: {
      id: true,
      documentId: true,
      pagesReviewed: true,
      completedAt: true,
    },
  });

  const runIdsByDoc = new Map<string, string[]>();
  const docByRunId = new Map<string, string>();
  for (const r of runs) {
    docByRunId.set(r.id, r.documentId);
    const list = runIdsByDoc.get(r.documentId) ?? [];
    list.push(r.id);
    runIdsByDoc.set(r.documentId, list);
  }

  const allRunIds = runs.map((r) => r.id);

  // Page-count signal precedence:
  //   1. operator-stated `pagesReviewed` (set via Mark Complete) is
  //      authoritative — it's what the annotator actually committed to
  //      reviewing, including pages where they agreed with every AI label
  //      (which leave no operatorVerified=true zones behind).
  //   2. distinct count of pageNumbers with operatorVerified=true is the
  //      fallback for runs still in progress (no Mark Complete yet).
  // For documents with multiple completed runs we trust the most recently
  // completed one — that's the latest pass over the document.
  const pagesReviewedByDoc = new Map<string, number>();
  const latestCompletedAtByDoc = new Map<string, Date>();
  for (const r of runs) {
    if (
      r.completedAt == null ||
      r.pagesReviewed == null ||
      r.pagesReviewed < 0
    ) {
      continue;
    }
    const current = latestCompletedAtByDoc.get(r.documentId);
    if (!current || r.completedAt > current) {
      latestCompletedAtByDoc.set(r.documentId, r.completedAt);
      pagesReviewedByDoc.set(r.documentId, r.pagesReviewed);
    }
  }

  // Aggregations only run when there is at least one calibration run; otherwise
  // every doc is NOT_STARTED with zero hours.
  const pagesAnnotatedByDoc = new Map<string, number>();
  const hoursByDoc = new Map<string, number>();
  const lastZoneUpdateByDoc = new Map<string, Date>();
  const annotatorCountsByDoc = new Map<string, Map<string, number>>();

  if (allRunIds.length > 0) {
    // Pages annotated: distinct pageNumber where any zone is operatorVerified.
    const verifiedPageRows = await prisma.$queryRaw<
      { calibrationRunId: string; pagesAnnotated: bigint }[]
    >`
      SELECT "calibrationRunId",
             COUNT(DISTINCT "pageNumber")::bigint AS "pagesAnnotated"
      FROM "Zone"
      WHERE "calibrationRunId" IN (${Prisma.join(allRunIds)})
        AND "operatorVerified" = true
      GROUP BY "calibrationRunId"
    `;
    for (const row of verifiedPageRows) {
      const docId = docByRunId.get(row.calibrationRunId);
      if (!docId) continue;
      pagesAnnotatedByDoc.set(
        docId,
        (pagesAnnotatedByDoc.get(docId) ?? 0) + Number(row.pagesAnnotated),
      );
    }

    // Hours: sum AnnotationSession.activeMs across all runs for the document.
    const hourRows = await prisma.annotationSession.groupBy({
      by: ['calibrationRunId'],
      where: { calibrationRunId: { in: allRunIds } },
      _sum: { activeMs: true },
    });
    for (const row of hourRows) {
      const docId = docByRunId.get(row.calibrationRunId);
      if (!docId) continue;
      const ms = row._sum.activeMs ?? 0;
      hoursByDoc.set(docId, (hoursByDoc.get(docId) ?? 0) + ms);
    }

    // Latest zone update — used for the lastUpdatedAt fallback when there is
    // no explicit statusUpdatedAt.
    const lastUpdateRows = await prisma.zone.groupBy({
      by: ['calibrationRunId'],
      where: { calibrationRunId: { in: allRunIds } },
      _max: { updatedAt: true },
    });
    for (const row of lastUpdateRows) {
      if (!row.calibrationRunId) continue;
      const docId = docByRunId.get(row.calibrationRunId);
      if (!docId || !row._max.updatedAt) continue;
      const current = lastZoneUpdateByDoc.get(docId);
      if (!current || row._max.updatedAt > current) {
        lastZoneUpdateByDoc.set(docId, row._max.updatedAt);
      }
    }

    // Per-annotator zone counts → primary annotator + other-annotator count.
    const annotatorRows = await prisma.zone.groupBy({
      by: ['calibrationRunId', 'verifiedBy'],
      where: {
        calibrationRunId: { in: allRunIds },
        operatorVerified: true,
        verifiedBy: { not: null },
      },
      _count: { _all: true },
    });
    for (const row of annotatorRows) {
      if (!row.calibrationRunId || !row.verifiedBy) continue;
      const docId = docByRunId.get(row.calibrationRunId);
      if (!docId) continue;
      if (SYSTEM_IDS.has(row.verifiedBy)) continue;
      const inner = annotatorCountsByDoc.get(docId) ?? new Map<string, number>();
      inner.set(row.verifiedBy, (inner.get(row.verifiedBy) ?? 0) + row._count._all);
      annotatorCountsByDoc.set(docId, inner);
    }
  }

  // Resolve user names/emails for every annotator id we saw.
  const userIds = new Set<string>();
  for (const inner of annotatorCountsByDoc.values()) {
    for (const id of inner.keys()) userIds.add(id);
  }
  const users = userIds.size
    ? await prisma.user.findMany({
        where: { id: { in: [...userIds] } },
        select: { id: true, firstName: true, lastName: true, email: true },
      })
    : [];
  const userById = new Map(users.map((u) => [u.id, u]));

  const rows: CorpusStatusRow[] = documents.map((doc, i) => {
    // operator-stated pagesReviewed (set via Mark Complete) is authoritative;
    // the verified-zone count is a fallback for runs still in progress.
    const pagesAnnotated =
      pagesReviewedByDoc.get(doc.id) ??
      pagesAnnotatedByDoc.get(doc.id) ??
      0;
    const overrideRaw = doc.statusOverride;
    const statusOverride =
      overrideRaw && isAnnotationStatus(overrideRaw) ? overrideRaw : null;

    const status = deriveStatus(pagesAnnotated, doc.pageCount, statusOverride);

    const inner = annotatorCountsByDoc.get(doc.id);
    let primaryAnnotator: PrimaryAnnotator | null = null;
    let otherAnnotatorCount = 0;
    if (inner && inner.size > 0) {
      const sorted = [...inner.entries()].sort((a, b) => b[1] - a[1]);
      const topId = sorted[0][0];
      const u = userById.get(topId);
      const displayName =
        u && (u.firstName || u.lastName)
          ? [u.firstName, u.lastName].filter(Boolean).join(' ')
          : topId;
      primaryAnnotator = {
        userId: topId,
        displayName,
        email: u?.email ?? null,
      };
      otherAnnotatorCount = sorted.length - 1;
    }

    const hoursSpent = (hoursByDoc.get(doc.id) ?? 0) / 3_600_000;

    const lastUpdatedAt = maxIso(
      doc.statusUpdatedAt,
      lastZoneUpdateByDoc.get(doc.id),
    );

    return {
      serialNumber: i + 1,
      documentId: doc.id,
      filename: doc.filename,
      pageCount: doc.pageCount ?? 0,
      pagesAnnotated,
      status,
      statusOverride,
      primaryAnnotator,
      otherAnnotatorCount,
      hoursSpent: Math.round(hoursSpent * 100) / 100,
      lastUpdatedAt,
      statusNote: doc.statusNote,
    };
  });

  return { rows, generatedAt: new Date().toISOString() };
}

/**
 * Update statusOverride and/or statusNote for a single document. Always
 * stamps statusUpdatedAt and statusUpdatedBy. Pass `statusOverride: null`
 * to clear the override.
 */
export async function updateDocumentStatus(
  documentId: string,
  payload: { statusOverride?: AnnotationStatus | null; statusNote?: string },
  userId: string,
): Promise<CorpusStatusRow | null> {
  const existing = await prisma.corpusDocument.findUnique({
    where: { id: documentId },
    select: { id: true },
  });
  if (!existing) return null;

  const data: Prisma.CorpusDocumentUpdateInput = {
    statusUpdatedAt: new Date(),
    statusUpdatedBy: userId,
  };
  if (payload.statusOverride !== undefined) {
    data.statusOverride = payload.statusOverride;
  }
  if (payload.statusNote !== undefined) {
    data.statusNote = payload.statusNote;
  }

  await prisma.corpusDocument.update({ where: { id: documentId }, data });

  // Re-fetch the row so the response reflects the same shape (including
  // recomputed derived status) the GET endpoint returns.
  const list = await listCorpusStatus();
  return list.rows.find((r) => r.documentId === documentId) ?? null;
}
