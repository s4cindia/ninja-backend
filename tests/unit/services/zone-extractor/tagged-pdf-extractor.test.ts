import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';

// --- S3 mock ---
const mockSend = vi.fn();
vi.mock('@aws-sdk/client-s3', () => ({
  S3Client: vi.fn(),
  GetObjectCommand: vi.fn(),
}));
vi.mock('../../../../src/services/s3.service', () => ({
  s3Client: { send: (...args: unknown[]) => mockSend(...args) },
}));

// --- Logger mock ---
vi.mock('../../../../src/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  extractZonesFromTaggedPdf,
  mapStructTag,
  parseS3Path,
} from '../../../../src/services/zone-extractor/tagged-pdf-extractor';

// Helper: build a minimal tagged PDF with structure tree
async function buildTaggedPdf(
  tags: Array<{ tag: string; bbox?: [number, number, number, number] }>,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);

  // Build structure elements
  const kids: PDFRef[] = [];
  for (const { tag, bbox } of tags) {
    const elemDict = doc.context.obj({});
    elemDict.set(PDFName.of('S'), PDFName.of(tag));
    elemDict.set(PDFName.of('Pg'), page.ref);

    if (bbox) {
      const bboxArray = doc.context.obj(bbox);
      elemDict.set(PDFName.of('BBox'), bboxArray);
    }

    const elemRef = doc.context.register(elemDict);
    kids.push(elemRef);
  }

  // Build StructTreeRoot
  const structTreeRoot = doc.context.obj({});
  structTreeRoot.set(PDFName.of('Type'), PDFName.of('StructTreeRoot'));
  if (kids.length > 0) {
    const kidsArray = doc.context.obj(kids);
    structTreeRoot.set(PDFName.of('K'), kidsArray);
  }

  const structRef = doc.context.register(structTreeRoot);
  doc.catalog.set(PDFName.of('StructTreeRoot'), structRef);

  return doc.save();
}

async function buildUntaggedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  // No StructTreeRoot set
  return doc.save();
}

function mockS3Download(pdfBytes: Uint8Array) {
  mockSend.mockResolvedValue({
    Body: pdfBytes,
  });
}

