import { Request, Response, NextFunction } from 'express';
import { acrGeneratorService, AcrGenerationOptions } from '../services/acr/acr-generator.service';
import { conformanceEngineService, ConformanceLevel, ValidationResult } from '../services/acr/conformance-engine.service';
import { 
  generateMethodologySection, 
  generateMethodologyText,
  LEGAL_DISCLAIMER,
  TOOL_VERSION,
  AI_MODEL_INFO 
} from '../services/acr/attribution.service';
import { humanVerificationService } from '../services/acr/human-verification.service';
import { remarksGeneratorService, RemarksGenerationRequest } from '../services/acr/remarks-generator.service';
import { acrExporterService, ExportOptions, ExportFormat } from '../services/acr/acr-exporter.service';
import { acrVersioningService } from '../services/acr/acr-versioning.service';
import { acrAnalysisService } from '../services/acr/acr-analysis.service';
import { acrService } from '../services/acr.service';
import { z } from 'zod';

const ProductInfoSchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  description: z.string(),
  vendor: z.string().min(1),
  contactEmail: z.string().email(),
  evaluationDate: z.string().transform((str) => new Date(str))
});

const GenerateAcrSchema = z.object({
  jobId: z.string().uuid(),
  options: z.object({
    edition: z.enum(['VPAT2.5-508', 'VPAT2.5-WCAG', 'VPAT2.5-EU', 'VPAT2.5-INT']).optional(),
    includeAppendix: z.boolean().optional(),
    includeMethodology: z.boolean().optional(),
    productInfo: ProductInfoSchema
  })
});

export class AcrController {
  async generateAcr(req: Request, res: Response, next: NextFunction) {
    try {
      const validatedData = GenerateAcrSchema.parse(req.body);
      
      const options: AcrGenerationOptions = {
        edition: validatedData.options.edition,
        includeAppendix: validatedData.options.includeAppendix,
        includeMethodology: validatedData.options.includeMethodology,
        productInfo: {
          ...validatedData.options.productInfo,
          evaluationDate: validatedData.options.productInfo.evaluationDate
        }
      };

      const verificationQueue = await humanVerificationService.getQueue(validatedData.jobId);
      
      const verificationData = new Map<string, { status: string; isAiGenerated: boolean; notes?: string }>();
      for (const item of verificationQueue.items) {
        const latestVerification = item.verificationHistory[item.verificationHistory.length - 1];
        verificationData.set(item.criterionId, {
          status: item.status,
          isAiGenerated: item.criterionId === '1.1.1',
          notes: latestVerification?.notes
        });
      }

      const acrDocument = await acrGeneratorService.generateAcr(
        validatedData.jobId,
        options,
        verificationData
      );

      res.status(201).json({
        success: true,
        data: acrDocument,
        message: acrDocument.edition === 'VPAT2.5-INT' 
          ? 'ACR generated using INT Edition - satisfies US Section 508, EU EN 301 549, and WCAG requirements in one document'
          : 'ACR generated successfully'
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

  async getEditions(_req: Request, res: Response) {
    const editionsInfo = acrGeneratorService.getEditions();
    
    res.json({
      success: true,
      data: editionsInfo,
      tooltip: 'INT Edition is recommended as it satisfies US Section 508, EU EN 301 549, and WCAG requirements in one document'
    });
  }

  async getEditionInfo(req: Request, res: Response, next: NextFunction) {
    try {
      const edition = req.params.edition as 'VPAT2.5-508' | 'VPAT2.5-WCAG' | 'VPAT2.5-EU' | 'VPAT2.5-INT';

      const validEditions = ['VPAT2.5-508', 'VPAT2.5-WCAG', 'VPAT2.5-EU', 'VPAT2.5-INT'];
      if (!validEditions.includes(edition)) {
        res.status(400).json({
          success: false,
          error: { message: 'Invalid edition. Valid options: VPAT2.5-508, VPAT2.5-WCAG, VPAT2.5-EU, VPAT2.5-INT' }
        });
        return;
      }

      const details = await acrGeneratorService.getEditionDetails(edition);

      if (!details) {
        res.status(404).json({
          success: false,
          error: { message: 'Edition not found' }
        });
        return;
      }

      res.json({
        success: true,
        data: details
      });
    } catch (error) {
      next(error);
    }
  }

  async validateCredibility(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        res.status(400).json({
          success: false,
          error: { message: 'Job ID is required' }
        });
        return;
      }

      const acr = await conformanceEngineService.buildAcrFromJob(jobId);

      if (!acr) {
        res.status(404).json({
          success: false,
          error: { message: 'No ACR data found for this job. Run validation first.' }
        });
        return;
      }

      const result = conformanceEngineService.validateAcrCredibilityFull(acr);

      res.json({
        success: true,
        data: result
      });
    } catch (error) {
      next(error);
    }
  }

  async getRemarksRequirements(_req: Request, res: Response) {
    const requirements = conformanceEngineService.getRemarksRequirements();
    
    res.json({
      success: true,
      data: requirements
    });
  }

  async getMethodology(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        res.status(400).json({
          success: false,
          error: { message: 'Job ID is required' }
        });
        return;
      }

      const verificationQueue = await humanVerificationService.getQueue(jobId);
      
      const verificationRecords = verificationQueue.items
        .filter(item => item.verificationHistory.length > 0)
        .map(item => {
          const latestVerification = item.verificationHistory[item.verificationHistory.length - 1];
          return {
            itemId: item.criterionId,
            status: item.status,
            verifiedBy: latestVerification?.verifiedBy,
            method: latestVerification?.method
          };
        });

      const findingsMetadata = verificationQueue.items.map(item => ({
        findingId: item.criterionId,
        isAiGenerated: item.criterionId === '1.1.1', 
        isAltTextSuggestion: item.criterionId === '1.1.1'
      }));

      const methodology = generateMethodologySection(findingsMetadata, verificationRecords);
      const methodologyText = generateMethodologyText(methodology);

      res.json({
        success: true,
        data: {
          methodology,
          formattedText: methodologyText,
          toolVersion: TOOL_VERSION,
          aiModel: AI_MODEL_INFO,
          legalDisclaimer: LEGAL_DISCLAIMER
        }
      });
    } catch (error) {
      next(error);
    }
  }

