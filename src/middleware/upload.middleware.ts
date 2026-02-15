/**
 * Upload Middleware
 * Handles file uploads with security validations including:
 * - Magic byte validation (prevents MIME type spoofing)
 * - File size limits
 * - Filename sanitization
 * - Suspicious content detection
 * - Memory-efficient streaming for large files
 */

import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { createReadStream } from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { Request, Response, NextFunction } from 'express';
import { uploadConfig } from '../config/upload.config';
import { memoryConfig, getMemoryUsage, isMemorySafeForSize } from '../config/memory.config';
import { AppError } from '../utils/app-error';
import { ErrorCodes } from '../utils/error-codes';
import { logger } from '../lib/logger';
import {
  validateFileContent,
  sanitizeFilename,
  checkForSuspiciousContent,
  validateMagicBytesFromStream
} from '../utils/file-validator';

/**
 * Get temporary upload directory
 */
function getTempUploadDir(): string {
  const tempDir = path.join(uploadConfig.uploadDir, 'temp');
  fs.mkdirSync(tempDir, { recursive: true });
  return tempDir;
}

/**
 * Dynamic storage selector - uses disk for large files, memory for small files
 * This prevents memory exhaustion from large uploads
 */
const dynamicStorage = multer.diskStorage({
  destination: (_req: Request, _file, cb) => {
    cb(null, getTempUploadDir());
  },
  filename: (_req, file, cb) => {
    const uniqueId = uuidv4();
    const sanitizedName = sanitizeFilename(file.originalname);
    const extension = path.extname(sanitizedName);
    cb(null, `temp_${uniqueId}${extension}`);
  },
});

// Memory storage for small files only (used when explicitly needed)
const memoryStorage = multer.memoryStorage();

// Disk storage for validated files (final destination)
const diskStorage = multer.diskStorage({
  destination: (req: Request, _file, cb) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      logger.warn('[Upload] Authentication required for file upload');
      return cb(AppError.unauthorized('Authentication required'), '');
    }

    const uploadPath = path.join(uploadConfig.uploadDir, tenantId);
    fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (_req, file, cb) => {
    const uniqueId = uuidv4();
    const sanitizedName = sanitizeFilename(file.originalname);
    const extension = path.extname(sanitizedName);
    cb(null, `${uniqueId}${extension}`);
  },
});

/**
 * File filter with basic extension/MIME validation
 * Note: Magic byte validation happens after upload in validateUploadedFile middleware
 */
const fileFilter = (
  _req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  const allowedMimeTypes = uploadConfig.allowedMimeTypes || [
    'application/epub+zip',
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];

  const extension = path.extname(file.originalname).toLowerCase();
  const allowedExtensions = ['.epub', '.pdf', '.docx'];

  // Don't allow application/octet-stream - require specific MIME types
  const isMimeTypeAllowed = allowedMimeTypes.includes(file.mimetype);
  const isExtensionAllowed = allowedExtensions.includes(extension);

  if (isMimeTypeAllowed && isExtensionAllowed) {
    cb(null, true);
  } else {
    logger.warn('[Upload] Rejected file with invalid type', {
      extension,
      mimeAllowed: isMimeTypeAllowed,
      extAllowed: isExtensionAllowed
    });
    cb(
      AppError.badRequest(
        `Invalid file type. Allowed: PDF, EPUB, DOCX`,
        ErrorCodes.FILE_INVALID_TYPE
      )
    );
  }
};

/**
 * Multer instances with different storage strategies
 */

// Default: Disk-based upload for memory efficiency
export const uploadToDisk = multer({
  storage: dynamicStorage,
  fileFilter,
  limits: {
    fileSize: memoryConfig.maxUploadFileSize,
  },
});

// Memory storage only for small files (below threshold)
export const uploadMemory = multer({
  storage: memoryStorage,
  fileFilter,
  limits: {
    fileSize: memoryConfig.maxMemoryFileSize, // Limited to 5MB for memory storage
  },
});

// Final disk storage for validated files
export const upload = multer({
  storage: diskStorage,
  fileFilter,
  limits: {
    fileSize: memoryConfig.maxUploadFileSize,
  },
});

// Export commonly used middleware
export const uploadSingle = upload.single('file');
export const uploadSingleMemory = uploadMemory.single('file');
export const uploadSingleToDisk = uploadToDisk.single('file');

