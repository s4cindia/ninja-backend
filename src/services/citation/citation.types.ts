/**
 * Citation Management Type Definitions
 * US-4.1: Citation Detection
 * US-4.2: Citation Parsing
 */

import { CitationType, CitationStyle, SourceType } from '@prisma/client';

// ============================================
// DETECTION TYPES (US-4.1)
// ============================================

/** Section context for citations */
export type SectionContext = 'BODY' | 'REFERENCES' | 'FOOTNOTES' | 'ENDNOTES' | 'ABSTRACT' | 'UNKNOWN';

/** Single detected citation from document */
export interface DetectedCitation {
  id: string;
  rawText: string;
  citationType: CitationType;
  detectedStyle: CitationStyle | null;
  pageNumber: number | null;
  paragraphIndex: number | null;
  startOffset: number;
  endOffset: number;
  confidence: number; // 0-1 normalized
  sectionContext?: SectionContext;
  primaryComponentId?: string | null;
  isParsed?: boolean;
  parseConfidence?: number | null;
}

/** Detection result summary for a document */
export interface DetectionResult {
  documentId: string;
  jobId: string;
  citations: DetectedCitation[];
  totalCount: number;
  byType: Record<string, number>;
  byStyle: Record<string, number>;
  processingTimeMs: number;
}

/** Input for detection operation */
export interface DetectionInput {
  jobId: string;
  tenantId: string;
  userId: string;
  fileName: string;
  fileSize?: number;
  fileS3Key?: string;
  presignedUrl?: string;
}

// ============================================
// PARSING TYPES (US-4.2)
// ============================================

/** Parsed citation component with all extracted fields */
export interface ParsedCitationResult {
  citationId: string;
  componentId: string;
  parseVariant: string | null;   // Which style was used to parse (e.g., "APA", "MLA")
  confidence: number;            // Overall parse confidence (0-1)
  authors: string[];
  year: string | null;
  title: string | null;
  source: string | null;
  volume: string | null;
  issue: string | null;
  pages: string | null;
  doi: string | null;
  url: string | null;
  publisher: string | null;
  edition: string | null;
  accessDate: string | null;
  sourceType: SourceType | null;
  fieldConfidence: Record<string, number>;
  // Validation fields
  doiVerified: boolean | null;
  urlValid: boolean | null;
  urlCheckedAt: Date | null;
  // AC-26: Explicit flag for ambiguous/incomplete citations
  needsReview: boolean;          // True if citation is ambiguous or incomplete
  reviewReasons: string[];       // Reasons why review is needed
  createdAt: Date;
}

/** Reasons for flagging a citation as needing review (AC-26) */
export const REVIEW_REASONS = {
  LOW_OVERALL_CONFIDENCE: 'Overall parse confidence below 70%',
  LOW_FIELD_CONFIDENCE: 'One or more fields have confidence below 50%',
  MISSING_AUTHORS: 'No authors could be extracted',
  MISSING_YEAR: 'Publication year could not be determined',
  MISSING_TITLE: 'Title could not be extracted',
  AMBIGUOUS_TYPE: 'Source type could not be determined',
  INVALID_DOI: 'DOI format appears invalid',
  INVALID_URL: 'URL format appears invalid',
} as const;

/** Bulk parse operation result */
export interface BulkParseResult {
  documentId: string;
  totalCitations: number;
  parsed: number;
  skipped: number; // Already had components
  failed: number;
  results: ParsedCitationResult[];
  errors: Array<{ citationId: string; error: string }>;
  processingTimeMs: number;
}

/** Citation with its primary/latest parsed component */
export interface CitationWithComponent {
  id: string;
  documentId: string;
  rawText: string;
  citationType: CitationType;
  detectedStyle: CitationStyle | null;
  confidence: number;
  pageNumber: number | null;
  paragraphIndex: number | null;
  startOffset: number;
  endOffset: number;
  isValid: boolean | null;
  validationErrors: string[];
  createdAt: Date;
  // Primary component pattern (from schema)
  primaryComponentId: string | null;
  primaryComponent: ParsedCitationResult | null;
  componentCount: number;
  // AC-26: Aggregated review status from primary component
  needsReview: boolean;
}

// ============================================
// ENUM MAPPING CONSTANTS
// ============================================

/** Map AI response type string to Prisma CitationType enum */
export const CITATION_TYPE_MAP: Record<string, CitationType> = {
  // Lowercase variants
  parenthetical: 'PARENTHETICAL',
  narrative: 'NARRATIVE',
  footnote: 'FOOTNOTE',
  endnote: 'ENDNOTE',
  numeric: 'NUMERIC',
  // Uppercase variants (for direct lookups without normalization)
  PARENTHETICAL: 'PARENTHETICAL',
  NARRATIVE: 'NARRATIVE',
  FOOTNOTE: 'FOOTNOTE',
  ENDNOTE: 'ENDNOTE',
  NUMERIC: 'NUMERIC',
  // Title case variants (common in AI responses)
  Parenthetical: 'PARENTHETICAL',
  Narrative: 'NARRATIVE',
  Footnote: 'FOOTNOTE',
  Endnote: 'ENDNOTE',
  Numeric: 'NUMERIC',
  // Fallback handled in code
};

