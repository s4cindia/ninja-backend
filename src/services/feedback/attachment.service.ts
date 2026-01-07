import { PrismaClient } from '@prisma/client';
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuid } from 'uuid';

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

    await this.s3.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: filename,
      Body: file.buffer,
      ContentType: file.mimetype,
    }));

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

    const command = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: attachment.filename,
      ResponseContentDisposition: `attachment; filename="${attachment.originalName}"`,
    });

    const url = await getSignedUrl(this.s3, command, { expiresIn: 3600 });
    return { url, attachment };
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

    await this.s3.send(new DeleteObjectCommand({
      Bucket: this.bucketName,
      Key: attachment.filename,
    }));

    await this.prisma.feedbackAttachment.delete({
      where: { id: attachmentId },
    });

    return { success: true };
  }
}
