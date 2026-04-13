import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { annotationReportController } from '../controllers/annotation-report.controller';

const router = Router();

router.use(authenticate);

// Corpus-level (static routes before parameterized). Order matters — more
// specific export paths must come before their parent summary routes so the
// router matches them first.
router.get(
  '/corpus/lineage-summary/export/csv',
  annotationReportController.exportCorpusLineageCsv.bind(annotationReportController),
);
router.get(
  '/corpus/timesheet-summary/export/per-operator-csv',
  annotationReportController.exportCorpusTimesheetPerOperatorCsv.bind(annotationReportController),
);
router.get(
  '/corpus/timesheet-summary/export/per-title-csv',
  annotationReportController.exportCorpusTimesheetPerTitleCsv.bind(annotationReportController),
);
router.get(
  '/corpus/timesheet-summary/export/pdf',
  annotationReportController.exportCorpusTimesheetPdf.bind(annotationReportController),
);
router.get(
  '/corpus/lineage-summary',
  annotationReportController.getCorpusLineageSummary.bind(annotationReportController),
);
router.get(
  '/corpus/timesheet-summary',
  annotationReportController.getCorpusTimesheetSummary.bind(annotationReportController),
);
router.get('/corpus/analysis-summary', annotationReportController.getCorpusSummary.bind(annotationReportController));

// Annotation analysis
router.post('/runs/:runId/complete', annotationReportController.markAnnotationComplete.bind(annotationReportController));
router.get('/runs/:runId/analysis', annotationReportController.getAnalysis.bind(annotationReportController));

// Annotation report
router.get('/runs/:runId/annotation-report/export/csv', annotationReportController.exportAnnotationCsv.bind(annotationReportController));
router.get('/runs/:runId/annotation-report/export/lineage-csv', annotationReportController.exportLineageCsv.bind(annotationReportController));
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
