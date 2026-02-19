/**
 * Citation Storage Service
 *
 * Abstracts file storage for citation management documents.
 * Uses S3 in production, falls back to local storage in development.
 */

import { s3Service } from '../s3.service';
import { config } from '../../config';
import { logger } from '../../lib/logger';

const S3_PREFIX = 'citation-management';

export interface StorageResult {
  storagePath: string;
  storageType: 'S3' | 'LOCAL';
}

class CitationStorageService {
  /**
   * Check if S3 storage is available and configured
   * Works with both explicit credentials and IAM roles (ECS/EC2)
   */
  private isS3Available(): boolean {
    // s3Service.isConfigured() checks if bucket is set
    // On ECS, credentials come from IAM role via AWS SDK credential chain
    // We don't require explicit credentials - trust the SDK to handle auth
    return s3Service.isConfigured();
  }

  /**
   * Upload a file buffer to storage
   * Uses S3 if configured, falls back to local filesystem
   */
  async uploadFile(
    tenantId: string,
    fileName: string,
    buffer: Buffer,
    contentType: string = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ): Promise<StorageResult> {
    // Sanitize filename to prevent path traversal attacks
    const sanitizedFileName = fileName
      .replace(/\0/g, '')           // Remove null bytes
      .replace(/[/\\]/g, '_')       // Replace path separators
      .replace(/\.\./g, '_')        // Remove parent directory references
      .replace(/[^a-zA-Z0-9._-]/g, '_') // Remove special chars
      .slice(0, 200);               // Limit length

    const timestamp = Date.now();
    const finalFileName = `${timestamp}-${sanitizedFileName}`;

    if (this.isS3Available()) {
      try {
        const s3Key = await s3Service.uploadBuffer(
          tenantId,
          finalFileName,
          buffer,
          contentType,
          S3_PREFIX
        );

        logger.info(`[Citation Storage] Uploaded to S3: ${s3Key}`);

        return {
          storagePath: s3Key,
          storageType: 'S3'
        };
      } catch (error) {
        logger.error('[Citation Storage] S3 upload failed, falling back to local:', error);
        // Fall through to local storage
      }
    }

    // Fall back to local storage
    const fs = await import('fs/promises');
    const path = await import('path');

    const uploadDir = path.join(config.uploadDir, S3_PREFIX, tenantId);
    await fs.mkdir(uploadDir, { recursive: true });

    const localPath = path.join(uploadDir, finalFileName);
    await fs.writeFile(localPath, buffer);

    const storagePath = `${S3_PREFIX}/${tenantId}/${finalFileName}`;
    logger.info(`[Citation Storage] Saved to local: ${storagePath}`);

    return {
      storagePath,
      storageType: 'LOCAL'
    };
  }

  /**
   * Get file buffer from storage
   * Automatically handles S3 or local storage based on storageType
   */
  async getFileBuffer(storagePath: string, storageType: 'S3' | 'LOCAL'): Promise<Buffer> {
    if (storageType === 'S3' && this.isS3Available()) {
      try {
        const buffer = await s3Service.getFileBuffer(storagePath);
        logger.info(`[Citation Storage] Retrieved from S3: ${storagePath}`);
        return buffer;
      } catch (error) {
        logger.error(`[Citation Storage] S3 retrieval failed for ${storagePath}:`, error);
        throw new Error(`Failed to retrieve file from S3: ${storagePath}`);
      }
    }

    // Local storage
    const fs = await import('fs/promises');
    const path = await import('path');

    const localPath = path.join(config.uploadDir, storagePath);

    try {
      const buffer = await fs.readFile(localPath);
      logger.info(`[Citation Storage] Retrieved from local: ${localPath}`);
      return buffer;
    } catch (error) {
      logger.error(`[Citation Storage] Local retrieval failed for ${localPath}:`, error);
      throw new Error(`Failed to retrieve file from local storage: ${storagePath}`);
    }
  }

  /**
   * Get a presigned download URL for S3 files
   * Returns null for local files (direct streaming required)
   */
  async getDownloadUrl(storagePath: string, storageType: 'S3' | 'LOCAL', expiresIn: number = 3600): Promise<string | null> {
    if (storageType === 'S3' && this.isS3Available()) {
      try {
        const result = await s3Service.getPresignedDownloadUrl(storagePath, expiresIn);
        return result.downloadUrl;
      } catch (error) {
        logger.error(`[Citation Storage] Failed to generate presigned URL for ${storagePath}:`, error);
        return null;
      }
    }

    // Local files don't have presigned URLs - return null to indicate streaming is needed
    return null;
  }

  /**
   * Delete a file from storage
   */
  async deleteFile(storagePath: string, storageType: 'S3' | 'LOCAL'): Promise<void> {
    if (storageType === 'S3' && this.isS3Available()) {
      try {
        await s3Service.deleteFile(storagePath);
        logger.info(`[Citation Storage] Deleted from S3: ${storagePath}`);
        return;
      } catch (error) {
        logger.error(`[Citation Storage] S3 deletion failed for ${storagePath}:`, error);
        // Don't throw - file might not exist
      }
    }

    // Local storage
    const fs = await import('fs/promises');
    const path = await import('path');

    const localPath = path.join(config.uploadDir, storagePath);

    try {
      await fs.unlink(localPath);
      logger.info(`[Citation Storage] Deleted from local: ${localPath}`);
    } catch (error) {
      // Don't throw - file might not exist
      logger.warn(`[Citation Storage] Local deletion failed for ${localPath}:`, error);
    }
  }

  /**
   * Check if a file exists in storage
   */
  async fileExists(storagePath: string, storageType: 'S3' | 'LOCAL'): Promise<boolean> {
    if (storageType === 'S3' && this.isS3Available()) {
      return s3Service.fileExists(storagePath);
    }

    // Local storage
    const fs = await import('fs/promises');
    const path = await import('path');

    const localPath = path.join(config.uploadDir, storagePath);

    try {
      await fs.access(localPath);
      return true;
    } catch {
      return false;
    }
  }
}

export const citationStorageService = new CitationStorageService();
