/**
 * Citation Validation Utilities
 * Input validation for citation-related operations
 */

import { AppError } from './app-error';
import { ErrorCodes } from './error-codes';

/**
 * Validates a document ID format
 * @param documentId - Document ID to validate
 * @throws {AppError} If document ID is invalid
 */
export function validateDocumentId(documentId: string | undefined | null): void {
  if (!documentId) {
    throw AppError.badRequest('Document ID is required', ErrorCodes.VALIDATION_ERROR);
  }

  if (typeof documentId !== 'string') {
    throw AppError.badRequest('Document ID must be a string', ErrorCodes.VALIDATION_ERROR);
  }

  if (!documentId.match(/^[a-zA-Z0-9-_]+$/)) {
    throw AppError.badRequest(
      'Invalid document ID format. Only alphanumeric characters, hyphens, and underscores are allowed.',
      ErrorCodes.CITATION_INVALID_DOCUMENT_ID
    );
  }

  if (documentId.length > 100) {
    throw AppError.badRequest(
      'Document ID too long. Maximum length is 100 characters.',
      ErrorCodes.CITATION_INVALID_DOCUMENT_ID
    );
  }
}

/**
 * Validates a citation number
 * @param num - Citation number to validate
 * @throws {AppError} If citation number is invalid
 */
export function validateCitationNumber(num: unknown): void {
  if (typeof num !== 'number') {
    throw AppError.badRequest(
      'Citation number must be a number',
      ErrorCodes.CITATION_INVALID_NUMBER
    );
  }

  if (!Number.isInteger(num)) {
    throw AppError.badRequest(
      'Citation number must be an integer',
      ErrorCodes.CITATION_INVALID_NUMBER
    );
  }

  if (num < 1 || num > 9999) {
    throw AppError.badRequest(
      'Citation number must be between 1 and 9999',
      ErrorCodes.CITATION_INVALID_NUMBER
    );
  }
}

/**
 * Validates a file upload for citation detection
 * @param file - Uploaded file from multer
 * @throws {AppError} If file is invalid
 */
export function validateFileUpload(file: Express.Multer.File | undefined): void {
  if (!file) {
    throw AppError.badRequest('No file uploaded', ErrorCodes.FILE_UPLOAD_FAILED);
  }

  const MAX_SIZE = 100 * 1024 * 1024; // 100MB
  const ALLOWED_TYPES = [
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/msword',
    'text/plain',
    'application/epub+zip',
  ];

  if (file.size > MAX_SIZE) {
    const sizeMB = (file.size / 1024 / 1024).toFixed(1);
    throw AppError.badRequest(
      `File size exceeds 100MB limit. Your file is ${sizeMB}MB. Please upload a smaller file.`,
      ErrorCodes.FILE_TOO_LARGE
    );
  }

  if (!ALLOWED_TYPES.includes(file.mimetype)) {
    throw AppError.badRequest(
      `Unsupported file type: ${file.mimetype}. Please upload PDF, DOCX, TXT, or EPUB files.`,
      ErrorCodes.FILE_INVALID_TYPE
    );
  }

  // Check file extension as additional validation
  const ext = file.originalname.toLowerCase().split('.').pop();
  const ALLOWED_EXTENSIONS = ['pdf', 'docx', 'doc', 'txt', 'epub'];

  if (!ext || !ALLOWED_EXTENSIONS.includes(ext)) {
    throw AppError.badRequest(
      `Invalid file extension: .${ext}. Allowed extensions: ${ALLOWED_EXTENSIONS.join(', ')}`,
      ErrorCodes.FILE_INVALID_TYPE
    );
  }
}

/**
 * Validates citation style code
 * @param styleCode - Citation style code (e.g., 'vancouver', 'apa', 'mla')
 * @throws {AppError} If style code is invalid
 */
export function validateStyleCode(styleCode: string | undefined): void {
  if (!styleCode) {
    throw AppError.badRequest('Citation style code is required', ErrorCodes.VALIDATION_ERROR);
  }

  const VALID_STYLES = ['vancouver', 'apa', 'mla', 'chicago', 'harvard', 'ieee', 'ama'];

  if (!VALID_STYLES.includes(styleCode.toLowerCase())) {
    throw AppError.badRequest(
      `Invalid citation style: ${styleCode}. Supported styles: ${VALID_STYLES.join(', ')}`,
      ErrorCodes.VALIDATION_ERROR
    );
  }
}

/**
 * Validates pagination parameters
 * @param page - Page number
 * @param limit - Items per page
 * @returns Validated and sanitized pagination params
 */
export function validatePagination(
  page?: string | number,
  limit?: string | number
): { page: number; limit: number } {
  let parsedPage = 1;
  let parsedLimit = 20;

  if (page !== undefined) {
    parsedPage = typeof page === 'string' ? parseInt(page, 10) : page;
    if (isNaN(parsedPage) || parsedPage < 1) {
      throw AppError.badRequest('Page must be a positive integer', ErrorCodes.VALIDATION_ERROR);
    }
  }

  if (limit !== undefined) {
    parsedLimit = typeof limit === 'string' ? parseInt(limit, 10) : limit;
    if (isNaN(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
      throw AppError.badRequest('Limit must be between 1 and 100', ErrorCodes.VALIDATION_ERROR);
    }
  }

  return { page: parsedPage, limit: parsedLimit };
}
