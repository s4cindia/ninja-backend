/**
 * Accessibility Worker — Auto-Tag / Strip-and-Retag Wiring Tests
 *
 * Covers processPdfAccessibility's tagging control flow, focused on the
 * strip-and-retag path (structure-tree-completeness.ts +
 * strip-marked-content.ts wired together): when an existing structure tree
 * is a semantically empty shell and forceAutoTag is set, the worker should
 * strip old marked content and retry tagging — falling back safely to the
 * existing structure/buffer whenever any step of that isn't possible.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Job } from 'bullmq';
import { PDFDocument, PDFName, StandardFonts } from 'pdf-lib';
import { decodePageContent, writePageContent } from '../../../src/services/pdf/pdf-content-stream-io';
import { processAccessibilityJob } from '../../../src/workers/processors/accessibility.processor';
import { JOB_TYPES, JobData, JobResult } from '../../../src/queues';
import { queueService } from '../../../src/services/queue.service';
import { pdfAuditService } from '../../../src/services/pdf/pdf-audit.service';
import { pdfParserService } from '../../../src/services/pdf/pdf-parser.service';
import { adobeAutoTagService } from '../../../src/services/pdf/adobe-autotag.service';
import { seamCTagService } from '../../../src/services/pdf/seam-c-tag.service';
import { fileStorageService } from '../../../src/services/storage/file-storage.service';
import prisma from '../../../src/lib/prisma';

vi.mock('../../../src/services/queue.service');
vi.mock('../../../src/services/pdf/pdf-audit.service');
vi.mock('../../../src/services/pdf/pdf-parser.service');
vi.mock('../../../src/services/pdf/adobe-autotag.service');
vi.mock('../../../src/services/pdf/seam-c-tag.service');
vi.mock('../../../src/services/pdf/ai-analysis.service');
vi.mock('../../../src/services/pdf/pdf-modifier.service');
vi.mock('../../../src/services/pdf/pdf-structure-writer.service');
vi.mock('../../../src/services/storage/file-storage.service');

vi.mock('../../../src/config/ai.config', () => ({
  aiConfig: { seamC: { enabled: true }, adobe: { enabled: false } },
}));

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: { findUnique: vi.fn(), update: vi.fn() },
    acrJob: { create: vi.fn() },
  },
}));

vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** A plain untagged document — no /StructTreeRoot at all. */
async function buildUntaggedDoc(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 600]);
  return Buffer.from(await doc.save());
}

/** A document with a real StructTreeRoot but at least one semantic (/Figure) element. */
async function buildGenuinelyTaggedDoc(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.addPage([400, 600]);
  const figRef = doc.context.register(doc.context.obj({ S: PDFName.of('Figure'), K: 0 }));
  const documentRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: figRef }));
  const rootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: documentRef }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef);
  return Buffer.from(await doc.save());
}

/**
 * A document whose StructTreeRoot is a semantically empty shell (only
 * grouping-only /S types — see structure-tree-completeness.ts), optionally
 * with its page content wrapped in a real MCID BDC…EMC pair (see
 * strip-marked-content.ts) to simulate what prepareDocumentForRetag needs
 * to find and strip.
 */
async function buildEmptyShellTaggedDoc(opts: { withMarkedContent: boolean }): Promise<Buffer> {
  const src = await PDFDocument.create();
  const font = await src.embedFont(StandardFonts.Helvetica);
  const page = src.addPage([400, 600]);
  page.drawText('Body text', { x: 50, y: 500, size: 14, font });
  // pdf-lib buffers drawText internally — save+reload before decodePageContent can see it.
  const doc = await PDFDocument.load(await src.save());

  if (opts.withMarkedContent) {
    const content = decodePageContent(doc, 1)!;
    writePageContent(doc, 1, `/Part <</MCID 0>> BDC\n${content}\nEMC`);
  }

  const partRef = doc.context.register(doc.context.obj({ S: PDFName.of('Part'), K: 0 }));
  const documentRef = doc.context.register(doc.context.obj({ S: PDFName.of('Document'), K: partRef }));
  const rootRef = doc.context.register(doc.context.obj({ Type: PDFName.of('StructTreeRoot'), K: documentRef }));
  doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef);
  doc.catalog.set(PDFName.of('MarkInfo'), doc.context.obj({ Marked: true }));

  return Buffer.from(await doc.save());
}

