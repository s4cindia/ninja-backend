import { PrismaClient } from '@prisma/client';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuid } from 'uuid';
import { logger } from '../../lib/logger';
import * as fs from 'fs/promises';
import * as path from 'path';

const LOCAL_STORAGE_PATH = '/tmp/feedback-attachments';

interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/epub+zip',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/markdown',
  'text/plain',
];

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export class FeedbackAttachmentService {
  constructor(
    private prisma: PrismaClient,
    private s3: S3Client,
    private bucketName: string
  ) {}

  async upload(
    feedbackId: string,
    file: MulterFile,
    userId?: string
  ) {
    const feedback = await this.prisma.feedback.findUnique({
      where: { id: feedbackId },
    });
    if (!feedback) {
      throw new Error('Feedback not found');
    }

    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new Error(`File type not allowed: ${file.mimetype}`);
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new Error(`File too large. Maximum size is 10MB`);
    }

    const ext = file.originalname.split('.').pop();
    const filename = `feedback-attachments/${feedbackId}/${uuid()}.${ext}`;

    logger.info(`Uploading file: key=${filename}, size=${file.size}`);

    try {
      await this.s3.send(new PutObjectCommand({
        Bucket: this.bucketName,
        Key: filename,
        Body: file.buffer,
        ContentType: file.mimetype,
      }));
      logger.info(`S3 upload successful: ${filename}`);
    } catch (s3Error) {
      const errorMessage = (s3Error as Error).message;
      if (errorMessage.includes('credentials') || errorMessage.includes('Could not load')) {
        logger.warn(`S3 not available, falling back to local storage: ${errorMessage}`);
        const localPath = path.join(LOCAL_STORAGE_PATH, filename);
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await fs.writeFile(localPath, file.buffer);
        logger.info(`Local storage upload successful: ${localPath}`);
      } else {
        logger.error(`S3 upload failed: ${errorMessage}`);
        throw new Error(`Failed to upload file to storage: ${errorMessage}`);
      }
    }

    const attachment = await this.prisma.feedbackAttachment.create({
      data: {
        feedbackId,
        filename,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
        uploadedById: userId,
      },
      include: {
        uploadedBy: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      },
    });

    return attachment;
  }

  async list(feedbackId: string) {
    return this.prisma.feedbackAttachment.findMany({
      where: { feedbackId },
      include: {
        uploadedBy: {
          select: { id: true, email: true, firstName: true, lastName: true },
        },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getDownloadUrl(attachmentId: string) {
    const attachment = await this.prisma.feedbackAttachment.findUnique({
      where: { id: attachmentId },
    });
    if (!attachment) {
      throw new Error('Attachment not found');
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: attachment.filename,
        ResponseContentDisposition: `attachment; filename="${attachment.originalName}"`,
      });
      const url = await getSignedUrl(this.s3, command, { expiresIn: 3600 });
      return { url, attachment };
    } catch (s3Error) {
      const localPath = path.join(LOCAL_STORAGE_PATH, attachment.filename);
      try {
        await fs.access(localPath);
        return { url: `/api/v1/feedback/attachments/${attachmentId}/file`, attachment, isLocal: true };
      } catch {
        throw new Error('File not found in storage');
      }
    }
  }

  async delete(attachmentId: string, userId: string) {
    const attachment = await this.prisma.feedbackAttachment.findUnique({
      where: { id: attachmentId },
    });
    if (!attachment) {
      throw new Error('Attachment not found');
    }

    if (attachment.uploadedById !== userId) {
      throw new Error('Not authorized to delete this attachment');
    }

    try {
      await this.s3.send(new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: attachment.filename,
      }));
    } catch (s3Error) {
      const localPath = path.join(LOCAL_STORAGE_PATH, attachment.filename);
      try {
        await fs.unlink(localPath);
      } catch {
        logger.warn(`File not found in storage: ${attachment.filename}`);
      }
    }

    await this.prisma.feedbackAttachment.delete({
      where: { id: attachmentId },
    });

    return { success: true };
  }

  async getLocalFile(attachmentId: string): Promise<{ buffer: Buffer; attachment: { originalName: string; mimeType: string } }> {
    const attachment = await this.prisma.feedbackAttachment.findUnique({
      where: { id: attachmentId },
    });
    if (!attachment) {
      throw new Error('Attachment not found');
    }

    const localPath = path.join(LOCAL_STORAGE_PATH, attachment.filename);
    const buffer = await fs.readFile(localPath);
    return { buffer, attachment: { originalName: attachment.originalName, mimeType: attachment.mimeType } };
  }
}
