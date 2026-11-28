import * as fs from 'fs/promises';
import { createReadStream } from 'fs';
import * as path from 'path';
import { Readable } from 'stream';
import {
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  CopyObjectCommand,
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

/**
 * Resolve a local-fallback storage reference (absolute, or relative to
 * STORAGE_BASE) and refuse anything outside STORAGE_BASE.
 */
function resolveLocalStoragePath(fileUrlOrKey: string): string {
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
  return resolvedPath;
}

async function s3PutBuffer(key: string, buffer: Buffer): Promise<{ ETag?: string; VersionId?: string }> {
  const result = await s3Client.send(new PutObjectCommand({ Bucket: config.s3Bucket, Key: key, Body: buffer }));
  return { ETag: result?.ETag, VersionId: result?.VersionId };
}

/**
 * Identifies one version of a stored object, cheaply (no body read): the
 * S3 ETag + VersionId, or a local file's size + mtime. Two reads returning
 * the same fingerprint saw the same bytes, so a hash computed under one can
 * be reused under the other.
 */
function s3Fingerprint(etag: string | undefined, versionId: string | undefined): string | null {
  if (!etag && !versionId) return null;
  return `s3:${versionId ?? '-'}:${etag ?? '-'}`;
}

function localFingerprint(stat: { size: number; mtimeMs: number }): string {
  return `fs:${stat.size}:${stat.mtimeMs}`;
}

/** Emitted after a remediated file is written; see onRemediatedFileSaved. */
export interface RemediatedFileSavedEvent {
  jobId: string;
  fileName: string;
  /** What saveRemediatedFile returned: S3 key or local path. */
  fileRef: string;
  /** The bytes just written. Listeners must not keep a reference. */
  buffer: Buffer;
  /** Fingerprint of the written object (see s3Fingerprint); null if S3 returned none. */
  fingerprint: string | null;
}

export type RemediatedFileSavedListener = (event: RemediatedFileSavedEvent) => Promise<void> | void;

// HEAD, not GET -- an existence check must never pull a potentially large
// (tens-of-MB) file body over the network just to answer a boolean.
async function s3ObjectExists(key: string): Promise<boolean> {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: key }));
    return true;
  } catch (error) {
    if (isNotFoundError(error)) return false;
    throw error;
  }
}

