import { Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { s3Service } from '../services/s3.service';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';

export const getPresignedUploadUrl = async (req: Request, res: Response) => {
  try {
    // Check if S3 is enabled for development
    const useS3 = process.env.USE_S3 !== 'false';
    if (!useS3) {
      return res.status(500).json({
        success: false,
        error: 'S3 not configured - use direct upload instead'
      });
    }

    const { fileName, contentType, fileSize } = req.body;
    const tenantId = req.user?.tenantId;

    if (!tenantId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    if (!fileName) {
      return res.status(400).json({ success: false, error: 'fileName is required' });
    }

    if (!fileName.toLowerCase().endsWith('.epub')) {
      return res.status(400).json({ success: false, error: 'Only EPUB files are allowed' });
    }

    const maxSize = 100 * 1024 * 1024;
    if (fileSize && fileSize > maxSize) {
      return res.status(400).json({
        success: false,
        error: `File size exceeds maximum allowed (${maxSize / 1024 / 1024}MB)`
      });
    }

    const result = await s3Service.getPresignedUploadUrl(
      tenantId,
      fileName,
      contentType || 'application/epub+zip'
    );

    const file = await prisma.file.create({
      data: {
        id: nanoid(),
        tenantId,
        filename: fileName,
        originalName: fileName,
        mimeType: contentType || 'application/epub+zip',
        size: fileSize || 0,
        path: result.fileKey,
        status: 'PENDING_UPLOAD',
        storagePath: result.fileKey,
        storageType: 'S3',
        updatedAt: new Date(),
      },
    });

    res.json({
      success: true,
      data: {
        uploadUrl: result.uploadUrl,
        fileKey: result.fileKey,
        fileId: file.id,
        expiresIn: result.expiresIn,
      },
    });
  } catch (error) {
    logger.error(`Failed to generate presigned URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
    res.status(500).json({ success: false, error: 'Failed to generate upload URL' });
  }
};

export const confirmUpload = async (req: Request, res: Response) => {
  try {
    const { fileId } = req.params;
    const tenantId = req.user?.tenantId;

    if (!tenantId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const file = await prisma.file.findFirst({
      where: { id: fileId, tenantId },
    });

    if (!file) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    if (file.status !== 'PENDING_UPLOAD') {
      return res.status(400).json({ success: false, error: 'File upload already confirmed' });
    }

    const updatedFile = await prisma.file.update({
      where: { id: fileId },
      data: { status: 'UPLOADED' },
    });

    res.json({
      success: true,
      data: updatedFile,
    });
  } catch (error) {
    logger.error(`Failed to confirm upload: ${error instanceof Error ? error.message : 'Unknown error'}`);
    res.status(500).json({ success: false, error: 'Failed to confirm upload' });
  }
};

export const getPresignedDownloadUrl = async (req: Request, res: Response) => {
  try {
    const { fileId } = req.params;
    const tenantId = req.user?.tenantId;

    if (!tenantId) {
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }

    const file = await prisma.file.findFirst({
      where: { id: fileId, tenantId, storageType: 'S3' },
    });

    if (!file || !file.storagePath) {
      return res.status(404).json({ success: false, error: 'File not found' });
    }

    const result = await s3Service.getPresignedDownloadUrl(file.storagePath);

    res.json({
      success: true,
      data: {
        downloadUrl: result.downloadUrl,
        fileName: file.originalName,
        expiresIn: result.expiresIn,
      },
    });
  } catch (error) {
    logger.error(`Failed to generate download URL: ${error instanceof Error ? error.message : 'Unknown error'}`);
    res.status(500).json({ success: false, error: 'Failed to generate download URL' });
  }
};
