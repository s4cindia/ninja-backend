/**
 * Build a self-contained input bundle for the pikepdf write spike (ML-3.8).
 *
 * Queries Prisma for every CorpusDocument that has operator-verified zones,
 * normalizes operatorLabel via the shared canonical-label module, downloads
 * each source PDF from S3, and packages everything into a single zip
 * uploaded to s3://<bucket>/admin-scripts/pikepdf-spike-bundle-<date>.zip.
 *
 * Bundle contents:
 *   - ground_truth.json   { documents: [{ documentId, pdfPath (relative),
 *                          contentType, publisher, zones: [...] }] }
 *   - pdfs/<documentId>.pdf       one file per document
 *   - README.txt                  human-readable run instructions
 *
 * Designed for in-VPC execution (private Postgres + S3). When run as an
 * ECS one-shot task it prints a 24-hour presigned URL on completion.
 *
 * Plain JS rather than TS to match the existing operational-script
 * convention (see scripts/spot-check-ecs.js, scripts/backfill-empty-pages.js)
 * which the Dockerfile COPY-line ships into the production image at
 * /app/scripts/.
 *
 * Runtime: node 20 (matches Dockerfile). Imports the canonical-label
 * normalizer from the compiled backend code at /app/dist.
 */
const AdmZip = require('adm-zip');
const {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { PrismaClient } = require('@prisma/client');
const {
  normalizeWithHeadingLevel,
} = require('/app/dist/services/metrics/operator-label-normalizer');

const BUCKET = process.env.S3_BUCKET || 'ninja-epub-staging';
const REGION = process.env.S3_REGION || 'ap-south-1';

const s3 = new S3Client({ region: REGION });
const prisma = new PrismaClient();

function parseS3Path(s3Path) {
  const m = /^s3:\/\/([^/]+)\/(.+)$/.exec(s3Path || '');
  return m ? { bucket: m[1], key: m[2] } : null;
}

async function streamToBuffer(body) {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  const chunks = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function downloadPdf(s3Path) {
  const parsed = parseS3Path(s3Path);
  if (!parsed) {
    console.warn(`[export] Invalid S3 path: ${s3Path}`);
    return null;
  }
  try {
    const res = await s3.send(
      new GetObjectCommand({ Bucket: parsed.bucket, Key: parsed.key }),
    );
    if (!res.Body) {
      console.warn(`[export] Empty S3 body for ${s3Path}`);
      return null;
    }
    return await streamToBuffer(res.Body);
  } catch (err) {
    console.warn(`[export] Failed to download ${s3Path}: ${err.message}`);
    return null;
  }
}

function buildSpikeZones(rows) {
  const zones = [];
  let skipped = 0;
  for (const r of rows) {
    if (!r.bounds || typeof r.bounds !== 'object') {
      skipped++;
      continue;
    }
    const b = r.bounds;
    if (
      typeof b.x !== 'number' ||
      typeof b.y !== 'number' ||
      typeof b.w !== 'number' ||
      typeof b.h !== 'number'
    ) {
      skipped++;
      continue;
    }
    // Prefer operatorLabel; fall back to raw type. Drop the zone if neither
    // normalizes (matching mAP-route flatMap semantics).
    const normalized =
      normalizeWithHeadingLevel(r.operatorLabel) ||
      normalizeWithHeadingLevel(r.type);
    if (!normalized) {
      skipped++;
      continue;
    }
    const zone = {
      pageNumber: r.pageNumber,
      bounds: { x: b.x, y: b.y, w: b.w, h: b.h },
      type: normalized.canonical,
      operatorLabel: normalized.canonical,
    };
    if (normalized.headingLevel !== undefined) {
      zone.headingLevel = normalized.headingLevel;
    }
    if (r.altText) zone.altText = r.altText;
    zones.push(zone);
  }
  return { zones, skipped };
}

(async () => {
  const generatedAt = new Date().toISOString();
  console.log(`[export] Starting pikepdf spike bundle build at ${generatedAt}`);

  const docs = await prisma.corpusDocument.findMany({
    where: {
      s3Path: { not: '' },
      calibrationRuns: {
        some: {
          type: 'CALIBRATION',
          completedAt: { not: null },
          zones: { some: { operatorVerified: true, isArtefact: false } },
        },
      },
    },
    select: {
      id: true,
      filename: true,
      s3Path: true,
      publisher: true,
      contentType: true,
    },
    orderBy: { uploadedAt: 'asc' },
  });
  console.log(`[export] Found ${docs.length} documents with operator-verified zones`);

  const groundTruth = { documents: [], generatedAt, notes: [] };
  const zip = new AdmZip();
  let totalZones = 0;
  let totalSkipped = 0;
  let pdfsAdded = 0;

  for (const doc of docs) {
    const run = await prisma.calibrationRun.findFirst({
      where: {
        documentId: doc.id,
        type: 'CALIBRATION',
        completedAt: { not: null },
      },
      orderBy: { completedAt: 'desc' },
      select: { id: true },
    });
    if (!run) continue;

    const zones = await prisma.zone.findMany({
      where: {
        calibrationRunId: run.id,
        operatorVerified: true,
        isArtefact: false,
        bounds: { not: null },
      },
      select: {
        pageNumber: true,
        bounds: true,
        type: true,
        operatorLabel: true,
        altText: true,
      },
    });

    const { zones: spikeZones, skipped } = buildSpikeZones(zones);
    totalZones += spikeZones.length;
    totalSkipped += skipped;

    if (spikeZones.length === 0) {
      console.log(
        `[export] SKIP ${doc.id} (${doc.filename}): no usable zones after normalization`,
      );
      continue;
    }

    const pdfBuffer = await downloadPdf(doc.s3Path);
    if (!pdfBuffer) {
      console.log(
        `[export] SKIP ${doc.id} (${doc.filename}): source PDF unreachable`,
      );
      continue;
    }

    const safeName = `${doc.id}.pdf`;
    zip.addFile(`pdfs/${safeName}`, pdfBuffer);
    pdfsAdded++;

    groundTruth.documents.push({
      documentId: doc.id,
      pdfPath: `pdfs/${safeName}`,
      contentType: doc.contentType || 'unknown',
      publisher: doc.publisher || 'unknown',
      zones: spikeZones,
    });

    console.log(
      `[export] ${doc.id}  ${spikeZones.length} zones (${skipped} skipped)  ${doc.filename}`,
    );
  }

  if (totalSkipped > 0) {
    groundTruth.notes.push(
      `${totalSkipped} zone(s) skipped during normalization (unrecognizable operatorLabel or invalid bounds).`,
    );
  }
  groundTruth.notes.push(
    'Zone.type and Zone.operatorLabel were both normalized to CanonicalZoneType via normalizeWithHeadingLevel. Heading levels h1-h6 are preserved as zone.headingLevel.',
  );

  zip.addFile(
    'ground_truth.json',
    Buffer.from(JSON.stringify(groundTruth, null, 2), 'utf8'),
  );

  const readme = [
    'pikepdf write spike bundle',
    `Generated: ${generatedAt}`,
    `Documents:  ${groundTruth.documents.length}`,
    `Total zones: ${totalZones}`,
    `Zones skipped during normalization: ${totalSkipped}`,
    '',
    'To run the spike (requires Python 3.11+ and veraPDF):',
    '  1. Extract this archive locally.',
    '  2. cd into spikes/pikepdf-write/ from the ninja-backend repo.',
    '  3. pip install -r requirements.txt',
    '  4. Set VERAPDF_PATH to your local veraPDF binary',
    "     - macOS/Linux:  export VERAPDF_PATH=/path/to/verapdf",
    '     - Windows:      set VERAPDF_PATH=C:\\path\\to\\verapdf.bat',
    '  5. python run_spike.py <path-to-extracted-bundle>/ground_truth.json ./output/',
    '  6. The output/ folder will contain spike_report.md and spike_results.json.',
    '',
    'Decision threshold: pass rate >= 95% -> PROCEED with pikepdf for Phase-2.',
    '                    pass rate <  95% -> EVALUATE PDFBox fallback.',
    '',
    "pdfPath entries in ground_truth.json are relative to this bundle's root.",
  ].join('\n');
  zip.addFile('README.txt', Buffer.from(readme, 'utf8'));

  const datePart = generatedAt.slice(0, 10);
  const bundleKey = `admin-scripts/pikepdf-spike-bundle-${datePart}.zip`;
  const zipBuffer = zip.toBuffer();
  console.log(
    `[export] Bundle ready: ${pdfsAdded} PDFs, ${groundTruth.documents.length} docs, ${totalZones} zones, ${(zipBuffer.length / 1024 / 1024).toFixed(1)} MB`,
  );

  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: bundleKey,
      Body: zipBuffer,
      ContentType: 'application/zip',
    }),
  );
  console.log(`[export] Uploaded to s3://${BUCKET}/${bundleKey}`);

  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket: BUCKET, Key: bundleKey }),
    { expiresIn: 86400 }, // 24 hours
  );
  console.log('[export] Presigned URL (valid 24 hours):');
  console.log(url);
  console.log('DONE');

  await prisma.$disconnect();
})().catch((err) => {
  console.error('[export] FAIL:', err);
  process.exit(1);
});
