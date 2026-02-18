/**
 * Document Resolver Utility
 *
 * Shared helper for resolving document IDs in citation controllers.
 * Handles the case where the URL parameter might be either a document ID or a job ID.
 */

import prisma from '../../lib/prisma';
import { Prisma } from '@prisma/client';

type EditorialDocumentInclude = Prisma.EditorialDocumentInclude;

/**
 * Resolve a document by ID (tries both document ID and job ID).
 *
 * This handles the case where the frontend navigates using a job ID
 * when the document ID wasn't available at upload time.
 *
 * @param idOrJobId - The ID from the URL param (could be document ID or job ID)
 * @param tenantId - The tenant ID for security
 * @param include - Optional Prisma include object for relations
 * @returns The document if found, null otherwise
 */
export async function resolveDocument<T extends EditorialDocumentInclude | undefined = undefined>(
  idOrJobId: string,
  tenantId: string,
  include?: T
): Promise<Prisma.EditorialDocumentGetPayload<{ include: T }> | null> {
  // First try to find by document ID
  let document = await prisma.editorialDocument.findFirst({
    where: { id: idOrJobId, tenantId },
    include: include as T,
  }) as Prisma.EditorialDocumentGetPayload<{ include: T }> | null;

  // If not found, try finding by job ID
  if (!document) {
    document = await prisma.editorialDocument.findFirst({
      where: { jobId: idOrJobId, tenantId },
      include: include as T,
    }) as Prisma.EditorialDocumentGetPayload<{ include: T }> | null;
  }

  return document;
}

/**
 * Simple document resolver without includes (for basic existence checks)
 */
export async function resolveDocumentSimple(
  idOrJobId: string,
  tenantId: string
) {
  // First try to find by document ID
  let document = await prisma.editorialDocument.findFirst({
    where: { id: idOrJobId, tenantId },
  });

  // If not found, try finding by job ID
  if (!document) {
    document = await prisma.editorialDocument.findFirst({
      where: { jobId: idOrJobId, tenantId },
    });
  }

  return document;
}
