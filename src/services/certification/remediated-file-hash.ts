/**
 * Hash of a PDF job's CURRENT remediated file.
 *
 * The EPUB-from-certified-PDF gate binds every piece of evidence (PAC
 * report, Acrobat report, the certification itself) to the exact bytes it
 * was produced against, by sha256. This is the one place that answers
 * "what are those bytes right now": it reads the same `output.remediatedFileUrl`
 * reference the remediated-PDF download endpoint serves, through the same
 * fileStorageService abstraction (S3 key or local path).
 */

import { createHash } from 'crypto';
import prisma from '../../lib/prisma';
import { fileStorageService } from '../storage/file-storage.service';

export interface RemediatedFileHash {
  sha256: string;
  /** Storage reference (S3 key or local path) the hash was computed from. */
  fileRef: string;
}

export function sha256Hex(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * sha256 of a stream, chunk by chunk -- memory stays at one chunk however
 * large the file (remediated PDFs can be hundreds of MB).
 */
export async function sha256OfStream(stream: AsyncIterable<Uint8Array | string>): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of stream) hash.update(chunk);
  return hash.digest('hex');
}

/**
 * Same not-found signature as pdf-remediation.controller.ts's
 * isRemediatedFileNotFoundError: fileStorageService's own
 * "File not found in S3:" message, or a local ENOENT. Anything else is a
 * real storage failure and is rethrown.
 */
function isNotFound(error: unknown): boolean {
  if (error instanceof Error && error.message.startsWith('File not found in S3:')) return true;
  return !!error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Resolves the remediated file exactly as the remediated-PDF download
 * endpoint does (pdf-remediation.controller.ts downloadRemediatedPdf):
 * `output.remediatedFileUrl` when recorded; otherwise the same
 * candidate-file-name fallback over input.fileName that endpoint uses for
 * jobs whose producer never recorded a URL (e.g. the post-audit auto-fix in
 * accessibility.processor.ts). So whatever the download endpoint can serve
 * is what gets hashed -- never a null hash for a downloadable file.
 */
async function resolveRemediatedFileRef(jobId: string): Promise<string | null> {
  const job = await prisma.job.findUnique({ where: { id: jobId }, select: { output: true, input: true } });
  if (!job) return null;
  const output = (job.output && typeof job.output === 'object' ? job.output : {}) as Record<string, unknown>;
  if (typeof output.remediatedFileUrl === 'string' && output.remediatedFileUrl.length > 0) {
    return output.remediatedFileUrl;
  }
  const input = (job.input && typeof job.input === 'object' ? job.input : {}) as { fileName?: unknown };
  const fileName = typeof input.fileName === 'string' && input.fileName ? input.fileName : 'document.pdf';
  return fileStorageService.findRemediatedFileRef(jobId, fileName);
}

/**
 * Null when the job has no remediated file (none recorded or found, or the
 * referenced object is gone). Throws on a real storage error, so a
 * transient S3 failure is never mistaken for "no file".
 */
export async function getCurrentRemediatedFileHash(jobId: string): Promise<RemediatedFileHash | null> {
  const fileRef = await resolveRemediatedFileRef(jobId);
  if (!fileRef) return null;

  // Streamed, never buffered whole. A failure mid-stream (connection
  // reset, etc.) propagates as a real error, never as "no file".
  let stream: Awaited<ReturnType<typeof fileStorageService.openReadStream>>;
  try {
    stream = await fileStorageService.openReadStream(fileRef);
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  return { sha256: await sha256OfStream(stream), fileRef };
}
