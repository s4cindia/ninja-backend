/**
 * Citation Analysis Service
 *
 * Provides citation analysis functionality for use by workers and other services.
 * Wraps the CitationManagementController's analyzeDocument method.
 */

import { CitationManagementController } from '../../controllers/citation-management.controller';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

// Singleton controller instance for service use
const controller = new CitationManagementController();

export type ProgressCallback = (progress: number, message: string) => Promise<void>;

class CitationAnalysisService {
  /**
   * Analyze a document for citations and references
   *
   * @param documentId - ID of the document to analyze
   * @param documentText - Full text content of the document
   * @param fullHtml - Optional HTML content for better reference extraction
   * @param progressCallback - Optional callback for progress updates (0-100)
   */
  async analyzeDocument(
    documentId: string,
    documentText: string,
    fullHtml?: string,
    progressCallback?: ProgressCallback
  ): Promise<void> {
    logger.info(`[Citation Analysis Service] Starting analysis for document ${documentId}`);

    try {
      // Update document status
      await prisma.editorialDocument.update({
        where: { id: documentId },
        data: { status: 'ANALYZING' },
      });

      if (progressCallback) {
        await progressCallback(5, 'Starting AI analysis');
      }

      // Call the controller's analyzeDocument method
      await controller.analyzeDocument(documentId, documentText, progressCallback);

      // Update document status to completed
      await prisma.editorialDocument.update({
        where: { id: documentId },
        data: { status: 'COMPLETED' },
      });

      if (progressCallback) {
        await progressCallback(100, 'Analysis complete');
      }

      logger.info(`[Citation Analysis Service] Completed analysis for document ${documentId}`);
    } catch (error) {
      logger.error(`[Citation Analysis Service] Analysis failed for document ${documentId}:`, error);

      // Update document status to failed
      await prisma.editorialDocument.update({
        where: { id: documentId },
        data: { status: 'FAILED' },
      }).catch(() => {
        // Ignore errors updating status
      });

      throw error;
    }
  }

  /**
   * Re-analyze a document (clears existing citations first)
   */
  async reanalyzeDocument(documentId: string): Promise<{ citationsFound: number; referencesFound: number }> {
    logger.info(`[Citation Analysis Service] Re-analyzing document ${documentId}`);

    const document = await prisma.editorialDocument.findUnique({
      where: { id: documentId },
      select: { id: true, fullText: true },
    });

    if (!document) {
      throw new Error(`Document not found: ${documentId}`);
    }

    if (!document.fullText) {
      throw new Error(`Document has no text content: ${documentId}`);
    }

    // Clear existing data
    await prisma.citation.deleteMany({ where: { documentId } });
    await prisma.referenceListEntry.deleteMany({ where: { documentId } });
    await prisma.citationChange.deleteMany({ where: { documentId } });

    // Re-run analysis
    await this.analyzeDocument(documentId, document.fullText);

    // Get counts
    const [citationsFound, referencesFound] = await Promise.all([
      prisma.citation.count({ where: { documentId } }),
      prisma.referenceListEntry.count({ where: { documentId } }),
    ]);

    return { citationsFound, referencesFound };
  }
}

export const citationAnalysisService = new CitationAnalysisService();