function makeJob(options: Record<string, unknown> = {}): Job<JobData, JobResult> {
  return {
    id: 'job-1',
    name: 'accessibility-job',
    data: {
      type: JOB_TYPES.PDF_ACCESSIBILITY,
      tenantId: 'tenant-1',
      userId: 'user-1',
      fileId: 'file-1',
      options: { dbJobId: 'job-1', fileName: 'test.pdf', ...options },
    },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<JobData, JobResult>;
}

describe('processPdfAccessibility — auto-tag / strip-and-retag wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();

    vi.mocked(prisma.job.findUnique).mockResolvedValue({ input: {} } as any);
    vi.mocked(prisma.job.update).mockResolvedValue({} as any);
    vi.mocked(prisma.acrJob.create).mockResolvedValue({} as any);

    vi.mocked(queueService.updateJobProgress).mockResolvedValue(undefined as any);

    vi.mocked(pdfParserService.close).mockResolvedValue(undefined as any);
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue(undefined as any);
    vi.mocked(fileStorageService.saveFile).mockResolvedValue(undefined as any);

    vi.mocked(pdfAuditService.runAuditFromBuffer).mockResolvedValue({ issues: [] } as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('tags an untagged document normally — no retag logic involved', async () => {
    const originalBuffer = await buildUntaggedDoc();
    vi.mocked(fileStorageService.getFile).mockResolvedValue(originalBuffer);
    vi.mocked(pdfParserService.parseBuffer).mockResolvedValue({ structure: { metadata: { isTagged: false } } } as any);
    vi.mocked(seamCTagService.tagPdf).mockResolvedValue({
      taggedPdfBuffer: Buffer.from('tagged-pdf'),
      reportBuffer: null,
      wordBuffer: null,
      elementCounts: { Figure: 2 },
      parsedFlags: {},
    } as any);

    const result = await processAccessibilityJob(makeJob());

    expect(seamCTagService.tagPdf).toHaveBeenCalledTimes(1);
    expect(adobeAutoTagService.tagPdf).not.toHaveBeenCalled();
    expect(result.data?.autoTagStatus).toBe('complete');
    expect(result.data?.taggerSource).toBe('seam-c');
    expect(result.data?.retagOutcome).toBeUndefined();
  });

  it('skips tagging entirely when already tagged and forceAutoTag is not set', async () => {
    const originalBuffer = await buildGenuinelyTaggedDoc();
    vi.mocked(fileStorageService.getFile).mockResolvedValue(originalBuffer);
    vi.mocked(pdfParserService.parseBuffer).mockResolvedValue({ structure: { metadata: { isTagged: true } } } as any);

    const result = await processAccessibilityJob(makeJob());

    expect(seamCTagService.tagPdf).not.toHaveBeenCalled();
    expect(result.data?.autoTagStatus).toBe('skipped');
    expect(result.data?.autoTagSkipReason).toBe('already-tagged');
  });

  it('does not attempt a retag when the existing structure has real semantic content', async () => {
    const originalBuffer = await buildGenuinelyTaggedDoc();
    vi.mocked(fileStorageService.getFile).mockResolvedValue(originalBuffer);
    vi.mocked(pdfParserService.parseBuffer).mockResolvedValue({ structure: { metadata: { isTagged: true } } } as any);
    vi.mocked(seamCTagService.tagPdf).mockRejectedValue(new Error('SEAM_C_ALREADY_TAGGED: document already has a /StructTreeRoot'));

    const result = await processAccessibilityJob(makeJob({ forceAutoTag: true }));

    expect(seamCTagService.tagPdf).toHaveBeenCalledTimes(1); // primary attempt only — no retry
    expect(result.data?.autoTagStatus).toBe('skipped');
    expect(result.data?.retagOutcome).toBeUndefined();
    expect((result.data?.structureTreeCompleteness as any)?.isEmptyShell).toBe(false);
  });

  it('strips and retags when the existing structure is an empty shell and forceAutoTag is set', async () => {
    const originalBuffer = await buildEmptyShellTaggedDoc({ withMarkedContent: true });
    vi.mocked(fileStorageService.getFile).mockResolvedValue(originalBuffer);
    vi.mocked(pdfParserService.parseBuffer).mockResolvedValue({ structure: { metadata: { isTagged: true } } } as any);
    vi.mocked(seamCTagService.tagPdf)
      .mockRejectedValueOnce(new Error('SEAM_C_ALREADY_TAGGED: document already has a /StructTreeRoot'))
      .mockResolvedValueOnce({
        taggedPdfBuffer: Buffer.from('retagged-pdf'),
        reportBuffer: null,
        wordBuffer: null,
        elementCounts: { Figure: 4, P: 12 },
        parsedFlags: {},
      } as any);

    const result = await processAccessibilityJob(makeJob({ forceAutoTag: true }));

    expect(seamCTagService.tagPdf).toHaveBeenCalledTimes(2);
    // The retry must run against a buffer with the old marked content stripped.
    const retryBuffer = vi.mocked(seamCTagService.tagPdf).mock.calls[1][0] as Buffer;
    expect(retryBuffer.toString('latin1')).not.toContain('BDC');

    expect(result.data?.autoTagStatus).toBe('complete');
    expect(result.data?.taggerSource).toBe('seam-c');
    expect(result.data?.retagOutcome).toBe('success');
    expect((result.data?.structureTreeCompleteness as any)?.isEmptyShell).toBe(true);

    // The audit must run against the newly retagged buffer, not the original.
    expect(pdfAuditService.runAuditFromBuffer).toHaveBeenCalledWith(
      Buffer.from('retagged-pdf'), 'job-1', 'test.pdf', 'comprehensive', undefined, expect.any(Function), expect.any(Function),
    );
  });

  it('falls back to the existing structure when there is nothing to strip', async () => {
    const originalBuffer = await buildEmptyShellTaggedDoc({ withMarkedContent: false });
    vi.mocked(fileStorageService.getFile).mockResolvedValue(originalBuffer);
    vi.mocked(pdfParserService.parseBuffer).mockResolvedValue({ structure: { metadata: { isTagged: true } } } as any);
    vi.mocked(seamCTagService.tagPdf).mockRejectedValue(new Error('SEAM_C_ALREADY_TAGGED: document already has a /StructTreeRoot'));

    const result = await processAccessibilityJob(makeJob({ forceAutoTag: true }));

    expect(seamCTagService.tagPdf).toHaveBeenCalledTimes(1); // no marked content found — never retries
    expect(result.data?.autoTagStatus).toBe('skipped');
    expect(result.data?.autoTagSkipReason).toBe('already-tagged');
    expect(result.data?.retagOutcome).toBe('failed-strip-bailed');

    expect(pdfAuditService.runAuditFromBuffer).toHaveBeenCalledWith(
      originalBuffer, 'job-1', 'test.pdf', 'comprehensive', undefined, expect.any(Function), expect.any(Function),
    );
  });

  it('falls back to the original buffer when strip succeeds but the retag retry itself fails', async () => {
    const originalBuffer = await buildEmptyShellTaggedDoc({ withMarkedContent: true });
    vi.mocked(fileStorageService.getFile).mockResolvedValue(originalBuffer);
    vi.mocked(pdfParserService.parseBuffer).mockResolvedValue({ structure: { metadata: { isTagged: true } } } as any);
    vi.mocked(seamCTagService.tagPdf)
      .mockRejectedValueOnce(new Error('SEAM_C_ALREADY_TAGGED: document already has a /StructTreeRoot'))
      .mockRejectedValueOnce(new Error('Seam C exploded on the stripped buffer'));

    const result = await processAccessibilityJob(makeJob({ forceAutoTag: true }));

    expect(seamCTagService.tagPdf).toHaveBeenCalledTimes(2); // primary + retry attempt
    expect(result.data?.autoTagStatus).toBe('skipped');
    expect(result.data?.retagOutcome).toBe('failed-retag-error');

    // Never ships a stripped-but-not-retagged document — the audit must see
    // the ORIGINAL (un-stripped) buffer, exactly like today's existing behavior.
    expect(pdfAuditService.runAuditFromBuffer).toHaveBeenCalledWith(
      originalBuffer, 'job-1', 'test.pdf', 'comprehensive', undefined, expect.any(Function), expect.any(Function),
    );
  });
});
