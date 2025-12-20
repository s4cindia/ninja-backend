import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../../lib/logger';

const STORAGE_BASE = process.env.EPUB_STORAGE_PATH || '/tmp/epub-storage';

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
      const filePath = path.join(STORAGE_BASE, jobId, 'remediated', sanitizedFileName);
      return await fs.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }
}

export const fileStorageService = new FileStorageService();
