import prisma from '../../lib/prisma';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';

// ── Types ───────────────────────────────────────────────────────────

export interface ZoneDetailRow {
  zoneId: string;
  pageNumber: number;
  zoneIndex: number;
  source: string;
  originalType: string;
  label: string | null;
  bucket: string | null;
  decision: string | null;
  finalLabel: string | null;
  correctionReason: string | null;
  verifiedBy: string | null;
  verifiedAt: string | null;
}

export interface CorrectionLogRow {
  zoneId: string;
  pageNumber: number;
  fromLabel: string;
  toLabel: string | null;
  decision: string;
  reason: string | null;
  verifiedBy: string;
  verifiedAt: string;
}

export interface AnnotationReport {
  header: {
    documentName: string;
    documentId: string;
    calibrationRunId: string;
    totalPages: number;
    reportDate: string;
    annotators: string[];
  };
  summary: {
    totalZones: number;
    confirmed: number;
    corrected: number;
    rejected: number;
    unreviewed: number;
    autoAnnotated: number;
    greenCount: number;
    amberCount: number;
    redCount: number;
    accuracyRate: number | null;
    agreementRate: number | null;
  };
  zoneDetails: ZoneDetailRow[];
  qualityMetrics: {
    extractorAgreementRate: number | null;
    autoAnnotationCoverage: number | null;
    humanReviewRequiredPct: number | null;
    correctionRate: number | null;
    rejectionRate: number | null;
    typeDistribution: Record<string, number>;
    pagesWithZeroCorrections: number;
    mostCorrectedPage: { page: number; corrections: number } | null;
  };
  correctionsLog: CorrectionLogRow[];
}

// ── Service ─────────────────────────────────────────────────────────

