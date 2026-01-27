import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { BatchFile } from '@prisma/client';
import * as fs from 'fs/promises';
import * as path from 'path';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB
const BATCH_UPLOAD_DIR = process.env.BATCH_UPLOAD_DIR || './data/batches';

class BatchFileService {
  async uploadFiles(
    batchId: string,
    files: Array<{ buffer: Buffer; filename: string; size: number }>
  ): Promise<BatchFile[]> {
    const batchFiles: BatchFile[] = [];

    for (const file of files) {
      this.validateFile(file);

      const uniqueFilename = this.generateUniqueFilename(file.filename);
      const storagePath = await this.uploadToStorage(batchId, uniqueFilename, file.buffer);

      const batchFile = await prisma.batchFile.create({
        data: {
          batchId,
          fileName: uniqueFilename,
          originalName: file.filename,
          fileSize: file.size,
          mimeType: 'application/epub+zip',
          storagePath,
          storageType: 'LOCAL',
          status: 'UPLOADED',
        },
      });

      batchFiles.push(batchFile);
      logger.info(`Uploaded file ${file.filename} to batch ${batchId}`);
    }

    return batchFiles;
  }

  async getFileBuffer(fileId: string): Promise<Buffer> {
    const file = await prisma.batchFile.findUnique({ where: { id: fileId } });

    if (!file) {
      throw new Error(`File not found: ${fileId}`);
    }

    return await fs.readFile(file.storagePath);
  }

  async getFileByBatchFile(batchFile: BatchFile): Promise<Buffer> {
    return await fs.readFile(batchFile.storagePath);
  }

  async saveRemediatedFile(
    fileId: string,
    buffer: Buffer
  ): Promise<string> {
    const file = await prisma.batchFile.findUnique({ where: { id: fileId } });

    if (!file) {
      throw new Error(`File not found: ${fileId}`);
    }

    const remediatedPath = file.storagePath.replace('.epub', '_remediated.epub');
    await fs.writeFile(remediatedPath, buffer);

    await prisma.batchFile.update({
      where: { id: fileId },
      data: { remediatedFilePath: remediatedPath },
    });

    return remediatedPath;
  }

  async deleteFile(fileId: string): Promise<void> {
    const file = await prisma.batchFile.findUnique({
      where: { id: fileId },
      include: { batch: true },
    });

    if (!file) {
      throw new Error(`File not found: ${fileId}`);
    }

    if (file.batch.status !== 'DRAFT') {
      throw new Error('Cannot delete files from batch that is not in DRAFT status');
    }

    await fs.unlink(file.storagePath).catch(() => {});

    await prisma.batchFile.delete({ where: { id: fileId } });

    await prisma.batch.update({
      where: { id: file.batchId },
      data: {
        totalFiles: { decrement: 1 },
        filesUploaded: { decrement: 1 },
      },
    });

    logger.info(`Deleted file ${fileId} from batch ${file.batchId}`);
  }

  private validateFile(file: { filename: string; size: number }): void {
    if (!file.filename.toLowerCase().endsWith('.epub')) {
      throw new Error(`Invalid file type: ${file.filename}. Only EPUB files are supported.`);
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`File too large: ${file.filename}. Maximum size is 100MB.`);
    }
  }

  private async uploadToStorage(
    batchId: string,
    filename: string,
    buffer: Buffer
  ): Promise<string> {
    const batchDir = path.join(BATCH_UPLOAD_DIR, batchId);
    await fs.mkdir(batchDir, { recursive: true });
    const filePath = path.join(batchDir, filename);
    await fs.writeFile(filePath, buffer);
    return filePath;
  }

  private generateUniqueFilename(originalFilename: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const ext = path.extname(originalFilename);
    const basename = path.basename(originalFilename, ext);
    const sanitized = basename.replace(/[^a-zA-Z0-9-_]/g, '-');
    return `${sanitized}-${timestamp}-${random}${ext}`;
  }
}

export const batchFileService = new BatchFileService();
