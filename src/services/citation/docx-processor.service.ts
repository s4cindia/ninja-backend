/**
 * DOCX Processor Service
 * Handles DOCX parsing and modification while preserving formatting
 * Supports Track Changes for showing modifications
 *
 * Memory Management:
 * - Files <= 5MB: Process in memory (fast path)
 * - Files > 5MB: Use disk-based processing with temp files
 * - Circuit breaker: Check available memory before processing
 */

import * as mammoth from 'mammoth';
import * as JSZip from 'jszip';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import { logger } from '../../lib/logger';
import { AppError } from '../../utils/app-error';
import { memoryConfig, getMemoryUsage, isMemorySafeForSize } from '../../config/memory.config';
import { withMemoryTracking, FileTooLargeError } from '../../utils/memory-safe-processor';
import { normalizeSuperscripts } from '../../utils/unicode';
// InTextCitation type reserved for future use
import { referenceStyleUpdaterService } from './reference-style-updater.service';

// Mammoth style map for academic/journal DOCX files
// Maps custom Word styles (used by publishers like Mattioli, Elsevier, etc.) to semantic HTML
const MAMMOTH_STYLE_MAP = [
  // === Paragraph styles ===
  // Article structure
  "p[style-name='AT'] => h1:fresh",
  "p[style-name='Title'] => h1.title:fresh",
  "p[style-name='H1'] => h2:fresh",
  "p[style-name='AH'] => h2:fresh",
  "p[style-name='BH'] => h3:fresh",
  "p[style-name='CH'] => h4:fresh",
  "p[style-name='REFH'] => h3:fresh",
  "p[style-name='Heading 1'] => h1:fresh",
  "p[style-name='Heading 2'] => h2:fresh",
  "p[style-name='Heading 3'] => h3:fresh",
  "p[style-name='Heading 4'] => h4:fresh",
  // Metadata
  "p[style-name='NMP'] => p.journal-meta:fresh",
  "p[style-name='AN'] => p.article-note:fresh",
  "p[style-name='AAU'] => p.authors:fresh",
  "p[style-name='AAFF'] => p.affiliations:fresh",
  "p[style-name='ABS'] => p.abstract:fresh",
  "p[style-name='Abstract'] => p.abstract:fresh",
  "p[style-name='KW'] => p.keywords:fresh",
  // Body text
  "p[style-name='TX'] => p:fresh",
  "p[style-name='TXL'] => p:fresh",
  "p[style-name='BP'] => p:fresh",
  "p[style-name='FP'] => p:fresh",
  // References
  "p[style-name='REF'] => p.reference:fresh",
  "p[style-name='NR'] => p.reference:fresh",
  // Figures / captions
  "p[style-name='FIG'] => p.figure:fresh",
  "p[style-name='FGC'] => p.figure-caption:fresh",
  "p[style-name='FC'] => p.figure-caption:fresh",
  // Other academic sections
  "p[style-name='COI'] => p:fresh",
  "p[style-name='ADR'] => p:fresh",
  "p[style-name='ADRF'] => p:fresh",
  // === Run (character) styles ===
  "r[style-name='bold'] => strong",
  "r[style-name='italic'] => em",
  "r[style-name='superscript'] => sup",
  "r[style-name='italicsuperscript'] => sup",
  "r[style-name='bolditalic'] => strong",
  "r[style-name='FGN'] => strong",
  "r[style-name='FigureCitation'] => em",
  // Built-in formatting (mammoth defaults, listed explicitly for clarity)
  "b => strong",
  "i => em",
];

// Security constants for DOCX processing
// Aligned with memoryConfig for consistent limits
const SECURITY_LIMITS = {
  MAX_DOCX_SIZE: memoryConfig.maxUploadFileSize,  // 50MB max DOCX file size
  MAX_XML_SIZE: memoryConfig.maxXmlMemorySize,    // 10MB max XML content size
  MAX_ZIP_ENTRIES: 1000,                           // Max files in DOCX archive
  MAX_ELEMENT_DEPTH: 100,                          // Max XML nesting depth
  // Memory-safe processing threshold (files larger use disk-based processing)
  MEMORY_PROCESSING_LIMIT: memoryConfig.maxMemoryFileSize, // 5MB
};

/**
 * Per-tenant circuit breaker state for memory protection
 *
 * MULTI-TENANCY: Each tenant has its own circuit breaker to prevent
 * one tenant's failures from affecting others. System-wide memory checks
 * remain global since memory is a shared resource.
 */
interface TenantCircuitBreakerState {
  isOpen: boolean;
  openedAt: number;
  consecutiveFailures: number;
}

interface GlobalMemoryState {
  lastMemoryCheck: number;
}

// Per-tenant circuit breakers - isolated failure tracking
const tenantCircuitBreakers = new Map<string, TenantCircuitBreakerState>();

// Global memory state - shared resource check
const globalMemoryState: GlobalMemoryState = {
  lastMemoryCheck: 0,
};

// Circuit breaker settings
const CIRCUIT_BREAKER_THRESHOLD = 3;  // Failures before opening
const CIRCUIT_BREAKER_RESET_MS = 30000; // 30 seconds cooldown
const MEMORY_CHECK_INTERVAL_MS = 5000;  // Check memory every 5 seconds
const MAX_TENANT_BREAKERS = 10000; // Prevent unbounded growth

/**
 * Get or create circuit breaker state for a tenant
 * Uses LRU eviction: delete and re-add on access to maintain recency order
 */
function getTenantBreaker(tenantId: string): TenantCircuitBreakerState {
  let breaker = tenantCircuitBreakers.get(tenantId);
  if (breaker) {
    // LRU: Move to end by deleting and re-adding (most recently used)
    tenantCircuitBreakers.delete(tenantId);
    tenantCircuitBreakers.set(tenantId, breaker);
  } else {
    // Evict least recently used (first entry) if at capacity
    if (tenantCircuitBreakers.size >= MAX_TENANT_BREAKERS) {
      const firstKey = tenantCircuitBreakers.keys().next().value;
      if (firstKey) tenantCircuitBreakers.delete(firstKey);
    }
    breaker = { isOpen: false, openedAt: 0, consecutiveFailures: 0 };
    tenantCircuitBreakers.set(tenantId, breaker);
  }
  return breaker;
}

/**
 * Check if circuit breaker allows processing
 * @param fileSize - Size of file to process
 * @param tenantId - Tenant ID for per-tenant tracking (optional for backwards compatibility)
 */
function checkCircuitBreaker(fileSize: number, tenantId?: string): void {
  const now = Date.now();
  const effectiveTenantId = tenantId || '__global__';
  const breaker = getTenantBreaker(effectiveTenantId);

  // Reset tenant circuit breaker after cooldown
  if (breaker.isOpen && (now - breaker.openedAt) > CIRCUIT_BREAKER_RESET_MS) {
    logger.info(`[DOCX Processor] Circuit breaker reset for tenant ${effectiveTenantId}`);
    breaker.isOpen = false;
    breaker.consecutiveFailures = 0;
  }

  // Check if tenant circuit is open
  if (breaker.isOpen) {
    throw AppError.serviceUnavailable(
      'DOCX processing temporarily unavailable due to recent failures. Please retry in a few seconds.',
      'CIRCUIT_BREAKER_OPEN'
    );
  }

  // Periodic SYSTEM-WIDE memory check (memory is shared across tenants)
  if ((now - globalMemoryState.lastMemoryCheck) > MEMORY_CHECK_INTERVAL_MS) {
    globalMemoryState.lastMemoryCheck = now;
    const usage = getMemoryUsage();

    // Check if we have enough memory for this file
    if (!isMemorySafeForSize(fileSize)) {
      logger.warn('[DOCX Processor] Memory pressure detected', {
        fileSize,
        tenantId: effectiveTenantId,
        heapUsedMB: usage.heapUsedMB,
        heapTotalMB: usage.heapTotalMB
      });

      // For large files under memory pressure, reject immediately
      // but only affect THIS tenant's circuit breaker
      if (fileSize > SECURITY_LIMITS.MEMORY_PROCESSING_LIMIT) {
        breaker.consecutiveFailures++;

        if (breaker.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
          breaker.isOpen = true;
          breaker.openedAt = now;
          logger.error(`[DOCX Processor] Circuit breaker OPENED for tenant ${effectiveTenantId} due to memory pressure`);
        }

        throw AppError.serviceUnavailable(
          `Insufficient memory to process ${Math.round(fileSize / 1024 / 1024)}MB file. Current heap: ${usage.heapUsedMB}MB/${usage.heapTotalMB}MB`,
          'INSUFFICIENT_MEMORY'
        );
      }
    } else {
      // Reset failure count on successful memory check
      breaker.consecutiveFailures = 0;
    }
  }
}

/**
 * Record successful processing (resets circuit breaker failures)
 * @param tenantId - Tenant ID for per-tenant tracking
 */
function recordSuccess(tenantId?: string): void {
  const breaker = getTenantBreaker(tenantId || '__global__');
  breaker.consecutiveFailures = 0;
}

/**
 * Record processing failure
 * @param tenantId - Tenant ID for per-tenant tracking
 */
function recordFailure(tenantId?: string): void {
  const effectiveTenantId = tenantId || '__global__';
  const breaker = getTenantBreaker(effectiveTenantId);
  breaker.consecutiveFailures++;
  if (breaker.consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD) {
    breaker.isOpen = true;
    breaker.openedAt = Date.now();
    logger.error(`[DOCX Processor] Circuit breaker OPENED for tenant ${effectiveTenantId} due to consecutive failures`);
  }
}

/**
 * Reset circuit breaker state (for testing only)
 * @param tenantId - Specific tenant to reset, or undefined to reset all
 */
export function resetCircuitBreaker(tenantId?: string): void {
  if (tenantId) {
    tenantCircuitBreakers.delete(tenantId);
  } else {
    tenantCircuitBreakers.clear();
  }
  globalMemoryState.lastMemoryCheck = 0;
}

/**
 * Sanitize XML content to prevent XXE (XML External Entity) attacks
 * Removes DOCTYPE declarations, entity definitions, and external references
 */
function sanitizeXML(xml: string): string {
  if (!xml || typeof xml !== 'string') {
    return '';
  }

  // Remove DOCTYPE declarations (prevents XXE entity expansion)
  let sanitized = xml.replace(/<!DOCTYPE[^>]*>/gi, '');

  // Remove entity declarations (prevents entity expansion attacks)
  sanitized = sanitized.replace(/<!ENTITY[^>]*>/gi, '');

  // Remove processing instructions that could be malicious
  sanitized = sanitized.replace(/<\?xml-stylesheet[^?]*\?>/gi, '');

  // Remove SYSTEM and PUBLIC entity references
  sanitized = sanitized.replace(/SYSTEM\s+["'][^"']*["']/gi, '');
  sanitized = sanitized.replace(/PUBLIC\s+["'][^"']*["']\s+["'][^"']*["']/gi, '');

  // Remove parameter entity references
  sanitized = sanitized.replace(/%[a-zA-Z0-9_]+;/g, '');

  return sanitized;
}

/**
 * Validate DOCX structure for security
 * @param zip - JSZip instance (using any for type compatibility with JSZip versions)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validateDOCXStructure(zip: any): { valid: boolean; error?: string } {
  // Check required DOCX files exist
  const requiredFiles = ['word/document.xml', '[Content_Types].xml'];
  for (const file of requiredFiles) {
    if (!zip.file(file)) {
      return { valid: false, error: `Missing required file: ${file}` };
    }
  }

  // Check number of entries (prevent zip bomb)
  const entryCount = Object.keys(zip.files).length;
  if (entryCount > SECURITY_LIMITS.MAX_ZIP_ENTRIES) {
    return { valid: false, error: `Too many files in archive: ${entryCount} (max: ${SECURITY_LIMITS.MAX_ZIP_ENTRIES})` };
  }

  // Validate file paths (prevent path traversal)
  for (const path of Object.keys(zip.files)) {
    if (path.includes('..') || path.startsWith('/') || path.includes('://')) {
      return { valid: false, error: `Invalid file path detected: ${path}` };
    }
  }

  // Security: Check for macro-enabled content (VBA projects)
  // Macro-enabled files (.docm) contain vbaProject.bin which could be malicious
  const dangerousFiles = ['word/vbaProject.bin', 'vbaProject.bin', 'word/vbaData.xml'];
  for (const dangerousFile of dangerousFiles) {
    if (zip.file(dangerousFile)) {
      return { valid: false, error: 'Macro-enabled documents are not allowed for security reasons' };
    }
  }

  // Verify ZIP central directory exists (basic structural integrity)
  // A valid ZIP must have at least the required DOCX files we already checked

  return { valid: true };
}

/**
 * Temp file management for disk-based processing
 */
interface TempFileHandle {
  path: string;
  cleanup: () => Promise<void>;
}

/**
 * Create a temp file from a buffer for disk-based processing
 */
async function createTempFile(buffer: Buffer, prefix: string = 'docx-'): Promise<TempFileHandle> {
  const tempDir = os.tmpdir();
  const fileName = `${prefix}${Date.now()}-${Math.random().toString(36).substring(7)}.docx`;
  const filePath = path.join(tempDir, fileName);

  await fs.writeFile(filePath, buffer);

  return {
    path: filePath,
    cleanup: async () => {
      try {
        await fs.unlink(filePath);
        logger.debug(`[DOCX Processor] Cleaned up temp file: ${filePath}`);
      } catch {
        // Ignore cleanup errors - file may already be deleted
        logger.debug(`[DOCX Processor] Temp file cleanup skipped: ${filePath}`);
      }
    }
  };
}

/**
 * Determine if a file should use disk-based processing
 */
function shouldUseDiskProcessing(bufferSize: number): boolean {
  // Use disk processing for files larger than memory limit
  if (bufferSize > SECURITY_LIMITS.MEMORY_PROCESSING_LIMIT) {
    return true;
  }

  // Also use disk processing if memory is low
  if (!isMemorySafeForSize(bufferSize * 3)) { // 3x for processing overhead
    logger.info(`[DOCX Processor] Using disk processing due to memory pressure`);
    return true;
  }

  return false;
}

/**
 * Memory management constants for segment processing
 */
const SEGMENT_LIMITS = {
  // Maximum segments to process in a single pass (prevents OOM on huge documents)
  MAX_SEGMENTS_PER_PASS: 50000,
  // Maximum charToSegment array size (each entry is ~48 bytes on 64-bit)
  MAX_CHAR_MAP_SIZE: 500000,
  // Warn threshold for segment count
  SEGMENT_WARN_THRESHOLD: 20000,
};

/**
 * ReDoS-safe regex constants
 * Uses bounded quantifiers {0,N} instead of unbounded * to prevent catastrophic backtracking
 */
const REGEX_LIMITS = {
  // Maximum attribute length in XML tags (e.g., xml:space="preserve")
  MAX_ATTR_LENGTH: 500,
  // Maximum text content length in a single <w:t> tag
  MAX_TEXT_LENGTH: 10000,
  // Maximum tag content for complex patterns
  MAX_TAG_CONTENT: 5000,
};

/**
 * Create a fresh safe regex for text tag extraction
 * Returns a new RegExp instance to avoid shared state issues with global flag
 */
function createSafeTextTagRegex(): RegExp {
  return new RegExp(
    `<w:t([^>]{0,${REGEX_LIMITS.MAX_ATTR_LENGTH}})>([^<]{0,${REGEX_LIMITS.MAX_TEXT_LENGTH}})<\\/w:t>`,
    'g'
  );
}

/**
 * Safe regex execution with match limit to prevent infinite loops on malformed input
 */
function safeRegexExec(
  regex: RegExp,
  input: string,
  maxMatches: number = SEGMENT_LIMITS.MAX_SEGMENTS_PER_PASS
): RegExpExecArray[] {
  const results: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  let count = 0;

  // Reset regex state for global patterns
  regex.lastIndex = 0;

  while ((match = regex.exec(input)) !== null && count < maxMatches) {
    results.push(match);
    count++;

    // Prevent infinite loop on zero-width matches
    if (match.index === regex.lastIndex) {
      regex.lastIndex++;
    }
  }

  if (count >= maxMatches) {
    logger.warn(`[DOCX Processor] Regex match limit reached (${maxMatches})`);
  }

  return results;
}

/**
 * Safely extract text content from XML paragraph using bounded regex
 * Prevents ReDoS by limiting attribute and text content lengths
 */
function safeExtractParagraphText(paragraphXml: string, maxMatches: number = 1000): string {
  const regex = createSafeTextTagRegex();
  const matches = safeRegexExec(regex, paragraphXml, maxMatches);
  return matches.map(m => m[2] || '').join('').trim();
}

/**
 * Create a safe regex pattern for matching specific reference section headers
 * Uses bounded quantifiers to prevent ReDoS
 */
function createSafeHeaderRegex(headerText: string): RegExp {
  const escaped = headerText.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `<w:t[^>]{0,${REGEX_LIMITS.MAX_ATTR_LENGTH}}>${escaped}<\\/w:t>`,
    'i'
  );
}

