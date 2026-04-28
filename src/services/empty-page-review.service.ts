import { Prisma } from '@prisma/client';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import type { UpsertEmptyPageReviewInput } from '../schemas/empty-page-review.schema';

const annotatorSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
} as const;

const reviewInclude = {
  annotator: { select: annotatorSelect },
} as const;

export type EmptyPageReviewWithAnnotator = Prisma.EmptyPageReviewGetPayload<{
  include: typeof reviewInclude;
}>;

export interface EmptyPageReviewDTO {
  pageNumber: number;
  category: 'LEGIT_EMPTY' | 'DETECTION_FAILURE' | 'UNSURE';
  pageType: string;
  expectedContent: string | null;
  notes: string | null;
  annotator: {
    id: string;
    firstName: string;
    lastName: string;
    email: string;
  };
  reviewedAt: string;
  updatedAt: string;
}

function toDTO(review: EmptyPageReviewWithAnnotator): EmptyPageReviewDTO {
  return {
    pageNumber: review.pageNumber,
    category: review.category,
    pageType: review.pageType,
    expectedContent: review.expectedContent ?? null,
    notes: review.notes ?? null,
    annotator: {
      id: review.annotator.id,
      firstName: review.annotator.firstName,
      lastName: review.annotator.lastName,
      email: review.annotator.email,
    },
    reviewedAt: review.reviewedAt.toISOString(),
    updatedAt: review.updatedAt.toISOString(),
  };
}

export async function calibrationRunExists(runId: string): Promise<boolean> {
  const run = await prisma.calibrationRun.findUnique({
    where: { id: runId },
    select: { id: true },
  });
  return run !== null;
}

export async function listReviews(runId: string): Promise<EmptyPageReviewDTO[]> {
  const reviews = await prisma.emptyPageReview.findMany({
    where: { calibrationRunId: runId },
    include: reviewInclude,
    orderBy: { pageNumber: 'asc' },
  });
  return reviews.map(toDTO);
}

export async function getReview(
  runId: string,
  pageNumber: number,
): Promise<EmptyPageReviewDTO | null> {
  const review = await prisma.emptyPageReview.findUnique({
    where: { calibrationRunId_pageNumber: { calibrationRunId: runId, pageNumber } },
    include: reviewInclude,
  });
  return review ? toDTO(review) : null;
}

export async function upsertReview(
  runId: string,
  pageNumber: number,
  annotatorId: string,
  input: UpsertEmptyPageReviewInput,
): Promise<EmptyPageReviewDTO> {
  const expectedContent = input.expectedContent ?? null;
  const notes = input.notes ?? null;

  const review = await prisma.emptyPageReview.upsert({
    where: { calibrationRunId_pageNumber: { calibrationRunId: runId, pageNumber } },
    create: {
      calibrationRunId: runId,
      pageNumber,
      category: input.category,
      pageType: input.pageType,
      expectedContent,
      notes,
      annotatorId,
    },
    update: {
      category: input.category,
      pageType: input.pageType,
      expectedContent,
      notes,
      annotatorId,
      reviewedAt: new Date(),
    },
    include: reviewInclude,
  });

  logger.info(
    `[empty-page-review] upsert run=${runId} page=${pageNumber} category=${input.category} by=${annotatorId}`,
  );

  return toDTO(review);
}

export async function deleteReview(
  runId: string,
  pageNumber: number,
): Promise<boolean> {
  try {
    await prisma.emptyPageReview.delete({
      where: { calibrationRunId_pageNumber: { calibrationRunId: runId, pageNumber } },
    });
    logger.info(`[empty-page-review] delete run=${runId} page=${pageNumber}`);
    return true;
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === 'P2025'
    ) {
      return false;
    }
    throw err;
  }
}
