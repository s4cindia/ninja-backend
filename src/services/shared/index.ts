/**
 * Shared Services Index
 * Central export for all shared Editorial services and types
 */

// Services
export { EditorialAiClient, editorialAi } from './editorial-ai-client';
export { DocumentParser, documentParser } from './document-parser';
export { ReportGenerator, reportGenerator } from './report-generator';

// Citation services (owned by Dev2)
export { CitationValidationService, createCitationValidationService } from '../citation/citation-validation.service';

// Types from editorial.types.ts (shared type definitions)
export type {
  TextChunk,
  EmbeddingResult,
  PlagiarismClassification,
  ClassificationResult,
  ExtractedCitation,
  ParsedCitation,
  StyleViolation,
  ParaphraseResult,
  ExtractedStyleRules,
} from '../../types/editorial.types';

// Types from document-parser
export type {
  ParsedDocument,
  DocumentMetadata,
  DocumentStructure,
} from './document-parser';

// Types from report-generator
export type {
  ValidationIssue,
  ReportConfig,
  GeneratedReport,
  ReportSummary,
} from './report-generator';
