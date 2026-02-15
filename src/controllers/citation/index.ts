/**
 * Citation Controllers Module
 *
 * This module provides a modular structure for citation management.
 * For backwards compatibility, it re-exports the original monolithic controller.
 *
 * Modular controllers (for incremental migration):
 * - citation-upload.controller.ts: Document upload and analysis
 * - citation-reference.controller.ts: Reference CRUD operations
 * - citation-style.controller.ts: Style conversion and DOI validation
 * - citation-export.controller.ts: Export and preview operations
 *
 * TODO: Once all type issues are resolved, switch to modular controllers:
 * export { CitationUploadController, citationUploadController } from './citation-upload.controller';
 * export { CitationReferenceController, citationReferenceController } from './citation-reference.controller';
 * export { CitationStyleController, citationStyleController } from './citation-style.controller';
 * export { CitationExportController, citationExportController } from './citation-export.controller';
 */

// Re-export original controller for backwards compatibility
export { CitationManagementController, citationManagementController } from '../citation-management.controller';

// Type definitions for modular controllers (for documentation/planning)
export interface CitationControllerModules {
  upload: 'citation-upload.controller';
  reference: 'citation-reference.controller';
  style: 'citation-style.controller';
  export: 'citation-export.controller';
}
