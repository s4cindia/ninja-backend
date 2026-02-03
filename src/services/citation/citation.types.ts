/**
 * Citation Management Type Definitions
 * US-4.1: Citation Detection
 * US-4.2: Citation Parsing
 */

import { CitationType, CitationStyle, SourceType } from '@prisma/client';

// ============================================
// DETECTION TYPES (US-4.1)
// ============================================

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
  // Parsing status fields
  primaryComponentId: string | null;  // Set when parsed
  isParsed: boolean;                  // Convenience flag
  parseConfidence: number | null;     // Component confidence when parsed
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
  // Enhanced fields for frontend updates
  averageConfidence: number;        // Average confidence across all parsed citations (0-1)
  message: string;                  // Completion status message
  stats: {
    total: number;
    parsed: number;
    unparsed: number;
    byType: Record<string, number>;
    byStyle: Record<string, number>;
  };
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
  parenthetical: 'PARENTHETICAL',
  narrative: 'NARRATIVE',
  footnote: 'FOOTNOTE',
  endnote: 'ENDNOTE',
  numeric: 'NUMERIC',
  reference: 'REFERENCE',
  // Fallback handled in code
};

/** Map AI response section context string to Prisma SectionContext enum */
export const SECTION_CONTEXT_MAP: Record<string, string> = {
  body: 'BODY',
  references: 'REFERENCES',
  bibliography: 'REFERENCES',
  footnotes: 'FOOTNOTES',
  endnotes: 'ENDNOTES',
  abstract: 'ABSTRACT',
  // Fallback handled in code
};

/** Safely map string to SectionContext with fallback */
export function mapToSectionContext(value: string | undefined | null): string {
  if (!value) return 'UNKNOWN';
  const normalized = value.toLowerCase().trim();
  return SECTION_CONTEXT_MAP[normalized] || 'UNKNOWN';
}

/** Map AI response style string to Prisma CitationStyle enum */
export const CITATION_STYLE_MAP: Record<string, CitationStyle> = {
  APA: 'APA',
  apa: 'APA',
  MLA: 'MLA',
  mla: 'MLA',
  Chicago: 'CHICAGO',
  chicago: 'CHICAGO',
  CMOS: 'CHICAGO',
  Vancouver: 'VANCOUVER',
  vancouver: 'VANCOUVER',
  Harvard: 'HARVARD',
  harvard: 'HARVARD',
  IEEE: 'IEEE',
  ieee: 'IEEE',
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
