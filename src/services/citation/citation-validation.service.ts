import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { AppError } from '../../utils/app-error';

const uuidSchema = z.string().uuid();

const validateComponentOwnershipSchema = z.object({
  citationId: uuidSchema,
  componentId: uuidSchema,
});

const setPrimaryComponentSchema = z.object({
  citationId: uuidSchema,
  componentId: uuidSchema,
});

const clearPrimaryComponentSchema = z.object({
  citationId: uuidSchema,
});

export class CitationValidationService {
  constructor(private prisma: PrismaClient) {}

  async validateComponentOwnership(
    citationId: string,
    componentId: string
  ): Promise<void> {
    const validation = validateComponentOwnershipSchema.safeParse({ citationId, componentId });
    if (!validation.success) {
      const errors = validation.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
      throw AppError.badRequest(`Validation failed: ${errors}`, 'VALIDATION_ERROR');
    }

    const component = await this.prisma.citationComponent.findUnique({
      where: { id: componentId },
      select: { id: true, citationId: true }
    });

    if (!component) {
      throw AppError.notFound(`CitationComponent not found: ${componentId}`, 'COMPONENT_NOT_FOUND');
    }

    if (component.citationId !== citationId) {
      throw AppError.badRequest(
        `CitationComponent ${componentId} belongs to Citation ${component.citationId}, ` +
        `not Citation ${citationId}. Cannot set as primary component.`,
        'COMPONENT_OWNERSHIP_MISMATCH'
      );
    }
  }

  async setPrimaryComponent(
    citationId: string,
    componentId: string
  ) {
    const validation = setPrimaryComponentSchema.safeParse({ citationId, componentId });
    if (!validation.success) {
      const errors = validation.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
      throw AppError.badRequest(`Validation failed: ${errors}`, 'VALIDATION_ERROR');
    }

    return this.prisma.$transaction(async (tx) => {
      const component = await tx.citationComponent.findFirst({
        where: {
          id: componentId,
          citationId: citationId
        },
        select: { id: true }
      });

      if (!component) {
        throw AppError.notFound(
          `CitationComponent ${componentId} not found or does not belong to Citation ${citationId}`,
          'COMPONENT_NOT_FOUND'
        );
      }

      return tx.citation.update({
        where: { id: citationId },
        data: { primaryComponentId: componentId }
      });
    });
  }

  async clearPrimaryComponent(citationId: string) {
    const validation = clearPrimaryComponentSchema.safeParse({ citationId });
    if (!validation.success) {
      const errors = validation.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join(', ');
      throw AppError.badRequest(`Validation failed: ${errors}`, 'VALIDATION_ERROR');
    }

    return this.prisma.citation.update({
      where: { id: citationId },
      data: { primaryComponentId: null }
    });
  }
}

export function createCitationValidationService(prisma: PrismaClient): CitationValidationService {
  return new CitationValidationService(prisma);
}

export default CitationValidationService;
