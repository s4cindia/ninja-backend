import { Request, Response, NextFunction } from 'express';
import { humanVerificationService, SubmitVerificationInput, VerificationStatus, RelatedIssue } from '../services/acr/human-verification.service';
import { ConfidenceLevel } from '../services/acr/confidence-analyzer.service';
import { acrAnalysisService } from '../services/acr/acr-analysis.service';
import { acrGeneratorService } from '../services/acr/acr-generator.service';
import { contentDetectionService } from '../services/acr/content-detection.service';
import { fileStorageService } from '../services/storage/file-storage.service';
import prisma from '../lib/prisma';
import { z } from 'zod';
import { logger } from '../lib/logger';

const SubmitVerificationSchema = z.object({
  status: z.enum(['PENDING', 'VERIFIED_PASS', 'VERIFIED_FAIL', 'VERIFIED_PARTIAL', 'DEFERRED']),
  method: z.string().min(1),
  notes: z.string().optional().default('')
});

const BulkVerificationSchema = z.object({
  itemIds: z.array(z.string().min(1)),
  status: z.string().transform(val => val.toUpperCase()).pipe(
    z.enum(['PENDING', 'VERIFIED_PASS', 'VERIFIED_FAIL', 'VERIFIED_PARTIAL', 'DEFERRED'])
  ),
  method: z.string().min(1),
  notes: z.string().optional().default('')
});

const stringOrArray = (enumValues: readonly [string, ...string[]]) => 
  z.union([
    z.enum(enumValues),
    z.array(z.enum(enumValues))
  ]).transform(val => Array.isArray(val) ? val : [val]);

const FilterQueueSchema = z.object({
  severity: stringOrArray(['critical', 'serious', 'moderate', 'minor']).optional(),
  confidenceLevel: stringOrArray(['HIGH', 'MEDIUM', 'LOW', 'MANUAL_REQUIRED']).optional(),
  status: stringOrArray(['PENDING', 'VERIFIED_PASS', 'VERIFIED_FAIL', 'VERIFIED_PARTIAL', 'DEFERRED']).optional()
});

export class VerificationController {
  async getQueue(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        res.status(400).json({
          success: false,
          error: { message: 'Job ID is required' }
        });
        return;
      }

      const queue = await humanVerificationService.getQueueFromJob(jobId);
      
      // Parse forceRefresh query param (default false to use caching)
      const forceRefresh = req.query.forceRefresh === 'true' || req.query.forceRefresh === '1';
      
