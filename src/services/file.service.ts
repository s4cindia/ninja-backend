import fs from 'fs/promises';
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

    try {
      await fs.unlink(file.path);
    } catch (err: unknown) {
      const fsError = err as NodeJS.ErrnoException;
      if (fsError.code !== 'ENOENT') {
        console.error(`Failed to delete physical file: ${file.path}`, err);
      }
    }

    await prisma.file.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    return { message: 'File deleted successfully' };
  }

  async updateFileStatus(
    id: string,
    tenantId: string,
    status: FileStatus,
    metadata?: Record<string, unknown>
  ) {
    await this.getFileById(id, tenantId);
    
    const file = await prisma.file.updateMany({
      where: { id, tenantId },
      data: {
        status,
        ...(metadata && { metadata: metadata as object }),
      },
    });

    if (file.count === 0) {
      throw AppError.notFound('File not found', ErrorCodes.FILE_NOT_FOUND);
    }

    return this.getFileById(id, tenantId);
  }

  async updateLatestJobId(fileId: string, tenantId: string, jobId: string) {
    const file = await this.getFileById(fileId, tenantId);
    return prisma.file.update({
      where: { id: file.id },
      data: { latestJobId: jobId },
    });
  }

  async updateFileMetadata(
    id: string,
    tenantId: string,
    metadata: Record<string, unknown>
  ) {
    const file = await this.getFileById(id, tenantId);
    const existingMetadata = (file.metadata as Record<string, unknown>) || {};
    
    await prisma.file.updateMany({
      where: { id, tenantId },
      data: {
        metadata: { ...existingMetadata, ...metadata } as object,
      },
    });

    return this.getFileById(id, tenantId);
  }

  async getFilesByStatus(tenantId: string, status: FileStatus) {
    return prisma.file.findMany({
      where: {
        tenantId,
        status,
        deletedAt: null,
      },
      orderBy: {
        createdAt: 'desc',
      },
    });
  }

  async listFilesAdvanced(
    tenantId: string,
    options: {
      page?: number;
      limit?: number;
      status?: FileStatus;
      mimeType?: string;
      sortBy?: 'createdAt' | 'size' | 'originalName';
      sortOrder?: 'asc' | 'desc';
    }
  ) {
    const {
      page = 1,
      limit = 20,
      status,
      mimeType,
      sortBy = 'createdAt',
      sortOrder = 'desc',
    } = options;

    const skip = (page - 1) * limit;

    const where = {
      tenantId,
      deletedAt: null,
      ...(status && { status }),
      ...(mimeType && { mimeType: { contains: mimeType } }),
    };

    const [files, total] = await Promise.all([
      prisma.file.findMany({
        where,
        skip,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
      }),
      prisma.file.count({ where }),
    ]);

    return {
      files,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getFileStats(tenantId: string) {
    const [statusCounts, totalSize, mimeTypeCounts] = await Promise.all([
      prisma.file.groupBy({
        by: ['status'],
        where: { tenantId, deletedAt: null },
        _count: { status: true },
      }),
      prisma.file.aggregate({
        where: { tenantId, deletedAt: null },
        _sum: { size: true },
        _count: { id: true },
      }),
      prisma.file.groupBy({
        by: ['mimeType'],
        where: { tenantId, deletedAt: null },
        _count: { mimeType: true },
      }),
    ]);

    const byStatus: Record<string, number> = {};
    statusCounts.forEach((item) => {
      byStatus[item.status] = item._count.status;
    });

    const byMimeType: Record<string, number> = {};
    mimeTypeCounts.forEach((item) => {
      byMimeType[item.mimeType] = item._count.mimeType;
    });

    return {
      totalFiles: totalSize._count.id,
      totalSize: totalSize._sum.size || 0,
      byStatus,
      byMimeType,
    };
  }
}

export const fileService = new FileService();
