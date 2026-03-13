import { Router, Request, Response } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { zoneService } from '../services/zone.service';

const router = Router();

// GET /api/v1/zones?fileId=xxx&pages=1,2,3
router.get('/', authenticate, async (req: Request, res: Response) => {
  try {
    const { fileId, pages } = req.query;
    const tenantId = req.user!.tenantId;

    if (!fileId || typeof fileId !== 'string') {
      return res.status(400).json({ success: false, error: { code: 'MISSING_FILE_ID', message: 'fileId query parameter is required' } });
    }

    const pageNumbers = pages && typeof pages === 'string'
      ? pages.split(',').map(Number).filter((n) => !isNaN(n))
      : undefined;

    const zones = await zoneService.getZones(fileId, tenantId, pageNumbers);
    return res.json({ success: true, data: zones });
  } catch (err) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: (err as Error).message } });
  }
});

// POST /api/v1/zones
router.post('/', authenticate, async (req: Request, res: Response) => {
  try {
    const { fileId, pageNumber, type, bounds, label, readingOrder, content, altText, longDesc } = req.body;
    const tenantId = req.user!.tenantId;

    if (!fileId || pageNumber == null || !type) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'fileId, pageNumber, and type are required' } });
    }

    if (type === 'TABLE') {
      const zone = await zoneService.createTableZone(fileId, tenantId, pageNumber, bounds);
      return res.status(201).json({ success: true, data: zone });
    }

    const zone = await zoneService.createZone({
      fileId,
      tenantId,
      pageNumber,
      type,
      bounds,
      label,
      readingOrder,
      content,
      altText,
      longDesc,
    });
    return res.status(201).json({ success: true, data: zone });
  } catch (err) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: (err as Error).message } });
  }
});

// PATCH /api/v1/zones/:id
router.patch('/:id', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user!.tenantId;
    const allowedFields = ['type', 'label', 'readingOrder', 'content', 'altText', 'longDesc', 'tableStructure', 'bounds'];
    const data: Record<string, unknown> = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        data[field] = req.body[field];
      }
    }

    const zone = await zoneService.updateZone(id, tenantId, data);
    return res.json({ success: true, data: zone });
  } catch (err) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: (err as Error).message } });
  }
});

// POST /api/v1/zones/:id/table-structure
router.post('/:id/table-structure', authenticate, async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const tenantId = req.user!.tenantId;
    const { thead, tbody } = req.body;
    if (!thead || !tbody) {
      return res.status(400).json({ success: false, error: { code: 'MISSING_FIELDS', message: 'thead and tbody are required' } });
    }

    const zone = await zoneService.updateTableStructure(id, tenantId, thead, tbody);
    return res.json({ success: true, data: zone });
  } catch (err) {
    return res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: (err as Error).message } });
  }
});

export default router;
