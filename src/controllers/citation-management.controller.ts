/**
 * Citation Management Controller
 *
 * @deprecated This file is deprecated. Use modular controllers instead:
 * - src/controllers/citation/citation-upload.controller.ts
 * - src/controllers/citation/citation-reference.controller.ts
 * - src/controllers/citation/citation-style.controller.ts
 * - src/controllers/citation/citation-export.controller.ts
 *
 * Or import the unified facade from src/controllers/citation/index.ts
 */

// Re-export from modular controllers for backwards compatibility
export {
  citationManagementController,
  CitationManagementController,
  CitationUploadController,
  CitationReferenceController,
  CitationStyleController,
  CitationExportController,
  citationUploadController,
  citationReferenceController,
  citationStyleController,
  citationExportController,
} from './citation';