/**
 * Middleware to validate uploaded file content (magic bytes)
 * Handles both memory-based and disk-based uploads efficiently
 */
export function validateUploadedFile(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const file = req.file;

  if (!file) {
    return next();
  }

  const startTime = Date.now();
  const VALIDATION_TIMEOUT_MS = 5000;

  try {
    // Check timeout
    if (Date.now() - startTime > VALIDATION_TIMEOUT_MS) {
      logger.error('[Upload] Validation timeout exceeded');
      res.status(408).json({
        success: false,
        error: { code: 'VALIDATION_TIMEOUT', message: 'File validation timed out' }
      });
      return;
    }

    // Determine if file is in memory or on disk
    if (file.buffer) {
      // Memory-based validation (small files)
      validateFromBuffer(file, res, next);
    } else if (file.path) {
      // Disk-based validation (large files) - use streaming
      validateFromDisk(file, res, next);
    } else {
      // No file data available
      return next();
    }
  } catch (error) {
    logger.error('[Upload] Validation error', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    next(error);
  }
}

/**
 * Validate file from memory buffer
 */
function validateFromBuffer(
  file: Express.Multer.File,
  res: Response,
  next: NextFunction
): void {
  // Magic byte validation
  const contentValidation = validateFileContent(
    file.buffer,
    file.mimetype,
    file.originalname
  );

  if (!contentValidation.valid) {
    logger.warn('[Upload] Magic byte validation failed', {
      declaredType: file.mimetype,
      detectedType: contentValidation.detectedType,
      fileSize: file.size
    });

    res.status(400).json({
      success: false,
      error: {
        code: 'FILE_CONTENT_MISMATCH',
        message: 'File content does not match declared type'
      }
    });
    return;
  }

  // Suspicious content check (only for first 10KB to save memory)
  const checkBuffer = file.buffer.length > 10000
    ? file.buffer.subarray(0, 10000)
    : file.buffer;
  const suspiciousCheck = checkForSuspiciousContent(checkBuffer);

  if (suspiciousCheck.suspicious) {
    logger.warn('[Upload] Suspicious content detected', {
      fileSize: file.size,
      mimeType: file.mimetype
    });

    res.status(400).json({
      success: false,
      error: {
        code: 'SUSPICIOUS_CONTENT',
        message: 'File contains potentially unsafe content'
      }
    });
    return;
  }

  logger.info('[Upload] File validated successfully', {
    size: file.size,
    type: file.mimetype
  });

  next();
}

/**
 * Validate file from disk using streaming (memory-efficient)
 */
async function validateFromDisk(
  file: Express.Multer.File,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    // Stream-based magic byte validation
    const streamValidation = await validateMagicBytesFromStream(
      file.path,
      file.mimetype,
      file.originalname
    );

    if (!streamValidation.valid) {
      // Clean up temp file
      cleanupTempFile(file.path);

      logger.warn('[Upload] Magic byte validation failed (streaming)', {
        declaredType: file.mimetype,
        detectedType: streamValidation.detectedType,
        fileSize: file.size
      });

      res.status(400).json({
        success: false,
        error: {
          code: 'FILE_CONTENT_MISMATCH',
          message: 'File content does not match declared type'
        }
      });
      return;
    }

    // Streaming suspicious content check (first 10KB only)
    const suspiciousCheck = await checkSuspiciousContentFromStream(file.path);

    if (suspiciousCheck.suspicious) {
      // Clean up temp file
      cleanupTempFile(file.path);

      logger.warn('[Upload] Suspicious content detected (streaming)', {
        fileSize: file.size,
        mimeType: file.mimetype
      });

      res.status(400).json({
        success: false,
        error: {
          code: 'SUSPICIOUS_CONTENT',
          message: 'File contains potentially unsafe content'
        }
      });
      return;
    }

    logger.info('[Upload] File validated successfully (streaming)', {
      size: file.size,
      type: file.mimetype
    });

    next();
  } catch (error) {
    // Clean up temp file on error
    cleanupTempFile(file.path);
    throw error;
  }
}

/**
 * Check suspicious content from file stream (memory-efficient)
 */
