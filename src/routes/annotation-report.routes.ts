import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { annotationReportController } from '../controllers/annotation-report.controller';

const router = Router();

router.use(authenticate);

// Annotation report
router.get('/runs/:runId/annotation-report/export/csv', annotationReportController.exportAnnotationCsv.bind(annotationReportController));
router.get('/runs/:runId/annotation-report/export/pdf', annotationReportController.exportAnnotationPdf.bind(annotationReportController));
router.get('/runs/:runId/annotation-report', annotationReportController.getAnnotationReport.bind(annotationReportController));

// Timesheet report
router.get('/runs/:runId/timesheet-report/export/csv', annotationReportController.exportTimesheetCsv.bind(annotationReportController));
router.get('/runs/:runId/timesheet-report/export/pdf', annotationReportController.exportTimesheetPdf.bind(annotationReportController));
router.get('/runs/:runId/timesheet-report', annotationReportController.getTimesheetReport.bind(annotationReportController));

// Session tracking
router.post('/runs/:runId/sessions/start', annotationReportController.startSession.bind(annotationReportController));
router.post('/runs/:runId/sessions/:sessionId/end', annotationReportController.endSession.bind(annotationReportController));

export default router;
