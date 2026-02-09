/**
 * PDF Validators
 *
 * Export all PDF validators for accessibility compliance checking.
 */

export { pdfStructureValidator } from './pdf-structure.validator';
export type { StructureValidationResult } from './pdf-structure.validator';

export { pdfAltTextValidator } from './pdf-alttext.validator';
export type { AltTextValidationResult } from './pdf-alttext.validator';

export { pdfTableValidator } from './pdf-table.validator';
export type { TableValidationResult } from './pdf-table.validator';