      // Enrich queue items with issues from ACR analysis
      try {
        logger.info(`[Verification] Enriching queue for job ${jobId} with ${queue.items.length} items`);
        const analysis = await acrAnalysisService.getAnalysisForJob(jobId, undefined, forceRefresh);

        // Fetch job for content detection
        const job = await prisma.job.findUnique({ where: { id: jobId } });
        if (!job) throw new Error('Job not found for enrichment');

        // Run content detection for N/A suggestions
        const jobInput = job.input as Record<string, unknown> | null;
        const jobOutput = job.output as Record<string, unknown> | null;
        const epubFileName = (jobInput?.fileName || jobOutput?.fileName) as string | undefined;
        const sourceJobId = (jobInput?.sourceJobId || jobOutput?.sourceJobId) as string | undefined;
        const fileJobId = sourceJobId || jobId;

        let naSuggestionsMap = new Map<string, any>();

        if (epubFileName) {
          try {
            logger.info(`[Verification] Running content detection on EPUB: ${epubFileName} (using job ID: ${fileJobId})`);
            const epubBuffer = await fileStorageService.getFile(fileJobId, epubFileName);

            if (epubBuffer) {
              const naSuggestions = await contentDetectionService.analyzeEPUBContent(epubBuffer);
              logger.info(`[Verification] Content detection generated ${naSuggestions.length} N/A suggestions`);

              // Map suggestions by criterion ID
              for (const suggestion of naSuggestions) {
                naSuggestionsMap.set(suggestion.criterionId, suggestion);
              }
            } else {
              logger.warn(`[Verification] EPUB file not found in storage: ${epubFileName} (job ID: ${fileJobId})`);
            }
          } catch (error) {
            logger.error('[Verification] Content detection failed, continuing without N/A suggestions', error instanceof Error ? error : undefined);
          }
        }

        if (analysis?.criteria) {
          logger.info(`[Verification] Found ${analysis.criteria.length} criteria in analysis`);

          // Create a map of criterion ID to issues and N/A suggestions
          const criteriaIssuesMap = new Map<string, { relatedIssues?: RelatedIssue[]; fixedIssues?: RelatedIssue[]; confidence?: number; naSuggestion?: any }>();
          
          let criteriaWithIssues = 0;
          for (const criterion of analysis.criteria) {
            const relatedCount = criterion.relatedIssues?.length || 0;
            const fixedCount = criterion.fixedIssues?.length || 0;
            
            if (relatedCount > 0 || fixedCount > 0) {
              criteriaWithIssues++;
              logger.debug(`[Verification] Criterion ${criterion.id}: ${relatedCount} remaining, ${fixedCount} fixed, confidence=${criterion.confidence}`);
            }
            
            // Get N/A suggestion from content detection
            const naSuggestion = naSuggestionsMap.get(criterion.id);

            criteriaIssuesMap.set(criterion.id, {
              relatedIssues: criterion.relatedIssues?.map((issue) => ({
                code: issue.ruleId,
                message: issue.message,
                severity: issue.impact,
                location: issue.location || issue.filePath,
                status: 'remaining'
              })),
              fixedIssues: criterion.fixedIssues?.map((issue) => ({
                code: issue.ruleId,
                message: issue.message,
                severity: issue.impact || 'unknown',
                location: issue.location || issue.filePath,
                status: 'fixed'
              })),
              confidence: criterion.confidence,
              naSuggestion
            });
          }
          logger.debug(`[Verification] Total criteria with issues: ${criteriaWithIssues}`);
          
          // Enrich queue items with issues
          let enrichedCount = 0;
          let naCount = 0;
          for (const item of queue.items) {
            const issueData = criteriaIssuesMap.get(item.criterionId);
            if (issueData) {
              item.relatedIssues = issueData.relatedIssues;
              item.fixedIssues = issueData.fixedIssues;
              item.naSuggestion = issueData.naSuggestion;

              if (issueData.naSuggestion) {
                naCount++;
                logger.debug(`[Verification] Added N/A suggestion to ${item.criterionId}: ${issueData.naSuggestion.suggestedStatus} (${Math.round(issueData.naSuggestion.confidence * 100)}%)`);
              }

              if (issueData.relatedIssues?.length || issueData.fixedIssues?.length) {
                enrichedCount++;
                logger.debug(`[Verification] Enriched ${item.criterionId}: ${issueData.relatedIssues?.length || 0} remaining, ${issueData.fixedIssues?.length || 0} fixed`);
                // Log sample issue structure for debugging
                if (issueData.relatedIssues?.[0]) {
                  logger.debug(`[Verification] Sample relatedIssue: ${JSON.stringify(issueData.relatedIssues[0])}`);
                }
              }
            }
          }
          logger.info(`[Verification] Enriched ${enrichedCount} queue items with issues, ${naCount} with N/A suggestions`);
          logger.debug(`[Verification] Enriched ${enrichedCount} queue items with issue data`);
          
          // Log a sample enriched item for frontend debugging
          const sampleEnriched = queue.items.find(i => i.relatedIssues?.length || i.fixedIssues?.length);
          if (sampleEnriched) {
            logger.debug(`[Verification] Sample enriched queue item: ${JSON.stringify({
              criterionId: sampleEnriched.criterionId,
              relatedIssues: sampleEnriched.relatedIssues,
              fixedIssues: sampleEnriched.fixedIssues
            }, null, 2)}`);
          }
        } else {
          logger.debug(`[Verification] No criteria found in analysis`);
        }
      } catch (analysisError) {
        logger.warn(`[Verification] Could not fetch ACR analysis for enrichment: ${analysisError}`);
        // Continue without enrichment
      }

