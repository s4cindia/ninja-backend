import { Request, Response, NextFunction } from 'express';
import { humanVerificationService, SubmitVerificationInput, VerificationStatus } from '../services/acr/human-verification.service';
import { ConfidenceLevel } from '../services/acr/confidence-analyzer.service';
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
      const userId = (req as any).user?.id || 'anonymous';

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
      const userId = (req as any).user?.id || 'anonymous';

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
