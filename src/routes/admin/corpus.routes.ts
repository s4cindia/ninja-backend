import { Router, Request, Response } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { authenticate } from '../../middleware/auth.middleware';
import {
  generateUploadUrl,
  registerCorpusDocument,
  listCorpusDocuments,
} from '../../services/corpus/corpus-upload.service';
import { s3Client } from '../../services/s3.service';
import { config } from '../../config';
import prisma from '../../lib/prisma';
import { getCalibrationQueue, JOB_TYPES, areQueuesAvailable } from '../../queues';
import { logger } from '../../lib/logger';

const router = Router();

const taggedPdfUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
}).single('file');

const isAdmin = (req: Request): boolean => {
  const role = (req as Request & { user?: { role?: string } }).user?.role;
  return role === 'admin' || role === 'ADMIN';
};

const isAdminOrOperator = (req: Request): boolean => {
  const role = (req as Request & { user?: { role?: string } }).user?.role;
  return ['admin', 'ADMIN', 'OPERATOR'].includes(role ?? '');
};

const uploadUrlBodySchema = z.object({
  filename: z.string().min(1),
  contentType: z.string().default('application/pdf'),
});

// POST /api/v1/admin/corpus/upload-url
router.post('/corpus/upload-url', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin role required' },
      });
    }

    const parsed = uploadUrlBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: parsed.error.issues,
        },
      });
    }

    const { filename, contentType } = parsed.data;
    const result = await generateUploadUrl(filename, contentType);
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

const registerBodySchema = z.object({
  filename: z.string().min(1),
  s3Path: z.string().min(1),
  publisher: z.string().optional(),
  contentType: z.string().optional(),
  pageCount: z.coerce.number().optional(),
  language: z.string().default('en'),
});

// POST /api/v1/admin/corpus/register
router.post('/corpus/register', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin role required' },
      });
    }

    const parsed = registerBodySchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: parsed.error.issues,
        },
      });
    }

    const doc = await registerCorpusDocument(parsed.data);
    return res.status(201).json({ success: true, data: doc });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

const documentsQuerySchema = z.object({
  limit: z.coerce.number().default(20),
  cursor: z.string().optional(),
  publisher: z.string().optional(),
  contentType: z.string().optional(),
});

// GET /api/v1/admin/corpus/documents
router.get('/corpus/documents', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin role required' },
      });
    }

    const parsed = documentsQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(422).json({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: 'Request validation failed',
          details: parsed.error.issues,
        },
      });
    }

    const result = await listCorpusDocuments(parsed.data);
    return res.json({ success: true, data: result });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// GET /api/v1/admin/corpus/documents/:id/download-url?type=source|tagged
// Returns a presigned S3 GET URL for the source or tagged PDF
router.get('/corpus/documents/:id/download-url', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdminOrOperator(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin or Operator role required' },
      });
    }

    const { id } = req.params;
    const type = (req.query.type as string) || 'source';

    if (type !== 'source' && type !== 'tagged') {
      return res.status(422).json({
        success: false,
        error: { code: 'VALIDATION_ERROR', message: 'type must be "source" or "tagged"' },
      });
    }

    const doc = await prisma.corpusDocument.findUnique({ where: { id } });
    if (!doc) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Corpus document not found' },
      });
    }

    const s3Uri = type === 'tagged' ? doc.taggedPdfPath : doc.s3Path;
    if (!s3Uri) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `No ${type} PDF uploaded for this document` },
      });
    }

    // Parse s3://bucket/key from the stored path
    const s3Match = s3Uri.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (!s3Match) {
      return res.status(422).json({
        success: false,
        error: { code: 'INVALID_S3_PATH', message: 'Document has no valid S3 path' },
      });
    }

    const [, parsedBucket, s3Key] = s3Match;
    if (parsedBucket !== config.s3Bucket) {
      return res.status(422).json({
        success: false,
        error: { code: 'INVALID_S3_PATH', message: 'Document bucket does not match configured bucket' },
      });
    }
    const expiresIn = 900;
    const command = new GetObjectCommand({
      Bucket: parsedBucket,
      Key: s3Key,
    });
    const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn });

    logger.info(`[download-url] type=${type} doc=${id} bucket=${parsedBucket} key=${s3Key} urlHost=${new URL(downloadUrl).hostname}`);

    return res.json({
      success: true,
      data: { downloadUrl, expiresIn },
    });
  } catch (err) {
    logger.error('GET /admin/corpus/documents/:id/download-url error:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
});

