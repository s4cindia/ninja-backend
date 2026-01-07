import { PrismaClient } from '@prisma/client';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
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
    try {
      await this.s3.send(new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: filename,
      }));
      logger.info(`Deleted from S3: ${filename}`);
    } catch (s3Error) {
      const localPath = path.join(LOCAL_STORAGE_PATH, filename);
      try {
        await fs.unlink(localPath);
        logger.info(`Deleted from local storage: ${localPath}`);
      } catch (localError) {
        logger.warn(`Could not delete file from storage: ${filename}`);
      }
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

    try {
      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: attachment.filename,
        ResponseContentDisposition: `attachment; filename="${safeFilename}"`,
      });
      const url = await getSignedUrl(this.s3, command, { expiresIn: 3600 });
      return { url, attachment };
    } catch (s3Error) {
      const errorMsg = s3Error instanceof Error ? s3Error.message : String(s3Error);
      logger.info(`S3 unavailable for attachment ${attachmentId} (${attachment.filename}), falling back to local storage: ${errorMsg}`);
      return {
        url: `/api/v1/feedback/attachments/${attachmentId}/file`,
        attachment,
        isLocal: true
      };
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
    try {
      const fileBuffer = await fs.readFile(localPath);
      return { buffer: fileBuffer, attachment };
    } catch (readError) {
      if ((readError as NodeJS.ErrnoException).code === 'ENOENT') {
        logger.warn(`Local file not found: ${localPath}`);
        throw new Error('File not available locally. It may exist in S3 storage.');
      }
      throw readError;
    }
  }

  async delete(attachmentId: string, userId: string) {
    const { allowed, attachment } = await this.canDeleteAttachment(attachmentId, userId);

    if (!allowed || !attachment) {
      throw new Error('Not authorized to delete this attachment');
    }

    const filename = attachment.filename;

    await this.prisma.feedbackAttachment.delete({
      where: { id: attachmentId },
    });

    try {
      await this.deleteFromStorage(filename);
    } catch (storageError) {
      const errorMsg = storageError instanceof Error ? storageError.message : String(storageError);
      logger.warn(`Failed to delete file from storage after DB deletion: ${filename} - ${errorMsg}`);
    }

    return { success: true };
  }

  async getPresignedUploadUrl(
    feedbackId: string,
    filename: string,
    contentType: string,
    size: number,
    userId?: string
  ): Promise<{ presignedUrl: string | null; s3Key: string; useDirectUpload: boolean }> {
    const feedback = await this.prisma.feedback.findUnique({
      where: { id: feedbackId },
    });
    if (!feedback) {
      throw new Error('Feedback not found');
    }

    const canAccess = await this.canAccessFeedback(feedbackId, userId);
    if (!canAccess) {
      throw new Error('Not authorized to upload attachments to this feedback');
    }

    if (size > MAX_FILE_SIZE) {
      throw new Error(`File size exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit`);
    }

    if (!ALLOWED_MIME_TYPES.includes(contentType)) {
      throw new Error('File type not allowed');
    }

    if (!this.bucketName || this.bucketName === 'feedback-attachments-local') {
      return {
        presignedUrl: null,
        s3Key: '',
        useDirectUpload: true,
      };
    }

    const timestamp = Date.now();
    const sanitizedFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const s3Key = `feedback-attachments/${feedbackId}/${timestamp}-${sanitizedFilename}`;

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: s3Key,
      ContentType: contentType,
    });

    const presignedUrl = await getSignedUrl(this.s3, command, { expiresIn: 300 });

    return {
      presignedUrl,
      s3Key,
      useDirectUpload: false,
    };
  }

  async confirmUpload(
    feedbackId: string,
    s3Key: string,
    originalName: string,
    mimeType: string,
    clientReportedSize: number,
    userId?: string
  ) {
    const feedback = await this.prisma.feedback.findUnique({
      where: { id: feedbackId },
    });
    if (!feedback) {
      throw new Error('Feedback not found');
    }

    const canAccess = await this.canAccessFeedback(feedbackId, userId);
    if (!canAccess) {
      throw new Error('Not authorized to confirm uploads for this feedback');
    }

    const expectedPrefix = `feedback-attachments/${feedbackId}/`;
    if (!s3Key.startsWith(expectedPrefix)) {
      throw new Error('Invalid S3 key for this feedback');
    }

    const headCommand = new HeadObjectCommand({
      Bucket: this.bucketName,
      Key: s3Key,
    });

    let actualSize: number;
    try {
      const headResult = await this.s3.send(headCommand);
      actualSize = headResult.ContentLength || clientReportedSize;
    } catch (error) {
      throw new Error('File not found in S3. Upload may have failed.');
    }

    const attachment = await this.prisma.feedbackAttachment.create({
      data: {
        feedbackId,
        filename: s3Key,
        originalName,
        mimeType,
        size: actualSize,
        uploadedById: userId || null,
      },
    });

    return attachment;
  }
}
