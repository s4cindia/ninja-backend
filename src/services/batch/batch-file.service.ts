import { randomUUID } from 'crypto';
import * as path from 'path';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { BatchFile } from '@prisma/client';
import { fileStorageService } from '../storage/file-storage.service';
import { s3Service } from '../s3.service';

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100MB

class BatchFileService {
  async uploadFiles(
    batchId: string,
    files: Array<{ buffer: Buffer; filename: string; size: number }>
  ): Promise<BatchFile[]> {
    const batchFiles: BatchFile[] = [];

    for (const file of files) {
      this.validateFile(file);

      const uniqueFilename = this.generateUniqueFilename(file.filename);
      // Precompute the id so it can be used as the storage key in the same
      // pass -- avoids a create-then-update round trip just to learn the id.
      const fileId = randomUUID();
      const storagePath = await fileStorageService.saveFile(fileId, uniqueFilename, file.buffer);

      const batchFile = await prisma.batchFile.create({
        data: {
          id: fileId,
          batchId,
          fileName: uniqueFilename,
          originalName: file.filename,
          fileSize: file.size,
          mimeType: 'application/epub+zip',
          storagePath,
          storageType: s3Service.isConfigured() ? 'S3' : 'LOCAL',
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

    return this.getFileByBatchFile(file);
  }

  async getFileByBatchFile(batchFile: BatchFile): Promise<Buffer> {
    const buffer = await fileStorageService.getFile(batchFile.id, batchFile.fileName);

    if (!buffer) {
      throw new Error(`File not found in storage: ${batchFile.id}`);
    }

    return buffer;
  }

  async saveRemediatedFile(
    fileId: string,
    buffer: Buffer
  ): Promise<string> {
    const file = await prisma.batchFile.findUnique({ where: { id: fileId } });

    if (!file) {
      throw new Error(`File not found: ${fileId}`);
    }

    const remediatedFileName = this.remediatedFileName(file.fileName);
    const remediatedPath = await fileStorageService.saveRemediatedFile(file.id, remediatedFileName, buffer);

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

    await fileStorageService.deleteFile(file.id, file.fileName).catch(() => {});

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

  private generateUniqueFilename(originalFilename: string): string {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 8);
    const ext = path.extname(originalFilename);
    const basename = path.basename(originalFilename, ext);
    const sanitized = basename.replace(/[^a-zA-Z0-9-_]/g, '-');
    return `${sanitized}-${timestamp}-${random}${ext}`;
  }

  // Extension-aware -- the old `.replace('.epub', '_remediated.epub')` would
  // silently no-op (leaving the filename unchanged, clobbering the original
  // on save) for any non-.epub file, e.g. a .pdf.
  private remediatedFileName(fileName: string): string {
    const ext = path.extname(fileName);
    const base = ext ? fileName.slice(0, -ext.length) : fileName;
    return `${base}_remediated${ext}`;
  }
}

export const batchFileService = new BatchFileService();
