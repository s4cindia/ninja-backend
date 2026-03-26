/**
 * Auto-annotation service for calibration zones.
 *
 * Applies rule-based patterns to bulk-annotate zones, reducing manual
 * review effort. Each pattern targets a specific class of zones that
 * can be reliably confirmed, corrected, or rejected without human review.
 *
 * Patterns:
 *   1. Ghost Zone Rejection — isGhost=true or zero-area bbox
 *   2. TOCI Bulk Confirm — all TOCI zones from pdfxt
 *   3. Running Header Auto-Classification — H on page>1 with header content
 *   4. List Item Sequence Confirm — ≥3 consecutive LI zones on a page
 *   5. Duplicate FIG Rejection — overlapping FIG zones, keep higher confidence
 */
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

// ── Types ───────────────────────────────────────────────────────────

interface AutoAnnotationResult {
  runId: string;
  patternsApplied: PatternResult[];
  totalConfirmed: number;
  totalCorrected: number;
  totalRejected: number;
  totalSkipped: number;
  durationMs: number;
}

interface PatternResult {
  pattern: string;
  description: string;
  confirmed: number;
  corrected: number;
  rejected: number;
  skipped: number;
  details: string[];
}

interface ZoneRow {
  id: string;
  pageNumber: number;
  type: string;
  label: string | null;
  content: string | null;
  bounds: unknown;
  source: string | null;
  reconciliationBucket: string | null;
  doclingLabel: string | null;
  doclingConfidence: number | null;
  pdfxtLabel: string | null;
  operatorVerified: boolean;
  isArtefact: boolean;
  isGhost: boolean;
  ghostTag: string | null;
}

interface BBox {
  x: number;
  y: number;
  w?: number;
  h?: number;
  width?: number;
  height?: number;
}

// ── Helpers ─────────────────────────────────────────────────────────

function parseBBox(bounds: unknown): BBox | null {
  if (!bounds || typeof bounds !== 'object') return null;
  const b = bounds as Record<string, unknown>;
  const x = Number(b.x ?? 0);
  const y = Number(b.y ?? 0);
  const w = Number(b.w ?? b.width ?? 0);
  const h = Number(b.h ?? b.height ?? 0);
  if (isNaN(x) || isNaN(y) || isNaN(w) || isNaN(h)) return null;
  return { x, y, w, h };
}

function bboxArea(b: BBox): number {
  return (b.w ?? b.width ?? 0) * (b.h ?? b.height ?? 0);
}

function computeIoU(a: BBox, b: BBox): number {
  const aw = a.w ?? a.width ?? 0;
  const ah = a.h ?? a.height ?? 0;
  const bw = b.w ?? b.width ?? 0;
  const bh = b.h ?? b.height ?? 0;

  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + aw, b.x + bw);
  const y2 = Math.min(a.y + ah, b.y + bh);

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  if (intersection === 0) return 0;

  const union = aw * ah + bw * bh - intersection;
  return union > 0 ? intersection / union : 0;
}

const SYSTEM_OPERATOR = 'auto-annotation';

// ── Pattern 1: Ghost Zone Rejection ─────────────────────────────────

async function applyGhostZoneRejection(zones: ZoneRow[]): Promise<PatternResult> {
  const result: PatternResult = {
    pattern: 'ghost-zone-rejection',
    description: 'Reject ghost zones (no bbox) and zero-area zones',
    confirmed: 0, corrected: 0, rejected: 0, skipped: 0, details: [],
  };

  const toReject: string[] = [];

  for (const z of zones) {
    if (z.operatorVerified || z.isArtefact) continue;

    if (z.isGhost) {
      toReject.push(z.id);
      result.details.push(`Zone ${z.id} p${z.pageNumber}: ghost (${z.ghostTag ?? z.type})`);
      continue;
    }

    const bbox = parseBBox(z.bounds);
    if (bbox && bboxArea(bbox) < 1) {
      toReject.push(z.id);
      result.details.push(`Zone ${z.id} p${z.pageNumber}: zero-area bbox`);
    }
  }

  if (toReject.length > 0) {
    await prisma.zone.updateMany({
      where: { id: { in: toReject } },
      data: {
        isArtefact: true,
        operatorVerified: true,
        verifiedAt: new Date(),
        verifiedBy: SYSTEM_OPERATOR,
      },
    });
    result.rejected = toReject.length;
  }

  return result;
}