/** Map AI response style string to Prisma CitationStyle enum */
export const CITATION_STYLE_MAP: Record<string, CitationStyle> = {
  // Uppercase variants
  APA: 'APA',
  MLA: 'MLA',
  CHICAGO: 'CHICAGO',
  VANCOUVER: 'VANCOUVER',
  HARVARD: 'HARVARD',
  IEEE: 'IEEE',
  // Lowercase variants
  apa: 'APA',
  mla: 'MLA',
  chicago: 'CHICAGO',
  vancouver: 'VANCOUVER',
  harvard: 'HARVARD',
  ieee: 'IEEE',
  // Title case variants
  Chicago: 'CHICAGO',
  Vancouver: 'VANCOUVER',
  Harvard: 'HARVARD',
  // Aliases
  CMOS: 'CHICAGO',
  cmos: 'CHICAGO',
  // Fallback handled in code
};

/** Map AI response source type to Prisma SourceType enum */
export const SOURCE_TYPE_MAP: Record<string, SourceType> = {
  journal: 'JOURNAL_ARTICLE',
  'journal article': 'JOURNAL_ARTICLE',
  'journal-article': 'JOURNAL_ARTICLE',
  book: 'BOOK',
  chapter: 'BOOK_CHAPTER',
  'book chapter': 'BOOK_CHAPTER',
  'book-chapter': 'BOOK_CHAPTER',
  conference: 'CONFERENCE_PAPER',
  'conference paper': 'CONFERENCE_PAPER',
  website: 'WEBSITE',
  web: 'WEBSITE',
  thesis: 'THESIS',
  dissertation: 'THESIS',
  report: 'REPORT',
  newspaper: 'NEWSPAPER',
  magazine: 'MAGAZINE',
  patent: 'PATENT',
  legal: 'LEGAL',
  'personal communication': 'PERSONAL_COMMUNICATION',
  // Fallback handled in code
};

// ============================================
// HELPER FUNCTIONS
// ============================================

/** Safely map string to CitationType with fallback */
export function mapToCitationType(value: string | undefined | null): CitationType {
  if (!value) return 'UNKNOWN';
  const normalized = value.toLowerCase().trim();
  return CITATION_TYPE_MAP[normalized] || 'UNKNOWN';
}

/** Safely map string to CitationStyle with fallback */
export function mapToCitationStyle(value: string | undefined | null): CitationStyle | null {
  if (!value || value.toLowerCase() === 'unknown') return null;
  return CITATION_STYLE_MAP[value] || CITATION_STYLE_MAP[value.toLowerCase()] || null;
}

/** Safely map string to SourceType with fallback */
export function mapToSourceType(value: string | undefined | null): SourceType | null {
  if (!value || value.toLowerCase() === 'unknown') return null;
  const normalized = value.toLowerCase().trim();
  return SOURCE_TYPE_MAP[normalized] || null;
}

// ============================================
// STYLESHEET DETECTION TYPES
// Note: Using 'any' to accommodate varying service implementations
// TODO: Define strict types once service implementations are standardized
// ============================================

import { SectionContext as PrismaSectionContext } from '@prisma/client';
export { PrismaSectionContext };

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Analysis result for stylesheet detection - flexible type for varying implementations */
export type StylesheetAnalysisResult = any;

/** Sequence analysis for citation ordering */
export type SequenceAnalysis = any;

/** Cross-reference analysis between citations and references */
export type CrossReferenceAnalysis = any;

/** Summary entry for reference list analysis */
export type ReferenceListSummaryEntry = any;

/* eslint-enable @typescript-eslint/no-explicit-any */

/** Map string to SectionContext enum */
export function mapToSectionContext(value: string | undefined | null): SectionContext {
  if (!value) return 'UNKNOWN';
  const normalized = value.toUpperCase().trim();
  const contextMap: Record<string, SectionContext> = {
    'BODY': 'BODY',
    'REFERENCES': 'REFERENCES',
    'FOOTNOTES': 'FOOTNOTES',
    'ENDNOTES': 'ENDNOTES',
    'ABSTRACT': 'ABSTRACT',
    'UNKNOWN': 'UNKNOWN',
    // Map common section names to BODY
    'INTRODUCTION': 'BODY',
    'METHODS': 'BODY',
    'RESULTS': 'BODY',
    'DISCUSSION': 'BODY',
    'CONCLUSION': 'BODY',
    'APPENDIX': 'BODY',
  };
  return contextMap[normalized] || 'UNKNOWN';
}