class AnnotationReportService {
  async getAnnotationReport(runId: string): Promise<AnnotationReport | null> {
    const run = await prisma.calibrationRun.findUnique({
      where: { id: runId },
      include: {
        corpusDocument: { select: { filename: true, id: true, pageCount: true } },
        zones: {
          orderBy: [{ pageNumber: 'asc' }, { readingOrder: 'asc' }],
        },
      },
    });

    if (!run) return null;

    const zones = run.zones;
    const doc = run.corpusDocument;

    // Compute summary
    const confirmed = zones.filter(z => z.decision === 'CONFIRMED').length;
    const corrected = zones.filter(z => z.decision === 'CORRECTED').length;
    const rejected = zones.filter(z => z.decision === 'REJECTED').length;
    const unreviewed = zones.filter(z => !z.decision).length;
    const autoAnnotated = zones.filter(z => z.verifiedBy === 'auto-annotation').length;
    const greenCount = zones.filter(z => z.reconciliationBucket === 'GREEN').length;
    const amberCount = zones.filter(z => z.reconciliationBucket === 'AMBER').length;
    const redCount = zones.filter(z => z.reconciliationBucket === 'RED').length;

    const reviewed = confirmed + corrected + rejected;
    const round4 = (n: number) => Math.round(n * 10000) / 10000;
    const accuracyRate = reviewed > 0
      ? round4(confirmed / reviewed) : null;
    const agreementRate = zones.length > 0
      ? round4(greenCount / zones.length) : null;

    // Annotators
    const annotatorSet = new Set<string>();
    for (const z of zones) {
      if (z.verifiedBy) annotatorSet.add(z.verifiedBy);
    }

    // Zone details with page-local index
    const pageCounters = new Map<number, number>();
    const zoneDetails: ZoneDetailRow[] = zones.map(z => {
      const idx = (pageCounters.get(z.pageNumber) ?? 0) + 1;
      pageCounters.set(z.pageNumber, idx);

      const finalLabel = z.decision === 'REJECTED' ? null
        : (z.operatorLabel ?? z.label ?? z.type);

      return {
        zoneId: z.id,
        pageNumber: z.pageNumber,
        zoneIndex: idx,
        source: z.source ?? 'unknown',
        originalType: z.type,
        label: z.label,
        bucket: z.reconciliationBucket,
        decision: z.decision,
        finalLabel,
        correctionReason: z.correctionReason ?? null,
        verifiedBy: z.verifiedBy,
        verifiedAt: z.verifiedAt ? new Date(z.verifiedAt).toISOString() : null,
      };
    });

    // Quality metrics
    const typeDistribution: Record<string, number> = {};
    for (const z of zones) {
      const finalType = z.decision === 'REJECTED' ? 'REJECTED'
        : (z.operatorLabel ?? z.label ?? z.type);
      typeDistribution[finalType] = (typeDistribution[finalType] ?? 0) + 1;
    }

    // Pages with zero corrections
    const correctionsByPage = new Map<number, number>();
    for (const z of zones) {
      if (z.decision === 'CORRECTED') {
        correctionsByPage.set(z.pageNumber, (correctionsByPage.get(z.pageNumber) ?? 0) + 1);
      }
    }
    const uniquePages = new Set(zones.map(z => z.pageNumber));
    const pagesWithZeroCorrections = [...uniquePages].filter(p => !correctionsByPage.has(p)).length;

    let mostCorrectedPage: { page: number; corrections: number } | null = null;
    for (const [page, count] of correctionsByPage) {
      if (!mostCorrectedPage || count > mostCorrectedPage.corrections) {
        mostCorrectedPage = { page, corrections: count };
      }
    }

    // Corrections log (corrected + rejected zones only)
    const correctionsLog: CorrectionLogRow[] = zones
      .filter(z => z.decision === 'CORRECTED' || z.decision === 'REJECTED')
      .map(z => ({
        zoneId: z.id,
        pageNumber: z.pageNumber,
        fromLabel: z.type,
        toLabel: z.decision === 'REJECTED' ? null : (z.operatorLabel ?? z.label ?? z.type),
        decision: z.decision!,
        reason: z.correctionReason ?? null,
        verifiedBy: z.verifiedBy ?? 'unknown',
        verifiedAt: z.verifiedAt ? new Date(z.verifiedAt).toISOString() : '',
      }));

    return {
      header: {
        documentName: doc?.filename ?? 'Unknown',
        documentId: doc?.id ?? '',
        calibrationRunId: run.id,
        totalPages: doc?.pageCount ?? uniquePages.size,
        reportDate: new Date().toISOString(),
        annotators: [...annotatorSet],
      },
      summary: {
        totalZones: zones.length,
        confirmed,
        corrected,
        rejected,
        unreviewed,
        autoAnnotated,
        greenCount,
        amberCount,
        redCount,
        accuracyRate,
        agreementRate,
      },
      zoneDetails,
      qualityMetrics: {
        extractorAgreementRate: agreementRate,
        autoAnnotationCoverage: zones.length > 0 ? round4(autoAnnotated / zones.length) : null,
        humanReviewRequiredPct: zones.length > 0 ? round4((zones.length - autoAnnotated) / zones.length) : null,
        correctionRate: reviewed > 0 ? round4(corrected / reviewed) : null,
        rejectionRate: reviewed > 0 ? round4(rejected / reviewed) : null,
        typeDistribution,
        pagesWithZeroCorrections,
        mostCorrectedPage,
      },
      correctionsLog,
    };
  }

  async exportAnnotationCsv(runId: string): Promise<string | null> {
    const report = await this.getAnnotationReport(runId);
    if (!report) return null;

    const headers = [
      'Page', 'Zone#', 'ZoneID', 'Source', 'OriginalType', 'Label', 'Bucket',
      'Decision', 'FinalLabel', 'Reason', 'VerifiedBy', 'VerifiedAt',
    ];

    const escape = (v: unknown): string => {
      const s = v === null || v === undefined ? '' : String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"`
        : s;
    };

    const lines = [
      headers.join(','),
      ...report.zoneDetails.map(r =>
        [
          r.pageNumber, r.zoneIndex, r.zoneId, r.source, r.originalType,
          r.label, r.bucket, r.decision, r.finalLabel, r.correctionReason,
          r.verifiedBy, r.verifiedAt,
        ].map(escape).join(','),
      ),
    ];

    return lines.join('\n');
  }