// ── Pattern 2: TOCI Bulk Confirm ────────────────────────────────────

async function applyTociBulkConfirm(zones: ZoneRow[]): Promise<PatternResult> {
  const result: PatternResult = {
    pattern: 'toci-bulk-confirm',
    description: 'Auto-confirm all TOCI (Table of Contents Item) zones',
    confirmed: 0, corrected: 0, rejected: 0, skipped: 0, details: [],
  };

  const tociZones = zones.filter(
    (z) => !z.operatorVerified && !z.isArtefact &&
      (z.type === 'TOCI' || z.label === 'TOCI' ||
       z.pdfxtLabel === 'TOCI' || z.doclingLabel === 'TOCI'),
  );

  if (tociZones.length === 0) return result;

  // Group by page — only confirm if page has ≥3 TOCI zones (real TOC page)
  const byPage = new Map<number, ZoneRow[]>();
  for (const z of tociZones) {
    const list = byPage.get(z.pageNumber) || [];
    list.push(z);
    byPage.set(z.pageNumber, list);
  }

  const toConfirm: string[] = [];
  for (const [pageNum, pageZones] of byPage) {
    if (pageZones.length >= 3) {
      for (const z of pageZones) {
        toConfirm.push(z.id);
      }
      result.details.push(`Page ${pageNum}: ${pageZones.length} TOCI zones confirmed`);
    } else {
      result.skipped += pageZones.length;
    }
  }

  if (toConfirm.length > 0) {
    await prisma.zone.updateMany({
      where: { id: { in: toConfirm } },
      data: {
        operatorVerified: true,
        operatorLabel: 'TOCI',
        verifiedAt: new Date(),
        verifiedBy: SYSTEM_OPERATOR,
      },
    });
    result.confirmed = toConfirm.length;
  }

  return result;
}

// ── Pattern 3: Running Header Auto-Classification ───────────────────

const RUNNING_HEADER_PATTERN = /^(chapter\s+\d+|part\s+\d+)?\s*.{0,80}\s*\d{1,4}\s*$/i;

async function applyRunningHeaderClassification(zones: ZoneRow[]): Promise<PatternResult> {
  const result: PatternResult = {
    pattern: 'running-header-classification',
    description: 'Reclassify running headers from H to HDR',
    confirmed: 0, corrected: 0, rejected: 0, skipped: 0, details: [],
  };

  // Find generic H zones on pages > 1 that look like running headers
  const candidates = zones.filter(
    (z) => !z.operatorVerified && !z.isArtefact && z.pageNumber > 1 &&
      (z.type === 'section-header' || z.type === 'H' || z.type === 'header') &&
      (z.label === 'H' || z.label === 'HDR' || z.label === 'Hdr' || z.label === 'Header'),
  );

  // Also look for zones already labeled HDR that need confirmation
  const hdrZones = zones.filter(
    (z) => !z.operatorVerified && !z.isArtefact &&
      (z.label === 'HDR' || z.label === 'Hdr' || z.label === 'Header' ||
       z.type === 'header' || z.pdfxtLabel === 'HDR'),
  );

  const toCorrect: string[] = [];
  const toConfirm: string[] = [];

  for (const z of candidates) {
    const text = (z.content || '').trim();

    // Check if text matches running header pattern (chapter + title + page number)
    if (text && RUNNING_HEADER_PATTERN.test(text)) {
      toCorrect.push(z.id);
      result.details.push(`Zone ${z.id} p${z.pageNumber}: "${text.slice(0, 50)}..." → HDR`);
      continue;
    }

    // Check by position: running headers are typically at very top of page (y < 50)
    const bbox = parseBBox(z.bounds);
    if (bbox && bbox.y < 50) {
      toCorrect.push(z.id);
      result.details.push(`Zone ${z.id} p${z.pageNumber}: top-of-page H → HDR (y=${bbox.y.toFixed(1)})`);
    }
  }

  // Confirm zones already correctly labeled as HDR
  for (const z of hdrZones) {
    if (!toCorrect.includes(z.id)) {
      toConfirm.push(z.id);
    }
  }

  if (toCorrect.length > 0) {
    await prisma.zone.updateMany({
      where: { id: { in: toCorrect } },
      data: {
        operatorVerified: true,
        operatorLabel: 'HDR',
        verifiedAt: new Date(),
        verifiedBy: SYSTEM_OPERATOR,
      },
    });
    result.corrected = toCorrect.length;
  }

  if (toConfirm.length > 0) {
    await prisma.zone.updateMany({
      where: { id: { in: toConfirm } },
      data: {
        operatorVerified: true,
        operatorLabel: 'HDR',
        verifiedAt: new Date(),
        verifiedBy: SYSTEM_OPERATOR,
      },
    });
    result.confirmed = toConfirm.length;
  }

  return result;
}

