import { Router, Request, Response } from 'express';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.middleware';
import { detectZones } from '../services/zone-extractor/zone-extractor.service';

const router = Router();

const detectBodySchema = z.object({
  pdfPath: z.string().min(1),
  bootstrapJobId: z.string().min(1),
  fileId: z.string().min(1),
  // Detection source: 'docling' (default) or 'yolo' (the fine-tuned zone
  // detector). The yolo service is scale-to-zero — bring it up before use.
  mode: z.enum(['docling', 'yolo']).optional(),
});

// POST /api/v1/zone-extractor/detect
router.post('/detect', authenticate, async (req: Request, res: Response) => {
  try {
    const parsed = detectBodySchema.safeParse(req.body);
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

    const { pdfPath, bootstrapJobId, fileId, mode } = parsed.data;
    const tenantId = req.user!.tenantId;

    const zones = await detectZones(pdfPath, bootstrapJobId, tenantId, fileId, mode);
    return res.json({ success: true, data: zones });
  } catch (err) {
    const message = (err as Error).message ?? '';

    if (message.includes('DOCLING_TIMEOUT')) {
      return res.status(503).json({
        success: false,
        error: { code: 'DOCLING_TIMEOUT', message },
      });
    }
    if (message.includes('DOCLING_SERVICE_ERROR')) {
      return res.status(503).json({
        success: false,
        error: { code: 'DOCLING_UNAVAILABLE', message },
      });
    }
    if (message.includes('DOCLING_CLIENT_ERROR')) {
      return res.status(422).json({
        success: false,
        error: { code: 'DOCLING_CLIENT_ERROR', details: message },
      });
    }

    if (message.includes('YOLO_TIMEOUT')) {
      return res.status(503).json({
        success: false,
        error: { code: 'YOLO_TIMEOUT', message },
      });
    }
    if (message.includes('YOLO_SERVICE_ERROR')) {
      return res.status(503).json({
        success: false,
        error: { code: 'YOLO_UNAVAILABLE', message },
      });
    }
    if (message.includes('YOLO_CLIENT_ERROR')) {
      return res.status(422).json({
        success: false,
        error: { code: 'YOLO_CLIENT_ERROR', details: message },
      });
    }

    return res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'An unexpected error occurred' },
    });
  }
});

export default router;