async function checkSuspiciousContentFromStream(
  filePath: string
): Promise<{ suspicious: boolean; reason?: string }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalSize = 0;
    const maxCheckSize = 10000; // Only check first 10KB

    const stream = createReadStream(filePath, {
      highWaterMark: memoryConfig.streamChunkSize
    });

    stream.on('data', (chunk: Buffer) => {
      if (totalSize < maxCheckSize) {
        const remaining = maxCheckSize - totalSize;
        const toAdd = chunk.subarray(0, Math.min(chunk.length, remaining));
        chunks.push(toAdd);
        totalSize += toAdd.length;
      }

      if (totalSize >= maxCheckSize) {
        stream.destroy();
      }
    });

    stream.on('end', () => {
      const buffer = Buffer.concat(chunks);
      resolve(checkForSuspiciousContent(buffer));
    });

    stream.on('close', () => {
      if (totalSize >= maxCheckSize) {
        const buffer = Buffer.concat(chunks);
        resolve(checkForSuspiciousContent(buffer));
      }
    });

    stream.on('error', (error) => {
      reject(error);
    });
  });
}

/**
 * Clean up temporary file
 */
function cleanupTempFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      logger.debug('[Upload] Cleaned up temp file', { path: filePath });
    }
  } catch (error) {
    logger.warn('[Upload] Failed to clean up temp file', {
      path: filePath,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
}

/**
 * Middleware to move validated temp file to final destination
 */
export function moveToFinalDestination(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  const file = req.file;

  if (!file || !file.path || file.buffer) {
    // No temp file to move or file is in memory
    return next();
  }

  const tenantId = req.user?.tenantId;
  if (!tenantId) {
    cleanupTempFile(file.path);
    res.status(401).json({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Authentication required' }
    });
    return;
  }

  try {
    // Create final destination
    const finalDir = path.join(uploadConfig.uploadDir, tenantId);
    fs.mkdirSync(finalDir, { recursive: true });

    // Generate final filename
    const uniqueId = uuidv4();
    const sanitizedName = sanitizeFilename(file.originalname);
    const extension = path.extname(sanitizedName);
    const finalFilename = `${uniqueId}${extension}`;
    const finalPath = path.join(finalDir, finalFilename);

    // Move file (rename is faster than copy+delete)
    fs.renameSync(file.path, finalPath);

    // Update file object with new path
    file.path = finalPath;
    file.filename = finalFilename;
    file.destination = finalDir;

    logger.info('[Upload] File moved to final destination', {
      size: file.size,
      destination: finalDir
    });

    next();
  } catch (error) {
    cleanupTempFile(file.path);
    logger.error('[Upload] Failed to move file to final destination', {
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    next(error);
  }
}

/**
 * Middleware to add processing timeout
 * Wraps the next middleware with a timeout
 */
export function withProcessingTimeout(timeoutMs: number = 30000) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const timeout = setTimeout(() => {
      if (!res.headersSent) {
        logger.error('[Upload] Processing timeout', { timeoutMs });
        res.status(408).json({
          success: false,
          error: { code: 'PROCESSING_TIMEOUT', message: 'File processing timed out' }
        });
      }
    }, timeoutMs);

    // Clear timeout when response is sent
    res.on('finish', () => clearTimeout(timeout));
    res.on('close', () => clearTimeout(timeout));

    next();
  };
}

/**
 * Middleware to log memory usage (for debugging large file issues)
 */
export function logMemoryUsage(label: string = 'Memory') {
  return (_req: Request, _res: Response, next: NextFunction): void => {
    if (memoryConfig.enableMemoryLogging) {
      const usage = getMemoryUsage();
      logger.debug(`[${label}] Memory usage`, {
        heapUsedMB: usage.heapUsedMB,
        heapTotalMB: usage.heapTotalMB
      });
    }
    next();
  };
}

/**
 * Middleware to check if memory is safe for processing
 */
export function checkMemorySafety(estimatedSize?: number) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const fileSize = estimatedSize || req.file?.size || 0;

    if (fileSize > 0 && !isMemorySafeForSize(fileSize)) {
      const usage = getMemoryUsage();
      logger.warn('[Upload] Memory pressure detected', {
        fileSize,
        heapUsedMB: usage.heapUsedMB,
        heapTotalMB: usage.heapTotalMB
      });

      // Don't reject, but log warning - let processing continue
      // In production, you might want to queue the request instead
    }

    next();
  };
}
