/**
 * processPdfAccessibility — fail-fast max file size check
 *
 * Regression for a real production incident (2026-09-25): a 1.43GB
 * comparison-study PDF ran through ~3 minutes of genuine Adobe/Seam-C
 * auto-tagging before the audit pipeline's own size limit finally failed
 * the job -- because the only earlier size check (the "quick tagged check"
 * parse) has its failure silently swallowed and treated as "assume
 * untagged", never propagated. This checks the file size unconditionally,
 * right after loading it from storage, before any tagging work begins.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Job } from 'bullmq';
import { processAccessibilityJob } from '../../../src/workers/processors/accessibility.processor';
import { JOB_TYPES, JobData, JobResult } from '../../../src/queues';
import { queueService } from '../../../src/services/queue.service';
import { pdfParserService } from '../../../src/services/pdf/pdf-parser.service';
import { seamCTagService } from '../../../src/services/pdf/seam-c-tag.service';
import { adobeAutoTagService } from '../../../src/services/pdf/adobe-autotag.service';
import { fileStorageService } from '../../../src/services/storage/file-storage.service';
import { pdfAuditService } from '../../../src/services/pdf/pdf-audit.service';
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

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: { findUnique: vi.fn(), update: vi.fn() },
    acrJob: { create: vi.fn() },
  },
}));

// Small cap so a small test buffer can exceed it without allocating a huge fixture.
vi.mock('../../../src/config/pdf.config', () => ({
  pdfConfig: { maxFileSizeMB: 1, maxPages: 5000 },
}));

vi.mock('../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

function makeJob(): Job<JobData, JobResult> {
  return {
    id: 'job-1',
    name: 'accessibility-job',
    data: {
      type: JOB_TYPES.PDF_ACCESSIBILITY,
      tenantId: 'tenant-1',
      userId: 'user-1',
      fileId: 'file-1',
      options: { dbJobId: 'job-1', fileName: 'huge.pdf' },
    },
    updateProgress: vi.fn().mockResolvedValue(undefined),
  } as unknown as Job<JobData, JobResult>;
}

describe('processPdfAccessibility — fail-fast max file size check', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(queueService.updateJobProgress).mockResolvedValue(undefined as any);
    vi.mocked(prisma.job.findUnique).mockResolvedValue({ input: {} } as any);
    vi.mocked(prisma.job.update).mockResolvedValue({} as any);
    vi.mocked(prisma.acrJob.create).mockResolvedValue({} as any);
    vi.mocked(pdfParserService.close).mockResolvedValue(undefined as any);
    vi.mocked(fileStorageService.saveRemediatedFile).mockResolvedValue(undefined as any);
    vi.mocked(fileStorageService.saveFile).mockResolvedValue(undefined as any);
    vi.mocked(pdfAuditService.runAuditFromBuffer).mockResolvedValue({ issues: [] } as any);
  });

  it('rejects an oversized file immediately, before the tagged-check parse or any tagging work', async () => {
    const oversizedBuffer = Buffer.alloc(2 * 1024 * 1024); // 2MB > the 1MB test cap
    vi.mocked(fileStorageService.getFile).mockResolvedValue(oversizedBuffer);

    await expect(processAccessibilityJob(makeJob())).rejects.toThrow(
      'PDF file exceeds maximum size of 1MB'
    );

    expect(pdfParserService.parseBuffer).not.toHaveBeenCalled();
    expect(seamCTagService.tagPdf).not.toHaveBeenCalled();
    expect(adobeAutoTagService.tagPdf).not.toHaveBeenCalled();
  });

  it('still proceeds normally for a file within the limit', async () => {
    const smallBuffer = Buffer.alloc(1024); // well under the 1MB test cap
    vi.mocked(fileStorageService.getFile).mockResolvedValue(smallBuffer);
    vi.mocked(pdfParserService.parseBuffer).mockResolvedValue({ structure: { metadata: { isTagged: true } } } as any);

    await processAccessibilityJob(makeJob());

    expect(pdfParserService.parseBuffer).toHaveBeenCalledTimes(1);
  });
});
