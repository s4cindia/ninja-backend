import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { pdfController } from '../controllers/pdf.controller';

const router = Router();

router.post('/parse', authenticate, (req, res, next) => pdfController.parse(req, res, next));
router.post('/metadata', authenticate, (req, res, next) => pdfController.getMetadata(req, res, next));
router.post('/validate-basics', authenticate, (req, res, next) => pdfController.validateBasics(req, res, next));

router.post('/extract-text', authenticate, (req, res, next) => pdfController.extractText(req, res, next));
router.post('/extract-page/:pageNumber', authenticate, (req, res, next) => pdfController.extractPage(req, res, next));
router.post('/text-stats', authenticate, (req, res, next) => pdfController.getTextStats(req, res, next));

router.post('/extract-images', authenticate, (req, res, next) => pdfController.extractImages(req, res, next));
router.post('/image/:imageId', authenticate, (req, res, next) => pdfController.getImageById(req, res, next));
router.post('/image-stats', authenticate, (req, res, next) => pdfController.getImageStats(req, res, next));

router.post('/analyze-structure', authenticate, (req, res, next) => pdfController.analyzeStructure(req, res, next));
router.post('/analyze-headings', authenticate, (req, res, next) => pdfController.analyzeHeadings(req, res, next));
router.post('/analyze-tables', authenticate, (req, res, next) => pdfController.analyzeTables(req, res, next));
router.post('/analyze-links', authenticate, (req, res, next) => pdfController.analyzeLinks(req, res, next));

export default router;
