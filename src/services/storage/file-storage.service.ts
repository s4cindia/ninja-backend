import * as fs from 'fs/promises';
import * as path from 'path';
import {
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { logger } from '../../lib/logger';
import { config } from '../../config';
import { s3Client, s3Service } from '../s3.service';

// Local-disk fallback, used only when S3 isn't configured (e.g. local dev
// without AWS credentials). NOT persistent across deploys/container
// restarts — every ECS deployment replaces the running task, wiping /tmp.
// This bit Comparison Study trials in practice: files uploaded before a
// deploy became permanently unreadable afterward, because nothing survived
// the container swap. S3 (below) is the real, persistent path.
const STORAGE_BASE = process.env.EPUB_STORAGE_PATH || '/tmp/epub-storage';
const S3_PREFIX = 'job-storage';

if (!s3Service.isConfigured()) {
  logger.warn(
    `S3 not configured (S3_BUCKET unset) — falling back to local disk storage at ${STORAGE_BASE}, ` +
    `which does NOT persist across deploys or container restarts. Set S3_BUCKET for production.`
  );
}

function isNotFoundError(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'name' in error &&
    ((error as { name?: string }).name === 'NoSuchKey' || (error as { name?: string }).name === 'NotFound');
}

async function s3GetBuffer(key: string): Promise<Buffer | null> {
  try {
    const response = await s3Client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }));
    const stream = response.Body as NodeJS.ReadableStream;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
    return Buffer.concat(chunks);
  } catch (error) {
    if (isNotFoundError(error)) return null;
    throw error;
  }
}

async function s3PutBuffer(key: string, buffer: Buffer): Promise<void> {
  await s3Client.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, Body: buffer }));
}

class FileStorageService {
  async ensureDir(dirPath: string): Promise<void> {
    await fs.mkdir(dirPath, { recursive: true });
  }

  async saveFile(jobId: string, fileName: string, buffer: Buffer): Promise<string> {
    const sanitizedFileName = path.basename(fileName);

    if (s3Service.isConfigured()) {
      const key = `${S3_PREFIX}/${jobId}/${sanitizedFileName}`;
      await s3PutBuffer(key, buffer);
      logger.info(`Saved file to S3: ${key} (${buffer.length} bytes)`);
      return key;
    }

    const jobDir = path.join(STORAGE_BASE, jobId);
    await this.ensureDir(jobDir);
    const filePath = path.join(jobDir, sanitizedFileName);
    await fs.writeFile(filePath, buffer);
    logger.info(`Saved file locally: ${filePath}`);
    return filePath;
  }