// ── Pattern 4: List Item Sequence Confirm ───────────────────────────

async function applyListItemSequenceConfirm(zones: ZoneRow[]): Promise<PatternResult> {
  const result: PatternResult = {
    pattern: 'list-item-sequence-confirm',
    description: 'Auto-confirm LI zones that appear in sequences of ≥3 on a page',
    confirmed: 0, corrected: 0, rejected: 0, skipped: 0, details: [],
  };

  const liZones = zones.filter(
    (z) => !z.operatorVerified && !z.isArtefact &&
      (z.type === 'LI' || z.label === 'LI' ||
       z.pdfxtLabel === 'LI' || z.doclingLabel === 'LI' ||
       z.type === 'list_item' || z.label === 'list_item'),
  );

  if (liZones.length === 0) return result;

  // Group by page
  const byPage = new Map<number, ZoneRow[]>();
  for (const z of liZones) {
    const list = byPage.get(z.pageNumber) || [];
    list.push(z);
    byPage.set(z.pageNumber, list);
  }

  const toConfirm: string[] = [];
  for (const [pageNum, pageZones] of byPage) {
    if (pageZones.length >= 3) {
      for (const z of pageZones) {
        toConfirm.push(z.id);
      }
      result.details.push(`Page ${pageNum}: ${pageZones.length} LI zones in sequence`);
    } else {
      result.skipped += pageZones.length;
    }
  }

  if (toConfirm.length > 0) {
    await prisma.zone.updateMany({
      where: { id: { in: toConfirm } },
      data: {
        operatorVerified: true,
        operatorLabel: 'LI',
        verifiedAt: new Date(),
        verifiedBy: SYSTEM_OPERATOR,
      },
    });
    result.confirmed = toConfirm.length;
  }

  return result;
}

// ── Pattern 5: Duplicate FIG Rejection ──────────────────────────────

async function applyDuplicateFigRejection(zones: ZoneRow[]): Promise<PatternResult> {
  const result: PatternResult = {
    pattern: 'duplicate-fig-rejection',
    description: 'Reject lower-confidence duplicate FIG zones with high IoU overlap',
    confirmed: 0, corrected: 0, rejected: 0, skipped: 0, details: [],
  };

  const figZones = zones.filter(
    (z) => !z.operatorVerified && !z.isArtefact && !z.isGhost &&
      (z.type === 'figure' || z.type === 'FIGURE' || z.type === 'FIG' ||
       z.label === 'Figure' || z.label === 'FIG'),
  );

  if (figZones.length < 2) return result;

  // Group by page
  const byPage = new Map<number, ZoneRow[]>();
  for (const z of figZones) {
    const list = byPage.get(z.pageNumber) || [];
    list.push(z);
    byPage.set(z.pageNumber, list);
  }

  const toReject = new Set<string>();

  for (const [pageNum, pageZones] of byPage) {
    if (pageZones.length < 2) continue;

    // Compare all pairs
    for (let i = 0; i < pageZones.length; i++) {
      for (let j = i + 1; j < pageZones.length; j++) {
        const a = pageZones[i];
        const b = pageZones[j];
        if (toReject.has(a.id) || toReject.has(b.id)) continue;

        const bboxA = parseBBox(a.bounds);
        const bboxB = parseBBox(b.bounds);
        if (!bboxA || !bboxB) continue;

        const iou = computeIoU(bboxA, bboxB);
        if (iou < 0.5) continue;

        // Reject the one with lower confidence (or smaller area as tiebreaker)
        const confA = a.doclingConfidence ?? 0;
        const confB = b.doclingConfidence ?? 0;
        const areaA = bboxArea(bboxA);
        const areaB = bboxArea(bboxB);

        let rejectZone: ZoneRow;
        let keepZone: ZoneRow;
        if (confA !== confB) {
          rejectZone = confA < confB ? a : b;
          keepZone = confA < confB ? b : a;
        } else {
          // Same confidence — keep the larger bbox (more complete)
          rejectZone = areaA < areaB ? a : b;
          keepZone = areaA < areaB ? b : a;
        }

        toReject.add(rejectZone.id);
        result.details.push(
          `Page ${pageNum}: FIG zone ${rejectZone.id.slice(0, 8)}… rejected (IoU=${iou.toFixed(2)} with ${keepZone.id.slice(0, 8)}…)`,
        );
      }
    }
  }

  if (toReject.size > 0) {
    await prisma.zone.updateMany({
      where: { id: { in: [...toReject] } },
      data: {
        isArtefact: true,
        operatorVerified: true,
        verifiedAt: new Date(),
        verifiedBy: SYSTEM_OPERATOR,
      },
    });
    result.rejected = toReject.size;
  }

  return result;
}

