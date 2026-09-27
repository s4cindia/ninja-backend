import { Request, Response } from 'express';
import { nanoid } from 'nanoid';
import { s3Service } from '../services/s3.service';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { pdfConfig } from '../config/pdf.config';

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

    // Allow both EPUB and PDF files
    const fileExtension = fileName.toLowerCase();
    const isEpub = fileExtension.endsWith('.epub');
    const isPdf = fileExtension.endsWith('.pdf');

    if (!isEpub && !isPdf) {
      return res.status(400).json({
        success: false,
        error: 'Only EPUB and PDF files are allowed'
      });
    }

    // PDFs get pdfConfig's own (much larger) cap -- this presigned-S3 path is
    // what batch PDF uploads use, and it's WAF-safe (unlike the direct
    // multipart /pdf/audit-upload route, which shares pdfConfig.maxFileSizeMB
    // but is documented as exactly the kind of request CloudFront's WAF can
    // block for large bodies). EPUB and everything else keeps the original
    // 100MB cap -- unrelated to this change.
    const maxSize = isPdf ? pdfConfig.maxFileSizeMB * 1024 * 1024 : 100 * 1024 * 1024;
    if (fileSize && fileSize > maxSize) {
      return res.status(400).json({
        success: false,
        error: `File size exceeds maximum allowed (${maxSize / 1024 / 1024}MB)`
      });
    }

    // Determine default content type based on file extension
    const defaultContentType = isPdf ? 'application/pdf' : 'application/epub+zip';
    const finalContentType = contentType || defaultContentType;

    const result = await s3Service.getPresignedUploadUrl(
      tenantId,
      fileName,
      finalContentType
    );

    const file = await prisma.file.create({
      data: {
        id: nanoid(),
        tenantId,
        filename: fileName,
        originalName: fileName,
        mimeType: finalContentType,
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

    // Verify the object actually landed in S3 and read its REAL size via a
    // HEAD request, rather than trusting the client-declared fileSize from
    // the presign request (getPresignedUploadUrl above) -- nothing before
    // this point confirms the upload succeeded at all, and batch weight
    // tiering (comparison-study batch PDF processing) depends on this
    // number being honest. getFileSize throws if the object is missing,
    // which is exactly the "never actually uploaded" case.
    let realSize: number;
    try {
      realSize = await s3Service.getFileSize(file.storagePath ?? file.path);
    } catch (error) {
      logger.warn(`[confirmUpload] Object not found in S3 for file ${fileId} (key ${file.storagePath ?? file.path}): ${error instanceof Error ? error.message : 'Unknown error'}`);
      return res.status(400).json({ success: false, error: 'Upload did not complete -- object not found in storage' });
    }

    const updatedFile = await prisma.file.update({
      where: { id: fileId },
      data: { status: 'UPLOADED', size: realSize },
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