// Server-side S3-to-S3 copy -- the object's bytes never transit this
// process. Real incident, comparison-study trial registration (2026-09-25):
// registerTrial() downloaded a just-uploaded PDF back out of S3 into an
// in-memory Buffer, purely to hand it to saveFile() below, which re-uploaded
// that same buffer to a different key -- a full download+reupload round
// trip inside the HTTP request/response cycle. For a large PDF this could
// exceed the server's own request timeout or exhaust memory, dropping the
// connection before ever responding (surfaced to the browser as a generic
// "Network Error", since axios reports that for any request that gets no
// response at all). CopyObjectCommand does the same net effect (the file
// ends up at the new key) without ever loading it into this process.
async function s3CopyObject(sourceKey: string, destKey: string): Promise<void> {
  await s3Client.send(new CopyObjectCommand({
    Bucket: config.s3Bucket,
    Key: destKey,
    CopySource: `${config.s3Bucket}/${encodeURIComponent(sourceKey)}`,
  }));
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

  /**
   * Same net effect as saveFile, for a source that's ALREADY an S3 object
   * (e.g. a comparison-study trial's presigned-upload key) -- does a
   * server-side S3-to-S3 copy instead of downloading the file into this
   * process just to re-upload it. Falls back to a real download+local-write
   * only when S3 isn't configured at all (local dev), matching saveFile's
   * own fallback.
   */
  async saveFileFromS3Key(jobId: string, fileName: string, sourceS3Key: string): Promise<string> {
    const sanitizedFileName = path.basename(fileName);

    if (s3Service.isConfigured()) {
      const key = `${S3_PREFIX}/${jobId}/${sanitizedFileName}`;
      await s3CopyObject(sourceS3Key, key);
      logger.info(`Copied file within S3: ${sourceS3Key} -> ${key}`);
      return key;
    }

    const buffer = await s3GetBuffer(sourceS3Key);
    if (!buffer) throw new Error(`Source S3 object not found: ${sourceS3Key}`);
    return this.saveFile(jobId, fileName, buffer);
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

  private readonly remediatedSavedListeners = new Set<RemediatedFileSavedListener>();

  /**
   * Registers a callback run after every saveRemediatedFile. Storage knows
   * nothing about what listeners do (the EPUB-from-PDF certification uses
   * it to cache the new file's hash and promptly revoke a certification of
   * the old bytes). A listener's failure is logged and never fails the
   * save. Returns an unsubscribe function.
   */
  onRemediatedFileSaved(listener: RemediatedFileSavedListener): () => void {
    this.remediatedSavedListeners.add(listener);
    return () => { this.remediatedSavedListeners.delete(listener); };
  }

  private async notifyRemediatedFileSaved(event: RemediatedFileSavedEvent): Promise<void> {
    for (const listener of this.remediatedSavedListeners) {
      try {
        await listener(event);
      } catch (error) {
        logger.warn(
          `[FileStorage] remediated-file-saved listener failed for job ${event.jobId}: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }
  }

  async saveRemediatedFile(jobId: string, fileName: string, buffer: Buffer): Promise<string> {
    const sanitizedFileName = path.basename(fileName);

    if (s3Service.isConfigured()) {
      const key = `${S3_PREFIX}/${jobId}/remediated/${sanitizedFileName}`;
      const put = await s3PutBuffer(key, buffer);
      logger.info(`Saved remediated file to S3: ${key} (${buffer.length} bytes)`);
      await this.notifyRemediatedFileSaved({
        jobId, fileName: sanitizedFileName, fileRef: key, buffer, fingerprint: s3Fingerprint(put.ETag, put.VersionId),
      });
      return key;
    }

    const jobDir = path.join(STORAGE_BASE, jobId, 'remediated');
    await this.ensureDir(jobDir);
    const filePath = path.join(jobDir, sanitizedFileName);
    await fs.writeFile(filePath, buffer);
    logger.info(`Saved remediated file locally: ${filePath}`);
    if (this.remediatedSavedListeners.size > 0) {
      const stat = await fs.stat(filePath);
      await this.notifyRemediatedFileSaved({
        jobId, fileName: sanitizedFileName, fileRef: filePath, buffer, fingerprint: localFingerprint(stat),
      });
    }
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
   * Whether a remediated file exists for this job, without downloading it.
   * Same candidate-filename fallback as getRemediatedFile (plain name, then
   * the `_remediated` suffix convention), but HEAD/fs.access only -- built
   * for a job/analysis status response that may be polled repeatedly, where
   * pulling a 50+MB PDF body just to answer "does one exist" would be
   * wasteful. See getAnalysis's own use of this: the AiAnalysis table's
   * `status: 'applied'` rows are intentionally pruned once an issue is
   * resolved and no longer appears in the latest audit (correct for that
   * table's own purpose), so a UI relying on "any row still says applied"
   * to decide whether to offer a download loses that signal the moment a
   * later round's re-audit confirms the fix worked -- exactly backwards.
   * The remediated file's own presence in storage is the one signal that
   * survives every round's pruning.
   */
  async remediatedFileExists(jobId: string, fileName: string): Promise<boolean> {
    return (await this.findRemediatedFileRef(jobId, fileName)) !== null;
  }

  /**
   * Storage reference (S3 key, or a STORAGE_BASE-relative local path) of
   * the remediated file getRemediatedFile would return -- same candidate
   * names, same order, HEAD/fs.access only. Null when none exists. The
   * reference is accepted by downloadFile/openReadStream, so a caller can
   * stream the file a job without `output.remediatedFileUrl` still serves.
   */
  async findRemediatedFileRef(jobId: string, fileName: string): Promise<string | null> {
    const sanitizedFileName = path.basename(fileName);
    const ext = path.extname(sanitizedFileName);
    const baseName = sanitizedFileName.slice(0, -ext.length);

    const candidates = [
      sanitizedFileName,
      baseName.endsWith('_remediated') ? sanitizedFileName : `${baseName}_remediated${ext}`,
    ];

    for (const candidate of candidates) {
      if (s3Service.isConfigured()) {
        const key = `${S3_PREFIX}/${jobId}/remediated/${candidate}`;
        if (await s3ObjectExists(key)) return key;
        continue;
      }
      try {
        await fs.access(path.join(STORAGE_BASE, jobId, 'remediated', candidate));
        return `${jobId}/remediated/${candidate}`;
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

      const resolvedPath = resolveLocalStoragePath(fileUrlOrKey);
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

  /**
   * Streaming counterpart to downloadFile: same reference resolution and
   * the same not-found signatures ("File not found in S3: <key>" for a
   * missing S3 object, ENOENT for a missing local file), but the bytes are
   * never collected into one Buffer -- for callers that only need to pass
   * over the file once (e.g. hashing a multi-hundred-MB PDF).
   */
  async openReadStream(fileUrlOrKey: string): Promise<Readable> {
    return (await this.openReadStreamWithFingerprint(fileUrlOrKey)).stream;
  }

  /**
   * openReadStream plus the fingerprint of the exact version being read --
   * taken from the GET response itself (S3), so it can't belong to a
   * different version than the bytes. Locally, the stat taken just before
   * opening (dev-only fallback; a write in between is not guarded against).
   */
  async openReadStreamWithFingerprint(fileUrlOrKey: string): Promise<{ stream: Readable; fingerprint: string | null }> {
    if (fileUrlOrKey.startsWith('http')) {
      throw new Error('HTTP URL download not yet implemented');
    }

    if (s3Service.isConfigured()) {
      try {
        const response = await s3Client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: fileUrlOrKey }));
        if (!response.Body) throw new Error(`File not found in S3: ${fileUrlOrKey}`);
        return { stream: response.Body as Readable, fingerprint: s3Fingerprint(response.ETag, response.VersionId) };
      } catch (error) {
        if (isNotFoundError(error)) throw new Error(`File not found in S3: ${fileUrlOrKey}`);
        throw error;
      }
    }

    const resolvedPath = resolveLocalStoragePath(fileUrlOrKey);
    // stat first so a missing file rejects here with ENOENT, rather than
    // surfacing later as a stream 'error' event.
    const stat = await fs.stat(resolvedPath);
    return { stream: createReadStream(resolvedPath), fingerprint: localFingerprint(stat) };
  }

  /**
   * Fingerprint of the stored object without reading it (HEAD / stat), or
   * null if it doesn't exist. Same reference forms as openReadStream.
   */
  async getFileFingerprint(fileUrlOrKey: string): Promise<string | null> {
    if (s3Service.isConfigured()) {
      try {
        const head = await s3Client.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: fileUrlOrKey }));
        return s3Fingerprint(head.ETag, head.VersionId);
      } catch (error) {
        if (isNotFoundError(error)) return null;
        throw error;
      }
    }
    try {
      return localFingerprint(await fs.stat(resolveLocalStoragePath(fileUrlOrKey)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }
}

export const fileStorageService = new FileStorageService();