// ── Main Orchestrator ───────────────────────────────────────────────

export async function runAutoAnnotation(
  runId: string,
  patterns?: string[],
): Promise<AutoAnnotationResult> {
  const start = Date.now();

  // Fetch all unverified zones for this calibration run
  const zones = await prisma.zone.findMany({
    where: {
      calibrationRunId: runId,
    },
    select: {
      id: true,
      pageNumber: true,
      type: true,
      label: true,
      content: true,
      bounds: true,
      source: true,
      reconciliationBucket: true,
      doclingLabel: true,
      doclingConfidence: true,
      pdfxtLabel: true,
      operatorVerified: true,
      isArtefact: true,
      isGhost: true,
      ghostTag: true,
    },
  }) as ZoneRow[];

  logger.info(`[auto-annotation] Run ${runId}: ${zones.length} total zones, ${zones.filter(z => !z.operatorVerified && !z.isArtefact).length} unreviewed`);

  const allPatterns = [
    { name: 'ghost-zone-rejection', fn: applyGhostZoneRejection },
    { name: 'toci-bulk-confirm', fn: applyTociBulkConfirm },
    { name: 'running-header-classification', fn: applyRunningHeaderClassification },
    { name: 'list-item-sequence-confirm', fn: applyListItemSequenceConfirm },
    { name: 'duplicate-fig-rejection', fn: applyDuplicateFigRejection },
  ];

  // Filter to requested patterns (or run all)
  const activePatterns = patterns && patterns.length > 0
    ? allPatterns.filter((p) => patterns.includes(p.name))
    : allPatterns;

  const results: PatternResult[] = [];

  for (const { name, fn } of activePatterns) {
    try {
      // Re-fetch zones to reflect changes from previous patterns
      const freshZones = await prisma.zone.findMany({
        where: { calibrationRunId: runId },
        select: {
          id: true, pageNumber: true, type: true, label: true,
          content: true, bounds: true, source: true,
          reconciliationBucket: true, doclingLabel: true,
          doclingConfidence: true, pdfxtLabel: true,
          operatorVerified: true, isArtefact: true,
          isGhost: true, ghostTag: true,
        },
      }) as ZoneRow[];

      const patternResult = await fn(freshZones);
      results.push(patternResult);
      logger.info(
        `[auto-annotation] Pattern "${name}": confirmed=${patternResult.confirmed} corrected=${patternResult.corrected} rejected=${patternResult.rejected} skipped=${patternResult.skipped}`,
      );
    } catch (err) {
      logger.error(`[auto-annotation] Pattern "${name}" failed:`, err);
      results.push({
        pattern: name,
        description: `FAILED: ${(err as Error).message}`,
        confirmed: 0, corrected: 0, rejected: 0, skipped: 0, details: [],
      });
    }
  }

  const totalConfirmed = results.reduce((sum, r) => sum + r.confirmed, 0);
  const totalCorrected = results.reduce((sum, r) => sum + r.corrected, 0);
  const totalRejected = results.reduce((sum, r) => sum + r.rejected, 0);
  const totalSkipped = results.reduce((sum, r) => sum + r.skipped, 0);

  logger.info(
    `[auto-annotation] Run ${runId} complete: confirmed=${totalConfirmed} corrected=${totalCorrected} rejected=${totalRejected} skipped=${totalSkipped} (${Date.now() - start}ms)`,
  );

  return {
    runId,
    patternsApplied: results,
    totalConfirmed,
    totalCorrected,
    totalRejected,
    totalSkipped,
    durationMs: Date.now() - start,
  };
}
