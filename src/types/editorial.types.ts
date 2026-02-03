/**
 * Editorial Services Type Definitions
 * Used by Plagiarism Detection, Citation Management, and Style Validation
 */

/** Text chunk for embedding generation */
export interface TextChunk {
  id: string;
  text: string;
  startOffset: number;
  endOffset: number;
  pageNumber?: number;
  paragraphIndex?: number;
}

/** Embedding result with vector */
export interface EmbeddingResult {
  chunkId: string;
  vector: number[] | null;  // 768-dimensional, null if failed
  tokenCount: number;
  success?: boolean;  // false if embedding generation failed
}

/** Classification categories for plagiarism */
export type PlagiarismClassification = 
  | 'VERBATIM_COPY' 
  | 'PARAPHRASED' 
  | 'COMMON_PHRASE' 
  | 'PROPERLY_CITED' 
  | 'COINCIDENTAL';

/** Classification result with reasoning */
export interface ClassificationResult {
  classification: PlagiarismClassification;
  confidence: number;  // 0-100
  reasoning: string;
}

/** Citation extraction result */
export interface ExtractedCitation {
  text: string;
  type: 'parenthetical' | 'narrative' | 'footnote' | 'endnote' | 'numeric' | 'reference';
  style: 'APA' | 'MLA' | 'Chicago' | 'Vancouver' | 'unknown';
  sectionContext: 'body' | 'references' | 'footnotes' | 'endnotes' | 'abstract' | 'unknown';
  location: {
    pageNumber?: number;
    paragraphIndex: number;
    startOffset: number;
    endOffset: number;
  };
  confidence: number;
}

/** Parsed citation components */
export interface ParsedCitation {
  authors: string[];
  year?: string;
  title?: string;
  source?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  url?: string;
  type: 'journal' | 'book' | 'chapter' | 'website' | 'conference' | 'unknown';
  confidence: Record<string, number>;  // Confidence per field
  rawText: string;
}

/** Style violation */
export interface StyleViolation {
  rule: string;
  ruleReference: string;  // e.g., "CMOS 6.28"
  location: { start: number; end: number };
  originalText: string;
  suggestedFix: string;
  severity: 'error' | 'warning' | 'suggestion';
}

/** Paraphrase detection result */
export interface ParaphraseResult {
  isParaphrase: boolean;
  confidence: number;
  matchedPhrases: Array<{ original: string; paraphrased: string }>;
  explanation: string;
}

/** Extracted style rules from document */
export interface ExtractedStyleRules {
  explicitRules: string[];
  preferences: Array<{ preferred: string; avoid: string }>;
  terminology: Array<{ use: string; instead: string }>;
}
