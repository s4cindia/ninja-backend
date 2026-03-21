import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import prisma from '../../lib/prisma';

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

export async function registerCorpusDocument(input: {
  filename: string;
  s3Path: string;
  publisher?: string;
  contentType?: string;
  pageCount?: number;
  language?: string;
}): Promise<{ id: string; s3Path: string; status: string }> {
  const doc = await prisma.corpusDocument.create({
    data: {
      filename: input.filename,
      s3Path: input.s3Path,
      publisher: input.publisher,
      contentType: input.contentType,
      pageCount: input.pageCount,
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
