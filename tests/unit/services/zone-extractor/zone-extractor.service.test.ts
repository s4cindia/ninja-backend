import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockUpdate = vi.fn();
const mockCreateMany = vi.fn();
const mockTransaction = vi.fn();

vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    zoneBootstrapJob: {
      update: (...args: unknown[]) => mockUpdate(...args),
    },
    zone: {
      createMany: (...args: unknown[]) => mockCreateMany(...args),
    },
    $transaction: (...args: unknown[]) => mockTransaction(...args),
  },
  Prisma: {
    InputJsonValue: {},
  },
}));

vi.mock('../../../../src/services/zone-extractor/docling-client');
vi.mock('../../../../src/services/zone-extractor/yolo-client');
vi.mock('../../../../src/services/zone-extractor/yolo-service-scaler');

import { detectZones } from '../../../../src/services/zone-extractor/zone-extractor.service';
import { detectWithDocling } from '../../../../src/services/zone-extractor/docling-client';
import { detectWithYolo } from '../../../../src/services/zone-extractor/yolo-client';
import {
  ensureYoloServiceUp,
  touchYoloIdleTimer,
} from '../../../../src/services/zone-extractor/yolo-service-scaler';
import type { DoclingServiceResponse, YoloServiceResponse } from '../../../../src/services/zone-extractor/types';

const mockedDetect = vi.mocked(detectWithDocling);
const mockedDetectYolo = vi.mocked(detectWithYolo);
const mockedEnsureUp = vi.mocked(ensureYoloServiceUp);
const mockedTouchIdle = vi.mocked(touchYoloIdleTimer);

beforeEach(() => {
  vi.clearAllMocks();
  mockTransaction.mockImplementation(async (args: unknown[]) => {
    // Batch transaction — resolve each promise
    return Promise.all(args as Promise<unknown>[]);
  });
  mockUpdate.mockResolvedValue({});
  mockCreateMany.mockResolvedValue({ count: 0 });
  mockedEnsureUp.mockResolvedValue(undefined);
});

describe('detectZones', () => {
  const pdfPath = '/tmp/test.pdf';
  const jobId = 'job-1';
  const tenantId = 'tenant-1';
  const fileId = 'file-1';

  it('happy path: maps and persists 3 zones', async () => {
    const response: DoclingServiceResponse = {
      jobId,
      processingTimeMs: 500,
      zones: [
        { page: 1, bbox: { x: 0, y: 0, w: 100, h: 50 }, label: 'Text', confidence: 0.9 },
        { page: 1, bbox: { x: 0, y: 50, w: 100, h: 80 }, label: 'Table', confidence: 0.85 },
        { page: 2, bbox: { x: 10, y: 10, w: 200, h: 200 }, label: 'Picture', confidence: 0.95 },
      ],
    };
    mockedDetect.mockResolvedValue(response);

    const result = await detectZones(pdfPath, jobId, tenantId, fileId);

    expect(result).toHaveLength(3);
    expect(result[0].zoneType).toBe('paragraph');
    expect(result[1].zoneType).toBe('table');
    expect(result[2].zoneType).toBe('figure');
    expect(result.every((z) => z.source === 'docling')).toBe(true);
    expect(mockTransaction).toHaveBeenCalledTimes(1);
  });

  it('unknown label falls through to paragraph', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const response: DoclingServiceResponse = {
      jobId,
      processingTimeMs: 100,
      zones: [
        { page: 1, bbox: { x: 0, y: 0, w: 50, h: 50 }, label: 'Formula', confidence: 0.7 },
      ],
    };
    mockedDetect.mockResolvedValue(response);

    const result = await detectZones(pdfPath, jobId, tenantId, fileId);

    expect(result).toHaveLength(1);
    expect(result[0].zoneType).toBe('paragraph');
    expect(result[0].doclingLabel).toBe('Formula');
    warnSpy.mockRestore();
  });

  it('confidence is null when missing from Docling response', async () => {
    const response: DoclingServiceResponse = {
      jobId,
      processingTimeMs: 100,
      zones: [
        { page: 1, bbox: { x: 0, y: 0, w: 50, h: 50 }, label: 'Text' },
      ],
    };
    mockedDetect.mockResolvedValue(response);

    const result = await detectZones(pdfPath, jobId, tenantId, fileId);

    expect(result[0].confidence).toBeNull();
  });

  it('rethrows on Docling timeout — no DB write', async () => {
    mockedDetect.mockRejectedValue(
      new Error('DOCLING_TIMEOUT: exceeded 60s for jobId job-1'),
    );

    await expect(
      detectZones(pdfPath, jobId, tenantId, fileId),
    ).rejects.toThrow('DOCLING_TIMEOUT');
    expect(mockTransaction).not.toHaveBeenCalled();
  });

  it('rethrows on transaction failure', async () => {
    const response: DoclingServiceResponse = {
      jobId,
      processingTimeMs: 100,
      zones: [
        { page: 1, bbox: { x: 0, y: 0, w: 50, h: 50 }, label: 'Text', confidence: 0.9 },
      ],
    };
    mockedDetect.mockResolvedValue(response);
    mockTransaction.mockRejectedValue(new Error('DB_WRITE_FAILED'));

    await expect(
      detectZones(pdfPath, jobId, tenantId, fileId),
    ).rejects.toThrow('DB_WRITE_FAILED');
  });

  describe('yolo mode — active-request lease release', () => {
    it('happy path: ensures the service up and releases the lease once done', async () => {
      const response: YoloServiceResponse = {
        jobId,
        processingTimeMs: 200,
        zones: [
          { page: 1, bbox: { x: 0, y: 0, w: 100, h: 50 }, label: 'paragraph', confidence: 0.9 },
        ],
      };
      mockedDetectYolo.mockResolvedValue(response);

      await detectZones(pdfPath, jobId, tenantId, fileId, 'yolo');

      expect(mockedEnsureUp).toHaveBeenCalledOnce();
      expect(mockedTouchIdle).toHaveBeenCalledOnce();
    });

    it('releases the lease even when detection throws — otherwise it leaks forever', async () => {
      mockedDetectYolo.mockRejectedValue(new Error('YOLO_SCALE_TIMEOUT: not healthy'));

      await expect(
        detectZones(pdfPath, jobId, tenantId, fileId, 'yolo'),
      ).rejects.toThrow('YOLO_SCALE_TIMEOUT');

      // Must fire even on the error path (finally), or the yolo-service-scaler's
      // active-request count never drops back to 0 and it can never scale down.
      expect(mockedTouchIdle).toHaveBeenCalledOnce();
    });

    it('releases the lease even when the DB transaction fails', async () => {
      const response: YoloServiceResponse = {
        jobId,
        processingTimeMs: 200,
        zones: [
          { page: 1, bbox: { x: 0, y: 0, w: 100, h: 50 }, label: 'paragraph', confidence: 0.9 },
        ],
      };
      mockedDetectYolo.mockResolvedValue(response);
      mockTransaction.mockRejectedValue(new Error('DB_WRITE_FAILED'));

      await expect(
        detectZones(pdfPath, jobId, tenantId, fileId, 'yolo'),
      ).rejects.toThrow('DB_WRITE_FAILED');
      expect(mockedTouchIdle).toHaveBeenCalledOnce();
    });
  });
});