  async exportAnnotationPdf(runId: string): Promise<Buffer | null> {
    const report = await this.getAnnotationReport(runId);
    if (!report) return null;

    const pdf = await PDFDocument.create();
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdf.embedFont(StandardFonts.HelveticaBold);

    const pageWidth = 612;
    const pageHeight = 792;
    const margin = 50;
    let currentPage = pdf.addPage([pageWidth, pageHeight]);
    let y = pageHeight - margin;

    const drawText = (text: string, x: number, yPos: number, size: number, useBold = false) => {
      currentPage.drawText(text, {
        x,
        y: yPos,
        size,
        font: useBold ? boldFont : font,
        color: rgb(0, 0, 0),
      });
    };

    const ensureSpace = (needed: number) => {
      if (y < margin + needed) {
        currentPage = pdf.addPage([pageWidth, pageHeight]);
        y = pageHeight - margin;
      }
    };

    // Title
    drawText('Annotation Report', margin, y, 18, true);
    y -= 25;
    drawText(`Document: ${report.header.documentName}`, margin, y, 10);
    y -= 15;
    drawText(`Run: ${report.header.calibrationRunId}`, margin, y, 10);
    y -= 15;
    drawText(`Pages: ${report.header.totalPages}  |  Date: ${new Date(report.header.reportDate).toLocaleDateString()}`, margin, y, 10);
    y -= 15;
    drawText(`Annotators: ${report.header.annotators.join(', ')}`, margin, y, 10);
    y -= 25;

    // Summary
    drawText('Summary', margin, y, 14, true);
    y -= 18;
    const s = report.summary;
    const summaryLines = [
      `Total Zones: ${s.totalZones}`,
      `Confirmed: ${s.confirmed} (${s.totalZones > 0 ? ((s.confirmed / s.totalZones) * 100).toFixed(1) : 0}%)`,
      `Corrected: ${s.corrected} (${s.totalZones > 0 ? ((s.corrected / s.totalZones) * 100).toFixed(1) : 0}%)`,
      `Rejected: ${s.rejected} (${s.totalZones > 0 ? ((s.rejected / s.totalZones) * 100).toFixed(1) : 0}%)`,
      `Unreviewed: ${s.unreviewed} (${s.totalZones > 0 ? ((s.unreviewed / s.totalZones) * 100).toFixed(1) : 0}%)`,
      `Auto-Annotated: ${s.autoAnnotated}`,
      `GREEN: ${s.greenCount}  |  AMBER: ${s.amberCount}  |  RED: ${s.redCount}`,
    ];
    for (const line of summaryLines) {
      drawText(line, margin + 10, y, 10);
      y -= 14;
    }
    y -= 10;

    // Quality metrics
    ensureSpace(120);
    drawText('Quality Metrics', margin, y, 14, true);
    y -= 18;
    const q = report.qualityMetrics;
    const qLines = [
      `Extractor Agreement Rate: ${q.extractorAgreementRate !== null ? (q.extractorAgreementRate * 100).toFixed(1) + '%' : 'N/A'}`,
      `Auto-Annotation Coverage: ${q.autoAnnotationCoverage !== null ? (q.autoAnnotationCoverage * 100).toFixed(1) + '%' : 'N/A'}`,
      `Correction Rate: ${q.correctionRate !== null ? (q.correctionRate * 100).toFixed(1) + '%' : 'N/A'}`,
      `Rejection Rate: ${q.rejectionRate !== null ? (q.rejectionRate * 100).toFixed(1) + '%' : 'N/A'}`,
      `Pages with Zero Corrections: ${q.pagesWithZeroCorrections}`,
      q.mostCorrectedPage ? `Most Corrected Page: Page ${q.mostCorrectedPage.page} (${q.mostCorrectedPage.corrections} corrections)` : '',
    ].filter(Boolean);
    for (const line of qLines) {
      drawText(line, margin + 10, y, 10);
      y -= 14;
    }
    y -= 10;

    // Corrections log
    ensureSpace(40);
    drawText('Corrections Log', margin, y, 14, true);
    y -= 18;

    if (report.correctionsLog.length === 0) {
      drawText('No corrections or rejections recorded.', margin + 10, y, 10);
      y -= 14;
    } else {
      for (const c of report.correctionsLog) {
        ensureSpace(30);
        const arrow = c.decision === 'REJECTED' ? `${c.fromLabel} -> REJECTED` : `${c.fromLabel} -> ${c.toLabel}`;
        drawText(`Page ${c.pageNumber}: ${arrow}`, margin + 10, y, 9);
        y -= 12;
        if (c.reason) {
          drawText(`  Reason: ${c.reason}`, margin + 10, y, 8);
          y -= 12;
        }
        drawText(`  By: ${c.verifiedBy}  At: ${c.verifiedAt ? new Date(c.verifiedAt).toLocaleString() : ''}`, margin + 10, y, 8);
        y -= 14;
      }
    }

    const pdfBytes = await pdf.save();
    return Buffer.from(pdfBytes);
  }
}

export const annotationReportService = new AnnotationReportService();
