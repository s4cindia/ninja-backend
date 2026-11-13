/**
 * createAndEnqueuePdfAuditJob -- focused coverage for the new
 * `jobOptions.assignment` parameter, which backs "a Team Leader uploads a
 * PDF and assigns it directly to an Executive." No prior test coverage
 * existed for this function at all (or for pdf.controller.ts in general);
 * this is intentionally scoped to just the new assignment behavior, not a
 * full first-time test of job creation/file persistence/queueing end to
 * end.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/lib/prisma', () => ({
  default: {
    job: { create: vi.fn() },
  },
}));

vi.mock('../../../src/services/storage/file-storage.service', () => ({
  fileStorageService: { saveFile: vi.fn(), saveFileFromS3Key: vi.fn() },
}));

const queueAddMock = vi.fn();
vi.mock('../../../src/queues', () => ({
  areQueuesAvailable: vi.fn(() => true),
  getAccessibilityQueue: vi.fn(() => ({ add: queueAddMock })),
  JOB_TYPES: { PDF_ACCESSIBILITY: 'PDF_ACCESSIBILITY' },
}));

vi.mock('../../../src/config', () => ({
  config: { processRole: 'web' }, // skips the 60s in-process fallback branch entirely
}));

import prisma from '../../../src/lib/prisma';
import { fileStorageService } from '../../../src/services/storage/file-storage.service';
import { createAndEnqueuePdfAuditJob } from '../../../src/controllers/pdf.controller';

const FILE = { originalname: 'title.pdf', mimetype: 'application/pdf', size: 1024, buffer: Buffer.from('pdf-bytes') };

describe('createAndEnqueuePdfAuditJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (fileStorageService.saveFile as any).mockResolvedValue(undefined);
  });

  it('owns the job as the caller themselves when no assignment is given (every existing caller -- normal self-upload)', async () => {
    (prisma.job.create as any).mockResolvedValue({ id: 'job-1' });

    await createAndEnqueuePdfAuditJob(FILE, 'tenant-1', 'caller-1');

    expect(prisma.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'caller-1', assignedById: null, assignedAt: null, fullAutoMode: null }),
      })
    );
    expect(queueAddMock).toHaveBeenCalledWith(
      'pdf-audit',
      expect.objectContaining({ userId: 'caller-1' }),
      expect.anything()
    );
  });

  it('persists Job.fullAutoMode as given (true/false), and null when no override is passed at all', async () => {
    (prisma.job.create as any).mockResolvedValue({ id: 'job-4' });
    await createAndEnqueuePdfAuditJob(FILE, 'tenant-1', 'caller-1', { fullAutoMode: true });
    expect(prisma.job.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fullAutoMode: true }) })
    );

    (prisma.job.create as any).mockResolvedValue({ id: 'job-5' });
    await createAndEnqueuePdfAuditJob(FILE, 'tenant-1', 'caller-1', { fullAutoMode: false });
    expect(prisma.job.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ fullAutoMode: false }) })
    );
  });

  it('owns the job as the assignee, stamping assignedById/assignedAt, when a real assignment is passed', async () => {
    (prisma.job.create as any).mockResolvedValue({ id: 'job-2' });
    const assignedAt = new Date('2026-11-13T00:00:00.000Z');

    await createAndEnqueuePdfAuditJob(FILE, 'tenant-1', 'leader-1', {
      assignment: { ownerId: 'exec-1', assignedById: 'leader-1', assignedAt },
    });

    expect(prisma.job.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ userId: 'exec-1', assignedById: 'leader-1', assignedAt }),
      })
    );
  });

  it('enqueues the BullMQ job under the ASSIGNEE\'s userId, not the uploading Team Leader\'s -- the worker\'s own completion notification must reach the real owner', async () => {
    (prisma.job.create as any).mockResolvedValue({ id: 'job-3' });

    await createAndEnqueuePdfAuditJob(FILE, 'tenant-1', 'leader-1', {
      assignment: { ownerId: 'exec-1', assignedById: 'leader-1', assignedAt: new Date() },
    });

    expect(queueAddMock).toHaveBeenCalledWith(
      'pdf-audit',
      expect.objectContaining({ userId: 'exec-1', tenantId: 'tenant-1' }),
      expect.anything()
    );
  });
});