// GET /api/v1/admin/corpus/documents/:id/struct-tree?source=tagged|source
// Returns the raw StructTreeRoot as JSON for debugging extraction gaps
router.get('/corpus/documents/:id/struct-tree', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin access required' },
      });
    }

    const doc = await prisma.corpusDocument.findUnique({ where: { id: req.params.id } });
    if (!doc) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Document not found' },
      });
    }

    const pdfSource = req.query.source === 'tagged' ? 'tagged' : 'source';
    const s3Path = pdfSource === 'tagged' ? doc.taggedPdfPath : doc.s3Path;
    if (!s3Path) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: `No ${pdfSource} PDF available` },
      });
    }

    // Download PDF from S3
    const { parseS3Path } = await import('../../services/zone-extractor/tagged-pdf-extractor');
    const { serializeStructTreeAsync } = await import('../../services/zone-extractor/struct-tree-serializer');
    const { bucket, key } = parseS3Path(s3Path);
    const response = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));

    const chunks: Buffer[] = [];
    for await (const chunk of response.Body as AsyncIterable<Buffer>) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const pdfBytes = Buffer.concat(chunks);

    const structTree = await serializeStructTreeAsync(pdfBytes);

    return res.json({ success: true, data: structTree });
  } catch (err) {
    logger.error('GET /admin/corpus/documents/:id/struct-tree error:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

// POST /api/v1/admin/corpus/documents/:id/run
router.post('/corpus/documents/:id/run', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin role required' },
      });
    }

    const { id } = req.params;

    const doc = await prisma.corpusDocument.findUnique({
      where: { id },
    });
    if (!doc) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Corpus document not found' },
      });
    }

    // Check for in-progress runs (completedAt is null means still running)
    // Auto-expire stale runs older than 10 minutes (worker crashed or job failed without updating DB)
    const STALE_THRESHOLD_MS = 10 * 60 * 1000;
    const openRuns = await prisma.calibrationRun.findMany({
      where: {
        documentId: id,
        completedAt: null,
      },
    });
    let hasActiveRun = false;
    for (const run of openRuns) {
      const age = Date.now() - new Date(run.runDate).getTime();
      if (age > STALE_THRESHOLD_MS) {
        await prisma.calibrationRun.update({
          where: { id: run.id },
          data: {
            completedAt: new Date(),
            summary: { error: 'Auto-expired: stale run with no completion', status: 'FAILED' },
          },
        });
        logger.warn(`[CorpusRun] Auto-expired stale run ${run.id} (age: ${Math.round(age / 1000)}s)`);
      } else {
        hasActiveRun = true;
      }
    }
    if (hasActiveRun) {
      return res.status(409).json({
        success: false,
        error: {
          code: 'RUN_IN_PROGRESS',
          message: 'A calibration run is already in progress',
        },
      });
    }

    // Use stored taggedPdfPath from CorpusDocument (set via tagged-pdf upload endpoint)
    const taggedPdfPath = doc.taggedPdfPath ?? undefined;

    // Validate tenant context
    const reqUser = (req as Request & { user?: { tenantId?: string; userId?: string; id?: string } }).user;
    const tenantId = reqUser?.tenantId;
    if (!tenantId) {
      return res.status(401).json({
        success: false,
        error: { code: 'MISSING_TENANT', message: 'Tenant context required' },
      });
    }
    const userId = reqUser?.userId ?? reqUser?.id ?? '';

    const run = await prisma.calibrationRun.create({
      data: {
        documentId: id,
      },
    });

    if (areQueuesAvailable()) {
      const queue = getCalibrationQueue();
      if (queue) {
        await queue.add(JOB_TYPES.CALIBRATION_RUN, {
          type: JOB_TYPES.CALIBRATION_RUN,
          tenantId,
          userId,
          options: {
            runId: run.id,
            documentId: id,
            s3Path: doc.s3Path,
            tenantId,
            ...(taggedPdfPath ? { taggedPdfPath } : {}),
          },
        }, {
          jobId: `calibration-${run.id}`,
          attempts: 2,
          backoff: { type: 'exponential', delay: 60_000 },
          removeOnComplete: 100,
          removeOnFail: 50,
        });
        logger.info(`[CorpusRun] Dispatched calibration job for run ${run.id}`);
      } else {
        logger.warn(`[CorpusRun] Calibration queue not available — run ${run.id} will not be processed`);
      }
    } else {
      logger.warn(`[CorpusRun] Redis not configured — run ${run.id} will not be processed`);
    }

    return res.status(202).json({
      success: true,
      data: { runId: run.id, documentId: id, status: 'QUEUED' },
    });
  } catch (err) {
    logger.error('POST /admin/corpus/documents/:id/run error:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
});

