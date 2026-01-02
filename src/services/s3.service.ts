import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { config } from '../config';
import { logger } from '../lib/logger';

const s3Client = new S3Client({
  region: config.s3Region,
  ...(config.awsAccessKeyId && config.awsSecretAccessKey ? {
    credentials: {
      accessKeyId: config.awsAccessKeyId,
      secretAccessKey: config.awsSecretAccessKey,
    }
  } : {}),
});

export interface PresignedUploadResult {
  uploadUrl: string;
  fileKey: string;
  expiresIn: number;
}

export interface PresignedDownloadResult {
  downloadUrl: string;
  expiresIn: number;
}

class S3Service {
  private bucket = config.s3Bucket;

  async getPresignedUploadUrl(
    tenantId: string,
    fileName: string,
    contentType: string = 'application/epub+zip',
    expiresIn: number = 3600
  ): Promise<PresignedUploadResult> {
    const timestamp = Date.now();
    const sanitizedFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const fileKey = `uploads/${tenantId}/${timestamp}-${sanitizedFileName}`;

    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
      ContentType: contentType,
    });

    const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn });

    logger.info(`Generated presigned upload URL for ${fileKey}`);

    return {
      uploadUrl,
      fileKey,
      expiresIn,
    };
  }

  async getPresignedDownloadUrl(
    fileKey: string,
    expiresIn: number = 3600
  ): Promise<PresignedDownloadResult> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
    });

    const downloadUrl = await getSignedUrl(s3Client, command, { expiresIn });

    return {
      downloadUrl,
      expiresIn,
    };
  }

  async getFileBuffer(fileKey: string): Promise<Buffer> {
    const command = new GetObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
    });

    const response = await s3Client.send(command);
    const stream = response.Body as NodeJS.ReadableStream;

    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.from(chunk));
    }

    return Buffer.concat(chunks);
  }

  async deleteFile(fileKey: string): Promise<void> {
    const command = new DeleteObjectCommand({
      Bucket: this.bucket,
      Key: fileKey,
    });

    await s3Client.send(command);
    logger.info(`Deleted file from S3: ${fileKey}`);
  }

  isConfigured(): boolean {
    return !!this.bucket;
  }
}

export const s3Service = new S3Service();