  async getFile(jobId: string, fileName: string): Promise<Buffer | null> {
    const sanitizedFileName = path.basename(fileName);

    if (s3Service.isConfigured()) {
      return s3GetBuffer(`${S3_PREFIX}/${jobId}/${sanitizedFileName}`);
    }

    try {
      const filePath = path.join(STORAGE_BASE, jobId, sanitizedFileName);
      return await fs.readFile(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  async deleteFile(jobId: string, fileName: string): Promise<void> {
    const sanitizedFileName = path.basename(fileName);

    if (s3Service.isConfigured()) {
      try {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: config.s3Bucket,
          Key: `${S3_PREFIX}/${jobId}/${sanitizedFileName}`,
        }));
      } catch (error) {
        if (!isNotFoundError(error)) throw error;
      }
      return;
    }

    try {
      const filePath = path.join(STORAGE_BASE, jobId, sanitizedFileName);
      await fs.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  async deleteJobFiles(jobId: string): Promise<void> {
    if (s3Service.isConfigured()) {
      try {
        const prefix = `${S3_PREFIX}/${jobId}/`;
        let continuationToken: string | undefined;
        do {
          const listed = await s3Client.send(new ListObjectsV2Command({
            Bucket: config.s3Bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }));
          const keys = (listed.Contents ?? []).map(o => o.Key).filter((k): k is string => !!k);
          if (keys.length > 0) {
            await s3Client.send(new DeleteObjectsCommand({
              Bucket: config.s3Bucket,
              Delete: { Objects: keys.map(Key => ({ Key })) },
            }));
          }
          continuationToken = listed.IsTruncated ? listed.NextContinuationToken : undefined;
        } while (continuationToken);
      } catch (error) {
        logger.error('Failed to delete job files from S3', error instanceof Error ? error : undefined);
      }
      return;
    }

    try {
      const jobDir = path.join(STORAGE_BASE, jobId);
      await fs.rm(jobDir, { recursive: true, force: true });
    } catch (error) {
      logger.error('Failed to delete job files', error instanceof Error ? error : undefined);
    }
  }

  async saveRemediatedFile(jobId: string, fileName: string, buffer: Buffer): Promise<string> {
    const sanitizedFileName = path.basename(fileName);

    if (s3Service.isConfigured()) {
      const key = `${S3_PREFIX}/${jobId}/remediated/${sanitizedFileName}`;
      await s3PutBuffer(key, buffer);
      logger.info(`Saved remediated file to S3: ${key} (${buffer.length} bytes)`);
      return key;
    }

    const jobDir = path.join(STORAGE_BASE, jobId, 'remediated');
    await this.ensureDir(jobDir);
    const filePath = path.join(jobDir, sanitizedFileName);
    await fs.writeFile(filePath, buffer);
    logger.info(`Saved remediated file locally: ${filePath}`);
    return filePath;
  }

  async getRemediatedFile(jobId: string, fileName: string): Promise<Buffer | null> {
    const sanitizedFileName = path.basename(fileName);
    const ext = path.extname(sanitizedFileName);
    const baseName = sanitizedFileName.slice(0, -ext.length);

    // Try plain filename first (how saveRemediatedFile stores it),
    // then fall back to the _remediated suffix convention
    const candidates = [
      sanitizedFileName,
      baseName.endsWith('_remediated') ? sanitizedFileName : `${baseName}_remediated${ext}`,
    ];

    for (const candidate of candidates) {
      if (s3Service.isConfigured()) {
        const buffer = await s3GetBuffer(`${S3_PREFIX}/${jobId}/remediated/${candidate}`);
        if (buffer) return buffer;
        continue;
      }
      try {
        const filePath = path.join(STORAGE_BASE, jobId, 'remediated', candidate);
        return await fs.readFile(filePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return null;
  }

  /**
   * Resolve a previously-stored file reference back to a buffer. The
   * reference is whatever saveFile/saveRemediatedFile returned — an S3 key
   * when S3 is configured, or a local path in the fallback case. HTTP URLs
   * are not supported.
   */
  async downloadFile(fileUrlOrKey: string): Promise<Buffer> {
    try {
      if (fileUrlOrKey.startsWith('http')) {
        // TODO: Add HTTP support when needed
        throw new Error('HTTP URL download not yet implemented');
      }

      if (s3Service.isConfigured()) {
        const buffer = await s3GetBuffer(fileUrlOrKey);
        if (!buffer) throw new Error(`File not found in S3: ${fileUrlOrKey}`);
        logger.info(`Downloaded file from S3: ${fileUrlOrKey}`);
        return buffer;
      }

      // Handle both absolute and relative local paths
      const candidatePath = fileUrlOrKey.startsWith('/')
        ? fileUrlOrKey
        : path.join(STORAGE_BASE, fileUrlOrKey);

      // Resolve to absolute path to prevent path traversal
      const resolvedPath = path.resolve(candidatePath);
      const resolvedBase = path.resolve(STORAGE_BASE);

      // Validate that resolved path is inside STORAGE_BASE
      if (!resolvedPath.startsWith(resolvedBase + path.sep) && resolvedPath !== resolvedBase) {
        throw new Error('Path traversal attempt detected - access denied');
      }

      const buffer = await fs.readFile(resolvedPath);
      logger.info(`Downloaded file from ${resolvedPath}`);
      return buffer;
    } catch (error) {
      logger.error(`Failed to download file from ${fileUrlOrKey}`, {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      throw error;
    }
  }
}

export const fileStorageService = new FileStorageService();
