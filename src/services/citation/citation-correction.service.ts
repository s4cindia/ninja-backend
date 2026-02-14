import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { AppError } from '../../utils/app-error';

export interface CorrectionResult {
  validationId: string;
  citationId: string;
  originalText: string;
  correctedText: string;
  changeId: string;
}

export interface BatchCorrectionResult {
  correctedCount: number;
  skippedCount: number;
  changes: CorrectionResult[];
}

class CitationCorrectionService {
  async acceptCorrection(
    validationId: string,
    tenantId: string
  ): Promise<CorrectionResult> {
    const validation = await prisma.citationValidation.findUnique({
      where: { id: validationId },
      include: {
        citation: true,
        document: true
      }
    });

    if (!validation) {
      throw AppError.notFound('Validation not found');
    }

    if (validation.document.tenantId !== tenantId) {
      throw AppError.forbidden('Access denied');
    }

    if (validation.status !== 'pending') {
      throw AppError.badRequest('Validation already resolved');
    }

    const originalText = validation.citation.rawText;
    const correctedText = validation.suggestedFix;

    await prisma.citation.update({
      where: { id: validation.citationId },
      data: {
        rawText: originalText.replace(validation.originalText, correctedText)
      }
    });

    const change = await prisma.citationChange.create({
      data: {
        documentId: validation.documentId,
        citationId: validation.citationId,
        changeType: 'correction',
        beforeText: originalText,
        afterText: originalText.replace(validation.originalText, correctedText),
        appliedBy: tenantId
      }
    });

    await prisma.citationValidation.update({
      where: { id: validationId },
      data: {
        status: 'accepted',
        resolvedText: correctedText,
        resolvedAt: new Date()
      }
    });

    return {
      validationId,
      citationId: validation.citationId,
      originalText,
      correctedText: originalText.replace(validation.originalText, correctedText),
      changeId: change.id
    };
  }

  async rejectCorrection(
    validationId: string,
    tenantId: string,
    reason?: string
  ): Promise<void> {
    const validation = await prisma.citationValidation.findUnique({
      where: { id: validationId },
      include: { document: true }
    });

    if (!validation) {
      throw AppError.notFound('Validation not found');
    }

    if (validation.document.tenantId !== tenantId) {
      throw AppError.forbidden('Access denied');
    }

    await prisma.citationValidation.update({
      where: { id: validationId },
      data: {
        status: 'rejected',
        resolvedAt: new Date(),
        explanation: reason ? `Rejected: ${reason}` : validation.explanation
      }
    });
  }

  async applyManualEdit(
    validationId: string,
    correctedText: string,
    tenantId: string
  ): Promise<CorrectionResult> {
    const validation = await prisma.citationValidation.findUnique({
      where: { id: validationId },
      include: {
        citation: true,
        document: true
      }
    });

    if (!validation) {
      throw AppError.notFound('Validation not found');
    }

    if (validation.document.tenantId !== tenantId) {
      throw AppError.forbidden('Access denied');
    }

    const originalText = validation.citation.rawText;

    await prisma.citation.update({
      where: { id: validation.citationId },
      data: { rawText: correctedText }
    });

    const change = await prisma.citationChange.create({
      data: {
        documentId: validation.documentId,
        citationId: validation.citationId,
        changeType: 'correction',
        beforeText: originalText,
        afterText: correctedText,
        appliedBy: tenantId
      }
    });

    await prisma.citationValidation.update({
      where: { id: validationId },
      data: {
        status: 'edited',
        resolvedText: correctedText,
        resolvedAt: new Date()
      }
    });

    return {
      validationId,
      citationId: validation.citationId,
      originalText,
      correctedText,
      changeId: change.id
    };
  }

  async batchCorrect(
    documentId: string,
    tenantId: string,
    options: {
      validationIds?: string[];
      violationType?: string;
      applyAll?: boolean;
    }
  ): Promise<BatchCorrectionResult> {
    const document = await prisma.editorialDocument.findFirst({
      where: { id: documentId, tenantId }
    });

    if (!document) {
      throw AppError.notFound('Document not found');
    }

    let validations;
    if (options.validationIds) {
      validations = await prisma.citationValidation.findMany({
        where: {
          id: { in: options.validationIds },
          documentId,
          status: 'pending'
        },
        include: { citation: true }
      });
    } else if (options.violationType && options.applyAll) {
      validations = await prisma.citationValidation.findMany({
        where: {
          documentId,
          violationType: options.violationType,
          status: 'pending'
        },
        include: { citation: true }
      });
    } else {
      throw AppError.badRequest('Provide validationIds or violationType with applyAll');
    }

    const results: CorrectionResult[] = [];
    let skippedCount = 0;

    for (const validation of validations) {
      try {
        const result = await this.acceptCorrection(validation.id, tenantId);
        results.push(result);
      } catch (error) {
        logger.warn(`[Correction] Skipped validation ${validation.id}`, error instanceof Error ? error : undefined);
        skippedCount++;
      }
    }

    return {
      correctedCount: results.length,
      skippedCount,
      changes: results
    };
  }

  async getChanges(documentId: string, tenantId: string) {
    const document = await prisma.editorialDocument.findFirst({
      where: { id: documentId, tenantId }
    });

    if (!document) {
      throw AppError.notFound('Document not found');
    }

    return prisma.citationChange.findMany({
      where: { documentId },
      orderBy: { appliedAt: 'desc' }
    });
  }

  async revertChange(changeId: string, tenantId: string): Promise<void> {
    const change = await prisma.citationChange.findUnique({
      where: { id: changeId },
      include: { document: true }
    });

    if (!change) {
      throw AppError.notFound('Change not found');
    }

    if (change.document.tenantId !== tenantId) {
      throw AppError.forbidden('Access denied');
    }

    if (change.isReverted) {
      throw AppError.badRequest('Change already reverted');
    }

    if (change.citationId) {
      await prisma.citation.update({
        where: { id: change.citationId },
        data: { rawText: change.beforeText }
      });
    }

    await prisma.citationChange.update({
      where: { id: changeId },
      data: {
        isReverted: true,
        revertedAt: new Date()
      }
    });
  }
}

export const citationCorrectionService = new CitationCorrectionService();
