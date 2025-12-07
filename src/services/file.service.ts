import fs from 'fs';
import path from 'path';
import prisma from '../lib/prisma';
import { FileStatus } from '@prisma/client';
import { AppError } from '../utils/app-error';
import { ErrorCodes } from '../utils/error-codes';
import { uploadConfig } from '../config/upload.config';

interface CreateFileInput {
  originalName: string;
  filename: string;
  mimeType: string;
  size: number;
  tenantId: string;
}

class FileService {
  async createFile(input: CreateFileInput) {
    const filePath = path.join(uploadConfig.uploadDir, input.tenantId, input.filename);
    
    const file = await prisma.file.create({
      data: {
        originalName: input.originalName,
        filename: input.filename,
        mimeType: input.mimeType,
        size: input.size,
        path: filePath,
        status: FileStatus.UPLOADED,
        tenantId: input.tenantId,
      },
    });

    return file;
  }

  async getFileById(id: string, tenantId: string) {
    const file = await prisma.file.findFirst({
      where: {
        id,
        tenantId,
        deletedAt: null,
      },
    });

    if (!file) {
      throw AppError.notFound('File not found', ErrorCodes.FILE_NOT_FOUND);
    }

    return file;
  }

  async getFilesByTenant(tenantId: string) {
    const files = await prisma.file.findMany({
      where: {
        tenantId,
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });

    return files;
  }

  async deleteFile(id: string, tenantId: string) {
    const file = await this.getFileById(id, tenantId);

    if (fs.existsSync(file.path)) {
      fs.unlinkSync(file.path);
    }

    await prisma.file.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return { message: 'File deleted successfully' };
  }

  async updateFileStatus(id: string, status: FileStatus) {
    const file = await prisma.file.update({
      where: { id },
      data: { status },
    });

    return file;
  }
}

export const fileService = new FileService();