describe('tagged-pdf-extractor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // --- parseS3Path ---
  describe('parseS3Path', () => {
    it('parses s3://bucket/key correctly', () => {
      expect(parseS3Path('s3://ninja-epub-staging/corpus/test.pdf')).toEqual({
        bucket: 'ninja-epub-staging',
        key: 'corpus/test.pdf',
      });
    });

    it('throws on invalid path', () => {
      expect(() => parseS3Path('s3://bucketonly')).toThrow('Invalid S3 path');
    });
  });

  // --- mapStructTag ---
  describe('mapStructTag', () => {
    it('H1-H6 all map to section-header', () => {
      expect(mapStructTag('H1')).toBe('section-header');
      expect(mapStructTag('H2')).toBe('section-header');
      expect(mapStructTag('H3')).toBe('section-header');
      expect(mapStructTag('H4')).toBe('section-header');
      expect(mapStructTag('H5')).toBe('section-header');
      expect(mapStructTag('H6')).toBe('section-header');
      expect(mapStructTag('H')).toBe('section-header');
    });

    it('P maps to paragraph', () => {
      expect(mapStructTag('P')).toBe('paragraph');
    });

    it('Table maps to table', () => {
      expect(mapStructTag('Table')).toBe('table');
    });

    it('Figure maps to figure', () => {
      expect(mapStructTag('Figure')).toBe('figure');
    });

    it('Note maps to footnote', () => {
      expect(mapStructTag('Note')).toBe('footnote');
    });

    it('Caption maps to caption', () => {
      expect(mapStructTag('Caption')).toBe('caption');
    });

    it('Span maps to paragraph', () => {
      expect(mapStructTag('Span')).toBe('paragraph');
    });

    it('NT maps to footnote', () => {
      expect(mapStructTag('NT')).toBe('footnote');
    });

    it('LBody maps to paragraph', () => {
      expect(mapStructTag('LBody')).toBe('paragraph');
    });

    it('Link maps to paragraph', () => {
      expect(mapStructTag('Link')).toBe('paragraph');
    });

    it('unknown tags return null', () => {
      expect(mapStructTag('CustomTag')).toBeNull();
      expect(mapStructTag('ZZZUnknown')).toBeNull();
    });
  });

  // --- extractZonesFromTaggedPdf ---
  describe('extractZonesFromTaggedPdf', () => {
    it('returns zones from PDF with StructTreeRoot (Test 1)', async () => {
      const pdfBytes = await buildTaggedPdf([
        { tag: 'P', bbox: [10, 20, 100, 50] },
        { tag: 'H1', bbox: [10, 80, 200, 30] },
        { tag: 'Table', bbox: [10, 120, 300, 200] },
      ]);
      mockS3Download(pdfBytes);

      const result = await extractZonesFromTaggedPdf(
        's3://ninja-epub-staging/corpus/test.pdf',
        'run-123',
      );

      expect(result.jobId).toBe('run-123');
      expect(result.zones).toHaveLength(3);
      expect(result.zones[0].zoneType).toBe('paragraph');
      expect(result.zones[0].label).toBe('P');
      expect(result.zones[1].zoneType).toBe('section-header');
      expect(result.zones[1].label).toBe('H1');
      expect(result.zones[2].zoneType).toBe('table');
      expect(result.zones[2].label).toBe('Table');
      expect(result.processingTimeMs).toBeGreaterThanOrEqual(0);
    });

    it('returns empty array for PDF without StructTreeRoot (Test 2)', async () => {
      const pdfBytes = await buildUntaggedPdf();
      mockS3Download(pdfBytes);

      const result = await extractZonesFromTaggedPdf(
        's3://ninja-epub-staging/corpus/untagged.pdf',
        'run-456',
      );

      expect(result.zones).toHaveLength(0);
      expect(result.jobId).toBe('run-456');
    });

    it('maps heading variants correctly (Test 3)', async () => {
      const pdfBytes = await buildTaggedPdf([
        { tag: 'H1', bbox: [0, 0, 100, 20] },
        { tag: 'H2', bbox: [0, 30, 100, 20] },
        { tag: 'H3', bbox: [0, 60, 100, 20] },
        { tag: 'H4', bbox: [0, 90, 100, 20] },
        { tag: 'H5', bbox: [0, 120, 100, 20] },
        { tag: 'H6', bbox: [0, 150, 100, 20] },
      ]);
      mockS3Download(pdfBytes);

      const result = await extractZonesFromTaggedPdf(
        's3://bucket/h.pdf',
        'run-h',
      );

      expect(result.zones).toHaveLength(6);
      for (const zone of result.zones) {
        expect(zone.zoneType).toBe('section-header');
      }
    });

    it('maps P, Table, Figure, Note correctly (Test 4)', async () => {
      const pdfBytes = await buildTaggedPdf([
        { tag: 'P', bbox: [0, 0, 100, 20] },
        { tag: 'Table', bbox: [0, 30, 200, 100] },
        { tag: 'Figure', bbox: [0, 140, 150, 150] },
        { tag: 'Note', bbox: [0, 300, 100, 30] },
      ]);
      mockS3Download(pdfBytes);

      const result = await extractZonesFromTaggedPdf(
        's3://bucket/mixed.pdf',
        'run-mix',
      );

      expect(result.zones).toHaveLength(4);
      expect(result.zones[0].zoneType).toBe('paragraph');
      expect(result.zones[1].zoneType).toBe('table');
      expect(result.zones[2].zoneType).toBe('figure');
      expect(result.zones[3].zoneType).toBe('footnote');
    });

    it('skips nodes without BBox (Test 5)', async () => {
      const pdfBytes = await buildTaggedPdf([
        { tag: 'P' },  // no bbox
        { tag: 'H1', bbox: [10, 20, 100, 30] },
        { tag: 'Table' }, // no bbox
      ]);
      mockS3Download(pdfBytes);

      const result = await extractZonesFromTaggedPdf(
        's3://bucket/partial.pdf',
        'run-partial',
      );

      // Only H1 has bbox
      expect(result.zones).toHaveLength(1);
      expect(result.zones[0].zoneType).toBe('section-header');
      expect(result.zones[0].label).toBe('H1');
    });

    it('source confidence is always 0.9 on returned zones (Test 6)', async () => {
      const pdfBytes = await buildTaggedPdf([
        { tag: 'P', bbox: [0, 0, 100, 20] },
        { tag: 'Figure', bbox: [0, 30, 100, 100] },
      ]);
      mockS3Download(pdfBytes);

      const result = await extractZonesFromTaggedPdf(
        's3://bucket/conf.pdf',
        'run-conf',
      );

      for (const zone of result.zones) {
        expect(zone.confidence).toBe(0.9);
      }
    });

    it('includes pageNumber on all zones', async () => {
      const pdfBytes = await buildTaggedPdf([
        { tag: 'P', bbox: [0, 0, 100, 20] },
      ]);
      mockS3Download(pdfBytes);

      const result = await extractZonesFromTaggedPdf(
        's3://bucket/page.pdf',
        'run-page',
      );

      expect(result.zones).toHaveLength(1);
      expect(result.zones[0].pageNumber).toBe(1);
    });
  });
});