// POST /api/v1/admin/corpus/documents/:id/tagged-pdf-upload-url
// Step 1 of presigned upload flow: generate a presigned PUT URL for the tagged PDF
router.post('/corpus/documents/:id/tagged-pdf-upload-url', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdminOrOperator(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin or Operator role required' },
      });
    }

    const { id } = req.params;
    const doc = await prisma.corpusDocument.findUnique({ where: { id } });
    if (!doc) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Corpus document not found' },
      });
    }

    const bucket = config.s3Bucket;
    const s3Key = `corpus/tagged/${id}.pdf`;
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: s3Key,
      ContentType: 'application/pdf',
    });
    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });

    return res.json({
      success: true,
      data: {
        uploadUrl,
        s3Key,
        expiresAt: new Date(Date.now() + 300_000).toISOString(),
      },
    });
  } catch (err) {
    logger.error('POST /admin/corpus/documents/:id/tagged-pdf-upload-url error:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
});

// POST /api/v1/admin/corpus/documents/:id/tagged-pdf-confirm
// Step 2 of presigned upload flow: confirm upload and persist taggedPdfPath
router.post('/corpus/documents/:id/tagged-pdf-confirm', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdminOrOperator(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin or Operator role required' },
      });
    }

    const { id } = req.params;

    const doc = await prisma.corpusDocument.findUnique({ where: { id } });
    if (!doc) {
      return res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Corpus document not found' },
      });
    }

    // Regenerate s3Key from document ID — never trust client-supplied paths
    const s3Key = `corpus/tagged/${id}.pdf`;
    const taggedPdfPath = `s3://${config.s3Bucket}/${s3Key}`;

    await prisma.corpusDocument.update({
      where: { id },
      data: { taggedPdfPath },
    });

    logger.info(`[TaggedPdf] Confirmed tagged PDF for document ${id}: ${taggedPdfPath}`);

    return res.json({
      success: true,
      data: { documentId: id, taggedPdfPath },
    });
  } catch (err) {
    logger.error('POST /admin/corpus/documents/:id/tagged-pdf-confirm error:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
});

