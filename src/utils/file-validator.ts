/**
 * File Validator Utility
 * Provides magic byte validation to prevent MIME type spoofing attacks
 * Includes memory-efficient streaming validation for large files
 */

import { createReadStream } from 'fs';
import { logger } from '../lib/logger';

/**
 * Magic bytes (file signatures) for supported file types
 * These are the first few bytes of each file type that identify its true format
 */
const MAGIC_BYTES: Record<string, { signature: number[]; offset?: number }[]> = {
  // PDF: starts with %PDF
  'application/pdf': [
    { signature: [0x25, 0x50, 0x44, 0x46] } // %PDF
  ],

  // EPUB: ZIP archive with specific structure (PK signature)
  'application/epub+zip': [
    { signature: [0x50, 0x4B, 0x03, 0x04] }, // PK.. (ZIP)
    { signature: [0x50, 0x4B, 0x05, 0x06] }, // PK.. (empty ZIP)
    { signature: [0x50, 0x4B, 0x07, 0x08] }  // PK.. (spanned ZIP)
  ],

  // DOCX: ZIP archive (Office Open XML)
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': [
    { signature: [0x50, 0x4B, 0x03, 0x04] }, // PK.. (ZIP)
    { signature: [0x50, 0x4B, 0x05, 0x06] }, // PK.. (empty ZIP)
    { signature: [0x50, 0x4B, 0x07, 0x08] }  // PK.. (spanned ZIP)
  ],

  // Images (for alt-text generation)
  'image/jpeg': [
    { signature: [0xFF, 0xD8, 0xFF] } // JPEG SOI marker
  ],
  'image/png': [
    { signature: [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A] } // PNG signature
  ],
  'image/gif': [
    { signature: [0x47, 0x49, 0x46, 0x38] } // GIF89 or GIF87
  ],
  'image/webp': [
    { signature: [0x52, 0x49, 0x46, 0x46], offset: 0 } // RIFF header, WEBP at offset 8
  ]
};

/**
 * File extension to expected MIME types mapping
 */
