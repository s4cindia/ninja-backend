import { Router } from 'express';
import { accessibilityController } from '../controllers/accessibility.controller';
import { authenticate } from '../middleware/auth.middleware';

const router = Router();

router.post(
  '/validate/structure',
  authenticate,
  accessibilityController.validateStructure.bind(accessibilityController)
);

router.post(
  '/validate/headings',
  authenticate,
  accessibilityController.validateHeadings.bind(accessibilityController)
);

router.post(
  '/validate/reading-order',
  authenticate,
  accessibilityController.validateReadingOrder.bind(accessibilityController)
);

router.post(
  '/validate/language',
  authenticate,
  accessibilityController.validateLanguage.bind(accessibilityController)
);

router.post(
  '/validate/alt-text',
  authenticate,
  accessibilityController.validateAltText.bind(accessibilityController)
);

router.post(
  '/validate/contrast',
  authenticate,
  accessibilityController.validateContrast.bind(accessibilityController)
);

router.post(
  '/validate/tables',
  authenticate,
  accessibilityController.validateTables.bind(accessibilityController)
);

router.post(
  '/validate/pdfua',
  authenticate,
  accessibilityController.validatePdfUa.bind(accessibilityController)
);

export default router;
