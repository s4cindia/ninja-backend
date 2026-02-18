/**
 * Citation Controllers Module
 *
 * Modular controllers for citation management following SRP:
 * - citation-upload.controller.ts: Document upload, analysis, and job status
 * - citation-reference.controller.ts: Reference CRUD operations
 * - citation-style.controller.ts: Style conversion and DOI validation
 * - citation-export.controller.ts: Export and preview operations
 */

// Export individual modular controllers
export { CitationUploadController, citationUploadController } from './citation-upload.controller';
export { CitationReferenceController, citationReferenceController } from './citation-reference.controller';
export { CitationStyleController, citationStyleController } from './citation-style.controller';
export { CitationExportController, citationExportController } from './citation-export.controller';

// Import controllers for unified facade
import { citationUploadController } from './citation-upload.controller';
import { citationReferenceController } from './citation-reference.controller';
import { citationStyleController } from './citation-style.controller';
import { citationExportController } from './citation-export.controller';

/**
 * Unified controller facade for backwards compatibility
 * Routes can use this single instance or the individual controllers
 */
export const citationManagementController = {
  // Upload & Analysis (citation-upload.controller)
  // Presigned S3 upload (preferred pattern)
  presignUpload: citationUploadController.presignUpload.bind(citationUploadController),
  confirmUpload: citationUploadController.confirmUpload.bind(citationUploadController),
  // Legacy in-memory upload (deprecated)
  upload: citationUploadController.upload.bind(citationUploadController),
  getJobStatus: citationUploadController.getJobStatus.bind(citationUploadController),
  getRecentJobs: citationUploadController.getRecentJobs.bind(citationUploadController),
  getAnalysis: citationUploadController.getAnalysis.bind(citationUploadController),
  reanalyze: citationUploadController.reanalyze.bind(citationUploadController),
  analyzeDocument: citationUploadController.analyzeDocument.bind(citationUploadController),

  // Reference Management (citation-reference.controller)
  reorderReferences: citationReferenceController.reorderReferences.bind(citationReferenceController),
  deleteReference: citationReferenceController.deleteReference.bind(citationReferenceController),
  editReference: citationReferenceController.editReference.bind(citationReferenceController),
  resetChanges: citationReferenceController.resetChanges.bind(citationReferenceController),
  createCitationLinks: citationReferenceController.createCitationLinks.bind(citationReferenceController),
  resequenceByAppearance: citationReferenceController.resequenceByAppearance.bind(citationReferenceController),

  // Style & DOI (citation-style.controller)
  convertStyle: citationStyleController.convertStyle.bind(citationStyleController),
  validateDOIs: citationStyleController.validateDOIs.bind(citationStyleController),
  getStyles: citationStyleController.getStyles.bind(citationStyleController),

  // Export & Preview (citation-export.controller)
  previewChanges: citationExportController.previewChanges.bind(citationExportController),
  exportDocument: citationExportController.exportDocument.bind(citationExportController),
  exportDebug: citationExportController.exportDebug.bind(citationExportController),
  debugStyleConversion: citationExportController.debugStyleConversion.bind(citationExportController),
};

// Type for the unified controller
export type CitationManagementController = typeof citationManagementController;