const EXTENSION_MIME_MAP: Record<string, string[]> = {
  '.pdf': ['application/pdf'],
  '.epub': ['application/epub+zip'],
  '.docx': ['application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  '.jpg': ['image/jpeg'],
  '.jpeg': ['image/jpeg'],
  '.png': ['image/png'],
  '.gif': ['image/gif'],
  '.webp': ['image/webp']
};

export interface FileValidationResult {
  valid: boolean;
  detectedType: string | null;
  declaredType: string;
  error?: string;
  warnings: string[];
}

/**
 * Validates file content against magic bytes to detect MIME type spoofing
 *
 * @param buffer - File buffer to validate
 * @param declaredMimeType - MIME type declared in request
 * @param filename - Original filename for extension validation
 * @returns Validation result with detected type and any warnings/errors
 */
export function validateFileContent(
  buffer: Buffer,
  declaredMimeType: string,
  filename: string
): FileValidationResult {
  const warnings: string[] = [];
  const extension = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';

  // Check if we have magic bytes definition for declared type
  const expectedSignatures = MAGIC_BYTES[declaredMimeType];

  if (!expectedSignatures) {
    // Unknown type - allow but warn
    warnings.push(`No magic byte validation available for type: ${declaredMimeType}`);
    return {
      valid: true,
      detectedType: null,
      declaredType: declaredMimeType,
      warnings
    };
  }

  // Validate magic bytes
  const matchesSignature = expectedSignatures.some(({ signature, offset = 0 }) => {
    if (buffer.length < offset + signature.length) return false;
    return signature.every((byte, index) => buffer[offset + index] === byte);
  });

  if (!matchesSignature) {
    // Try to detect actual type
    const detectedType = detectFileType(buffer);

    return {
      valid: false,
      detectedType,
      declaredType: declaredMimeType,
      error: `File content does not match declared type. Declared: ${declaredMimeType}, Detected: ${detectedType || 'unknown'}`,
      warnings
    };
  }

  // Validate extension matches MIME type
  const expectedMimes = EXTENSION_MIME_MAP[extension];
  if (expectedMimes && !expectedMimes.includes(declaredMimeType)) {
    warnings.push(`Extension ${extension} typically corresponds to ${expectedMimes.join(', ')}, not ${declaredMimeType}`);
  }

  return {
    valid: true,
    detectedType: declaredMimeType,
    declaredType: declaredMimeType,
    warnings
  };
}

/**
 * Detects file type from magic bytes
 */
function detectFileType(buffer: Buffer): string | null {
  for (const [mimeType, signatures] of Object.entries(MAGIC_BYTES)) {
    const matches = signatures.some(({ signature, offset = 0 }) => {
      if (buffer.length < offset + signature.length) return false;
      return signature.every((byte, index) => buffer[offset + index] === byte);
    });
    if (matches) return mimeType;
  }
  return null;
}

/**
 * Validates file size is within limits
 */
export function validateFileSize(size: number, maxSizeBytes: number): boolean {
  return size > 0 && size <= maxSizeBytes;
}

/**
 * Sanitizes filename to prevent path traversal attacks
 */
export function sanitizeFilename(filename: string): string {
  return filename
    .replace(/\0/g, '') // Remove null bytes
    .replace(/[/\\]/g, '_') // Replace path separators
    .replace(/\.\./g, '_') // Remove parent directory references
    .replace(/[<>:"|?*]/g, '_') // Remove Windows reserved characters
    .slice(0, 200); // Limit length
}

/**
 * Checks for potentially malicious content patterns
 * Note: This is a basic check, not a replacement for proper virus scanning
 */
export function checkForSuspiciousContent(buffer: Buffer): { suspicious: boolean; reason?: string } {
  // Check for embedded scripts in supposed document files
  const content = buffer.toString('utf8', 0, Math.min(buffer.length, 10000));

  const suspiciousPatterns = [
    /<script[\s>]/i,
    /javascript:/i,
    /vbscript:/i,
    /on\w+\s*=/i, // onclick=, onload=, etc.
    /data:text\/html/i,
  ];

  for (const pattern of suspiciousPatterns) {
    if (pattern.test(content)) {
      return {
        suspicious: true,
        reason: `Suspicious pattern detected: ${pattern.source}`
      };
    }
  }

  return { suspicious: false };
}

/**
 * Complete file validation with all checks
 */
export async function validateFile(
  buffer: Buffer,
  declaredMimeType: string,
  filename: string,
  maxSizeBytes: number
): Promise<{
  valid: boolean;
  errors: string[];
  warnings: string[];
  sanitizedFilename: string;
}> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Size validation
  if (!validateFileSize(buffer.length, maxSizeBytes)) {
    errors.push(`File size ${buffer.length} exceeds maximum allowed ${maxSizeBytes} bytes`);
  }

  // Magic byte validation
  const contentValidation = validateFileContent(buffer, declaredMimeType, filename);
  if (!contentValidation.valid) {
    errors.push(contentValidation.error || 'Content validation failed');
  }
  warnings.push(...contentValidation.warnings);

  // Suspicious content check
  const suspiciousCheck = checkForSuspiciousContent(buffer);
  if (suspiciousCheck.suspicious) {
    errors.push(`Potentially malicious content: ${suspiciousCheck.reason}`);
  }

  // Sanitize filename
  const sanitizedFilename = sanitizeFilename(filename);
  if (sanitizedFilename !== filename) {
    warnings.push('Filename was sanitized for security');
  }

  // Log validation result (without sensitive details)
  if (errors.length > 0) {
    logger.warn('[FileValidator] Validation failed', {
      errorCount: errors.length,
      warningCount: warnings.length,
      declaredType: declaredMimeType,
      fileSize: buffer.length
    });
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    sanitizedFilename
  };
}

/**
 * Maximum bytes needed for magic byte detection
 * Most file signatures are within first 16 bytes
 */
const MAX_MAGIC_BYTE_LENGTH = 16;

/**
 * Validates magic bytes from a file stream (memory-efficient for large files)
 * Only reads the minimum bytes needed for validation
 *
 * @param filePath - Path to the file on disk
 * @param declaredMimeType - MIME type declared in request
 * @param filename - Original filename for extension validation
 * @returns Promise with validation result
 */
export async function validateMagicBytesFromStream(
  filePath: string,
  declaredMimeType: string,
  filename: string
): Promise<FileValidationResult> {
  return new Promise((resolve, reject) => {
    const warnings: string[] = [];
    const extension = filename.toLowerCase().match(/\.[^.]+$/)?.[0] || '';

    // Check if we have magic bytes definition for declared type
    const expectedSignatures = MAGIC_BYTES[declaredMimeType];

    if (!expectedSignatures) {
      // Unknown type - allow but warn
      warnings.push(`No magic byte validation available for type: ${declaredMimeType}`);
      resolve({
        valid: true,
        detectedType: null,
        declaredType: declaredMimeType,
        warnings
      });
      return;
    }

    // Calculate minimum bytes needed
    let maxBytesNeeded = 0;
    for (const { signature, offset = 0 } of expectedSignatures) {
      maxBytesNeeded = Math.max(maxBytesNeeded, offset + signature.length);
    }
    // Add buffer for detecting other types
    maxBytesNeeded = Math.max(maxBytesNeeded, MAX_MAGIC_BYTE_LENGTH);

    // Read only the bytes we need
    const chunks: Buffer[] = [];

    const stream = createReadStream(filePath, {
      start: 0,
      end: maxBytesNeeded - 1, // end is inclusive
      highWaterMark: maxBytesNeeded
    });

    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    stream.on('end', () => {
      const buffer = Buffer.concat(chunks);

      // Validate magic bytes
      const matchesSignature = expectedSignatures.some(({ signature, offset = 0 }) => {
        if (buffer.length < offset + signature.length) return false;
        return signature.every((byte, index) => buffer[offset + index] === byte);
      });

      if (!matchesSignature) {
        // Try to detect actual type
        const detectedType = detectFileTypeFromBuffer(buffer);

        resolve({
          valid: false,
          detectedType,
          declaredType: declaredMimeType,
          error: `File content does not match declared type. Declared: ${declaredMimeType}, Detected: ${detectedType || 'unknown'}`,
          warnings
        });
        return;
      }

      // Validate extension matches MIME type
      const expectedMimes = EXTENSION_MIME_MAP[extension];
      if (expectedMimes && !expectedMimes.includes(declaredMimeType)) {
        warnings.push(`Extension ${extension} typically corresponds to ${expectedMimes.join(', ')}, not ${declaredMimeType}`);
      }

      resolve({
        valid: true,
        detectedType: declaredMimeType,
        declaredType: declaredMimeType,
        warnings
      });
    });

    stream.on('error', (error) => {
      logger.error('[FileValidator] Stream error during validation', {
        error: error.message
      });
      reject(error);
    });
  });
}

/**
 * Detects file type from buffer (internal helper)
 */
function detectFileTypeFromBuffer(buffer: Buffer): string | null {
  for (const [mimeType, signatures] of Object.entries(MAGIC_BYTES)) {
    const matches = signatures.some(({ signature, offset = 0 }) => {
      if (buffer.length < offset + signature.length) return false;
      return signature.every((byte, index) => buffer[offset + index] === byte);
    });
    if (matches) return mimeType;
  }
  return null;
}