/**
 * Cleanup JSZip instance to help garbage collection
 * JSZip holds references to buffers internally that need to be released
 * @param zip - JSZip instance to cleanup (using any for version compatibility)
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function cleanupZip(zip: any): void {
  if (!zip) return;

  try {
    // Clear internal file references
    if (zip.files) {
      for (const key of Object.keys(zip.files)) {
        const file = zip.files[key];
        if (file) {
          // Clear any cached data
          if (file._data) {
            file._data = null;
          }
        }
        delete zip.files[key];
      }
    }

    // Clear the root reference
    if (zip.root) {
      zip.root = null;
    }
  } catch {
    // Ignore cleanup errors - best effort only
    logger.debug('[DOCX Processor] JSZip cleanup completed (with some warnings)');
  }
}

export interface DOCXContent {
  text: string;
  html: string;
  rawBuffer: Buffer;
}

export interface CitationReplacement {
  citationId: string;
  oldText: string;
  newText: string;
  status?: 'changed' | 'orphaned';
}

export type CitationChangeType = 'renumber' | 'style_conversion' | 'orphaned';

export interface ReplacementSummary {
  totalCitations: number;
  changed: Array<{ from: string; to: string; count: number }>;
  orphaned: Array<{ text: string; count: number }>;
  unchanged: number;
  referencesReordered: number;
  referencesDeleted: number;
  swapped: Array<{ refA: string; refB: string }>;
}

export interface ReferenceEntry {
  id: string;
  authors: string[];
  title?: string;
  sortKey: string;
  originalPosition?: number;  // Original position in DOCX before any changes
  isSwapped?: boolean;        // Was this reference swapped with another
  swappedWith?: string;       // Name of the reference it was swapped with
  convertedText?: string;     // Converted format text (for style conversion)
  originalText?: string;      // Original format text before conversion
  // Bibliographic details for building complete citations
  year?: string;
  journalName?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
}

class DOCXProcessorService {
  /**
   * Extract text from DOCX file
   * Uses disk-based processing for large files (> 5MB) or when memory is constrained
   */
  async extractText(buffer: Buffer): Promise<DOCXContent> {
    const fileSize = buffer.length;

    // Circuit breaker check
    checkCircuitBreaker(fileSize);

    // Check file size limit
    if (fileSize > SECURITY_LIMITS.MAX_DOCX_SIZE) {
      throw new FileTooLargeError(
        fileSize,
        SECURITY_LIMITS.MAX_DOCX_SIZE,
        `DOCX file too large: ${Math.round(fileSize / 1024 / 1024)}MB exceeds ${Math.round(SECURITY_LIMITS.MAX_DOCX_SIZE / 1024 / 1024)}MB limit`
      );
    }

    const useDiskProcessing = shouldUseDiskProcessing(fileSize);

    if (useDiskProcessing) {
      return this.extractTextDiskBased(buffer);
    }

    return this.extractTextInMemory(buffer);
  }

  /**
   * Extract text using in-memory processing (fast path for small files)
   */
  private async extractTextInMemory(buffer: Buffer): Promise<DOCXContent> {
    return withMemoryTracking('DOCX extractText (in-memory)', async () => {
      try {
        logger.info(`[DOCX Processor] Extracting text in-memory (${Math.round(buffer.length / 1024)}KB)`);

        const textResult = await mammoth.extractRawText({ buffer });
        const htmlResult = await mammoth.convertToHtml({ buffer }, {
          includeDefaultStyleMap: true,
          styleMap: MAMMOTH_STYLE_MAP,
        });

        recordSuccess();

        return {
          text: textResult.value,
          html: htmlResult.value,
          rawBuffer: buffer
        };
      } catch (error: unknown) {
        recordFailure();
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error('[DOCX Processor] Failed to extract text (in-memory):', error);
        throw AppError.unprocessable(`DOCX extraction failed: ${errorMessage}`, 'DOCX_EXTRACTION_FAILED');
      }
    });
  }

  /**
   * Extract text using disk-based processing (memory-safe for large files)
   */
  private async extractTextDiskBased(buffer: Buffer): Promise<DOCXContent> {
    let tempFile: TempFileHandle | null = null;

    return withMemoryTracking('DOCX extractText (disk-based)', async () => {
      try {
        logger.info(`[DOCX Processor] Extracting text disk-based (${Math.round(buffer.length / 1024)}KB)`);

        // Write buffer to temp file
        tempFile = await createTempFile(buffer, 'docx-extract-');

        // Process using file path instead of buffer (reduces memory footprint)
        const textResult = await mammoth.extractRawText({ path: tempFile.path });
        const htmlResult = await mammoth.convertToHtml({ path: tempFile.path }, {
          includeDefaultStyleMap: true,
          styleMap: MAMMOTH_STYLE_MAP,
        });

        recordSuccess();

        return {
          text: textResult.value,
          html: htmlResult.value,
          rawBuffer: buffer // Keep original buffer for downstream use
        };
      } catch (error: unknown) {
        recordFailure();
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error('[DOCX Processor] Failed to extract text (disk-based):', error);
        throw AppError.unprocessable(`DOCX extraction failed: ${errorMessage}`, 'DOCX_EXTRACTION_FAILED');
      } finally {
        // Always clean up temp file
        if (tempFile) {
          await tempFile.cleanup();
        }
      }
    });
  }

  /**
   * Replace citations with Track Changes enabled
   * Also updates the References section to reflect reordering/deletions
   *
   * @param changedCitations - Array of citation changes with optional changeType
   *   - changeType 'renumber': Uses cyan highlighting (default)
   *   - changeType 'style_conversion': Uses green highlighting
   * @param authorYearRefChanges - Optional selective changes for author-year documents
   *   - deletedRefTexts: Full reference entry text patterns to strike through
   *   - editedRefs: Reference entry text replacements {oldText, newText}
   * @param acceptChanges - If true, apply changes cleanly without Track Changes markup
   */
  async replaceCitationsWithTrackChanges(
    originalBuffer: Buffer,
    changedCitations: Array<{ oldText: string; newText: string; changeType?: CitationChangeType }>,
    orphanedCitations: string[],
    currentReferences?: ReferenceEntry[],  // References in their new order (after reordering/deletion)
    authorYearRefChanges?: {
      deletedRefTexts?: string[];  // Full reference entry text to strike through
      editedRefs?: Array<{ oldText: string; newText: string }>;  // Reference entry text replacements
    },
    acceptChanges: boolean = false  // If true, apply changes cleanly without Track Changes markup
  ): Promise<{ buffer: Buffer; summary: ReplacementSummary }> {
    const fileSize = originalBuffer.length;

    // Circuit breaker check - this operation is memory-intensive
    checkCircuitBreaker(fileSize);

    // Log memory state before processing
    const memBefore = getMemoryUsage();
    logger.info(`[DOCX Processor] Memory before processing: ${memBefore.heapUsedMB}MB/${memBefore.heapTotalMB}MB`);

    return withMemoryTracking('DOCX replaceCitationsWithTrackChanges', async () => {
      try {
        logger.info(`[DOCX Processor] Processing: ${changedCitations.length} changed, ${orphanedCitations.length} orphaned`);

        // Security: Check buffer size
        if (fileSize > SECURITY_LIMITS.MAX_DOCX_SIZE) {
          throw new FileTooLargeError(
            fileSize,
            SECURITY_LIMITS.MAX_DOCX_SIZE,
            `DOCX file too large: ${Math.round(fileSize / 1024 / 1024)}MB exceeds ${Math.round(SECURITY_LIMITS.MAX_DOCX_SIZE / 1024 / 1024)}MB limit`
          );
        }

      const summary: ReplacementSummary = {
        totalCitations: 0,
        changed: [],
        orphaned: [],
        unchanged: 0,
        referencesReordered: 0,
        referencesDeleted: 0,
        swapped: []
      };

      const zip = await JSZip.loadAsync(originalBuffer);

      // Security: Validate DOCX structure
      const structureValidation = validateDOCXStructure(zip);
      if (!structureValidation.valid) {
        throw AppError.badRequest(`Invalid DOCX structure: ${structureValidation.error}`, 'INVALID_DOCX_STRUCTURE');
      }

      let documentXML = await zip.file('word/document.xml')?.async('string');
      if (!documentXML) {
        throw AppError.badRequest('Invalid DOCX: word/document.xml not found', 'INVALID_DOCX_STRUCTURE');
      }

      // Security: Check XML size and sanitize to prevent XXE attacks
      if (documentXML.length > SECURITY_LIMITS.MAX_XML_SIZE) {
        throw AppError.badRequest(`XML content too large: ${documentXML.length} bytes (max: ${SECURITY_LIMITS.MAX_XML_SIZE})`, 'XML_TOO_LARGE');
      }
      documentXML = sanitizeXML(documentXML);

      // Split document at References section to avoid modifying reference list citations
      // Look for common References section headers (using safe bounded regex patterns)
      const refPatterns = [
        createSafeHeaderRegex('References'),
        createSafeHeaderRegex('Bibliography'),
        createSafeHeaderRegex('Works Cited'),
        createSafeHeaderRegex('Reference List'),
      ];

      let bodyXML = documentXML;
      let referencesXML = '';
      let splitIndex = -1;

      for (const pattern of refPatterns) {
        const match = documentXML.match(pattern);
        if (match && match.index !== undefined) {
          // Find the paragraph containing "References" - go back to find <w:p>
          const beforeMatch = documentXML.substring(0, match.index);
          const lastParagraphStart = beforeMatch.lastIndexOf('<w:p');
          if (lastParagraphStart !== -1) {
            splitIndex = lastParagraphStart;
            bodyXML = documentXML.substring(0, splitIndex);
            referencesXML = documentXML.substring(splitIndex);
            logger.info(`[DOCX Processor] Found References section at index ${splitIndex}, excluding from processing`);
            break;
          }
        }
      }

      if (splitIndex === -1) {
        logger.info('[DOCX Processor] WARNING: No References section found in DOCX - reference style conversion will NOT be applied!');
        logger.info('[DOCX Processor] Looking for headers: "References", "Bibliography", "Works Cited", "Reference List"');
      } else {
        logger.info(`[DOCX Processor] References section found at index ${splitIndex}, referencesXML length: ${referencesXML.length}`);
      }

      const revisionDate = new Date().toISOString();
      const author = 'Citation Tool';
      let revisionId = 1;

      // Deduplicate changes and preserve change type
      const changeMap = new Map<string, { newText: string; changeType: CitationChangeType }>();
      for (const { oldText, newText, changeType } of changedCitations) {
        if (!changeMap.has(oldText)) {
          changeMap.set(oldText, { newText, changeType: changeType || 'renumber' });
        }
      }

      // Deduplicate orphaned (exclude those being changed)
      const orphanedSet = new Set<string>(orphanedCitations);
      for (const oldText of changeMap.keys()) {
        orphanedSet.delete(oldText);
      }

      // PHASE 1: Replace all citations using a universal approach
      // This handles ANY document structure by working with the text content directly
      logger.info('[DOCX Processor] Phase 1: Replacing citations (universal approach)');
      logger.info(`[DOCX Processor] Processing ${changeMap.size} changed citations`);
      const placeholders = new Map<string, { type: 'change' | 'orphan'; oldText: string; newText?: string; changeType?: CitationChangeType }>();
      let phIndex = 0;

      // Process all changed citations using the universal replacer
      for (const [oldText, { newText, changeType }] of changeMap) {
        const placeholder = `__PH_CHANGE_${phIndex}__`;
        placeholders.set(placeholder, { type: 'change', oldText, newText, changeType });
        phIndex++;

        const result = this.replaceCitationUniversal(bodyXML, oldText, placeholder);
        bodyXML = result.xml;

        if (result.count > 0) {
          summary.changed.push({ from: oldText, to: newText, count: result.count });
          summary.totalCitations += result.count;
          const typeLabel = changeType === 'style_conversion' ? ' [style]' : '';
          logger.info(`[DOCX Processor] Changed${typeLabel}: ${oldText} → ${newText} (${result.count}x)`);
        } else {
          logger.warn(`[DOCX Processor] No match for "${oldText}"`);
        }
      }

      // Orphaned citations - only in bodyXML
      // Use the universal replacer for consistency (handles citations split across multiple w:t tags)
      for (const orphanText of orphanedSet) {
        const placeholder = `__PH_ORPHAN_${phIndex}__`;
        placeholders.set(placeholder, { type: 'orphan', oldText: orphanText });
        phIndex++;

        // Use universal replacer to handle citations that may be split across multiple <w:t> tags
        const result = this.replaceCitationUniversal(bodyXML, orphanText, placeholder);
        bodyXML = result.xml;

        if (result.count > 0) {
          summary.orphaned.push({ text: orphanText, count: result.count });
          summary.totalCitations += result.count;
          logger.info(`[DOCX Processor] Orphaned: ${orphanText} (${result.count}x)`);
        } else {
          logger.warn(`[DOCX Processor] No match for orphaned citation "${orphanText}"`);
        }
      }

      // PHASE 2: Replace placeholders with Track Changes markup OR clean replacement
      if (acceptChanges) {
        logger.info('[DOCX Processor] Phase 2: Applying CLEAN changes (no Track Changes)');
      } else {
        logger.info('[DOCX Processor] Phase 2: Applying Track Changes');
      }

      for (const [placeholder, info] of placeholders) {
        // Use bounded quantifiers to prevent ReDoS on malformed XML
        const pattern = new RegExp(
          `<w:t([^>]{0,${REGEX_LIMITS.MAX_ATTR_LENGTH}})>([^<]{0,${REGEX_LIMITS.MAX_TEXT_LENGTH}})` + this.escapeRegex(placeholder) + `([^<]{0,${REGEX_LIMITS.MAX_TEXT_LENGTH}})</w:t>`,
          'g'
        );

        let replacement: string;

        if (acceptChanges) {
          // CLEAN EXPORT: Apply changes directly without Track Changes markup
          if (info.type === 'change' && info.newText) {
            const escapedNew = this.escapeXml(info.newText);
            // Simply replace with the new text
            replacement = `<w:t$1>$2${escapedNew}$3</w:t>`;
          } else {
            // Orphaned citation: remove it entirely (leave empty)
            replacement = `<w:t$1>$2$3</w:t>`;
          }
        } else {
          // TRACK CHANGES: Show strikethrough (old) + underline (new)
          if (info.type === 'change' && info.newText) {
            const escapedOld = this.escapeXml(info.oldText);
            const escapedNew = this.escapeXml(info.newText);

            // Use different highlight colors based on change type:
            // - cyan: renumbered citations (default)
            // - green: style conversion (e.g., "(1)" → "(Smith, 2020)")
            const highlightColor = info.changeType === 'style_conversion' ? 'green' : 'cyan';

            // Track Changes shows strikethrough (old) + underline (new), plus colored background for new text
            replacement = `<w:t$1>$2</w:t></w:r>` +
                          `<w:del w:id="${revisionId}" w:author="${author}" w:date="${revisionDate}">` +
                          `<w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:delText>${escapedOld}</w:delText></w:r></w:del>` +
                          `<w:ins w:id="${revisionId + 1}" w:author="${author}" w:date="${revisionDate}">` +
                          `<w:r><w:rPr><w:highlight w:val="${highlightColor}"/></w:rPr><w:t>${escapedNew}</w:t></w:r></w:ins>` +
                          `<w:r><w:t>$3</w:t>`;
            revisionId += 2;
          } else {
            const escapedOrphan = this.escapeXml(info.oldText);

            // Use red highlight for orphaned/deleted citations
            replacement = `<w:t$1>$2</w:t></w:r>` +
                          `<w:del w:id="${revisionId}" w:author="${author}" w:date="${revisionDate}">` +
                          `<w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:delText>${escapedOrphan}</w:delText></w:r></w:del>` +
                          `<w:r><w:t>$3</w:t>`;
            revisionId++;
          }
        }

        bodyXML = bodyXML.replace(pattern, replacement);
      }

      // Clean up empty elements
      bodyXML = bodyXML.replace(/<w:r><w:t><\/w:t><\/w:r>/g, '');
      bodyXML = bodyXML.replace(/<w:t><\/w:t>/g, '');

      // PHASE 2.5: Selective author-year reference section updates (deletions and edits)
      // This is used for author-year documents instead of full rebuild
      if (authorYearRefChanges && referencesXML && (authorYearRefChanges.deletedRefTexts?.length || authorYearRefChanges.editedRefs?.length)) {
        logger.info(`[DOCX Processor] Phase 2.5: Selective author-year reference section updates`);
        logger.info(`  - Deletions: ${authorYearRefChanges.deletedRefTexts?.length || 0}`);
        logger.info(`  - Edits: ${authorYearRefChanges.editedRefs?.length || 0}`);
        logger.info(`  - Accept Changes: ${acceptChanges}`);

        const selectiveResult = this.updateReferenceSectionSelective(
          referencesXML,
          authorYearRefChanges.deletedRefTexts || [],
          authorYearRefChanges.editedRefs || [],
          author,
          revisionDate,
          revisionId,
          acceptChanges  // Pass acceptChanges flag
        );
        referencesXML = selectiveResult.xml;
        summary.referencesDeleted = selectiveResult.deleted;
        revisionId = selectiveResult.nextRevisionId;
        // Mark that we've handled References section selectively
        logger.info(`[DOCX Processor] Phase 2.5 complete: ${selectiveResult.deleted} deleted, ${selectiveResult.edited} edited`);
      }

      // PHASE 3: Update References section if reference data provided (full rebuild - for numeric docs)
      logger.info(`[DOCX Processor] Phase 3 check: currentReferences=${currentReferences?.length || 0}, referencesXML.length=${referencesXML?.length || 0}`);

      if (currentReferences && currentReferences.length > 0 && referencesXML) {
        logger.info(`[DOCX Processor] Phase 3: Updating References section (${currentReferences.length} refs), acceptChanges=${acceptChanges}`);

        // Log each reference's convertedText
        currentReferences.forEach((ref, idx) => {
          logger.info(`[DOCX Processor] Ref ${idx + 1}: convertedText=${ref.convertedText ? `"${ref.convertedText.substring(0, 80)}..."` : 'NONE'}`);
        });

        const updatedRefsResult = this.updateReferencesSection(referencesXML, currentReferences, author, revisionDate, revisionId, acceptChanges);
        referencesXML = updatedRefsResult.xml;
        summary.referencesReordered = updatedRefsResult.reordered;
        summary.referencesDeleted = updatedRefsResult.deleted;
        summary.swapped = updatedRefsResult.swapped || [];
        revisionId = updatedRefsResult.nextRevisionId;
      } else {
        logger.warn(`[DOCX Processor] Phase 3 SKIPPED: currentReferences=${currentReferences?.length || 0}, referencesXML.length=${referencesXML?.length || 0}`);
        if (!referencesXML || referencesXML.length === 0) {
          logger.warn(`[DOCX Processor] Reason: References section not found in DOCX`);
        }
        if (!currentReferences || currentReferences.length === 0) {
          logger.warn(`[DOCX Processor] Reason: No references provided from database`);
        }
      }

      // Recombine body + references section
      documentXML = bodyXML + referencesXML;

      // Only enable track changes in settings when NOT using clean export
      if (!acceptChanges) {
        await this.updateSettingsForTrackChanges(zip);
      }

      zip.file('word/document.xml', documentXML);
      const modifiedBuffer = await zip.generateAsync({
        type: 'nodebuffer',
        compression: 'DEFLATE',
        compressionOptions: { level: 9 }
      });

      // Memory cleanup: Release JSZip resources and large strings
      cleanupZip(zip);
      documentXML = '';
      bodyXML = '';
      referencesXML = '';

      const exportType = acceptChanges ? 'clean export' : 'Track Changes';
      logger.info(`[DOCX Processor] Complete: ${summary.totalCitations} citations (${exportType})`);

      // Log memory state after processing
      const memAfter = getMemoryUsage();
      logger.info(`[DOCX Processor] Memory after processing: ${memAfter.heapUsedMB}MB/${memAfter.heapTotalMB}MB`);

      recordSuccess();
      return { buffer: modifiedBuffer, summary };
    } catch (error: unknown) {
      recordFailure();
      // Log full error object with stack trace for debugging
      logger.error('[DOCX Processor] Failed to replace citations:', error);
      throw error;
    }
    }); // End withMemoryTracking
  }

  private escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Generate format variants of a citation text for cross-format matching.
   * E.g., "(1, 2)" → ["[1, 2]", "[1,2]", "(1,2)"], "(2-4)" → ["[2-4]", "[2–4]", ...]
   */
  private generateCitationFormatVariants(text: string): string[] {
    const variants: string[] = [];
    const inner = text.replace(/^[[(]|[)\]]$/g, '').trim();
    const nums: number[] = [];
    for (const part of inner.split(',')) {
      const rangeMatch = part.trim().match(/^(\d+)\s*[-–]\s*(\d+)$/);
      if (rangeMatch) {
        for (let i = parseInt(rangeMatch[1]); i <= parseInt(rangeMatch[2]); i++) nums.push(i);
      } else {
        const n = parseInt(part.trim(), 10);
        if (!isNaN(n)) nums.push(n);
      }
    }
    if (nums.length === 0) return variants;

    const isRange = nums.length >= 2 && nums.every((n, i) => i === 0 || n === nums[i - 1] + 1);
    const formats = [nums.join(', '), nums.join(',')];
    if (isRange) {
      formats.push(`${nums[0]}-${nums[nums.length - 1]}`);
      formats.push(`${nums[0]}\u2013${nums[nums.length - 1]}`);
    }

    for (const fmt of formats) {
      const bracket = `[${fmt}]`;
      const paren = `(${fmt})`;
      if (bracket !== text && !variants.includes(bracket)) variants.push(bracket);
      if (paren !== text && !variants.includes(paren)) variants.push(paren);
    }
    return variants;
  }

  /**
   * Extract all paragraphs from document XML with their combined text content.
   * This handles text split across multiple <w:t> elements due to formatting.
   */
  private extractParagraphsWithText(documentXML: string): Array<{
    fullMatch: string;
    startIndex: number;
    paraId: string | null;
    pStart: string;
    pContent: string;
    pEnd: string;
    combinedText: string;
  }> {
    const paragraphs: Array<{
      fullMatch: string;
      startIndex: number;
      paraId: string | null;
      pStart: string;
      pContent: string;
      pEnd: string;
      combinedText: string;
    }> = [];

    // Match all paragraphs
    const paraRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
    let match: RegExpExecArray | null;

    while ((match = paraRegex.exec(documentXML)) !== null) {
      const fullMatch = match[0];
      const startIndex = match.index;

      // Extract paraId if present
      const paraIdMatch = fullMatch.match(/w14:paraId="([^"]+)"/);
      const paraId = paraIdMatch ? paraIdMatch[1] : null;

      // Split into parts: opening tag, content, closing tag
      const openTagMatch = fullMatch.match(/^(<w:p\b[^>]*>)/);
      const pStart = openTagMatch ? openTagMatch[1] : '<w:p>';
      const pEnd = '</w:p>';
      const pContent = fullMatch.slice(pStart.length, -pEnd.length);

      // Extract all text from <w:t> elements and combine
      const textMatches = fullMatch.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
      const combinedText = textMatches
        .map(t => t.replace(/<w:t[^>]*>([^<]*)<\/w:t>/, '$1'))
        .join('');

      paragraphs.push({
        fullMatch,
        startIndex,
        paraId,
        pStart,
        pContent,
        pEnd,
        combinedText
      });
    }

    return paragraphs;
  }

  /**
   * Mark an entire paragraph as deleted with track changes.
   * Returns the modified paragraph XML.
   */
  private markParagraphAsDeleted(
    paragraph: { pStart: string; pContent: string; pEnd: string; combinedText: string },
    revisionId: number,
    author: string,
    revisionDate: string
  ): string {
    // Extract paragraph properties if present
    const pPrMatch = paragraph.pContent.match(/^(<w:pPr>[\s\S]*?<\/w:pPr>)/);
    const pProps = pPrMatch ? pPrMatch[1] : '';

    // Create deletion markup for the entire text
    const delMarkup =
      `<w:del w:id="${revisionId}" w:author="${author}" w:date="${revisionDate}">` +
      `<w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:delText>${this.escapeXml(paragraph.combinedText)}</w:delText></w:r></w:del>`;

    // Return new paragraph with deletion markup
    return `${paragraph.pStart}${pProps}<w:r>${delMarkup}</w:r>${paragraph.pEnd}`;
  }

  /**
   * Find a paragraph by its paraId and mark it as deleted.
   * This is the most reliable method as it uses Word's unique paragraph IDs.
   */
  private findAndDeleteParagraphById(
    documentXML: string,
    paraId: string,
    revisionId: number,
    author: string,
    revisionDate: string
  ): { xml: string; found: boolean; deletedText: string } {
    // Find paragraph by paraId
    const paraRegex = new RegExp(
      `(<w:p[^>]*w14:paraId="${paraId}"[^>]*>)([\\s\\S]*?)(</w:p>)`,
      ''
    );

    const match = documentXML.match(paraRegex);
    if (!match) {
      return { xml: documentXML, found: false, deletedText: '' };
    }

    const [fullMatch, pStart, pContent, pEnd] = match;

    // Extract all text from paragraph
    const textMatches = fullMatch.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
    const combinedText = textMatches
      .map(t => t.replace(/<w:t[^>]*>([^<]*)<\/w:t>/, '$1'))
      .join('');

    if (!combinedText.trim()) {
      return { xml: documentXML, found: false, deletedText: '' };
    }

    // Build deletion markup - use w:del to mark entire paragraph content as deleted
    // When user accepts changes in Word, the paragraph will be removed and list renumbers
    const pPrMatch = pContent.match(/^(<w:pPr>[\s\S]*?<\/w:pPr>)/);
    const pProps = pPrMatch ? pPrMatch[1] : '';

    // Proper Track Changes structure: <w:del><w:r><w:delText>...</w:delText></w:r></w:del>
    // Note: w:del wrapper already signals deletion - explicit w:strike is redundant and could double-style
    const delMarkup =
      `<w:del w:id="${revisionId}" w:author="${author}" w:date="${revisionDate}">` +
      `<w:r><w:delText>${this.escapeXml(combinedText)}</w:delText></w:r></w:del>`;

    const newParagraph = `${pStart}${pProps}${delMarkup}${pEnd}`;

    return {
      xml: documentXML.replace(fullMatch, newParagraph),
      found: true,
      deletedText: combinedText
    };
  }

  /**
   * Build a mapping of reference/citation text to paragraph IDs.
   * This is used when we don't have stored paragraph IDs.
   */
  private buildTextToParagraphIdMap(paragraphs: Array<{
    paraId: string | null;
    combinedText: string;
  }>): Map<string, string> {
    const map = new Map<string, string>();

    for (const para of paragraphs) {
      if (!para.paraId || !para.combinedText.trim()) continue;

      // Store full text -> paraId mapping
      map.set(para.combinedText, para.paraId);

      // Also store first 80 chars for partial matching
      if (para.combinedText.length > 80) {
        map.set(para.combinedText.substring(0, 80), para.paraId);
      }

      // Store first 50 chars
      if (para.combinedText.length > 50) {
        map.set(para.combinedText.substring(0, 50), para.paraId);
      }
    }

    return map;
  }

  /**
   * Build a mapping of character positions to paragraph IDs.
   * This allows finding a paragraph by text offset (startOffset from Citation model).
   */
  private buildPositionToParagraphMap(paragraphs: Array<{
    paraId: string | null;
    combinedText: string;
  }>): Map<number, { paraId: string; startPos: number; endPos: number }> {
    const map = new Map<number, { paraId: string; startPos: number; endPos: number }>();
    let currentPos = 0;

    for (const para of paragraphs) {
      if (!para.paraId) {
        currentPos += para.combinedText.length + 1; // +1 for paragraph break
        continue;
      }

      const startPos = currentPos;
      const endPos = currentPos + para.combinedText.length;

      // Store mapping for each position in this paragraph
      map.set(startPos, { paraId: para.paraId, startPos, endPos });

      currentPos = endPos + 1; // +1 for paragraph break
    }

    return map;
  }

  /**
   * Find paragraph ID by character offset position.
   */
  private findParagraphByOffset(
    positionMap: Map<number, { paraId: string; startPos: number; endPos: number }>,
    offset: number
  ): string | null {
    // Find the paragraph that contains this offset
    for (const [, info] of positionMap) {
      if (offset >= info.startPos && offset < info.endPos) {
        return info.paraId;
      }
    }
    return null;
  }

  /**
   * Delete a citation within a paragraph by rebuilding the paragraph content.
   * This handles citations split across multiple XML elements.
   *
   * @param documentXML - The full document XML
   * @param paraId - The paragraph ID containing the citation
   * @param citationText - The citation text to delete (e.g., "(Bender et al., 2021)")
   * @param revisionId - Track changes revision ID
   * @param author - Track changes author
   * @param revisionDate - Track changes date
   * @returns Updated XML and whether the citation was found
   */
  private deleteCitationInParagraph(
    documentXML: string,
    paraId: string,
    citationText: string,
    revisionId: number,
    author: string,
    revisionDate: string
  ): { xml: string; found: boolean } {
    // Find the paragraph by ID
    const paraRegex = new RegExp(
      `(<w:p[^>]*w14:paraId="${paraId}"[^>]*>)([\\s\\S]*?)(</w:p>)`,
      ''
    );

    const match = documentXML.match(paraRegex);
    if (!match) {
      return { xml: documentXML, found: false };
    }

    const [fullMatch, pStart, pContent, pEnd] = match;

    // Extract all text segments with their positions
    const segments: Array<{
      fullTag: string;
      text: string;
      start: number;
      end: number;
    }> = [];

    const tagRegex = /<w:t[^>]*>([^<]*)<\/w:t>/g;
    let tagMatch: RegExpExecArray | null;
    let combinedText = '';

    while ((tagMatch = tagRegex.exec(pContent)) !== null) {
      segments.push({
        fullTag: tagMatch[0],
        text: tagMatch[1],
        start: combinedText.length,
        end: combinedText.length + tagMatch[1].length
      });
      combinedText += tagMatch[1];
    }

    // Try to find the citation in the combined text with various patterns
    // Citation might be stored without brackets/parentheses but appear with them in document
    let citationStart = -1;
    let actualCitationText = citationText;

    // Normalize Unicode superscript characters to regular digits for matching
    // Chicago/footnote style may store "¹²³" but Word XML uses "123" with styling
    const normalizedCitationText = normalizeSuperscripts(citationText);

    // Pattern 1: Exact match first
    citationStart = combinedText.indexOf(citationText);

    // Pattern 1b: Try with normalized superscripts (¹ → 1)
    if (citationStart === -1 && normalizedCitationText !== citationText) {
      citationStart = combinedText.indexOf(normalizedCitationText);
      if (citationStart !== -1) {
        actualCitationText = normalizedCitationText;
        logger.debug(`[DOCX Processor] Found citation with normalized superscripts: "${normalizedCitationText}"`);
      }
    }

    // Pattern 2: Try with parentheses - single citation (Author, Year)
    if (citationStart === -1) {
      const withParens = `(${citationText})`;
      citationStart = combinedText.indexOf(withParens);
      if (citationStart !== -1) {
        actualCitationText = withParens;
        logger.debug(`[DOCX Processor] Found citation with parentheses: "${withParens}"`);
      }
    }

    // Pattern 3: Try as last item in compound citation: "; Author, Year)"
    if (citationStart === -1) {
      const asLastInCompound = `; ${citationText})`;
      citationStart = combinedText.indexOf(asLastInCompound);
      if (citationStart !== -1) {
        actualCitationText = asLastInCompound;
        logger.debug(`[DOCX Processor] Found as last in compound: "${asLastInCompound}"`);
      }
    }

    // Pattern 4: Try as first item in compound citation: "(Author, Year;"
    if (citationStart === -1) {
      const asFirstInCompound = `(${citationText};`;
      citationStart = combinedText.indexOf(asFirstInCompound);
      if (citationStart !== -1) {
        actualCitationText = asFirstInCompound;
        logger.debug(`[DOCX Processor] Found as first in compound: "${asFirstInCompound}"`);
      }
    }

    // Pattern 5: Try as middle item in compound: "; Author, Year;"
    if (citationStart === -1) {
      const asMiddleInCompound = `; ${citationText};`;
      citationStart = combinedText.indexOf(asMiddleInCompound);
      if (citationStart !== -1) {
        actualCitationText = asMiddleInCompound;
        logger.debug(`[DOCX Processor] Found as middle in compound: "${asMiddleInCompound}"`);
      }
    }

    // Pattern 6: Try with brackets for numeric citations [N]
    if (citationStart === -1) {
      const withBrackets = `[${citationText}]`;
      citationStart = combinedText.indexOf(withBrackets);
      if (citationStart !== -1) {
        actualCitationText = withBrackets;
        logger.debug(`[DOCX Processor] Found citation with brackets: "${withBrackets}"`);
      }
    }

    if (citationStart === -1) {
      logger.debug(`[DOCX Processor] Citation not found in paragraph. Text: "${citationText}", Combined: "${combinedText.substring(0, 200)}..."`);
      return { xml: documentXML, found: false };
    }
    const citationEnd = citationStart + actualCitationText.length;

    // Build new paragraph content with the citation marked as deleted
    let newContent = pContent;

    // Find which segments contain the citation
    const affectedSegments: number[] = [];
    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      // Check if this segment overlaps with the citation
      if (seg.end > citationStart && seg.start < citationEnd) {
        affectedSegments.push(i);
      }
    }

    if (affectedSegments.length === 0) {
      return { xml: documentXML, found: false };
    }

    // Process affected segments in reverse order to preserve positions
    for (let i = affectedSegments.length - 1; i >= 0; i--) {
      const segIdx = affectedSegments[i];
      const seg = segments[segIdx];

      // Calculate what part of this segment is the citation
      const segCitStart = Math.max(0, citationStart - seg.start);
      const segCitEnd = Math.min(seg.text.length, citationEnd - seg.start);

      const beforeCit = seg.text.substring(0, segCitStart);
      const citPart = seg.text.substring(segCitStart, segCitEnd);
      const afterCit = seg.text.substring(segCitEnd);

      // Build replacement with track changes
      let replacement = '';

      if (beforeCit) {
        replacement += `<w:t>${beforeCit}</w:t></w:r><w:r>`;
      }

      if (citPart) {
        replacement += `</w:r><w:del w:id="${revisionId}" w:author="${author}" w:date="${revisionDate}">` +
          `<w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:delText>${this.escapeXml(citPart)}</w:delText></w:r></w:del><w:r>`;
      }

      if (afterCit) {
        replacement += `<w:t>${afterCit}</w:t>`;
      } else if (beforeCit || citPart) {
        replacement += `<w:t></w:t>`;
      }

      // Replace the original tag
      newContent = newContent.replace(seg.fullTag, replacement);
    }

    // Clean up empty elements
    newContent = newContent.replace(/<w:r><w:t><\/w:t><\/w:r>/g, '');
    newContent = newContent.replace(/<w:r><\/w:r>/g, '');
    newContent = newContent.replace(/<w:t><\/w:t>/g, '');

    const newParagraph = `${pStart}${newContent}${pEnd}`;
    return {
      xml: documentXML.replace(fullMatch, newParagraph),
      found: true
    };
  }

  /**
   * Universal citation replacement that works with any document structure
   * Handles citations split across multiple XML tags
   * Supports both numeric citations like "(1)" and author-year citations like "(Smith, 2019)"
   */
  private replaceCitationUniversal(xml: string, citation: string, replacement: string): { xml: string; count: number } {
    let count = 0;

    // Determine if this is an author-year citation or numeric citation
    // Author-year citations contain letters (e.g., "(Smith, 2019)", "(Marcus & Davis, 2019)")
    // Numeric citations are just numbers in parentheses (e.g., "(1)", "(2, 3)")
    const hasLetters = /[a-zA-Z]/.test(citation);
    const isAuthorYearCitation = hasLetters && /\d{4}/.test(citation);

    // For author-year citations, we need to match the full text
    // For numeric citations, we extract just the number
    let searchPattern: string;

    if (isAuthorYearCitation) {
      // Author-year citation: escape the full text for regex matching
      // Also handle XML entity encoding (& becomes &amp; in DOCX XML)
      const xmlEncodedCitation = citation.replace(/&/g, '&amp;');
      // Create pattern that matches either the original or XML-encoded version
      if (citation !== xmlEncodedCitation) {
        searchPattern = `(?:${this.escapeRegex(citation)}|${this.escapeRegex(xmlEncodedCitation)})`;
        logger.debug(`[DOCX Processor] Author-year citation with ampersand: "${citation}" (also trying "${xmlEncodedCitation}")`);
      } else {
        searchPattern = this.escapeRegex(citation);
        logger.debug(`[DOCX Processor] Author-year citation detected: "${citation}"`);
      }
    } else {
      // Numeric citation: check if it has parentheses or not
      // Chicago style uses superscript numbers without parentheses: "1", "2", "3"
      // Vancouver style uses numbers in parentheses: "(1)", "(2)", "(3)"
      const hasParentheses = /^\s*[\(\[\{]/.test(citation) || /[\)\]\}]\s*$/.test(citation);
      const numberMatch = citation.match(/\d+/);

      if (!numberMatch) {
        // No numbers in the text - this might be reference list text for DELETE operations
        // Fall back to general text search
        searchPattern = this.escapeRegex(citation.trim());
        logger.debug(`[DOCX Processor] General text search (no numbers): "${citation.substring(0, 50)}..."`);
      } else if (hasParentheses) {
        // Citation has parentheses/brackets - match the full pattern
        searchPattern = this.escapeRegex(citation.trim());
        logger.debug(`[DOCX Processor] Numeric citation with brackets: "${citation}"`);
      } else {
        // Chicago-style superscript without parentheses - match just the number
        // Use the full citation text to match exactly (handles "1", "2, 3", etc.)
        searchPattern = this.escapeRegex(citation.trim());
        logger.debug(`[DOCX Processor] Numeric citation (superscript/no brackets): "${citation}"`);
      }
    }

    // Strategy: Find sequences of <w:t> tags that together form the citation pattern
    // Build a map of character positions to XML positions

    // Step 1: Extract all <w:t> content with their positions in the XML
    interface TextSegment {
      start: number;  // Start position in XML
      end: number;    // End position in XML
      text: string;   // The text content
      fullMatch: string; // The full <w:t>...</w:t> match
    }

    const segments: TextSegment[] = [];
    // Use safe regex with bounded quantifiers to prevent ReDoS on malformed XML
    const textTagRegex = createSafeTextTagRegex();

    // Use safe regex execution with match limit
    const textTagMatches = safeRegexExec(textTagRegex, xml, SEGMENT_LIMITS.MAX_SEGMENTS_PER_PASS);

    for (const textMatch of textTagMatches) {
      segments.push({
        start: textMatch.index,
        end: textMatch.index + textMatch[0].length,
        text: textMatch[2],
        fullMatch: textMatch[0]
      });
    }

    // Log warning for large documents
    if (segments.length >= SEGMENT_LIMITS.SEGMENT_WARN_THRESHOLD) {
      logger.warn(`[DOCX Processor] Large document detected: ${segments.length} text segments`);
    }

    // Step 2: Build combined text and track which segment each character belongs to
    // Use string array and join for better memory efficiency with large documents
    const textParts: string[] = [];
    const charToSegment: { segmentIndex: number; charIndex: number }[] = [];
    let totalChars = 0;

    for (let segIdx = 0; segIdx < segments.length; segIdx++) {
      const seg = segments[segIdx];
      textParts.push(seg.text);

      // Memory safety: Limit charToSegment array size
      if (totalChars + seg.text.length > SEGMENT_LIMITS.MAX_CHAR_MAP_SIZE) {
        logger.warn(`[DOCX Processor] Character map limit reached at segment ${segIdx}, stopping`);
        break;
      }

      for (let charIdx = 0; charIdx < seg.text.length; charIdx++) {
        charToSegment.push({ segmentIndex: segIdx, charIndex: charIdx });
        totalChars++;
      }
    }

    // Join text parts (more memory efficient than string concatenation in loop)
    const combinedText = textParts.join('');
    // Clear textParts array to free memory
    textParts.length = 0;

    // Step 3: Find all occurrences of the citation pattern in the combined text
    const citationPattern = new RegExp(searchPattern, 'g');
    const matches: { start: number; end: number }[] = [];
    let citMatch: RegExpExecArray | null;

    while ((citMatch = citationPattern.exec(combinedText)) !== null) {
      matches.push({
        start: citMatch.index,
        end: citMatch.index + citMatch[0].length
      });
    }

    if (matches.length === 0) {
      return { xml, count: 0 };
    }

    // Step 4: For each match, determine which segments are involved and replace
    // Process matches in reverse order to preserve positions
    let modifiedXml = xml;

    for (let i = matches.length - 1; i >= 0; i--) {
      const m = matches[i];

      // Find the segments involved in this match
      const startInfo = charToSegment[m.start];
      const endInfo = charToSegment[m.end - 1];

      if (!startInfo || !endInfo) continue;

      const startSegIdx = startInfo.segmentIndex;
      const endSegIdx = endInfo.segmentIndex;

      if (startSegIdx === endSegIdx) {
        // Citation is within a single segment - simple replacement
        const seg = segments[startSegIdx];
        const beforeCitation = seg.text.substring(0, startInfo.charIndex);
        const afterCitation = seg.text.substring(endInfo.charIndex + 1);
        const newText = beforeCitation + replacement + afterCitation;
        const newTag = seg.fullMatch.replace(/>([^<]*)</, `>${newText}<`);

        modifiedXml = modifiedXml.substring(0, seg.start) + newTag + modifiedXml.substring(seg.end);
        count++;
      } else {
        // Citation spans multiple segments
        // Strategy: Put the replacement in the first segment, clear the middle segments,
        // and adjust the last segment

        const firstSeg = segments[startSegIdx];
        const lastSeg = segments[endSegIdx];

        // Text before the citation in the first segment
        const beforeCitation = firstSeg.text.substring(0, startInfo.charIndex);
        // Text after the citation in the last segment
        const afterCitation = lastSeg.text.substring(endInfo.charIndex + 1);

        // Build replacement: first segment gets before + replacement, last segment gets after
        // Middle segments become empty

        // Work backwards to preserve positions
        // 1. Modify last segment
        const newLastText = afterCitation;
        const newLastTag = lastSeg.fullMatch.replace(/>([^<]*)</, `>${newLastText}<`);
        modifiedXml = modifiedXml.substring(0, lastSeg.start) + newLastTag + modifiedXml.substring(lastSeg.end);

        // 2. Clear middle segments (if any)
        for (let segIdx = endSegIdx - 1; segIdx > startSegIdx; segIdx--) {
          const midSeg = segments[segIdx];
          const newMidTag = midSeg.fullMatch.replace(/>([^<]*)</, `><`);
          modifiedXml = modifiedXml.substring(0, midSeg.start) + newMidTag + modifiedXml.substring(midSeg.end);
        }

        // 3. Modify first segment
        const newFirstText = beforeCitation + replacement;
        const newFirstTag = firstSeg.fullMatch.replace(/>([^<]*)</, `>${newFirstText}<`);
        modifiedXml = modifiedXml.substring(0, firstSeg.start) + newFirstTag + modifiedXml.substring(firstSeg.end);

        count++;
      }

      // Re-parse segments for next iteration (positions have changed)
      // Note: This re-parsing is necessary because XML positions shift after each replacement
      if (i > 0) {
        // Clear arrays to free memory before rebuilding
        segments.length = 0;
        charToSegment.length = 0;

        // Use safe bounded regex for text tag extraction
        const newTextTagRegex = createSafeTextTagRegex();
        const reMatches = safeRegexExec(newTextTagRegex, modifiedXml, SEGMENT_LIMITS.MAX_SEGMENTS_PER_PASS);

        for (const reMatch of reMatches) {
          segments.push({
            start: reMatch.index,
            end: reMatch.index + reMatch[0].length,
            text: reMatch[2],
            fullMatch: reMatch[0]
          });
        }

        let reCharCount = 0;
        for (let segIdx = 0; segIdx < segments.length; segIdx++) {
          const seg = segments[segIdx];
          // Memory safety: Limit charToSegment array during re-parsing
          if (reCharCount + seg.text.length > SEGMENT_LIMITS.MAX_CHAR_MAP_SIZE) {
            break;
          }
          for (let charIdx = 0; charIdx < seg.text.length; charIdx++) {
            charToSegment.push({ segmentIndex: segIdx, charIndex: charIdx });
            reCharCount++;
          }
        }
      }
    }

    // Memory cleanup: Clear segment arrays before returning
    segments.length = 0;
    charToSegment.length = 0;

    return { xml: modifiedXml, count };
  }

  /**
   * Add highlight to all text runs in a paragraph
   * This adds a highlight color to all <w:t> elements
   */
  private addHighlightToAllText(paragraphXml: string, color: string): string {
    // Add highlight to all <w:r> elements that contain <w:t>
    return paragraphXml.replace(
      /(<w:r\b[^>]*>)([\s\S]*?)(<\/w:r>)/g,
      (match, openTag, content, closeTag) => {
        // Skip if this run doesn't contain text
        if (!content.includes('<w:t')) {
          return match;
        }

        // Check if <w:rPr> already exists
        if (content.includes('<w:rPr>')) {
          // Check if highlight already exists
          if (content.includes('<w:highlight')) {
            return match; // Already has highlight, don't modify
          }
          // Add highlight to existing rPr
          const newContent = content.replace(/<w:rPr>/, `<w:rPr><w:highlight w:val="${color}"/>`);
          return openTag + newContent + closeTag;
        } else {
          // Add new rPr with highlight before the text
          const newContent = content.replace(/(<w:t)/, `<w:rPr><w:highlight w:val="${color}"/></w:rPr>$1`);
          return openTag + newContent + closeTag;
        }
      }
    );
  }

  /**
   * Selective update of References section for author-year documents
   * Only modifies specific paragraphs that match deleted or edited references
   * Does NOT rebuild the entire section - leaves other references untouched
   * @param acceptChanges - If true, apply changes cleanly without Track Changes markup
   */
  private updateReferenceSectionSelective(
    referencesXML: string,
    deletedRefTexts: string[],
    editedRefs: Array<{ oldText: string; newText: string }>,
    author: string,
    date: string,
    startRevisionId: number,
    acceptChanges: boolean = false
  ): { xml: string; deleted: number; edited: number; nextRevisionId: number } {
    let revisionId = startRevisionId;
    let deleted = 0;
    let edited = 0;

    try {
      logger.info(`[DOCX Processor] Selective reference update: ${deletedRefTexts.length} deletions, ${editedRefs.length} edits`);

      // Extract all paragraphs from References section
      const paragraphRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
      let updatedXML = referencesXML;

      // Helper to extract text from paragraph (using safe bounded regex)
      const extractText = (para: string): string => {
        return safeExtractParagraphText(para);
      };

      // Helper to normalize text for matching (remove extra spaces, handle different quote styles)
      const normalizeText = (text: string): string => {
        return text.replace(/\s+/g, ' ').replace(/[""'']/g, '"').trim().toLowerCase();
      };

      // Process each paragraph
      const paragraphs = updatedXML.match(paragraphRegex) || [];

      // Helper to extract author name from inline citation "(Author, Year)" or full reference "Author. (Year)."
      const extractAuthorFromCitation = (text: string): string | null => {
        // Try inline citation format: "(Marcus & Davis, 2019)" or "(Smith, 2020)"
        const inlineMatch = text.match(/^\(([^,]+?)(?:,|\s*&|\s+et\s+al)/i);
        if (inlineMatch) {
          return inlineMatch[1].trim();
        }
        // Try inline citation with just year: "(Marcus, 2019)" - author is before the year
        const simpleInlineMatch = text.match(/^\(([^)]+?),?\s*\d{4}\)/);
        if (simpleInlineMatch) {
          const authorPart = simpleInlineMatch[1].replace(/,?\s*\d{4}.*/, '').trim();
          // Extract first author name (before & or comma indicating second author)
          const firstAuthor = authorPart.split(/\s*[&,]\s*/)[0];
          return firstAuthor || authorPart;
        }
        // Try citation WITHOUT parentheses: "Bommasani et al., 2021" or "Brown et al., 2020"
        // This handles author-year citations stored without parentheses in rawText
        const noParenMatch = text.match(/^([A-Za-z]+)(?:\s+et\s+al\.?)?(?:,|\s*&|\s+)\s*\d{4}/i);
        if (noParenMatch) {
          return noParenMatch[1].trim();
        }
        // Try full reference format: "Marcus, J., & Davis, K. (2019)."
        const fullRefMatch = text.match(/^([^(]+)\(/);
        if (fullRefMatch) {
          return fullRefMatch[1].trim();
        }
        return null;
      };

      for (const para of paragraphs) {
        const paraText = extractText(para);
        const normalizedParaText = normalizeText(paraText);

        // Check for deletions - match by author name pattern (partial match)
        for (const deleteText of deletedRefTexts) {
          const authorPart = extractAuthorFromCitation(deleteText);
          if (authorPart) {
            const normalizedAuthor = normalizeText(authorPart);
            logger.info(`[DOCX Processor] Looking for deleted ref author: "${authorPart}" (normalized: "${normalizedAuthor}")`);

            if (normalizedParaText.includes(normalizedAuthor)) {
              logger.info(`[DOCX Processor] Found deleted reference match: "${paraText.substring(0, 50)}..."`);

              let updatedPara = para;

              if (acceptChanges) {
                // CLEAN EXPORT: Remove the paragraph entirely
                updatedXML = updatedXML.replace(para, '');
                logger.info(`[DOCX Processor] Removed deleted reference (clean export)`);
              } else {
                // TRACK CHANGES: Mark paragraph as deleted (strikethrough)
                updatedPara = updatedPara.replace(/<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g, '<w:delText$1>$2</w:delText>');

                let localRevId = revisionId;
                updatedPara = updatedPara.replace(
                  /(<w:r\b[^>]*>)([\s\S]*?)(<\/w:r>)/g,
                  (match, openTag, content, closeTag) => {
                    const newContent = content.replace(/<w:rPr>/, '<w:rPr><w:highlight w:val="red"/>');
                    const contentWithHighlight = content.includes('<w:rPr>') ? newContent : content.replace(/(<w:delText)/, '<w:rPr><w:highlight w:val="red"/></w:rPr>$1');
                    const result = `<w:del w:id="${localRevId}" w:author="${author}" w:date="${date}">${openTag}${contentWithHighlight}${closeTag}</w:del>`;
                    localRevId++;
                    return result;
                  }
                );
                revisionId = localRevId;

                updatedXML = updatedXML.replace(para, updatedPara);
              }
              deleted++;
              break;
            }
          } else {
            logger.warn(`[DOCX Processor] Could not extract author from deleteText: "${deleteText}"`);
          }
        }

        // Check for edits - match by author name pattern
        for (const editRef of editedRefs) {
          const authorPart = extractAuthorFromCitation(editRef.oldText);
          if (authorPart) {
            const normalizedAuthor = normalizeText(authorPart);
            logger.info(`[DOCX Processor] Looking for edited ref author: "${authorPart}" (normalized: "${normalizedAuthor}")`);

            if (normalizedParaText.includes(normalizedAuthor)) {
              logger.info(`[DOCX Processor] Found edited reference match: "${paraText.substring(0, 50)}..."`);

              // For year edits, find the year and replace it with track changes
              // Handle both formats: "(2019)" or just "2019" in the text
              const oldYearMatch = editRef.oldText.match(/(\d{4})/);
              const newYearMatch = editRef.newText.match(/(\d{4})/);

              if (oldYearMatch && newYearMatch && oldYearMatch[1] !== newYearMatch[1]) {
                const oldYear = oldYearMatch[1];
                const newYear = newYearMatch[1];

                let updatedPara = para;
                let replaced = false;

                if (acceptChanges) {
                  // CLEAN EXPORT: Simply replace the year without Track Changes
                  const yearRegex = new RegExp(`(${oldYear})`, 'g');
                  // Replace only the first occurrence (APA year in parens comes first)
                  updatedPara = updatedPara.replace(yearRegex, newYear);
                  replaced = updatedPara !== para;
                  if (replaced) {
                    updatedXML = updatedXML.replace(para, updatedPara);
                    edited++;
                    logger.info(`[DOCX Processor] Replaced year (clean export): ${oldYear} → ${newYear}`);
                  }
                } else {
                  // TRACK CHANGES: Find and replace ONLY the year in parentheses "(YEAR)"
                  // In APA format, the year in parentheses comes right after authors: "Smith, J. (2019). Title..."
                  // Using bounded quantifiers to prevent ReDoS on malformed XML

                  // Pattern 1: Year with opening paren in same w:t element: "(2019" or "(2019)"
                  const yearWithParenRegex = new RegExp(`(<w:t[^>]{0,${REGEX_LIMITS.MAX_ATTR_LENGTH}}>)([^<]{0,${REGEX_LIMITS.MAX_TEXT_LENGTH}}\\()(${oldYear})(\\)?[^<]{0,${REGEX_LIMITS.MAX_TEXT_LENGTH}})(<\\/w:t>)`);

                  if (yearWithParenRegex.test(updatedPara)) {
                    updatedPara = updatedPara.replace(yearWithParenRegex, (match, openTag, before, year, after, closeTag) => {
                      const delId = revisionId++;
                      const insId = revisionId++;
                      replaced = true;
                      return `${openTag}${before}${closeTag}</w:r><w:del w:id="${delId}" w:author="${author}" w:date="${date}"><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:delText>${year}</w:delText></w:r></w:del><w:ins w:id="${insId}" w:author="${author}" w:date="${date}"><w:r><w:rPr><w:highlight w:val="green"/></w:rPr><w:t>${newYear}</w:t></w:r></w:ins><w:r>${openTag}${after}${closeTag}`;
                    });
                  }

                  // Pattern 2: If paren and year are in separate w:t elements, look for year right after "(</w:t>"
                  if (!replaced) {
                    const yearAfterParenRegex = new RegExp(`(\\(<\\/w:t><\\/w:r>)(<w:r[^>]{0,${REGEX_LIMITS.MAX_ATTR_LENGTH}}>)(<w:t[^>]{0,${REGEX_LIMITS.MAX_ATTR_LENGTH}}>)(${oldYear})`);
                    if (yearAfterParenRegex.test(updatedPara)) {
                      updatedPara = updatedPara.replace(yearAfterParenRegex, (match, parenClose, rOpen, tOpen, year) => {
                        const delId = revisionId++;
                        const insId = revisionId++;
                        replaced = true;
                        return `${parenClose}${rOpen}<w:del w:id="${delId}" w:author="${author}" w:date="${date}"><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:delText>${year}</w:delText></w:r></w:del><w:ins w:id="${insId}" w:author="${author}" w:date="${date}"><w:r><w:rPr><w:highlight w:val="green"/></w:rPr><w:t>${newYear}</w:t></w:r></w:ins><w:r>${tOpen}`;
                      });
                    }
                  }

                  // Pattern 3: Fallback - replace only the FIRST occurrence of the year (APA year in parens comes first)
                  if (!replaced) {
                    const firstYearRegex = new RegExp(`(<w:t[^>]{0,${REGEX_LIMITS.MAX_ATTR_LENGTH}}>)([^<]{0,${REGEX_LIMITS.MAX_TEXT_LENGTH}})(${oldYear})([^<]{0,${REGEX_LIMITS.MAX_TEXT_LENGTH}})(<\\/w:t>)`);
                    if (firstYearRegex.test(updatedPara)) {
                      updatedPara = updatedPara.replace(firstYearRegex, (match, openTag, before, year, after, closeTag) => {
                        const delId = revisionId++;
                        const insId = revisionId++;
                        replaced = true;
                        return `${openTag}${before}${closeTag}</w:r><w:del w:id="${delId}" w:author="${author}" w:date="${date}"><w:r><w:rPr><w:highlight w:val="yellow"/></w:rPr><w:delText>${year}</w:delText></w:r></w:del><w:ins w:id="${insId}" w:author="${author}" w:date="${date}"><w:r><w:rPr><w:highlight w:val="green"/></w:rPr><w:t>${newYear}</w:t></w:r></w:ins><w:r>${openTag}${after}${closeTag}`;
                      });
                    }
                  }

                  if (replaced && updatedPara !== para) {
                    updatedXML = updatedXML.replace(para, updatedPara);
                    edited++;
                    logger.info(`[DOCX Processor] Updated year in parentheses: (${oldYear}) → (${newYear})`);
                  }
                }
              }
              break;
            }
          } else {
            logger.warn(`[DOCX Processor] Could not extract author from editRef.oldText: "${editRef.oldText}"`);
          }
        }
      }

      logger.info(`[DOCX Processor] Selective update complete: ${deleted} deleted, ${edited} edited`);
      return { xml: updatedXML, deleted, edited, nextRevisionId: revisionId };
    } catch (error: unknown) {
      // Log full error with stack trace for debugging
      logger.error('[DOCX Processor] Selective reference update failed:', error);
      return { xml: referencesXML, deleted: 0, edited: 0, nextRevisionId: revisionId };
    }
  }

  /**
   * Update the References section to reflect reordering and deletions
   * - PHYSICALLY REORDERS paragraphs to match database order
   * - Keeps deleted references in their ORIGINAL position (with strikethrough) - unless acceptChanges is true
   * - Updates reference numbers with Track Changes - unless acceptChanges is true
   * - Shows swapping visually with yellow highlighting - unless acceptChanges is true
   * @param acceptChanges - If true, apply changes cleanly without Track Changes markup
   */
  private updateReferencesSection(
    referencesXML: string,
    currentReferences: ReferenceEntry[],
    author: string,
    date: string,
    startRevisionId: number,
    acceptChanges: boolean = false
  ): { xml: string; reordered: number; deleted: number; swapped: Array<{ refA: string; refB: string }>; nextRevisionId: number } {
    let revisionId = startRevisionId;
    let reordered = 0;
    let deleted = 0;
    const swappedPairs: Array<{ refA: string; refB: string }> = [];

    try {
      // IMPORTANT: Some documents have content AFTER the References section
      // (tables, figures, correspondence info, author details, etc.)
      // We must only process actual reference paragraphs and preserve everything else

      // Find where tables/section breaks start (if any)
      const tableStartIndex = referencesXML.indexOf('<w:tbl');
      const sectionBreakIndex = referencesXML.indexOf('<w:sectPr');

      // Determine where reference content ends based on structural elements
      let structuralEndIndex = referencesXML.length;
      if (tableStartIndex > 0) {
        structuralEndIndex = Math.min(structuralEndIndex, tableStartIndex);
      }
      if (sectionBreakIndex > 0) {
        structuralEndIndex = Math.min(structuralEndIndex, sectionBreakIndex);
      }

      // Extract ALL paragraphs first to analyze them
      const paragraphRegex = /<w:p[^>]*>[\s\S]*?<\/w:p>/g;
      const allParagraphs = referencesXML.match(paragraphRegex) || [];

      if (allParagraphs.length <= 1) {
        logger.info('[DOCX Processor] No reference paragraphs found to update');
        return { xml: referencesXML, reordered: 0, deleted: 0, swapped: [], nextRevisionId: revisionId };
      }

      // First paragraph is usually the "References" header
      const headerParagraph = allParagraphs[0];
      const candidateParagraphs = allParagraphs.slice(1);

      // Helper to extract text from paragraph (using safe bounded regex)
      const extractText = (para: string): string => {
        return safeExtractParagraphText(para);
      };

      // Helper to check if paragraph looks like a reference entry
      // Handles BOTH numbered (Vancouver: "1. Author...") and unnumbered (APA: "Author Name. Title...")
      const isReferenceEntry = (text: string): boolean => {
        // Pattern 1: Numbered references - "1." or "1.\t" or "[1]" etc.
        if (/^\d+[\.\)\]\t\s]/.test(text) || /^\[\d+\]/.test(text)) {
          return true;
        }

        // Pattern 2: Unnumbered references - starts with author name pattern
        // Author patterns: "LastName Initials." or "LastName, Initials." or "LastName A, LastName B."
        // Examples: "Edstrom LE, Robson MC" or "Smith, J.A." or "Van der Berg A."
        if (/^[A-Z][a-z]+(\s+[A-Z]{1,3}[,.]?)+/.test(text)) {
          // Additional check: should contain year in parentheses or followed by period
          // or look like a citation with journal info
          if (/\d{4}/.test(text) || /\.\s+[A-Z]/.test(text)) {
            return true;
          }
        }

        // Pattern 3: Starts with author name followed by period and title
        // "LastName Initials. Title of article..."
        if (/^[A-Z][a-z]+\s+[A-Z]{1,3}\./.test(text)) {
          return true;
        }

        return false;
      };

      // Find where actual reference entries end
      // Stop when we hit content that doesn't look like a reference (Correspondence, Author info, etc.)
      const refParagraphs: string[] = [];
      const nonRefParagraphs: string[] = [];
      let foundNonRef = false;

      for (const para of candidateParagraphs) {
        // Check if paragraph is before structural elements (tables, etc.)
        const paraIndex = referencesXML.indexOf(para);
        if (paraIndex >= structuralEndIndex) {
          // This paragraph is after tables/section breaks - preserve it
          nonRefParagraphs.push(para);
          continue;
        }

        const text = extractText(para);

        // Skip empty paragraphs
        if (!text) {
          if (foundNonRef) {
            nonRefParagraphs.push(para);
          } else {
            refParagraphs.push(para);
          }
          continue;
        }

        // Once we hit non-reference content, everything after is preserved
        if (foundNonRef) {
          nonRefParagraphs.push(para);
          continue;
        }

        // Check for non-reference markers FIRST (these definitely aren't references)
        const nonRefMarkers = ['correspondence', 'received:', 'accepted:', 'conflict of interest', 'acknowledgment', 'funding', 'orcid', 'e-mail:', 'email:', 'address:', 'affiliation', 'author contributions'];
        const lowerText = text.toLowerCase();
        const isNonRefContent = nonRefMarkers.some(marker => lowerText.includes(marker));

        if (isNonRefContent) {
          // Definitely non-reference content - stop collecting references
          foundNonRef = true;
          nonRefParagraphs.push(para);
          logger.info(`[DOCX Processor] Found non-reference content: "${text.substring(0, 50)}..." - preserving remaining content`);
        } else if (isReferenceEntry(text)) {
          // Looks like a reference entry - add it
          refParagraphs.push(para);
          logger.info(`[DOCX Processor] Found reference paragraph: "${text.substring(0, 80)}..."`);
        } else {
          // Doesn't match reference patterns but not explicitly non-reference
          // Could be a continuation or unusual format - include it for safety
          refParagraphs.push(para);
          logger.info(`[DOCX Processor] Including ambiguous paragraph as reference: "${text.substring(0, 50)}..."`);
        }
      }

      // Build preserved content from non-reference paragraphs and everything after structural elements
      const lastRefPara = refParagraphs[refParagraphs.length - 1];
      const headerParaStr = headerParagraph || '';
      const lastRefParaEnd = lastRefPara ? referencesXML.indexOf(lastRefPara) + lastRefPara.length : referencesXML.indexOf(headerParaStr) + headerParaStr.length;
      const preservedContent = referencesXML.substring(lastRefParaEnd);

      logger.info(`[DOCX Processor] Found ${refParagraphs.length} reference paragraphs, ${nonRefParagraphs.length} non-reference paragraphs to preserve`);

      // STEP 1: Build a map of each DOCX paragraph to its matched database reference
      interface ParagraphInfo {
        para: string;
        origNum: number;
        origIndex: number;
        refId: string | null;
        matchedRef: ReferenceEntry | null;
      }

      const paragraphInfos: ParagraphInfo[] = [];
      const refIdToParagraphInfo = new Map<string, ParagraphInfo>();

      // Extract original numbers and match to database references
      for (let paraIdx = 0; paraIdx < refParagraphs.length; paraIdx++) {
        const para = refParagraphs[paraIdx];
        // Use safe bounded regex for text extraction
        const fullText = safeExtractParagraphText(para);

        // Extract original number from paragraph
        const numMatch = fullText.match(/^(\d+)\./);
        const origNum = numMatch ? parseInt(numMatch[1]) : paraIdx + 1;

        // Try to match by author name using word boundary
        let matchedRefId: string | null = null;
        let matchedRef: ReferenceEntry | null = null;
        for (const ref of currentReferences) {
          if (ref.authors && ref.authors[0]) {
            const authorLastName = ref.authors[0].split(/[,\s]/)[0];
            // Guard against empty or too-short author names that would create unsafe regex patterns
            // \b\b (empty) matches at every word boundary, causing wrong replacements
            if (!authorLastName || authorLastName.length < 2) {
              logger.debug(`[DOCX Processor] Author name too short for safe matching: "${authorLastName}", skipping regex match`);
              continue;
            }
            const escapedAuthor = authorLastName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const authorRegex = new RegExp(`\\b${escapedAuthor}\\b`, 'i');
            if (authorRegex.test(fullText)) {
              matchedRefId = ref.id;
              matchedRef = ref;
              logger.debug(`[DOCX Processor] Matched DOCX para ${origNum} (idx ${paraIdx}) to ref "${ref.authors[0]}" (id: ${ref.id})`);
              break;
            }
          }
        }

        const info: ParagraphInfo = {
          para,
          origNum,
          origIndex: paraIdx,
          refId: matchedRefId,
          matchedRef
        };

        paragraphInfos.push(info);

        if (matchedRefId) {
          refIdToParagraphInfo.set(matchedRefId, info);
        }
      }

      // STEP 2: Identify deleted paragraphs (in DOCX but not in database)
      const deletedParagraphs: ParagraphInfo[] = paragraphInfos.filter(info => info.refId === null);

      // STEP 3: Build the NEW order of paragraphs following the DATABASE order
      // While inserting deleted refs at their original positions
      const outputParagraphs: {
        para: string;
        newNum: number;
        origNum: number;
        isDeleted: boolean;
        isSwapped: boolean;
        swappedWith?: string;
        convertedText?: string;  // For style conversion
      }[] = [];

      // Create a slot for each position
      // First, we need to figure out the final order
      // Database order determines where matched refs go
      // Deleted refs stay at their original positions

      // Build array of new positions
      let newPosition = 1;
      const usedOrigPositions = new Set<number>();

      // First pass: place references according to database order
      for (const ref of currentReferences) {
        const paraInfo = refIdToParagraphInfo.get(ref.id);
        if (paraInfo) {
          // Build complete citation from bibliographic fields if available
          // This ensures journal name, volume, issue, pages are included
          let finalConvertedText = ref.convertedText;

          if (ref.journalName || ref.volume || ref.pages) {
            // We have bibliographic details - build complete citation
            finalConvertedText = referenceStyleUpdaterService.buildCompleteApaCitation({
              id: ref.id,
              authors: ref.authors,
              year: ref.year,
              title: ref.title || '',
              journalName: ref.journalName,
              volume: ref.volume,
              issue: ref.issue,
              pages: ref.pages,
              doi: ref.doi,
              formattedApa: ref.convertedText,
              sortKey: ref.sortKey
            });
            logger.info(`[DOCX Processor] Built complete citation for ref ${newPosition}: "${finalConvertedText?.substring(0, 80)}..."`);
          }

          outputParagraphs.push({
            para: paraInfo.para,
            newNum: newPosition,
            origNum: paraInfo.origNum,
            isDeleted: false,
            isSwapped: false,
            convertedText: finalConvertedText  // Use complete citation with journal details
          });
          usedOrigPositions.add(paraInfo.origNum);
          newPosition++;
        }
      }

      // STEP 4: Detect swaps by comparing original vs new positions
      const detectedSwaps = new Set<string>();
      for (let i = 0; i < outputParagraphs.length; i++) {
        const itemA = outputParagraphs[i];
        for (let j = i + 1; j < outputParagraphs.length; j++) {
          const itemB = outputParagraphs[j];
          // If A was at position X and B was at position Y, and now A is at Y and B is at X, it's a swap
          if (itemA.origNum === itemB.newNum && itemB.origNum === itemA.newNum) {
            itemA.isSwapped = true;
            itemB.isSwapped = true;

            // Find author names for swap logging
            const refA = currentReferences.find(r => {
              const info = refIdToParagraphInfo.get(r.id);
              return info && info.origNum === itemA.origNum;
            });
            const refB = currentReferences.find(r => {
              const info = refIdToParagraphInfo.get(r.id);
              return info && info.origNum === itemB.origNum;
            });

            itemA.swappedWith = refB?.authors?.[0] || `Ref ${itemB.origNum}`;
            itemB.swappedWith = refA?.authors?.[0] || `Ref ${itemA.origNum}`;

            const swapKey = [itemA.origNum, itemB.origNum].sort().join('-');
            if (!detectedSwaps.has(swapKey)) {
              detectedSwaps.add(swapKey);
              swappedPairs.push({
                refA: refA?.authors?.[0] || `Ref ${itemA.origNum}`,
                refB: refB?.authors?.[0] || `Ref ${itemB.origNum}`
              });
              logger.info(`[DOCX Processor] Detected swap: ${itemA.origNum} (${refA?.authors?.[0]}) ↔ ${itemB.origNum} (${refB?.authors?.[0]})`);
            }
          }
        }
      }

      // STEP 5: Insert deleted paragraphs at their original positions
      // For clean export (acceptChanges=true), don't include deleted paragraphs at all
      if (!acceptChanges) {
        // Sort deleted paragraphs by their original position
        deletedParagraphs.sort((a, b) => a.origNum - b.origNum);

        for (const delInfo of deletedParagraphs) {
          // Insert at the original position (0-indexed)
          const insertIndex = Math.min(delInfo.origNum - 1, outputParagraphs.length);
          outputParagraphs.splice(insertIndex, 0, {
            para: delInfo.para,
            newNum: -1, // Will be marked as deleted
            origNum: delInfo.origNum,
            isDeleted: true,
            isSwapped: false
          });
          deleted++;
        }
      } else {
        // Clean export: just count the deleted items
        deleted = deletedParagraphs.length;
        logger.info(`[DOCX Processor] Clean export: ${deleted} deleted paragraphs will be omitted`);
      }

      // STEP 6: Generate the final XML for each paragraph
      const newRefParagraphs: string[] = [];

      for (const item of outputParagraphs) {
        let updatedPara = item.para;

        if (item.isDeleted) {
          if (acceptChanges) {
            // CLEAN EXPORT: Skip deleted paragraphs entirely (don't add to output)
            logger.info(`[DOCX Processor] Clean export: skipping deleted paragraph at position ${item.origNum}`);
            continue;  // Skip this paragraph
          } else {
            // TRACK CHANGES: Mark with strikethrough
            updatedPara = updatedPara.replace(/<w:t(\s[^>]*)?>([^<]*)<\/w:t>/g, '<w:delText$1>$2</w:delText>');

            let localRevId = revisionId;
            updatedPara = updatedPara.replace(
              /(<w:r\b[^>]*>)([\s\S]*?)(<\/w:r>)/g,
              (match, openTag, content, closeTag) => {
                const newContent = content.replace(/<w:rPr>/, '<w:rPr><w:highlight w:val="red"/>');
                const contentWithHighlight = content.includes('<w:rPr>') ? newContent : content.replace(/(<w:delText)/, '<w:rPr><w:highlight w:val="red"/></w:rPr>$1');
                const result = `<w:del w:id="${localRevId}" w:author="${author}" w:date="${date}">${openTag}${contentWithHighlight}${closeTag}</w:del>`;
                localRevId++;
                return result;
              }
            );
            revisionId = localRevId;
            logger.info(`[DOCX Processor] Marked as deleted (in place): original position ${item.origNum}`);
          }
        } else {
          // Active reference - may need number update and/or swap highlighting
          // Using bounded quantifiers to prevent ReDoS on malformed XML
          const numberPatterns = [
            { pattern: new RegExp(`(<w:t[^>]{0,${REGEX_LIMITS.MAX_ATTR_LENGTH}}>)\\s*(\\d+)\\.\\s*`), format: 'dot' },
            { pattern: new RegExp(`(<w:t[^>]{0,${REGEX_LIMITS.MAX_ATTR_LENGTH}}>)\\s*(\\d+)\\s+`), format: 'space' },
            { pattern: new RegExp(`(<w:t[^>]{0,${REGEX_LIMITS.MAX_ATTR_LENGTH}}>)\\s*\\[(\\d+)\\]\\s*`), format: 'bracket' },
          ];

          for (const { pattern, format } of numberPatterns) {
            const match = updatedPara.match(pattern);
            if (match) {
              const originalNumber = parseInt(match[2]);
              const newNumber = item.newNum;

              if (originalNumber !== newNumber) {
                const oldNumStr = format === 'bracket' ? `[${originalNumber}]` : `${originalNumber}.`;
                const newNumStr = format === 'bracket' ? `[${newNumber}]` : `${newNumber}.`;

                if (acceptChanges) {
                  // CLEAN EXPORT: Just replace the number directly
                  updatedPara = updatedPara.replace(pattern, `$1${newNumStr}\t`);
                  reordered++;
                  logger.info(`[DOCX Processor] Clean export: Reference number ${originalNumber} → ${newNumber}`);
                } else {
                  // TRACK CHANGES: Use del/ins markup
                  // Use yellow highlight for swapped references
                  const highlightColor = item.isSwapped ? 'yellow' : 'cyan';

                  updatedPara = updatedPara.replace(pattern, (fullMatch, tagPrefix) => {
                    let trackChange = `${tagPrefix}</w:t></w:r>` +
                      `<w:del w:id="${revisionId}" w:author="${author}" w:date="${date}">` +
                      `<w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:delText>${oldNumStr}\t</w:delText></w:r></w:del>` +
                      `<w:ins w:id="${revisionId + 1}" w:author="${author}" w:date="${date}">` +
                      `<w:r><w:rPr><w:highlight w:val="${highlightColor}"/></w:rPr><w:t>${newNumStr}\t</w:t></w:r></w:ins>`;

                    trackChange += `<w:r><w:t>`;
                    return trackChange;
                  });
                  revisionId += 2;
                  reordered++;
                  logger.info(`[DOCX Processor] Reference number: ${originalNumber} → ${newNumber}${item.isSwapped ? ' (SWAPPED with ' + item.swappedWith + ')' : ''}`);

                  // If swapped, also highlight the entire reference content with yellow
                  if (item.isSwapped) {
                    updatedPara = this.addHighlightToAllText(updatedPara, 'yellow');
                  }
                }
                // Number was successfully changed
              } else if (!acceptChanges && item.isSwapped && item.swappedWith) {
                // Track Changes only: Number stayed the same BUT position was swapped - highlight entire paragraph
                updatedPara = this.addHighlightToAllText(updatedPara, 'yellow');
                reordered++;
                logger.info(`[DOCX Processor] Reference ${originalNumber} position swapped with ${item.swappedWith} - highlighted`);
              } else {
                // No change needed, just ensure number is correct
                updatedPara = updatedPara.replace(pattern, `$1${newNumber}.\t`);
              }
              break;
            }
          }

          // STYLE CONVERSION: If converted text exists, replace the reference content
          if (item.convertedText) {
            // Check if this is a numbered or unnumbered reference (using safe bounded regex)
            const paraFullText = safeExtractParagraphText(updatedPara);
            const isNumberedRef = /^\s*\d+[\.\)\]]/.test(paraFullText);

            if (isNumberedRef) {
              // Use existing method for numbered references
              updatedPara = this.replaceReferenceContent(updatedPara, item.convertedText, item.newNum, author, date, revisionId, acceptChanges);
              logger.info(`[DOCX Processor] Applied style conversion for NUMBERED reference ${item.newNum} (acceptChanges=${acceptChanges})`);
            } else {
              // Use new method for unnumbered (author-first) references
              updatedPara = this.replaceUnnumberedReferenceContent(updatedPara, item.convertedText, author, date, revisionId, acceptChanges);
              logger.info(`[DOCX Processor] Applied style conversion for UNNUMBERED reference ${item.newNum} (acceptChanges=${acceptChanges})`);
            }
            if (!acceptChanges) {
              revisionId += 2;
            }
          }
        }

        newRefParagraphs.push(updatedPara);
      }

      // Reconstruct References section
      // Find position of header paragraph in original XML
      const headerParaForIndex = headerParagraph || '';
      const headerIndex = referencesXML.indexOf(headerParaForIndex);
      const beforeHeader = referencesXML.substring(0, headerIndex);

      // Reconstruct: beforeHeader + header + new ref paragraphs + preserved content (correspondence, tables, etc.)
      const newReferencesXML = beforeHeader + headerParagraph + newRefParagraphs.join('') + preservedContent;

      logger.info(`[DOCX Processor] Reconstructed references section, preserved ${preservedContent.length} chars of non-reference content`);

      logger.info(`[DOCX Processor] References updated: ${reordered} reordered, ${deleted} deleted, ${swappedPairs.length} swaps detected`);
      logger.info(`[DOCX Processor] Paragraphs physically reordered to match database order`);

      return {
        xml: newReferencesXML,
        reordered,
        deleted,
        swapped: swappedPairs,
        nextRevisionId: revisionId
      };
    } catch (error: unknown) {
      // Log full error with stack trace for debugging
      logger.error('[DOCX Processor] Failed to update references section:', error);
      return { xml: referencesXML, reordered: 0, deleted: 0, swapped: [], nextRevisionId: revisionId };
    }
  }


  /**
   * Replace reference content with converted style text
   * Preserves the reference number but replaces the rest of the content
   * @param acceptChanges - If true, apply changes cleanly without Track Changes markup
   */
  private replaceReferenceContent(
    paragraphXml: string,
    convertedText: string,
    refNumber: number,
    author: string,
    date: string,
    revisionId: number,
    acceptChanges: boolean = false
  ): string {
    // Extract all text from the paragraph (using safe bounded regex)
    const fullText = safeExtractParagraphText(paragraphXml);

    // Find where the content starts (after the number and period/tab)
    const contentStartMatch = fullText.match(/^\s*\d+[\.\)\]]\s*/);
    if (!contentStartMatch) {
      // No number pattern found, return original
      return paragraphXml;
    }

    const numberPart = contentStartMatch[0];
    const oldContent = fullText.substring(numberPart.length).trim();
    const newContent = convertedText.trim();

    logger.info(`[DOCX Processor] replaceReferenceContent - Ref ${refNumber}:`);
    logger.info(`[DOCX Processor]   OLD: "${oldContent.substring(0, 100)}..."`);
    logger.info(`[DOCX Processor]   NEW: "${newContent.substring(0, 100)}..."`);
    logger.info(`[DOCX Processor]   SAME: ${oldContent === newContent}`);

    // If content is the same, no change needed
    if (oldContent === newContent) {
      logger.info(`[DOCX Processor]   -> Skipping (no change needed)`);
      return paragraphXml;
    }

    // Find the first text run after the number and replace with Track Changes
    // Strategy: Find a <w:t> tag that contains content after the number, wrap in del/ins

    // Simplified approach: Replace all text content after number with Track Changes
    // Find position of content in the XML
    let result = paragraphXml;

    // Find text runs with content
    const runRegex = /(<w:r\b[^>]*>)([\s\S]*?)(<\/w:r>)/g;
    let runMatch;
    let foundNumber = false;
    let contentRuns: { start: number; end: number; content: string }[] = [];

    while ((runMatch = runRegex.exec(paragraphXml)) !== null) {
      const runContent = runMatch[2];
      // Use safe bounded regex for text extraction (single match)
      const textMatches = safeRegexExec(createSafeTextTagRegex(), runContent, 1);
      const textMatch = textMatches.length > 0 ? textMatches[0] : null;
      if (textMatch) {
        const text = textMatch[2];
        // Check if this run contains the number
        if (!foundNumber && /^\s*\d+[\.\)\]]/.test(text)) {
          foundNumber = true;
          // This run has the number, content starts after
          const afterNumMatch = text.match(/^\s*\d+[\.\)\]]\s*(.*)/);
          if (afterNumMatch && afterNumMatch[1]) {
            contentRuns.push({
              start: runMatch.index,
              end: runMatch.index + runMatch[0].length,
              content: afterNumMatch[1]
            });
          }
        } else if (foundNumber && text.trim()) {
          // This is content after the number
          contentRuns.push({
            start: runMatch.index,
            end: runMatch.index + runMatch[0].length,
            content: text
          });
        }
      }
    }

    if (contentRuns.length === 0) {
      return paragraphXml;
    }

    if (acceptChanges) {
      // CLEAN EXPORT: Replace content directly without Track Changes
      // Find the number run and replace content directly after it
      // Using bounded quantifiers to prevent ReDoS
      const cleanReplacePattern = new RegExp(
        `(<w:r\\b[^>]{0,${REGEX_LIMITS.MAX_ATTR_LENGTH}}>[\\s\\S]*?<w:t[^>]{0,${REGEX_LIMITS.MAX_ATTR_LENGTH}}>\\s*\\d+[.\\)\\]]\\s*)([^<]{0,${REGEX_LIMITS.MAX_TEXT_LENGTH}})(<\\/w:t>[\\s\\S]*?<\\/w:r>)`
      );
      result = paragraphXml.replace(
        cleanReplacePattern,
        (match, beforeContent, contentAfterNum, afterTag) => {
          // Replace content directly
          return `${beforeContent}${afterTag}<w:r><w:t>${this.escapeXml(newContent)}</w:t></w:r>`;
        }
      );

      // If the simple replacement didn't work, try a more aggressive approach
      if (result === paragraphXml) {
        const insertPoint = paragraphXml.indexOf('</w:r>', paragraphXml.search(/\d+[\.\)\]]/));
        if (insertPoint > 0) {
          result = paragraphXml.substring(0, insertPoint + 6) +
            `<w:r><w:t>${this.escapeXml(newContent)}</w:t></w:r>` +
            paragraphXml.substring(insertPoint + 6);
          logger.info(`[DOCX Processor] Style conversion applied via insertion (clean)`);
        }
      }
    } else {
      // TRACK CHANGES: Build Track Changes: delete old content, insert new content
      const trackChangeMarkup =
        `<w:del w:id="${revisionId}" w:author="${author}" w:date="${date}">` +
        `<w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:delText>${this.escapeXml(oldContent)}</w:delText></w:r></w:del>` +
        `<w:ins w:id="${revisionId + 1}" w:author="${author}" w:date="${date}">` +
        `<w:r><w:rPr><w:highlight w:val="green"/></w:rPr><w:t>${this.escapeXml(newContent)}</w:t></w:r></w:ins>`;

      // Find the number run and append Track Changes after it
      // Using bounded quantifiers to prevent ReDoS
      const trackChangePattern = new RegExp(
        `(<w:r\\b[^>]{0,${REGEX_LIMITS.MAX_ATTR_LENGTH}}>[\\s\\S]*?<w:t[^>]{0,${REGEX_LIMITS.MAX_ATTR_LENGTH}}>\\s*\\d+[.\\)\\]]\\s*)([^<]{0,${REGEX_LIMITS.MAX_TEXT_LENGTH}})(<\\/w:t>[\\s\\S]*?<\\/w:r>)`
      );
      result = paragraphXml.replace(
        trackChangePattern,
        (match, beforeContent, contentAfterNum, afterTag) => {
          if (contentAfterNum.trim()) {
            // Number and some content in same run
            return `${beforeContent}${afterTag}${trackChangeMarkup}`;
          }
          return match;
        }
      );

      // If the simple replacement didn't work, try a more aggressive approach
      if (result === paragraphXml) {
        // Find the last </w:r> before content and insert Track Changes there
        const insertPoint = paragraphXml.indexOf('</w:r>', paragraphXml.search(/\d+[\.\)\]]/));
        if (insertPoint > 0) {
          result = paragraphXml.substring(0, insertPoint + 6) +
            trackChangeMarkup +
            paragraphXml.substring(insertPoint + 6);

          // Remove original content runs (simplified - just mark success)
          logger.info(`[DOCX Processor] Style conversion applied via insertion`);
        }
      }
    }

    return result;
  }

  /**
   * Replace ENTIRE reference content for unnumbered references (author-first format)
   * SEPARATE from replaceReferenceContent to avoid changing existing numbered ref logic
   * @param acceptChanges - If true, apply changes cleanly without Track Changes markup
   */
  private replaceUnnumberedReferenceContent(
    paragraphXml: string,
    convertedText: string,
    author: string,
    date: string,
    revisionId: number,
    acceptChanges: boolean = false
  ): string {
    // Extract all text from the paragraph (using safe bounded regex)
    const fullText = safeExtractParagraphText(paragraphXml);

    const newContent = convertedText.trim();

    logger.info(`[DOCX Processor] replaceUnnumberedReferenceContent (acceptChanges=${acceptChanges}):`);
    logger.info(`[DOCX Processor]   OLD: "${fullText.substring(0, 100)}..."`);
    logger.info(`[DOCX Processor]   NEW: "${newContent.substring(0, 100)}..."`);

    // If content is essentially the same, no change needed
    if (fullText === newContent) {
      logger.info(`[DOCX Processor]   -> Skipping (no change needed)`);
      return paragraphXml;
    }

    // Extract paragraph properties if any
    const pPrMatch = paragraphXml.match(/<w:pPr>[\s\S]*?<\/w:pPr>/);
    const pPr = pPrMatch ? pPrMatch[0] : '';

    // Find opening and closing paragraph tags
    const pOpenMatch = paragraphXml.match(/^<w:p[^>]*>/);
    const pOpen = pOpenMatch ? pOpenMatch[0] : '<w:p>';

    let result: string;

    if (acceptChanges) {
      // CLEAN EXPORT: Replace content directly without Track Changes
      result = `${pOpen}${pPr}<w:r><w:t>${this.escapeXml(newContent)}</w:t></w:r></w:p>`;
      logger.info(`[DOCX Processor] Unnumbered reference style conversion applied (clean)`);
    } else {
      // TRACK CHANGES: Build Track Changes markup
      const trackChangeMarkup =
        `<w:del w:id="${revisionId}" w:author="${author}" w:date="${date}">` +
        `<w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:delText>${this.escapeXml(fullText)}</w:delText></w:r></w:del>` +
        `<w:ins w:id="${revisionId + 1}" w:author="${author}" w:date="${date}">` +
        `<w:r><w:rPr><w:highlight w:val="green"/></w:rPr><w:t>${this.escapeXml(newContent)}</w:t></w:r></w:ins>`;

      result = `${pOpen}${pPr}${trackChangeMarkup}</w:p>`;
      logger.info(`[DOCX Processor] Unnumbered reference style conversion applied (track changes)`);
    }

    return result;
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async updateSettingsForTrackChanges(zip: any): Promise<void> {
    try {
      let settingsXML = await zip.file('word/settings.xml')?.async('string');
      if (settingsXML) {
        // Security: Sanitize XML to prevent XXE attacks
        settingsXML = sanitizeXML(settingsXML);
        if (!settingsXML.includes('<w:trackRevisions')) {
          settingsXML = settingsXML.replace('</w:settings>', '<w:trackRevisions/></w:settings>');
          zip.file('word/settings.xml', settingsXML);
        }
      }
    } catch (error) {
      logger.warn('[DOCX Processor] Could not update settings:', error);
    }
  }

  /**
   * Simple replacement without track changes
   */
  async replaceCitations(
    originalBuffer: Buffer,
    replacements: CitationReplacement[]
  ): Promise<Buffer> {
    if (replacements.length === 0) return originalBuffer;

    const fileSize = originalBuffer.length;

    // Circuit breaker check
    checkCircuitBreaker(fileSize);

    return withMemoryTracking('DOCX replaceCitations', async () => {
      try {
        // Security: Check buffer size
        if (fileSize > SECURITY_LIMITS.MAX_DOCX_SIZE) {
          throw new FileTooLargeError(
            fileSize,
            SECURITY_LIMITS.MAX_DOCX_SIZE,
            `DOCX file too large: ${Math.round(fileSize / 1024 / 1024)}MB`
          );
        }

        const zip = await JSZip.loadAsync(originalBuffer);

      // Security: Validate DOCX structure
      const structureValidation = validateDOCXStructure(zip);
      if (!structureValidation.valid) {
        throw AppError.badRequest(`Invalid DOCX structure: ${structureValidation.error}`, 'INVALID_DOCX_STRUCTURE');
      }

      let documentXML = await zip.file('word/document.xml')?.async('string');
      if (!documentXML) throw AppError.badRequest('Invalid DOCX: word/document.xml not found', 'INVALID_DOCX_STRUCTURE');

      // Security: Sanitize XML to prevent XXE attacks
      documentXML = sanitizeXML(documentXML);

      const changeMap = new Map<string, string>();
      for (const r of replacements) {
        if (!changeMap.has(r.oldText)) changeMap.set(r.oldText, r.newText);
      }

      // Placeholder approach for swaps
      const placeholders = new Map<string, string>();
      let idx = 0;
      for (const [oldText, newText] of changeMap) {
        const ph = `__CITE_PH_${idx}__`;
        placeholders.set(ph, newText);
        const regex = new RegExp(this.escapeRegex(oldText), 'g');
        documentXML = documentXML.replace(regex, ph);
        idx++;
      }

      for (const [ph, newText] of placeholders) {
        const regex = new RegExp(this.escapeRegex(ph), 'g');
        documentXML = documentXML.replace(regex, newText);
      }

      zip.file('word/document.xml', documentXML);
      const result = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

      // Memory cleanup: Release JSZip resources and large strings
      cleanupZip(zip);
      documentXML = '';
      changeMap.clear();
      placeholders.clear();

      recordSuccess();
      return result;
    } catch (error: unknown) {
      recordFailure();
      // Log full error with stack trace for debugging
      logger.error('[DOCX Processor] Failed to replace style references:', error);
      throw error;
    }
    }); // End withMemoryTracking
  }

  async validateDOCX(buffer: Buffer): Promise<{ valid: boolean; error?: string }> {
    try {
      // Quick size check before processing
      if (buffer.length > SECURITY_LIMITS.MAX_DOCX_SIZE) {
        return {
          valid: false,
          error: `File too large: ${Math.round(buffer.length / 1024 / 1024)}MB exceeds ${Math.round(SECURITY_LIMITS.MAX_DOCX_SIZE / 1024 / 1024)}MB limit`
        };
      }

      await this.extractText(buffer);
      return { valid: true };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { valid: false, error: errorMessage };
    }
  }

  async getStatistics(buffer: Buffer): Promise<{ wordCount: number; paragraphCount: number; pageCount: number }> {
    // extractText already handles memory safety
    const content = await this.extractText(buffer);
    const words = content.text.split(/\s+/).filter(w => w.length > 0);
    const paragraphs = content.text.split(/\n\n+/);
    return { wordCount: words.length, paragraphCount: paragraphs.length, pageCount: Math.ceil(words.length / 250) };
  }

  async updateReferences(originalBuffer: Buffer, _newReferences: string[]): Promise<Buffer> {
    return originalBuffer;
  }

  /**
   * Apply changes to a DOCX document with Track Changes markup
   * @param originalBuffer - The original DOCX buffer
   * @param changes - Array of changes to apply
   * @returns Modified DOCX buffer with track changes
   */
  async applyChanges(
    originalBuffer: Buffer,
    changes: Array<{ type: string; beforeText: string; afterText: string; metadata?: Record<string, unknown> | null }>
  ): Promise<Buffer> {
    if (changes.length === 0) {
      logger.info('[DOCXProcessor] No changes to apply, returning original buffer');
      return originalBuffer;
    }

    const fileSize = originalBuffer.length;

    // Circuit breaker check
    checkCircuitBreaker(fileSize);

    return withMemoryTracking('DOCX applyChanges', async () => {
      try {
        // Security: Check buffer size
        if (fileSize > SECURITY_LIMITS.MAX_DOCX_SIZE) {
          throw new FileTooLargeError(
            fileSize,
            SECURITY_LIMITS.MAX_DOCX_SIZE,
            `DOCX file too large: ${Math.round(fileSize / 1024 / 1024)}MB`
          );
        }

        logger.info(`[DOCXProcessor] Applying ${changes.length} changes with Track Changes`);

        const zip = await JSZip.loadAsync(originalBuffer);

        // Security: Validate DOCX structure
        const structureValidation = validateDOCXStructure(zip);
        if (!structureValidation.valid) {
          throw AppError.badRequest(`Invalid DOCX structure: ${structureValidation.error}`, 'INVALID_DOCX_STRUCTURE');
        }

        let documentXML = await zip.file('word/document.xml')?.async('string');
        if (!documentXML) {
          throw AppError.badRequest('Invalid DOCX: word/document.xml not found', 'INVALID_DOCX_STRUCTURE');
        }

        // Security: Sanitize XML to prevent XXE attacks
        documentXML = sanitizeXML(documentXML);

        // Track Changes metadata
        const author = 'Citation Manager';
        const revisionDate = new Date().toISOString();
        let revisionId = 1;

        // PHASE 1: Replace text with placeholders to avoid interference
        // IMPORTANT: Only replace in-text citations in the BODY, not in the References section
        // to avoid changing issue numbers like "60(5)" which look like citations
        const placeholders = new Map<string, {
          type: string;
          oldText: string;
          newText: string;
        }>();
        let phIndex = 0;

        // Collect reference reorder info for PHASE 4
        const referenceReorderMap: Array<{
          oldPosition: number;
          newPosition: number;
          content: string;
          contentStart: string;
        }> = [];

        // Find the References section to exclude it from in-text citation replacement
        // Find the position of <w:t>References</w:t> or <w:t xml:space="preserve">References</w:t>
        const refTextMatch = documentXML.match(/<w:t[^>]*>References<\/w:t>/i);
        let refSectionStart = documentXML.length;

        if (refTextMatch) {
          const refTextIndex = documentXML.indexOf(refTextMatch[0]);
          // Find the enclosing <w:p> tag by searching backwards from the References text
          const beforeRefText = documentXML.substring(0, refTextIndex);
          const lastParagraphStart = beforeRefText.lastIndexOf('<w:p ');
          const lastParagraphStartAlt = beforeRefText.lastIndexOf('<w:p>');
          refSectionStart = Math.max(lastParagraphStart, lastParagraphStartAlt);
          if (refSectionStart < 0) {
            refSectionStart = documentXML.length;
          }
        }

        // Split document into body and references
        let bodyXML = documentXML.substring(0, refSectionStart);
        let referencesXML = documentXML.substring(refSectionStart);

        logger.info(`[DOCXProcessor] Body length: ${bodyXML.length}, References length: ${referencesXML.length}`);

        // Separate reference section changes from body changes
        const referenceSectionPlaceholders = new Map<string, { type: string; oldText: string; newText: string }>();
        let refPhIndex = 0;

        for (const change of changes) {
          if (!change.beforeText) continue;

          // Skip reference RENUMBER changes in Phase 1 - they're handled in Phase 4
          if (change.type === 'RENUMBER' && change.beforeText.match(/^\[\d+\]/)) {
            continue;
          }

          // Handle REFERENCE_SECTION_EDIT changes - these go in the References section, not body
          // Uses ID-based matching: referenceId -> author name -> paragraph in DOCX
          if (change.type === 'REFERENCE_SECTION_EDIT') {
            const refPlaceholder = `__REF_CHANGE_PH_${refPhIndex}__`;
            referenceSectionPlaceholders.set(refPlaceholder, {
              type: change.type,
              oldText: change.beforeText,
              newText: change.afterText || ''
            });
            refPhIndex++;

            logger.info(`[DOCXProcessor] Processing REFERENCE_SECTION_EDIT:`);
            logger.info(`[DOCXProcessor]   referenceId: ${change.metadata?.referenceId || 'unknown'}`);
            logger.info(`[DOCXProcessor]   afterText: "${(change.afterText || '').substring(0, 100)}..."`);

            let found = false;
            const meta = change.metadata as Record<string, unknown> | undefined;

            // ID-BASED MATCHING: Use referenceId to find paragraph by author name
            if (meta?.referenceId) {
              // Extract author info from the old values or beforeText
              let authorLastName: string | undefined;

              // Try to get author from oldValues in metadata
              const oldValues = meta.oldValues as Record<string, unknown> | undefined;
              if (oldValues?.authors) {
                const authors = oldValues.authors as string[];
                if (authors.length > 0) {
                  // Extract last name from first author
                  authorLastName = String(authors[0]).split(/[,\s]/)[0];
                  logger.info(`[DOCXProcessor] Using author from metadata: "${authorLastName}"`);
                }
              }

              // Fallback: extract author from beforeText (format: "Author1, Author2 (Year). Title...")
              if (!authorLastName && change.beforeText) {
                const authorMatch = change.beforeText.match(/^([A-Z][a-z]+)/);
                if (authorMatch) {
                  authorLastName = authorMatch[1];
                  logger.info(`[DOCXProcessor] Extracted author from beforeText: "${authorLastName}"`);
                }
              }

              // Guard against empty or too-short author names that would create unsafe regex patterns
              // \b\b (empty) matches at every word boundary, causing wrong replacements
              if (!authorLastName || authorLastName.length < 2) {
                logger.warn(`[DOCXProcessor] Author name too short for safe matching: "${authorLastName || ''}", falling through to exact text match`);
              } else if (authorLastName && authorLastName.length >= 2) {
                // Find paragraph containing this author in the References section
                const escapedAuthor = authorLastName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                // Use safe bounded regex to find paragraph with author name
                const paraPattern = new RegExp(
                  `<w:p[^>]{0,500}>(?:(?!</w:p>).){0,10000}?\\b${escapedAuthor}\\b(?:(?!</w:p>).){0,10000}?</w:p>`,
                  'is'
                );
                const paraMatch = referencesXML.match(paraPattern);

                if (paraMatch) {
                  const fullParaXML = paraMatch[0];
                  // Extract the text content from the paragraph
                  const textMatches = fullParaXML.match(/<w:t[^>]*>([^<]*)<\/w:t>/g);
                  if (textMatches) {
                    const paragraphText = textMatches
                      .map(m => m.replace(/<\/?w:t[^>]*>/g, ''))
                      .join('');

                    logger.info(`[DOCXProcessor] Found paragraph by author "${authorLastName}": "${paragraphText.substring(0, 80)}..."`);

                    // Replace this paragraph's text with placeholder
                    const replaceResult = this.replaceCitationUniversal(referencesXML, paragraphText.trim(), refPlaceholder);
                    if (replaceResult.count > 0) {
                      referencesXML = replaceResult.xml;
                      // Update placeholder mapping with actual old text from DOCX
                      referenceSectionPlaceholders.set(refPlaceholder, {
                        type: change.type,
                        oldText: paragraphText.trim(),
                        newText: change.afterText || ''
                      });
                      logger.info(`[DOCXProcessor] ✓ ID-based match succeeded for reference ${meta.referenceId}`);
                      found = true;
                    }
                  }
                } else {
                  logger.warn(`[DOCXProcessor] Could not find paragraph with author "${authorLastName}" in References`);
                }
              }
            }

            // Fallback: try exact text match
            if (!found) {
              const result = this.replaceCitationUniversal(referencesXML, change.beforeText, refPlaceholder);
              if (result.count > 0) {
                referencesXML = result.xml;
                logger.info(`[DOCXProcessor] ✓ Exact text match succeeded`);
                found = true;
              } else {
                // Try with XML-encoded version (& -> &amp;)
                const xmlEncodedText = change.beforeText.replace(/&/g, '&amp;');
                if (xmlEncodedText !== change.beforeText) {
                  const altResult = this.replaceCitationUniversal(referencesXML, xmlEncodedText, refPlaceholder);
                  if (altResult.count > 0) {
                    referencesXML = altResult.xml;
                    logger.info(`[DOCXProcessor] ✓ XML-encoded text match succeeded`);
                    found = true;
                  }
                }
              }
            }

            if (!found) {
              logger.warn(`[DOCXProcessor] ✗ Could not find reference in document (id: ${meta?.referenceId || 'unknown'})`);
            }
            continue;
          }

          const placeholder = `__CHANGE_PH_${phIndex}__`;
          placeholders.set(placeholder, {
            type: change.type,
            oldText: change.beforeText,
            newText: change.afterText || ''
          });
          phIndex++;

          // Only replace in the BODY section (before References)
          // This prevents changing issue numbers like "(5)" in "60(5):812-4"
          const result = this.replaceCitationUniversal(bodyXML, change.beforeText, placeholder);
          bodyXML = result.xml;

          let found = false;
          if (result.count > 0) {
            logger.info(`[DOCXProcessor] ✓ Replaced "${change.beforeText}" with placeholder in body (${result.count}x)`);
            found = true;
          } else {
            // Try with XML-encoded version (& -> &amp;)
            const xmlEncodedText = change.beforeText.replace(/&/g, '&amp;');
            if (xmlEncodedText !== change.beforeText) {
              const altResult = this.replaceCitationUniversal(bodyXML, xmlEncodedText, placeholder);
              bodyXML = altResult.xml;
              if (altResult.count > 0) {
                logger.info(`[DOCXProcessor] ✓ Replaced XML-encoded "${xmlEncodedText}" with placeholder in body (${altResult.count}x)`);
                found = true;
              }
            }
          }

          if (!found) {
            // Try format variants: brackets↔parens, spacing, ranges
            const variants = this.generateCitationFormatVariants(change.beforeText);
            for (const variant of variants) {
              const varResult = this.replaceCitationUniversal(bodyXML, variant, placeholder);
              bodyXML = varResult.xml;
              if (varResult.count > 0) {
                logger.info(`[DOCXProcessor] ✓ Replaced variant "${variant}" (for "${change.beforeText}") with placeholder (${varResult.count}x)`);
                // Update oldText to show the actual DOCX text in track changes
                const phInfo = placeholders.get(placeholder);
                if (phInfo) phInfo.oldText = variant;
                found = true;
                break;
              }
            }
          }

          if (!found) {
            logger.warn(`[DOCXProcessor] ✗ Could not find "${change.beforeText}" in document body`);
          }
        }

        // Recombine body and references
        documentXML = bodyXML + referencesXML;

        // PHASE 2: Replace placeholders with Track Changes markup
        for (const [placeholder, info] of placeholders) {
          const pattern = new RegExp(
            `<w:t([^>]{0,${REGEX_LIMITS.MAX_ATTR_LENGTH}})>([^<]{0,${REGEX_LIMITS.MAX_TEXT_LENGTH}})` +
            this.escapeRegex(placeholder) +
            `([^<]{0,${REGEX_LIMITS.MAX_TEXT_LENGTH}})</w:t>`,
            'g'
          );

          let replacement: string;
          const escapedOld = this.escapeXml(info.oldText);
          const escapedNew = this.escapeXml(info.newText);

          // Determine highlight color based on change type
          let highlightColor = 'cyan'; // default
          if (info.type === 'INTEXT_STYLE_CONVERSION' || info.type === 'REFERENCE_STYLE_CONVERSION') {
            highlightColor = 'green';
          } else if (info.type === 'DELETE') {
            highlightColor = 'red';
          } else if (info.type === 'RENUMBER') {
            highlightColor = 'yellow';
          }

          if (info.type === 'DELETE' || !info.newText) {
            // DELETE: Show strikethrough with red highlight
            replacement = `<w:t$1>$2</w:t></w:r>` +
                          `<w:del w:id="${revisionId}" w:author="${author}" w:date="${revisionDate}">` +
                          `<w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:delText>${escapedOld}</w:delText></w:r></w:del>` +
                          `<w:r><w:t>$3</w:t>`;
            revisionId++;
          } else {
            // CHANGE: Show strikethrough (old) + underline (new) with colored highlight
            replacement = `<w:t$1>$2</w:t></w:r>` +
                          `<w:del w:id="${revisionId}" w:author="${author}" w:date="${revisionDate}">` +
                          `<w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:delText>${escapedOld}</w:delText></w:r></w:del>` +
                          `<w:ins w:id="${revisionId + 1}" w:author="${author}" w:date="${revisionDate}">` +
                          `<w:r><w:rPr><w:highlight w:val="${highlightColor}"/></w:rPr><w:t>${escapedNew}</w:t></w:r></w:ins>` +
                          `<w:r><w:t>$3</w:t>`;
            revisionId += 2;
          }

          documentXML = documentXML.replace(pattern, replacement);
        }

        // PHASE 2.1: Replace reference section placeholders with Track Changes markup
        for (const [placeholder, info] of referenceSectionPlaceholders) {
          const pattern = new RegExp(
            `<w:t([^>]{0,${REGEX_LIMITS.MAX_ATTR_LENGTH}})>([^<]{0,${REGEX_LIMITS.MAX_TEXT_LENGTH}})` +
            this.escapeRegex(placeholder) +
            `([^<]{0,${REGEX_LIMITS.MAX_TEXT_LENGTH}})</w:t>`,
            'g'
          );

          const escapedOld = this.escapeXml(info.oldText);
          const escapedNew = this.escapeXml(info.newText);

          // Reference edits use green highlighting
          const replacement = `<w:t$1>$2</w:t></w:r>` +
                            `<w:del w:id="${revisionId}" w:author="${author}" w:date="${revisionDate}">` +
                            `<w:r><w:rPr><w:highlight w:val="red"/></w:rPr><w:delText>${escapedOld}</w:delText></w:r></w:del>` +
                            `<w:ins w:id="${revisionId + 1}" w:author="${author}" w:date="${revisionDate}">` +
                            `<w:r><w:rPr><w:highlight w:val="green"/></w:rPr><w:t>${escapedNew}</w:t></w:r></w:ins>` +
                            `<w:r><w:t>$3</w:t>`;
          revisionId += 2;

          documentXML = documentXML.replace(pattern, replacement);
          logger.info(`[DOCXProcessor] Applied track changes to reference section edit`);
        }

        // Clean up empty elements
        documentXML = documentXML.replace(/<w:r><w:t><\/w:t><\/w:r>/g, '');
        documentXML = documentXML.replace(/<w:t><\/w:t>/g, '');

        // PHASE 3: Handle reference list changes and in-text citation deletions
        // Extract all paragraphs with their combined text for reliable searching
        const paragraphs = this.extractParagraphsWithText(documentXML);
        logger.info(`[DOCXProcessor] Extracted ${paragraphs.length} paragraphs for DELETE/RENUMBER processing`);

        // Process DELETE changes to strike through deleted references and citations
        // Process RENUMBER changes to update reference list numbers
        for (const change of changes) {
          if (change.type === 'DELETE' && change.beforeText) {
            // Check if this is a reference list deletion or an in-text citation deletion
            // Reference deletions can be:
            // 1. Vancouver/numbered style: "[N] Reference text..."
            // 2. Chicago/footnote style: Just the reference text (metadata stored separately)

            // Check for Chicago/footnote style via metadata field
            let isFootnoteStyleRef = false;
            let refPosition: number | null = null;
            if (change.metadata && typeof change.metadata === 'object') {
              const meta = change.metadata as Record<string, unknown>;
              if (meta.isFootnoteStyle === true) {
                isFootnoteStyleRef = true;
                refPosition = typeof meta.position === 'number' ? meta.position : null;
              }
            }

            // Check for numbered style format: "[N] Reference text..."
            const deleteMatch = change.beforeText.match(/^\[(\d+)\]\s*(.+)$/);

            // Determine if this is a reference deletion or in-text citation deletion
            const isReferenceDelete = deleteMatch || isFootnoteStyleRef;

            if (!isReferenceDelete) {
              // This is an in-text citation deletion (e.g., "(Bender et al., 2021)" or "¹")
              const citationText = change.beforeText.trim();
              logger.info(`[DOCXProcessor] Processing in-text citation DELETE: "${citationText}"`);

              // ID-BASED APPROACH: Use stored position/ID to find paragraph
              let citationFound = false;
              let targetParaId: string | null = null;

              // Try to get position info from metadata (stored during change creation)
              if (change.metadata && typeof change.metadata === 'object') {
                const meta = change.metadata as Record<string, unknown>;
                if (typeof meta.startOffset === 'number') {
                  // Build position map and find paragraph by offset
                  const positionMap = this.buildPositionToParagraphMap(paragraphs);
                  targetParaId = this.findParagraphByOffset(positionMap, meta.startOffset);
                  if (targetParaId) {
                    logger.info(`[DOCXProcessor] Found citation by offset ${meta.startOffset} -> paraId=${targetParaId}`);
                  }
                }
              }

              // If we have a target paragraph ID, use it directly
              if (targetParaId) {
                const deleteResult = this.deleteCitationInParagraph(
                  documentXML,
                  targetParaId,
                  citationText,
                  revisionId,
                  author,
                  revisionDate
                );

                if (deleteResult.found) {
                  documentXML = deleteResult.xml;
                  revisionId++;
                  citationFound = true;
                  logger.info(`[DOCXProcessor] ✓ Deleted citation by ID: "${citationText}" (paraId=${targetParaId})`);
                }
              }

              // Fallback: search paragraphs for the citation text
              if (!citationFound) {
                // Normalize Unicode superscripts for fallback search (¹ → 1)
                const normalizedCitationText = normalizeSuperscripts(citationText);

                for (const para of paragraphs) {
                  if (!para.paraId) continue;
                  // Check for both original and normalized text
                  if (!para.combinedText.includes(citationText) && !para.combinedText.includes(normalizedCitationText)) continue;

                  logger.info(`[DOCXProcessor] Found citation by text search in paragraph ${para.paraId}`);

                  const deleteResult = this.deleteCitationInParagraph(
                    documentXML,
                    para.paraId,
                    citationText,
                    revisionId,
                    author,
                    revisionDate
                  );

                  if (deleteResult.found) {
                    documentXML = deleteResult.xml;
                    revisionId++;
                    citationFound = true;
                    logger.info(`[DOCXProcessor] ✓ Deleted citation: "${citationText}" (paraId=${para.paraId})`);
                    break;
                  }
                }
              }

              if (!citationFound) {
                logger.warn(`[DOCXProcessor] Could not find in-text citation to delete: "${citationText}"`);
              }
              continue;
            }

            // Handle reference deletion - get refNumber and refText based on style
            let refNumber: string;
            let refText: string;

            if (deleteMatch) {
              // Vancouver/numbered style: "[N] Reference text..."
              refNumber = deleteMatch[1];
              refText = deleteMatch[2].trim();
            } else if (isFootnoteStyleRef) {
              // Chicago/footnote style: reference text stored directly
              // Use position from metadata, or fallback to '0' if missing
              refNumber = refPosition !== null ? String(refPosition) : '0';
              refText = change.beforeText.trim();
              if (refPosition === null) {
                logger.warn(`[DOCXProcessor] Footnote style DELETE missing position in metadata, using 0`);
              }
            } else {
              // This branch is unreachable given isReferenceDelete = deleteMatch || isFootnoteStyleRef
              // If we somehow get here, it's a programming error - log and skip
              logger.error(`[DOCXProcessor] BUG: Unreachable code reached. isReferenceDelete=${isReferenceDelete}, deleteMatch=${!!deleteMatch}, isFootnoteStyleRef=${isFootnoteStyleRef}`);
              continue;
            }

            logger.info(`[DOCXProcessor] DELETE ref ${refNumber}: refText="${refText.substring(0, 80)}..." (footnoteStyle=${isFootnoteStyleRef})`);

            // ID-BASED APPROACH: Search in combined paragraph text, then use paraId to locate
            // This handles text split across multiple XML elements due to formatting
            let found = false;

            // Build search patterns from reference text
            const searchPatterns = [
              refText.substring(0, 80),  // First 80 chars
              refText.substring(0, 50),  // First 50 chars
              refText.substring(0, 30),  // First 30 chars
              // Extract author name for matching
              refText.match(/^([A-Z][a-z]+(?:[-'][A-Z][a-z]+)?)/)?.[1], // First author surname
            ].filter((t): t is string => !!t && t.length >= 3);

            // Search in extracted paragraphs (combined text, not raw XML)
            for (const pattern of searchPatterns) {
              if (found) break;

              for (const para of paragraphs) {
                if (found) break;
                if (!para.paraId) continue;

                // Check if this paragraph's combined text contains the search pattern
                if (para.combinedText.includes(pattern)) {
                  // Skip if this looks like an in-text citation paragraph (short, contains parentheses)
                  if (para.combinedText.length < 100 && para.combinedText.includes('(') && para.combinedText.includes(')')) {
                    // Check if this is actually a reference entry, not just a citation
                    // Reference entries typically have: a year, a period after the year, and length > 40 chars
                    const hasYear = /\b(19|20)\d{2}\b/.test(para.combinedText);
                    const hasRefStructure = para.combinedText.length > 40 && /\.\s/.test(para.combinedText);
                    if (!hasYear || !hasRefStructure) {
                      continue; // Skip this, likely an in-text citation
                    }
                  }

                  // Use the paragraph ID to reliably locate and delete
                  logger.info(`[DOCXProcessor] Found reference ${refNumber} in paragraph ${para.paraId}`);

                  const deleteResult = this.findAndDeleteParagraphById(
                    documentXML,
                    para.paraId,
                    revisionId,
                    author,
                    revisionDate
                  );

                  if (deleteResult.found) {
                    documentXML = deleteResult.xml;
                    revisionId++;
                    found = true;
                    logger.info(`[DOCXProcessor] ✓ Marked reference ${refNumber} as deleted using paraId=${para.paraId} (${deleteResult.deletedText.length} chars)`);
                  }
                }
              }
            }

            if (!found) {
              logger.warn(`[DOCXProcessor] Could not find reference ${refNumber} in document for deletion.`);
              logger.warn(`[DOCXProcessor] Search patterns tried: ${searchPatterns.slice(0, 3).map(t => `"${t.substring(0, 30)}..."`).join(', ')}`);
              logger.warn(`[DOCXProcessor] Available paragraphs: ${paragraphs.length}`);
            }
          }

          // Handle REFERENCE_REORDER - full reference section reordering by content matching
          if (change.type === 'REFERENCE_REORDER' && change.beforeText) {
            try {
              const parsed = JSON.parse(change.beforeText);
              if (!Array.isArray(parsed)) {
                logger.warn('[DOCXProcessor] REFERENCE_REORDER payload is not an array');
                continue;
              }
              let validCount = 0;
              for (let ri = 0; ri < parsed.length; ri++) {
                const ref = parsed[ri];
                if (
                  !Number.isInteger(ref?.position) || ref.position < 1 ||
                  typeof ref?.contentStart !== 'string' ||
                  ref.contentStart.trim().length === 0
                ) {
                  logger.warn('[DOCXProcessor] Skipping invalid REFERENCE_REORDER entry', ref);
                  continue;
                }
                referenceReorderMap.push({
                  oldPosition: ri + 1,
                  newPosition: ref.position,
                  content: ref.contentStart,
                  contentStart: ref.contentStart
                });
                validCount++;
              }
              logger.info(`[DOCXProcessor] REFERENCE_REORDER: ${validCount} valid references to reorder`);
            } catch (e) {
              logger.warn(`[DOCXProcessor] Failed to parse REFERENCE_REORDER data`, e);
            }
            continue;
          }

          // Handle RENUMBER changes for reference list - collect for reordering
          if (change.type === 'RENUMBER' && change.beforeText && change.afterText) {
            const beforeMatch = change.beforeText.match(/^\[(\d+)\]\s*(.+)$/s);
            const afterMatch = change.afterText.match(/^\[(\d+)\]\s*(.+)$/s);

            if (beforeMatch && afterMatch) {
              const beforeNum = parseInt(beforeMatch[1]);
              const afterNum = parseInt(afterMatch[1]);
              const refContent = beforeMatch[2]?.trim() || '';

              if (refContent && beforeNum !== afterNum) {
                referenceReorderMap.push({
                  oldPosition: beforeNum,
                  newPosition: afterNum,
                  content: refContent,
                  contentStart: refContent.substring(0, 30) // For matching
                });
                logger.info(`[DOCXProcessor] RENUMBER: [${beforeNum}] → [${afterNum}] for "${refContent.substring(0, 40)}..."`);
              }
            }
          }
        }

        // PHASE 4: Reorder reference section if we have reference RENUMBER changes
        if (referenceReorderMap.length > 0) {
          logger.info(`[DOCXProcessor] Reordering ${referenceReorderMap.length} references in document`);
          documentXML = this.reorderReferencesInXML(documentXML, referenceReorderMap, author, revisionDate, revisionId);
        }

        // Save modified document.xml
        zip.file('word/document.xml', documentXML);

        // Enable Track Revisions in settings.xml
        await this.updateSettingsForTrackChanges(zip);

        // Generate the modified DOCX
        const result = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

        // Memory cleanup
        cleanupZip(zip);
        documentXML = '';
        placeholders.clear();

        recordSuccess();
        logger.info(`[DOCXProcessor] Successfully applied ${changes.length} changes with Track Changes`);
        return result;
      } catch (error: unknown) {
        recordFailure();
        logger.error('[DOCXProcessor] Failed to apply changes:', error);
        throw error;
      }
    }); // End withMemoryTracking
  }

  /**
   * Get current circuit breaker status (for monitoring/debugging)
   * @param tenantId - Optional tenant ID to get specific tenant status
   */
  getCircuitBreakerStatus(tenantId?: string): {
    isOpen: boolean;
    consecutiveFailures: number;
    memoryUsage: ReturnType<typeof getMemoryUsage>;
    tenantCount: number;
  } {
    const breaker = getTenantBreaker(tenantId || '__global__');
    return {
      isOpen: breaker.isOpen,
      consecutiveFailures: breaker.consecutiveFailures,
      memoryUsage: getMemoryUsage(),
      tenantCount: tenantCircuitBreakers.size
    };
  }

  /**
   * Reorder references in the XML document based on the reorder map.
   * Finds reference paragraphs by content and reorders them with track changes.
   */
  private reorderReferencesInXML(
    xml: string,
    reorderMap: Array<{ oldPosition: number; newPosition: number; content: string; contentStart: string }>,
    _author: string,
    _revisionDate: string,
    _revisionId: number
  ): string {
    try {
      // Find the References section - look for "References" header
      const refSectionMatch = xml.match(/(<w:p[^>]*>.*?References.*?<\/w:p>)/is);
      if (!refSectionMatch) {
        logger.warn('[DOCXProcessor] Could not find References section header');
        return xml;
      }

      const refHeaderIndex = xml.indexOf(refSectionMatch[0]);
      if (refHeaderIndex < 0) {
        return xml;
      }

      // Get the content after "References" header
      const afterHeader = xml.substring(refHeaderIndex + refSectionMatch[0].length);

      // Find all paragraphs that contain reference content
      // Match complete <w:p>...</w:p> elements
      const paragraphRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
      const paragraphs: Array<{ xml: string; content: string; index: number }> = [];

      let match;
      let searchXml = afterHeader;
      let offset = 0;

      // Extract paragraphs until we hit a section break or run out of paragraphs
      while ((match = paragraphRegex.exec(searchXml)) !== null) {
        const pXml = match[0];
        // Extract text content from paragraph
        const textMatches = pXml.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
        const content = textMatches.map(t => t.replace(/<[^>]+>/g, '')).join('');

        // Stop if we hit another section (empty paragraph or different formatting)
        if (paragraphs.length > 0 && content.trim() === '' && paragraphs.length >= reorderMap.length) {
          break;
        }

        // Check if this paragraph contains reference content
        const matchedRef = reorderMap.find(r =>
          content.includes(r.contentStart) ||
          content.toLowerCase().includes(r.contentStart.toLowerCase().substring(0, 20))
        );

        if (matchedRef || (content.trim().length > 20 && paragraphs.length < reorderMap.length + 2)) {
          paragraphs.push({
            xml: pXml,
            content: content.trim(),
            index: match.index + offset
          });
        }

        // Limit to reasonable number of paragraphs
        if (paragraphs.length >= reorderMap.length + 5) {
          break;
        }
      }

      logger.info(`[DOCXProcessor] Found ${paragraphs.length} potential reference paragraphs`);

      if (paragraphs.length < 2) {
        logger.warn('[DOCXProcessor] Not enough paragraphs found for reordering');
        return xml;
      }

      // Match paragraphs to references using content
      const matchedParagraphs: Array<{ para: typeof paragraphs[0]; oldPos: number; newPos: number } | null> = [];

      for (const reorder of reorderMap) {
        const matchedPara = paragraphs.find(p =>
          p.content.includes(reorder.contentStart) ||
          p.content.toLowerCase().includes(reorder.contentStart.toLowerCase().substring(0, 25))
        );

        if (matchedPara) {
          matchedParagraphs.push({
            para: matchedPara,
            oldPos: reorder.oldPosition,
            newPos: reorder.newPosition
          });
          logger.info(`[DOCXProcessor] Matched ref [${reorder.oldPosition}→${reorder.newPosition}]: "${reorder.contentStart.substring(0, 30)}..."`);
        } else {
          logger.warn(`[DOCXProcessor] Could not match reference: "${reorder.contentStart.substring(0, 30)}..."`);
        }
      }

      if (matchedParagraphs.filter(Boolean).length < 2) {
        logger.warn('[DOCXProcessor] Not enough references matched for reordering');
        return xml;
      }

      // Sort by new position to get the desired order
      const sortedByNewPos = matchedParagraphs
        .filter((m): m is NonNullable<typeof m> => m !== null)
        .sort((a, b) => a.newPos - b.newPos);

      // Build the reordered paragraphs with track changes
      const reorderedXml = sortedByNewPos.map((m, idx) => {
        // Wrap in move tracking (simplified - just highlight changed positions)
        const oldPosInSorted = matchedParagraphs
          .filter((x): x is NonNullable<typeof x> => x !== null)
          .sort((a, b) => a.oldPos - b.oldPos)
          .findIndex(x => x.para === m.para);

        if (oldPosInSorted !== idx) {
          // Position changed - add a comment/highlight
          // For now, just return the paragraph (actual move tracking is complex in OOXML)
          return m.para.xml;
        }
        return m.para.xml;
      }).join('');

      // Replace the original paragraphs with reordered ones
      // IMPORTANT: Include ALL paragraphs in the range, not just matched ones.
      // Unmatched paragraphs (e.g., modified by REFERENCE_SECTION_EDIT track changes)
      // must be preserved — append them after the matched/reordered paragraphs.
      if (sortedByNewPos.length > 0) {
        // Use array indices as stable identity — xml strings may be duplicated across paragraphs
        const matchedIndices = new Set(sortedByNewPos.map(s => paragraphs.indexOf(s.para)));

        // Find the range of ALL reference paragraphs (first to last)
        // Use deterministic offsets from the parser instead of xml.indexOf() which can
        // match duplicate paragraph XML elsewhere in the document.
        const firstPara = paragraphs[0];
        const lastPara = paragraphs[paragraphs.length - 1];
        const afterHeaderOffset = refHeaderIndex + refSectionMatch[0].length;

        if (firstPara && lastPara) {
          const startIdx = afterHeaderOffset + firstPara.index;
          const endIdx = afterHeaderOffset + lastPara.index + lastPara.xml.length;
          if (startIdx > 0 && endIdx > startIdx) {
            // Collect unmatched paragraphs that fall within the range
            const unmatchedParas = paragraphs.filter((_p, i) => !matchedIndices.has(i));
            const unmatchedXml = unmatchedParas.map(p => p.xml).join('');

            if (unmatchedXml) {
              logger.info(`[DOCXProcessor] Preserving ${unmatchedParas.length} unmatched paragraph(s) in reference section`);
            }

            const before = xml.substring(0, startIdx);
            const after = xml.substring(endIdx);
            xml = before + reorderedXml + unmatchedXml + after;
            logger.info('[DOCXProcessor] Successfully reordered reference section');
          }
        }
      }

      return xml;
    } catch (error) {
      logger.error('[DOCXProcessor] Error reordering references:', error);
      return xml;
    }
  }
}

export const docxProcessorService = new DOCXProcessorService();
