import { Request, Response, NextFunction } from 'express';
import { humanVerificationService, SubmitVerificationInput, VerificationStatus, RelatedIssue } from '../services/acr/human-verification.service';
import { ConfidenceLevel } from '../services/acr/confidence-analyzer.service';
import { acrAnalysisService } from '../services/acr/acr-analysis.service';
import { z } from 'zod';

const SubmitVerificationSchema = z.object({
  status: z.enum(['PENDING', 'VERIFIED_PASS', 'VERIFIED_FAIL', 'VERIFIED_PARTIAL', 'DEFERRED']),
  method: z.string().min(1),
  notes: z.string().optional().default('')
});

const BulkVerificationSchema = z.object({
  itemIds: z.array(z.string().min(1)),
  status: z.enum(['PENDING', 'VERIFIED_PASS', 'VERIFIED_FAIL', 'VERIFIED_PARTIAL', 'DEFERRED']),
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
      
      // Enrich queue items with issues from ACR analysis
      try {
        console.log(`[Verification] Enriching queue for job ${jobId} with ${queue.items.length} items`);
        const analysis = await acrAnalysisService.getAnalysisForJob(jobId, undefined, true);
        
        if (analysis?.criteria) {
          console.log(`[Verification] Found ${analysis.criteria.length} criteria in analysis`);
          
          // Create a map of criterion ID to issues
          const criteriaIssuesMap = new Map<string, { relatedIssues?: RelatedIssue[]; fixedIssues?: RelatedIssue[]; confidence?: number }>();
          
          let criteriaWithIssues = 0;
          for (const criterion of analysis.criteria) {
            const relatedCount = criterion.relatedIssues?.length || 0;
            const fixedCount = criterion.fixedIssues?.length || 0;
            
            if (relatedCount > 0 || fixedCount > 0) {
              criteriaWithIssues++;
              console.log(`[Verification] Criterion ${criterion.id}: ${relatedCount} remaining, ${fixedCount} fixed, confidence=${criterion.confidence}`);
            }
            
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
              confidence: criterion.confidence
            });
          }
          console.log(`[Verification] Total criteria with issues: ${criteriaWithIssues}`);
          
          // Enrich queue items with issues
          let enrichedCount = 0;
          for (const item of queue.items) {
            const issueData = criteriaIssuesMap.get(item.criterionId);
            if (issueData) {
              item.relatedIssues = issueData.relatedIssues;
              item.fixedIssues = issueData.fixedIssues;
              if (issueData.relatedIssues?.length || issueData.fixedIssues?.length) {
                enrichedCount++;
                console.log(`[Verification] Enriched ${item.criterionId}: ${issueData.relatedIssues?.length || 0} remaining, ${issueData.fixedIssues?.length || 0} fixed`);
                // Log sample issue structure for debugging
                if (issueData.relatedIssues?.[0]) {
                  console.log(`[Verification] Sample relatedIssue:`, JSON.stringify(issueData.relatedIssues[0]));
                }
              }
            }
          }
          console.log(`[Verification] Enriched ${enrichedCount} queue items with issue data`);
          
          // Log a sample enriched item for frontend debugging
          const sampleEnriched = queue.items.find(i => i.relatedIssues?.length || i.fixedIssues?.length);
          if (sampleEnriched) {
            console.log(`[Verification] Sample enriched queue item:`, JSON.stringify({
              criterionId: sampleEnriched.criterionId,
              criterionName: sampleEnriched.criterionName,
              relatedIssues: sampleEnriched.relatedIssues,
              fixedIssues: sampleEnriched.fixedIssues
            }, null, 2));
          }
        } else {
          console.log(`[Verification] No criteria found in analysis`);
        }
      } catch (analysisError) {
        console.warn(`[Verification] Could not fetch ACR analysis for enrichment:`, analysisError);
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
