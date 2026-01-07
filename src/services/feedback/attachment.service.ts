import { PrismaClient } from '@prisma/client';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuid } from 'uuid';
import * as fs from 'fs/promises';
import * as path from 'path';
import { logger } from '../../lib/logger';

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

const ALLOWED_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'pdf', 'epub', 'docx', 'md', 'txt'];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const LOCAL_STORAGE_PATH = process.env.LOCAL_STORAGE_PATH || path.resolve(process.cwd(), 'data', 'feedback-attachments');

function sanitizeFilename(filename: string): string {
  const sanitized = filename
    .replace(/[/\\]/g, '_')
    .replace(/\0/g, '')
    .replace(/[^\w\s.-]/g, '_');
  return sanitized || 'unnamed';
}

function getSafeExtension(filename: string): string {
  const parts = filename.split('.');
  if (parts.length < 2) return 'bin';
  const ext = parts.pop()?.toLowerCase() || 'bin';
  return ALLOWED_EXTENSIONS.includes(ext) ? ext : 'bin';
}

interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export class FeedbackAttachmentService {
  constructor(
    private prisma: PrismaClient,
    private s3: S3Client,
    private bucketName: string
  ) {}

  private async canAccessFeedback(feedbackId: string, userId?: string): Promise<boolean> {
    const feedback = await this.prisma.feedback.findUnique({
      where: { id: feedbackId },
      select: { userId: true, tenantId: true },
    });

    if (!feedback) return false;

    if (feedback.userId === userId) return true;

    if (userId) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { tenantId: true, role: true },
      });
      if (user?.role === 'ADMIN' && user.tenantId === feedback.tenantId) {
        return true;
      }
    }

    return false;
  }

  private async canDeleteAttachment(attachmentId: string, userId: string): Promise<{ allowed: boolean; attachment?: any }> {
    const attachment = await this.prisma.feedbackAttachment.findUnique({
      where: { id: attachmentId },
      include: { feedback: { select: { userId: true, tenantId: true } } },
    });

    if (!attachment) return { allowed: false };

    if (attachment.uploadedById === userId) return { allowed: true, attachment };

    if (attachment.feedback.userId === userId) return { allowed: true, attachment };

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { tenantId: true, role: true },
    });
    if (user?.role === 'ADMIN' && user.tenantId === attachment.feedback.tenantId) {
      return { allowed: true, attachment };
    }

    return { allowed: false };
  }

  private async deleteFromStorage(filename: string): Promise<void> {
    let s3Deleted = false;
    let localDeleted = false;

    try {
      await this.s3.send(new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: filename,
      }));
      s3Deleted = true;
      logger.info(`Deleted from S3: ${filename}`);
    } catch (s3Error) {
      logger.warn(`S3 delete failed for ${filename}: ${(s3Error as Error).message}`);
    }

    const localPath = path.join(LOCAL_STORAGE_PATH, filename);
    try {
      await fs.unlink(localPath);
      localDeleted = true;
      logger.info(`Deleted from local storage: ${localPath}`);
    } catch (localError) {
      if ((localError as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn(`Local delete failed for ${filename}: ${(localError as Error).message}`);
      }
    }

    if (!s3Deleted && !localDeleted) {
      logger.warn(`File not found in any storage location: ${filename}`);
    }
  }

  async upload(feedbackId: string, file: MulterFile, userId?: string) {
    const canAccess = await this.canAccessFeedback(feedbackId, userId);
    if (!canAccess) {
      throw new Error('Not authorized to add attachments to this feedback');
    }

    if (!ALLOWED_MIME_TYPES.includes(file.mimetype)) {
      throw new Error(`File type not allowed: ${file.mimetype}`);
    }

    if (file.size > MAX_FILE_SIZE) {
      throw new Error('File too large. Maximum size is 10MB');
    }

    const ext = getSafeExtension(file.originalname);
    const filename = `feedback-attachments/${feedbackId}/${uuid()}.${ext}`;
    const sanitizedOriginalName = sanitizeFilename(file.originalname);

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
      const isConfigError =
        s3Error instanceof Error && (
          s3Error.name === 'CredentialsProviderError' ||
          s3Error.name === 'InvalidAccessKeyId' ||
          s3Error.name === 'SignatureDoesNotMatch' ||
          s3Error.message.includes('credentials') ||
          s3Error.message.includes('Could not load') ||
          s3Error.message.includes('config') ||
          s3Error.message.includes('region')
        );

      if (isConfigError) {
        logger.warn(`S3 not configured, falling back to local storage: ${(s3Error as Error).name}`);
        const localPath = path.join(LOCAL_STORAGE_PATH, filename);
        await fs.mkdir(path.dirname(localPath), { recursive: true });
        await fs.writeFile(localPath, file.buffer);
        logger.info(`Local storage upload successful: ${localPath}`);
      } else {
        logger.error(`S3 upload failed: ${(s3Error as Error).message}`);
        throw new Error(`Failed to upload file to storage: ${(s3Error as Error).message}`);
      }
    }

    try {
      const attachment = await this.prisma.feedbackAttachment.create({
        data: {
          feedbackId,
          filename,
          originalName: sanitizedOriginalName,
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
    } catch (dbError) {
      logger.error(`Database insert failed, cleaning up uploaded file: ${filename}`);
      await this.deleteFromStorage(filename);
      throw dbError;
    }
  }

  async list(feedbackId: string, userId?: string) {
    const canAccess = await this.canAccessFeedback(feedbackId, userId);
    if (!canAccess) {
      throw new Error('Not authorized to view attachments for this feedback');
    }

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

  async getDownloadUrl(attachmentId: string, userId?: string) {
    const attachment = await this.prisma.feedbackAttachment.findUnique({
      where: { id: attachmentId },
      include: { feedback: { select: { userId: true, tenantId: true } } },
    });

    if (!attachment) {
      throw new Error('Attachment not found');
    }

    const canAccess = await this.canAccessFeedback(attachment.feedbackId, userId);
    if (!canAccess) {
      throw new Error('Not authorized to download this attachment');
    }

    const safeFilename = sanitizeFilename(attachment.originalName).replace(/"/g, '\\"');

    const localPath = path.join(LOCAL_STORAGE_PATH, attachment.filename);
    
    try {
      await fs.access(localPath);
      logger.info(`Serving local file: ${localPath}`);
      return {
        url: `/api/v1/feedback/attachments/${attachmentId}/file`,
        attachment,
        isLocal: true
      };
    } catch {
      logger.info(`Local file not found, trying S3: ${attachment.filename}`);
    }

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: attachment.filename,
        ResponseContentDisposition: `attachment; filename="${safeFilename}"`,
      });
      const url = await getSignedUrl(this.s3, command, { expiresIn: 3600 });
      return { url, attachment };
    } catch (s3Error) {
      logger.error(`File not found in any storage: ${attachment.filename}`);
      throw new Error('File not found in storage. The file may have been uploaded before storage was configured.');
    }
  }

  async getLocalFile(attachmentId: string, userId?: string) {
    const attachment = await this.prisma.feedbackAttachment.findUnique({
      where: { id: attachmentId },
    });

    if (!attachment) {
      throw new Error('Attachment not found');
    }

    const canAccess = await this.canAccessFeedback(attachment.feedbackId, userId);
    if (!canAccess) {
      throw new Error('Not authorized to download this attachment');
    }

    const localPath = path.join(LOCAL_STORAGE_PATH, attachment.filename);
    const fileBuffer = await fs.readFile(localPath);
    return { buffer: fileBuffer, attachment };
  }

  async delete(attachmentId: string, userId: string) {
    const { allowed, attachment } = await this.canDeleteAttachment(attachmentId, userId);

    if (!allowed || !attachment) {
      throw new Error('Not authorized to delete this attachment');
    }

    await this.deleteFromStorage(attachment.filename);

    await this.prisma.feedbackAttachment.delete({
      where: { id: attachmentId },
    });

    return { success: true };
  }
}