      res.json({
        success: true,
        data: queue
      });
    } catch (error) {
      next(error);
    }
  }

  async submitVerification(req: Request, res: Response, next: NextFunction) {
    try {
      const { itemId } = req.params;
      const userId = (req as Request & { user?: { id: string } }).user?.id || 'anonymous';

      if (!itemId) {
        res.status(400).json({
          success: false,
          error: { message: 'Item ID is required' }
        });
        return;
      }

      const validatedData = SubmitVerificationSchema.parse(req.body);
      
      const verification: SubmitVerificationInput = {
        status: validatedData.status as VerificationStatus,
        method: validatedData.method,
        notes: validatedData.notes
      };

      const record = await humanVerificationService.submitVerification(itemId, verification, userId);

      if (!record) {
        res.status(404).json({
          success: false,
          error: { message: 'Verification item not found' }
        });
        return;
      }

      res.status(201).json({
        success: true,
        data: record,
        message: 'Verification recorded successfully'
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          success: false,
          error: {
            message: 'Validation failed',
            details: error.issues
          }
        });
        return;
      }
      next(error);
    }
  }

  async bulkVerify(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = (req as Request & { user?: { id: string } }).user?.id || 'anonymous';

      logger.info(`[BulkVerify] Request body: ${JSON.stringify(req.body)}`);
      
      const validatedData = BulkVerificationSchema.parse(req.body);
      
      const verification: SubmitVerificationInput = {
        status: validatedData.status as VerificationStatus,
        method: validatedData.method,
        notes: validatedData.notes
      };

      const records = await humanVerificationService.bulkVerify(
        validatedData.itemIds,
        verification,
        userId
      );

      res.status(201).json({
        success: true,
        data: {
          recordsCreated: records.length,
          records
        },
        message: `${records.length} items verified successfully`
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        logger.warn(`[BulkVerify] Validation failed: ${JSON.stringify(error.issues)}`);
        res.status(400).json({
          success: false,
          error: {
            message: 'Validation failed',
            details: error.issues
          }
        });
        return;
      }
      next(error);
    }
  }

  async getAuditLog(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        res.status(400).json({
          success: false,
          error: { message: 'Job ID is required' }
        });
        return;
      }

      const records = await humanVerificationService.getAuditLog(jobId);

      res.json({
        success: true,
        data: {
          jobId,
          totalRecords: records.length,
          records,
          exportUrl: `/api/v1/verification/${jobId}/audit-log/export`
        }
      });
    } catch (error) {
      next(error);
    }
  }

  async exportAuditLog(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        res.status(400).json({
          success: false,
          error: { message: 'Job ID is required' }
        });
        return;
      }

      const records = await humanVerificationService.getAuditLog(jobId);

      const csvHeader = 'ID,Item ID,Status,Verified By,Verified At,Method,Notes,Previous Status\n';
      const csvRows = records.map(r => 
        `${r.id},${r.validationItemId},${r.status},${r.verifiedBy},${r.verifiedAt.toISOString()},${r.method},"${r.notes.replace(/"/g, '""')}",${r.previousStatus || ''}`
      ).join('\n');

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="audit-log-${jobId}.csv"`);
      res.send(csvHeader + csvRows);
    } catch (error) {
      next(error);
    }
  }

  async canFinalize(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        res.status(400).json({
          success: false,
          error: { message: 'Job ID is required' }
        });
        return;
      }

      const result = await humanVerificationService.canFinalizeAcr(jobId);

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async getMethods(_req: Request, res: Response) {
    const methods = humanVerificationService.getVerificationMethods();

    res.json({
      success: true,
      data: methods
    });
  }

  async filterQueue(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        res.status(400).json({
          success: false,
          error: { message: 'Job ID is required' }
        });
        return;
      }

      const validatedFilters = FilterQueueSchema.parse(req.query);
      
      const items = humanVerificationService.filterQueue(jobId, {
        severity: validatedFilters.severity as ('critical' | 'serious' | 'moderate' | 'minor')[] | undefined,
        confidenceLevel: validatedFilters.confidenceLevel as ConfidenceLevel[] | undefined,
        status: validatedFilters.status as VerificationStatus[] | undefined
      });

      res.json({
        success: true,
        data: {
          jobId,
          totalItems: items.length,
          items
        }
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          success: false,
          error: {
            message: 'Validation failed',
            details: error.issues
          }
        });
        return;
      }
      next(error);
    }
  }
}

export const verificationController = new VerificationController();
