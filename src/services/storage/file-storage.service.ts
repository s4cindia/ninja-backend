import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../../lib/logger';

const STORAGE_BASE = process.env.EPUB_STORAGE_PATH || '/tmp/epub-storage';

if (!process.env.EPUB_STORAGE_PATH) {
  logger.warn('EPUB_STORAGE_PATH not set. Using /tmp/epub-storage which is NOT persistent. Set EPUB_STORAGE_PATH for production.');
}

class FileStorageService {
  async ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  async saveFile(jobId: string, fileName: string, buffer: Buffer): Promise<string> {
    const jobDir = path.join(STORAGE_BASE, jobId);
    await this.ensureDir(jobDir);
    
    const sanitizedFileName = path.basename(fileName);
    const filePath = path.join(jobDir, sanitizedFileName);
    
    await fs.writeFile(filePath, buffer);
    logger.info(`Saved EPUB file: ${filePath}`);
    
    return filePath;
  }

  async getFile(jobId: string, fileName: string): Promise<Buffer | null> {
    try {
      const sanitizedFileName = path.basename(fileName);
      const filePath = path.join(STORAGE_BASE, jobId, sanitizedFileName);

      const buffer = await fs.readFile(filePath);
      return buffer;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async getFilePath(jobId: string, fileName: string): Promise<string> {
    const sanitizedFileName = path.basename(fileName);
    const filePath = path.join(STORAGE_BASE, jobId, sanitizedFileName);

    // Verify file exists
    try {
      await fs.access(filePath);
      return path.resolve(filePath); // Return absolute path for sendFile
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new Error(`File not found: ${fileName}`);
      }
      throw error;
    }
  }

  async deleteFile(jobId: string, fileName: string): Promise<void> {
    try {
      const sanitizedFileName = path.basename(fileName);
      const filePath = path.join(STORAGE_BASE, jobId, sanitizedFileName);
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async deleteJobFiles(jobId: string): Promise<void> {
    try {
      const jobDir = path.join(STORAGE_BASE, jobId);
      await fs.rm(jobDir, { recursive: true, force: true });
    } catch (error) {
      logger.error('Failed to delete job files', error instanceof Error ? error : undefined);
    }
  }

  async saveRemediatedFile(jobId: string, fileName: string, buffer: Buffer): Promise<string> {
    const jobDir = path.join(STORAGE_BASE, jobId, 'remediated');
    await this.ensureDir(jobDir);
    
    const sanitizedFileName = path.basename(fileName);
    const filePath = path.join(jobDir, sanitizedFileName);
    
    await fs.writeFile(filePath, buffer);
    logger.info(`Saved remediated EPUB: ${filePath}`);
    
    return filePath;
  }

  async getRemediatedFile(jobId: string, fileName: string): Promise<Buffer | null> {
    try {
      const sanitizedFileName = path.basename(fileName);
      const ext = path.extname(sanitizedFileName);
      const baseName = sanitizedFileName.slice(0, -ext.length);

      const remediatedFileName = baseName.endsWith('_remediated')
        ? sanitizedFileName
        : `${baseName}_remediated${ext}`;

      const filePath = path.join(STORAGE_BASE, jobId, 'remediated', remediatedFileName);
      return await fs.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Download file from URL or file path
   * For now, supports local file paths. Can be extended to support S3/HTTP URLs.
   */
  async downloadFile(fileUrlOrPath: string): Promise<Buffer> {
    try {
      // If it's a local path, read directly
      if (!fileUrlOrPath.startsWith('http')) {
        // Handle both absolute and relative paths
        const filePath = fileUrlOrPath.startsWith('/')
          ? fileUrlOrPath
          : path.join(STORAGE_BASE, fileUrlOrPath);

        const buffer = await fs.readFile(filePath);
        logger.info(`Downloaded file from ${filePath}`);
        return buffer;
      }

      // TODO: Add S3/HTTP support when needed
      throw new Error('HTTP/S3 URL download not yet implemented');
    } catch (error) {
      logger.error(`Failed to download file from ${fileUrlOrPath}`, {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }
}

export const fileStorageService = new FileStorageService();