// DEPRECATED: POST /api/v1/admin/corpus/documents/:id/tagged-pdf
// Multipart upload through CloudFront — blocked by WAF. Kept for local dev.
// Use tagged-pdf-upload-url + tagged-pdf-confirm instead.
// Auth check runs BEFORE multer to avoid buffering 100MB for unauthorized users
router.post('/corpus/documents/:id/tagged-pdf', authenticate, (req: Request, res: Response, next) => {
  if (!isAdminOrOperator(req)) {
    return res.status(403).json({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Admin or Operator role required' },
    });
  }
  next();
}, (req: Request, res: Response) => {
  taggedPdfUpload(req, res, async (multerErr) => {
    try {
      if (multerErr) {
        logger.error('[TaggedPdf] Multer error:', multerErr);
        return res.status(400).json({
          success: false,
          error: { code: 'UPLOAD_ERROR', message: multerErr.message },
        });
      }

      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_FILE', message: 'No file uploaded' },
        });
      }

      if (req.file.mimetype !== 'application/pdf') {
        return res.status(422).json({
          success: false,
          error: { code: 'INVALID_FILE_TYPE', message: 'Only PDF files are accepted' },
        });
      }

      const { id } = req.params;
      const reqUser = (req as Request & { user?: { tenantId?: string } }).user;
      const tenantId = reqUser?.tenantId;
      if (!tenantId) {
        return res.status(401).json({
          success: false,
          error: { code: 'MISSING_TENANT', message: 'Tenant context required' },
        });
      }

      // Tenant-scoped lookup to prevent cross-tenant access
      const doc = await prisma.corpusDocument.findFirst({
        where: { id },
      });
      if (!doc) {
        return res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Corpus document not found' },
        });
      }

      // Upload to S3 under tagged/ prefix
      const bucket = config.s3Bucket;
      const s3Key = `corpus/tagged/${id}.pdf`;

      await s3Client.send(new PutObjectCommand({
        Bucket: bucket,
        Key: s3Key,
        Body: req.file.buffer,
        ContentType: 'application/pdf',
      }));

      const taggedPdfPath = `s3://${bucket}/${s3Key}`;

      // Update CorpusDocument with tagged PDF path
      await prisma.corpusDocument.update({
        where: { id },
        data: { taggedPdfPath },
      });

      logger.info(`[TaggedPdf] Uploaded tagged PDF for document ${id}: ${taggedPdfPath}`);

      return res.json({
        success: true,
        data: {
          documentId: id,
          taggedPdfPath,
          message: 'Tagged PDF uploaded successfully',
        },
      });
    } catch (err) {
      logger.error('POST /admin/corpus/documents/:id/tagged-pdf error:', err);
      return res.status(500).json({
        success: false,
        error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
      });
    }
  });
});

// POST /api/v1/admin/corpus/reset
// Deletes ALL corpus data: zones, calibration runs, bootstrap jobs, corpus documents
router.post('/corpus/reset', authenticate, async (req: Request, res: Response) => {
  try {
    if (!isAdmin(req)) {
      return res.status(403).json({
        success: false,
        error: { code: 'FORBIDDEN', message: 'Admin role required' },
      });
    }

    // Delete in FK order: zones → calibration runs → bootstrap jobs → corpus documents
    const [deletedZones, deletedRuns, deletedJobs, deletedDocs] = await prisma.$transaction([
      prisma.zone.deleteMany({
        where: { calibrationRunId: { not: null } },
      }),
      prisma.calibrationRun.deleteMany({}),
      prisma.zoneBootstrapJob.deleteMany({}),
      prisma.corpusDocument.deleteMany({}),
    ]);

    logger.info(
      `[CorpusReset] Admin reset: ${deletedDocs.count} docs, ${deletedRuns.count} runs, ${deletedJobs.count} jobs, ${deletedZones.count} zones deleted`,
    );

    return res.json({
      success: true,
      data: {
        deletedDocuments: deletedDocs.count,
        deletedCalibrationRuns: deletedRuns.count,
        deletedBootstrapJobs: deletedJobs.count,
        deletedZones: deletedZones.count,
      },
    });
  } catch (err) {
    logger.error('POST /admin/corpus/reset error:', err);
    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: (err as Error).message },
    });
  }
});

export default router;
