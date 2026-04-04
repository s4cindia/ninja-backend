import { S3Client, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { PDFDocument } from 'pdf-lib';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

const s3Client = new S3Client({
  region: process.env.AWS_REGION ?? 'ap-south-1',
});
const BUCKET = process.env.S3_BUCKET ?? 'ninja-epub-staging';
const CORPUS_PREFIX = 'corpus/';

export interface PresignedUploadResult {
  uploadUrl: string;
  s3Key: string;
  s3Path: string;
  expiresAt: string;
}

export async function generateUploadUrl(
  filename: string,
  contentType: string = 'application/pdf',
): Promise<PresignedUploadResult> {
  const sanitised = filename
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .toLowerCase();
  const s3Key = `${CORPUS_PREFIX}${Date.now()}-${sanitised}`;
  const command = new PutObjectCommand({
    Bucket: BUCKET,
    Key: s3Key,
    ContentType: contentType,
  });
  const uploadUrl = await getSignedUrl(s3Client, command, { expiresIn: 300 });
  return {
    uploadUrl,
    s3Key,
    s3Path: `s3://${BUCKET}/${s3Key}`,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  };
}

/**
 * Extract publisher (and pageCount) from PDF metadata stored in S3.
 * Returns partial fields; caller merges with user-supplied values.
 */
async function extractPdfMetadata(s3Path: string): Promise<{
  publisher?: string;
  pageCount?: number;
}> {
  try {
    const match = s3Path.match(/^s3:\/\/([^/]+)\/(.+)$/);
    if (!match) return {};

    const [, bucket, key] = match;
    const obj = await s3Client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    if (!obj.Body) return {};

    const bytes = await obj.Body.transformToByteArray();
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });

    // pdf-lib exposes Producer/Creator but not a dedicated publisher field.
    // Many academic/commercial PDFs set Producer or Creator to the publisher name.
    const creator = pdf.getCreator();
    const subject = pdf.getSubject();

    // Heuristic: prefer subject (often used for publisher in scholarly PDFs),
    // then creator (if it doesn't look like a tool name).
    // Skip producer — usually "Adobe PDF Library" or similar tool names.
    const toolPatterns = /acrobat|pdf|library|writer|openoffice|libreoffice|microsoft|latex|quark|indesign/i;
    let publisher: string | undefined;
    if (subject && !toolPatterns.test(subject)) {
      publisher = subject;
    } else if (creator && !toolPatterns.test(creator)) {
      publisher = creator;
    }

    return { publisher, pageCount: pdf.getPageCount() };
  } catch (err) {
    logger.warn(`[corpus-upload] Failed to extract PDF metadata: ${(err as Error).message}`);
    return {};
  }
}

export async function registerCorpusDocument(input: {
  filename: string;
  s3Path: string;
  publisher?: string;
  contentType?: string;
  pageCount?: number;
  language?: string;
}): Promise<{ id: string; s3Path: string; status: string }> {
  // Auto-extract metadata from PDF if publisher or pageCount not provided
  let autoPublisher: string | undefined;
  let autoPageCount: number | undefined;
  if ((!input.publisher || !input.pageCount) && input.filename.toLowerCase().endsWith('.pdf')) {
    const meta = await extractPdfMetadata(input.s3Path);
    autoPublisher = meta.publisher;
    autoPageCount = meta.pageCount;
  }

  const doc = await prisma.corpusDocument.create({
    data: {
      filename: input.filename,
      s3Path: input.s3Path,
      publisher: input.publisher || autoPublisher,
      contentType: input.contentType,
      pageCount: input.pageCount ?? autoPageCount,
      language: input.language ?? 'en',
    },
  });
  return { id: doc.id, s3Path: doc.s3Path, status: 'PENDING' };
}

export async function listCorpusDocuments(opts: {
  limit?: number;
  cursor?: string;
  publisher?: string;
  contentType?: string;
}) {
  const { limit = 20, cursor, publisher, contentType } = opts;
  const where: Record<string, unknown> = {};
  if (publisher) where.publisher = publisher;
  if (contentType) where.contentType = contentType;

  const docs = await prisma.corpusDocument.findMany({
    where,
    take: limit + 1,
    ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    orderBy: { uploadedAt: 'desc' },
    include: {
      bootstrapJobs: {
        orderBy: { createdAt: 'desc' },
        take: 1,
        select: { status: true, id: true },
      },
      calibrationRuns: {
        orderBy: { runDate: 'desc' },
        take: 1,
        select: {
          id: true,
          completedAt: true,
          summary: true,
        },
      },
    },
  });
  const hasMore = docs.length > limit;
  const items = hasMore ? docs.slice(0, limit) : docs;
  const nextCursor = hasMore ? items[items.length - 1].id : null;
  return { documents: items, nextCursor };
}
