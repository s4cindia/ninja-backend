/**
 * Citation Services - Central Exports
 * US-4.1: Citation Detection
 * US-4.2: Citation Parsing
 */

// Services
export { citationDetectionService } from './citation-detection.service';
export { citationParsingService } from './citation-parsing.service';
export { CitationValidationService, createCitationValidationService } from './citation-validation.service';

// Controller
export { citationController } from './citation.controller';

// Types
export * from './citation.types';

// Schemas
export * from './citation.schemas';