  async generateRemarks(req: Request, res: Response, next: NextFunction) {
    try {
      const GenerateRemarksSchema = z.object({
        criterionId: z.string().min(1),
        wcagCriterion: z.string().min(1),
        validationResults: z.array(z.object({
          criterionId: z.string(),
          passed: z.boolean(),
          passCount: z.number().optional(),
          failCount: z.number().optional(),
          totalCount: z.number().optional(),
          details: z.string().optional()
        })),
        conformanceLevel: z.enum(['Supports', 'Partially Supports', 'Does Not Support', 'Not Applicable'])
      });

      const validatedData = GenerateRemarksSchema.parse(req.body);

      const request: RemarksGenerationRequest = {
        criterionId: validatedData.criterionId,
        wcagCriterion: validatedData.wcagCriterion,
        validationResults: validatedData.validationResults as ValidationResult[],
        conformanceLevel: validatedData.conformanceLevel as ConformanceLevel
      };

      const generatedRemarks = await remarksGeneratorService.generateRemarks(request);

      res.status(200).json({
        success: true,
        data: generatedRemarks,
        message: generatedRemarks.aiGenerated 
          ? 'Remarks generated using AI. Review and edit as needed.'
          : 'Remarks generated using fallback template.'
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

  async exportAcr(req: Request, res: Response, next: NextFunction) {
    try {
      const ExportOptionsSchema = z.object({
        format: z.enum(['docx', 'pdf', 'html']),
        includeMethodology: z.boolean().default(true),
        includeAttribution: z.boolean().default(true),
        branding: z.object({
          companyName: z.string().optional(),
          logoUrl: z.string().url().optional(),
          primaryColor: z.string().optional(),
          footerText: z.string().optional()
        }).optional()
      });

      const ExportRequestSchema = z.object({
        options: ExportOptionsSchema,
        acrData: z.object({
          edition: z.enum(['VPAT2.5-508', 'VPAT2.5-WCAG', 'VPAT2.5-EU', 'VPAT2.5-INT']).optional(),
          productInfo: ProductInfoSchema
        }).optional()
      });

      const { acrId } = req.params;
      const validatedData = ExportRequestSchema.parse(req.body);

      const exportOptions: ExportOptions = {
        format: validatedData.options.format as ExportFormat,
        includeMethodology: validatedData.options.includeMethodology,
        includeAttribution: validatedData.options.includeAttribution,
        branding: validatedData.options.branding
      };

      const verificationQueue = await humanVerificationService.getQueue(acrId);
      
      const verificationData = new Map<string, { status: string; isAiGenerated: boolean; notes?: string }>();
      for (const item of verificationQueue.items) {
        const latestVerification = item.verificationHistory[item.verificationHistory.length - 1];
        verificationData.set(item.criterionId, {
          status: item.status,
          isAiGenerated: item.criterionId === '1.1.1',
          notes: latestVerification?.notes
        });
      }

      const acrGenerationOptions = {
        edition: validatedData.acrData?.edition || 'VPAT2.5-INT' as const,
        includeMethodology: exportOptions.includeMethodology,
        productInfo: validatedData.acrData?.productInfo || {
          name: 'Unnamed Product',
          version: '1.0.0',
          description: 'Product accessibility conformance report',
          vendor: 'Unknown Vendor',
          contactEmail: 'contact@example.com',
          evaluationDate: new Date()
        }
      };

      const acrDocument = await acrGeneratorService.generateAcr(
        acrId,
        acrGenerationOptions,
        verificationData
      );

      const exportResult = await acrExporterService.exportAcr(acrDocument, exportOptions);

      res.status(200).json({
        success: true,
        data: exportResult,
        message: `ACR exported successfully as ${exportOptions.format.toUpperCase()}`
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

  async getVersions(req: Request, res: Response, next: NextFunction) {
    try {
      const { acrId } = req.params;
      const versions = await acrVersioningService.getVersions(acrId);

      res.json({
        success: true,
        data: versions.map(v => ({
          id: v.id,
          acrId: v.acrId,
          version: v.version,
          createdAt: v.createdAt,
          createdBy: v.createdBy,
          changeCount: v.changeLog.length
        })),
        total: versions.length
      });
    } catch (error) {
      next(error);
    }
  }

  async getVersion(req: Request, res: Response, next: NextFunction) {
    try {
      const { acrId, version } = req.params;
      const versionNumber = parseInt(version, 10);

      if (isNaN(versionNumber) || versionNumber < 1) {
        res.status(400).json({
          success: false,
          error: { message: 'Invalid version number' }
        });
        return;
      }

      const versionData = await acrVersioningService.getVersion(acrId, versionNumber);

      if (!versionData) {
        res.status(404).json({
          success: false,
          error: { message: `Version ${versionNumber} not found for ACR ${acrId}` }
        });
        return;
      }

      res.json({
        success: true,
        data: versionData
      });
    } catch (error) {
      next(error);
    }
  }

  async compareVersions(req: Request, res: Response, next: NextFunction) {
    try {
      const { acrId } = req.params;
      const v1 = parseInt(req.query.v1 as string, 10);
      const v2 = parseInt(req.query.v2 as string, 10);

      if (isNaN(v1) || isNaN(v2) || v1 < 1 || v2 < 1) {
        res.status(400).json({
          success: false,
          error: { message: 'Invalid version numbers. Provide v1 and v2 query parameters.' }
        });
        return;
      }

      const comparison = await acrVersioningService.compareVersions(acrId, v1, v2);

      if (!comparison) {
        res.status(404).json({
          success: false,
          error: { message: `One or both versions not found for ACR ${acrId}` }
        });
        return;
      }

      res.json({
        success: true,
        data: comparison
      });
    } catch (error) {
      next(error);
    }
  }

  async createVersion(req: Request, res: Response, next: NextFunction) {
    try {
      const CreateVersionSchema = z.object({
        reason: z.string().optional(),
        acrData: z.object({
          edition: z.enum(['VPAT2.5-508', 'VPAT2.5-WCAG', 'VPAT2.5-EU', 'VPAT2.5-INT']).optional(),
          productInfo: ProductInfoSchema
        }).optional()
      });

      const { acrId } = req.params;
      const validatedData = CreateVersionSchema.parse(req.body);
      const userId = req.user?.id || 'anonymous';

      const verificationQueue = await humanVerificationService.getQueue(acrId);
      
      const verificationData = new Map<string, { status: string; isAiGenerated: boolean; notes?: string }>();
      for (const item of verificationQueue.items) {
        const latestVerification = item.verificationHistory[item.verificationHistory.length - 1];
        verificationData.set(item.criterionId, {
          status: item.status,
          isAiGenerated: item.criterionId === '1.1.1',
          notes: latestVerification?.notes
        });
      }

      const acrGenerationOptions = {
        edition: validatedData.acrData?.edition || 'VPAT2.5-INT' as const,
        includeMethodology: true,
        productInfo: validatedData.acrData?.productInfo || {
          name: 'Unnamed Product',
          version: '1.0.0',
          description: 'Product accessibility conformance report',
          vendor: 'Unknown Vendor',
          contactEmail: 'contact@example.com',
          evaluationDate: new Date()
        }
      };

      const acrDocument = await acrGeneratorService.generateAcr(
        acrId,
        acrGenerationOptions,
        verificationData
      );

      const version = await acrVersioningService.createVersion(
        acrId,
        userId,
        acrDocument,
        validatedData.reason
      );

      res.status(201).json({
        success: true,
        data: {
          id: version.id,
          acrId: version.acrId,
          version: version.version,
          createdAt: version.createdAt,
          createdBy: version.createdBy,
          changeCount: version.changeLog.length
        },
        message: `Version ${version.version} created successfully`
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

  async getAnalysis(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;
      const userId = req.user?.id;

      if (!jobId) {
        res.status(400).json({
          success: false,
          error: { message: 'Job ID is required' }
        });
        return;
      }

      if (!userId) {
        res.status(401).json({
          success: false,
          error: { message: 'Authentication required' }
        });
        return;
      }

      const analysis = await acrAnalysisService.getAnalysisForJob(jobId, userId);

      res.json({
        success: true,
        data: analysis
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: { message: 'Job not found or access denied' }
        });
        return;
      }
      next(error);
    }
  }

  async getAllEditions(_req: Request, res: Response, next: NextFunction) {
    try {
      const editions = acrService.getAllEditions();

      res.json({
        success: true,
        data: editions,
      });
    } catch (error) {
      next(error);
    }
  }

  async getEditionCriteria(req: Request, res: Response, next: NextFunction) {
    try {
      const { editionCode } = req.params;

      const data = acrService.getEditionCriteria(editionCode);

      res.json({
        success: true,
        data,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: {
            message: error.message,
            code: 'EDITION_NOT_FOUND',
          },
        });
      } else {
        next(error);
      }
    }
  }

  async getCriterion(req: Request, res: Response, next: NextFunction) {
    try {
      const { criterionId } = req.params;

      const criterion = acrService.getCriterionById(criterionId);

      res.json({
        success: true,
        data: criterion,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: {
            message: error.message,
            code: 'CRITERION_NOT_FOUND',
          },
        });
      } else {
        next(error);
      }
    }
  }

  async createAnalysis(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      const tenantId = req.user?.tenantId;

      if (!userId || !tenantId) {
        res.status(401).json({
          success: false,
          error: { message: 'Authentication required' }
        });
        return;
      }

      const { jobId, edition, documentTitle } = req.body;

      if (!jobId || !edition) {
        res.status(400).json({
          success: false,
          error: {
            message: 'jobId and edition are required',
            code: 'INVALID_REQUEST',
          },
        });
        return;
      }

      const validEditions = ['section508', 'wcag', 'eu', 'international'];
      if (!validEditions.includes(edition)) {
        res.status(400).json({
          success: false,
          error: {
            message: `Invalid edition. Must be one of: ${validEditions.join(', ')}`,
            code: 'INVALID_EDITION',
          },
        });
        return;
      }

      const result = await acrService.createAcrAnalysis(
        userId,
        tenantId,
        jobId,
        edition,
        documentTitle
      );

      res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      if (error instanceof Error && (error.message.includes('not found') || error.message.includes('access denied'))) {
        res.status(404).json({
          success: false,
          error: { message: 'Job not found or access denied', code: 'JOB_NOT_FOUND' }
        });
        return;
      }
      next(error);
    }
  }

  async getAcrAnalysis(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      const tenantId = req.user?.tenantId;

      if (!userId || !tenantId) {
        res.status(401).json({
          success: false,
          error: { message: 'Authentication required' }
        });
        return;
      }

      const { acrJobId } = req.params;

      const result = await acrService.getAcrAnalysis(acrJobId, userId, tenantId);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: { message: 'ACR job not found or access denied' }
        });
        return;
      }
      next(error);
    }
  }

  async getAcrAnalysisByJobId(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      const tenantId = req.user?.tenantId;

      if (!userId || !tenantId) {
        res.status(401).json({
          success: false,
          error: { message: 'Authentication required' }
        });
        return;
      }

      const { jobId } = req.params;

      const result = await acrService.getAcrAnalysisByJobId(jobId, userId, tenantId);

      if (!result) {
        res.status(404).json({
          success: false,
          error: { message: 'No ACR analysis found for this job' }
        });
        return;
      }

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      next(error);
    }
  }

  async saveCriterionReview(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      const tenantId = req.user?.tenantId;

      if (!userId || !tenantId) {
        res.status(401).json({
          success: false,
          error: { message: 'Authentication required' }
        });
        return;
      }

      const { acrJobId, criterionId } = req.params;
      const { conformanceLevel, remarks } = req.body;

      if (!conformanceLevel) {
        res.status(400).json({
          success: false,
          error: {
            message: 'conformanceLevel is required',
            code: 'INVALID_REQUEST',
          },
        });
        return;
      }

      const validLevels = ['supports', 'partially_supports', 'does_not_support', 'not_applicable'];
      if (!validLevels.includes(conformanceLevel)) {
        res.status(400).json({
          success: false,
          error: {
            message: `Invalid conformanceLevel. Must be one of: ${validLevels.join(', ')}`,
            code: 'INVALID_CONFORMANCE_LEVEL',
          },
        });
        return;
      }

      const result = await acrService.saveCriterionReview(
        acrJobId,
        criterionId,
        userId,
        tenantId,
        { conformanceLevel, remarks }
      );

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      if (error instanceof Error && (error.message.includes('not found') || error.message.includes('access denied'))) {
        res.status(404).json({
          success: false,
          error: { message: error.message }
        });
        return;
      }
      next(error);
    }
  }

  async saveBulkReviews(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      const tenantId = req.user?.tenantId;

      if (!userId || !tenantId) {
        res.status(401).json({
          success: false,
          error: { message: 'Authentication required' }
        });
        return;
      }

      const { acrJobId } = req.params;
      const { reviews } = req.body;

      if (!Array.isArray(reviews) || reviews.length === 0) {
        res.status(400).json({
          success: false,
          error: {
            message: 'reviews array is required and must not be empty',
            code: 'INVALID_REQUEST',
          },
        });
        return;
      }

      const result = await acrService.saveBulkReviews(acrJobId, userId, tenantId, reviews);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      if (error instanceof Error) {
        if (error.message.includes('not found') || error.message.includes('access denied')) {
          res.status(404).json({
            success: false,
            error: { message: error.message }
          });
          return;
        }
        if (error.message.includes('Invalid conformance levels')) {
          res.status(400).json({
            success: false,
            error: { message: error.message, code: 'INVALID_CONFORMANCE_LEVEL' }
          });
          return;
        }
      }
      next(error);
    }
  }

  async getCriterionDetailsFromJob(req: Request, res: Response, next: NextFunction) {
    try {
      const userId = req.user?.id;
      const tenantId = req.user?.tenantId;

      if (!userId || !tenantId) {
        res.status(401).json({
          success: false,
          error: { message: 'Authentication required' }
        });
        return;
      }

      const { acrJobId, criterionId } = req.params;

      const result = await acrService.getCriterionDetails(acrJobId, criterionId, userId, tenantId);

      res.json({
        success: true,
        data: result,
      });
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        res.status(404).json({
          success: false,
          error: { message: 'Criterion not found in ACR job' }
        });
        return;
      }
      next(error);
    }
  }
}

export const acrController = new AcrController();
