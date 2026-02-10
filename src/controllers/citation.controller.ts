/**
 * Citation Controller
 *
 * Handles all citation intelligence tool endpoints
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';
import { citationParserService } from '../services/citation/citation-parser.service';
import { citationAnalyzerService } from '../services/citation/citation-analyzer.service';
import { doiVerifierService } from '../services/citation/doi-verifier.service';
import { styleNormalizerService } from '../services/citation/style-normalizer.service';
import { DOCXExporterService } from '../services/citation/docx-exporter.service';

export class CitationController {
  /**
   * POST /api/v1/citation/upload
   * Upload and analyze manuscript
   */
  async upload(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { tenantId, id: userId } = req.user!;
      const file = req.file;

      if (!file) {
        res.status(400).json({
          success: false,
          error: { code: 'NO_FILE', message: 'No file uploaded' },
        });
        return;
      }

      logger.info(`[CitationController] Upload from user ${userId}: ${file.originalname}`);

      // Save file to disk for later retrieval
      const fs = require('fs').promises;
      const path = require('path');
      const uploadDir = './data/uploads/citations';

      // Ensure upload directory exists
      await fs.mkdir(uploadDir, { recursive: true });

      // Generate unique filename
      const timestamp = Date.now();
      const sanitizedName = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');
      const filename = `${timestamp}-${sanitizedName}`;
      const filePath = path.join(uploadDir, filename);

      // Write file to disk
      await fs.writeFile(filePath, file.buffer);
      logger.info(`[CitationController] Saved file to ${filePath}`);

      // Create job record
      const job = await prisma.citationJob.create({
        data: {
          tenantId,
          userId,
          originalFilename: file.originalname,
          fileUrl: filePath,
          status: 'QUEUED',
        },
      });

      logger.info(`[CitationController] Created job ${job.id}`);

      // Start processing asynchronously
      this.processJob(job.id, file.buffer).catch(error => {
        logger.error(`[CitationController] Job ${job.id} failed: ${error.message}`);
      });

      res.json({
        success: true,
        data: {
          jobId: job.id,
          status: 'QUEUED',
          message: 'Processing started',
        },
      });
    } catch (error) {
      logger.error(`[CitationController] Upload error: ${error instanceof Error ? error.message : 'Unknown error'}`);
      logger.error(`[CitationController] Stack: ${error instanceof Error ? error.stack : 'No stack'}`);
      next(error);
    }
  }

  /**
   * Background job processing
   */
  private async processJob(jobId: string, fileBuffer: Buffer): Promise<void> {
    const startTime = Date.now();

    try {
      // Update status to PROCESSING
      await prisma.citationJob.update({
        where: { id: jobId },
        data: { status: 'PROCESSING' },
      });

      const job = await prisma.citationJob.findUnique({ where: { id: jobId } });
      if (!job) throw new Error('Job not found');

      logger.info(`[CitationController] Processing job ${jobId}`);

      // Step 1: Parse document
      const parseResult = await citationParserService.parseDOCX(fileBuffer, job.originalFilename);

      // Step 2: Analyze for issues
      const analysisResult = citationAnalyzerService.analyze(
        parseResult.citations,
        parseResult.references,
        parseResult.detectedStyle
      );

      // Step 3: Save citations to database
      const citationRecords = parseResult.citations.map((cit, index) => ({
        id: `${jobId}-cit-${index}`,
        jobId,
        number: cit.number,
        location: cit.location,
        context: cit.context,
        matchedReferenceId: null,
      }));

      await prisma.inTextCitation.createMany({
        data: citationRecords,
        skipDuplicates: true,
      });

      // Step 4: Save references to database
      const referenceRecords = parseResult.references.map((ref, index) => ({
        id: `${jobId}-ref-${index}`,
        jobId,
        number: ref.number,
        originalText: ref.text,
        correctedText: null,
        doi: null,
        doiVerified: false,
        verificationStatus: 'PENDING' as const,
        confidence: null,
        metadata: null,
        changes: null,
        needsReview: false,
      }));

      await prisma.citationReference.createMany({
        data: referenceRecords,
        skipDuplicates: true,
      });

      // Step 5: Save issues
      const issueRecords = analysisResult.issues.map((issue, index) => ({
        id: `${jobId}-issue-${index}`,
        jobId,
        type: issue.type,
        severity: issue.severity,
        description: issue.description,
        location: issue.location || null,
        resolved: false,
      }));

      await prisma.citationIssue.createMany({
        data: issueRecords,
        skipDuplicates: true,
      });

      // Step 6: Update job with results
      const processingTime = (Date.now() - startTime) / 1000;

      await prisma.citationJob.update({
        where: { id: jobId },
        data: {
          status: 'COMPLETED',
          processingTime,
          totalReferences: parseResult.references.length,
          totalCitations: parseResult.citations.length,
          totalIssues: analysisResult.issues.length,
          detectedStyle: parseResult.detectedStyle || 'Unknown',
          styleConfidence: parseResult.styleConfidence / 100,
        },
      });

      logger.info(`[CitationController] ✓ Job ${jobId} completed in ${processingTime}s`);
    } catch (error: any) {
      logger.error(`[CitationController] Job ${jobId} failed: ${error.message}`);

      await prisma.citationJob.update({
        where: { id: jobId },
        data: {
          status: 'FAILED',
          errorMessage: error.message,
        },
      });
    }
  }

  /**
   * GET /api/v1/citation/job/:jobId/progress
   * Get job processing progress (for SSE)
   */
  async getProgress(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;

      const job = await prisma.citationJob.findUnique({
        where: { id: jobId },
        include: {
          _count: {
            select: {
              references: true,
              citations: true,
              issues: true,
            },
          },
        },
      });

      if (!job) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Job not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          jobId: job.id,
          status: job.status,
          progress: job.status === 'COMPLETED' ? 100 : job.status === 'PROCESSING' ? 60 : 0,
          totalReferences: job._count.references,
          totalCitations: job._count.citations,
          totalIssues: job._count.issues,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/job/:jobId/analysis
   * Get analysis results (the dashboard)
   */
  async getAnalysis(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;

      const job = await prisma.citationJob.findUnique({
        where: { id: jobId },
        include: {
          issues: true,
        },
      });

      if (!job) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Job not found' },
        });
        return;
      }

      // Calculate breakdown by issue type
      const breakdown = {
        missingDois: job.issues.filter(i => i.type === 'MISSING_DOI').length,
        duplicates: job.issues.filter(i => i.type === 'DUPLICATE_REFERENCE').length,
        uncited: job.issues.filter(i => i.type === 'UNCITED_REFERENCE').length,
        mismatches: job.issues.filter(i => i.type === 'CITATION_MISMATCH').length,
        formattingIssues: job.issues.filter(i => i.type === 'FORMATTING_INCONSISTENCY').length,
        numberingMismatches: job.issues.filter(i => i.type === 'NUMBERING_MISMATCH').length,
      };

      res.json({
        success: true,
        data: {
          jobId: job.id,
          processingTime: job.processingTime,
          totalIssues: job.totalIssues || 0,
          breakdown,
          stats: {
            totalReferences: job.totalReferences || 0,
            totalCitations: job.totalCitations || 0,
            detectedStyle: job.detectedStyle,
            confidence: job.styleConfidence,
          },
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/job/:jobId/references
   * Get reference list with verification status
   */
  async getReferences(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;

      const references = await prisma.citationReference.findMany({
        where: { jobId },
        orderBy: { number: 'asc' },
      });

      res.json({
        success: true,
        data: { references },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/reference/:refId/verify-doi
   * Verify DOI for a specific reference
   */
  async verifyDOI(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { refId } = req.params;

      const reference = await prisma.citationReference.findUnique({
        where: { id: refId },
      });

      if (!reference) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Reference not found' },
        });
        return;
      }

      logger.info(`[CitationController] Verifying DOI for reference ${refId}`);

      const result = await doiVerifierService.verifyReference(reference.originalText);

      // Update reference with verification result
      await prisma.citationReference.update({
        where: { id: refId },
        data: {
          doi: result.doi,
          doiVerified: result.status === 'VERIFIED',
          verificationStatus: result.status,
          confidence: result.confidence,
          metadata: result.metadata,
          needsReview: result.status === 'AI_SUGGESTED' || result.status === 'BROKEN',
        },
      });

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/job/:jobId/issues
   * Get ghost citations and issues
   */
  async getIssues(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;

      const issues = await prisma.citationIssue.findMany({
        where: { jobId },
        orderBy: { severity: 'desc' },
      });

      // Group by type
      const grouped = {
        unmatchedCitations: issues.filter(i => i.type === 'CITATION_MISMATCH'),
        uncitedReferences: issues.filter(i => i.type === 'UNCITED_REFERENCE'),
        numberingMismatches: issues.filter(i => i.type === 'NUMBERING_MISMATCH'),
      };

      res.json({
        success: true,
        data: grouped,
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/job/:jobId/convert-style
   * Convert all references to a specific citation style
   */
  async convertStyle(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;
      const { targetStyle } = req.body;

      if (!targetStyle || !['Vancouver', 'APA', 'Chicago', 'Harvard'].includes(targetStyle)) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_STYLE', message: 'Invalid target style' },
        });
        return;
      }

      logger.info(`[CitationController] Converting job ${jobId} to ${targetStyle}`);

      const references = await prisma.citationReference.findMany({
        where: { jobId },
        orderBy: { number: 'asc' },
      });

      // Convert each reference
      const converted = references.map(ref => ({
        id: ref.id,
        number: ref.number,
        originalText: ref.originalText,
        convertedText: styleNormalizerService.convertToStyle(
          ref.originalText,
          ref.metadata as any,
          targetStyle as any
        ),
      }));

      // Update database with converted text
      await Promise.all(
        converted.map(c =>
          prisma.citationReference.update({
            where: { id: c.id },
            data: { correctedText: c.convertedText },
          })
        )
      );

      res.json({
        success: true,
        data: {
          converted: converted.length,
          style: targetStyle,
          references: converted,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/job/:jobId/export-corrected
   * Export corrected manuscript as DOCX
   */
  async exportCorrectedDOCX(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;

      logger.info(`[CitationController] Exporting corrected DOCX for job ${jobId}`);

      const exporterService = new DOCXExporterService(prisma);
      const { buffer, filename } = await exporterService.exportCorrectedDOCX(jobId);

      // Set headers for file download
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', buffer.length);

      res.send(buffer);
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/job/:jobId/export-summary
   * Export change summary report as DOCX
   */
  async exportChangeSummary(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;

      logger.info(`[CitationController] Exporting change summary for job ${jobId}`);

      const exporterService = new DOCXExporterService(prisma);
      const { buffer, filename } = await exporterService.exportChangeSummary(jobId);

      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', buffer.length);

      res.send(buffer);
    } catch (error) {
      next(error);
    }
  }
  /**
   * GET /api/v1/citation/job/:jobId/manuscript
   * Get manuscript content with citation positions for editor
   */
  async getManuscript(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { jobId } = req.params;

      logger.info(`[CitationController] Getting manuscript content for job ${jobId}`);

      const job = await prisma.citationJob.findUnique({
        where: { id: jobId },
        include: {
          citations: { orderBy: { number: 'asc' } },
          references: { orderBy: { number: 'asc' } },
        },
      });

      if (!job) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Job not found' },
        });
        return;
      }

      // Check if original file exists
      if (!job.fileUrl) {
        res.status(404).json({
          success: false,
          error: { code: 'NO_FILE', message: 'Original file not found' },
        });
        return;
      }

      // Read original file
      const fs = require('fs').promises;
      const fileBuffer = await fs.readFile(job.fileUrl);

      // Import manuscript extractor service
      const { manuscriptExtractorService } = await import('../services/citation/manuscript-extractor.service');

      // Extract reference numbers
      const referenceNumbers = job.references.map(r => r.number);

      // Extract content
      const content = await manuscriptExtractorService.extractContent(fileBuffer, referenceNumbers);

      // Highlight citations
      const highlightedHtml = manuscriptExtractorService.highlightCitations(content.html, content.citations);

      res.json({
        success: true,
        data: {
          jobId: job.id,
          filename: job.originalFilename,
          highlightedHtml,
          citations: content.citations,
          references: job.references.map(ref => {
            const citationInstances = content.citations.filter(c => c.number === ref.number);
            return {
              id: ref.id,
              number: ref.number,
              text: ref.originalText,
              correctedText: ref.correctedText,
              hasInTextCitation: citationInstances.length > 0,
              citationCount: citationInstances.length,
              doi: ref.doi,
              doiVerified: ref.doiVerified,
              verificationStatus: ref.verificationStatus,
              metadata: ref.metadata,
            };
          }),
          wordCount: content.wordCount,
          paragraphCount: content.paragraphCount,
        },
      });
    } catch (error) {
      logger.error(`[CitationController] Get manuscript error: ${error instanceof Error ? error.message : 'Unknown'}`);
      next(error);
    }
  }

  /**
   * Export manuscript with corrected references
   * POST /api/v1/citation/job/:jobId/export
   */
  async exportWithCorrections(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;
      const { includeOriginal = false, highlightChanges = false } = req.body;

      logger.info(`[CitationController] Exporting job ${jobId} with corrections`);

      // Import export service
      const { docxExportService } = await import('../services/citation/docx-export.service');

      // Get job details for filename
      const job = await prisma.citationJob.findUnique({
        where: { id: jobId },
      });

      if (!job) {
        return res.status(404).json({
          success: false,
          error: {
            code: 'NOT_FOUND',
            message: 'Job not found',
          },
        });
      }

      // Generate export filename
      const exportFilename = docxExportService.getExportFilename(job.originalFilename);
      const exportPath = `data/exports/citations/${exportFilename}`;

      // Ensure export directory exists
      const fs = await import('fs');
      const path = await import('path');
      const exportDir = path.dirname(exportPath);
      if (!fs.existsSync(exportDir)) {
        fs.mkdirSync(exportDir, { recursive: true });
      }

      // Export document
      const outputPath = await docxExportService.exportWithCorrections(
        jobId,
        exportPath,
        {
          includeOriginal,
          highlightChanges,
        }
      );

      logger.info(`[CitationController] Export complete: ${outputPath}`);

      // Send file
      res.download(outputPath, exportFilename, (err) => {
        if (err) {
          logger.error(`[CitationController] Download error: ${err.message}`);
          next(err);
        }

        // Clean up file after download
        setTimeout(() => {
          if (fs.existsSync(outputPath)) {
            fs.unlinkSync(outputPath);
            logger.info(`[CitationController] Cleaned up export file: ${outputPath}`);
          }
        }, 5000);
      });

    } catch (error) {
      logger.error(`[CitationController] Export error: ${error instanceof Error ? error.message : 'Unknown'}`);
      next(error);
    }
  }

  /**
   * Get recent citation jobs
   * GET /api/v1/citation/jobs/recent
   */
  async getRecentJobs(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const limit = parseInt(req.query.limit as string) || 5;
      const userId = req.user!.id;
      const tenantId = req.user!.tenantId;

      const jobs = await prisma.citationJob.findMany({
        where: {
          tenantId,
          userId,
        },
        orderBy: {
          createdAt: 'desc',
        },
        take: limit,
        select: {
          id: true,
          originalFilename: true,
          status: true,
          totalReferences: true,
          totalCitations: true,
          totalIssues: true,
          detectedStyle: true,
          createdAt: true,
        },
      });

      res.json({
        success: true,
        data: jobs,
      });
    } catch (error) {
      logger.error(`[CitationController] Get recent jobs error: ${error instanceof Error ? error.message : 'Unknown'}`);
      next(error);
    }
  }
}

export const citationController = new CitationController();
