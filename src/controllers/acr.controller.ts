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

  async getEditionInfo(req: Request, res: Response) {
    const edition = req.params.edition as 'VPAT2.5-508' | 'VPAT2.5-WCAG' | 'VPAT2.5-EU' | 'VPAT2.5-INT';
    
    const validEditions = ['VPAT2.5-508', 'VPAT2.5-WCAG', 'VPAT2.5-EU', 'VPAT2.5-INT'];
    if (!validEditions.includes(edition)) {
      res.status(400).json({
        success: false,
        error: { message: 'Invalid edition. Valid options: VPAT2.5-508, VPAT2.5-WCAG, VPAT2.5-EU, VPAT2.5-INT' }
      });
      return;
    }

    const info = acrGeneratorService.getEditionInfo(edition);
    
    res.json({
      success: true,
      data: info
    });
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
}

export const acrController = new AcrController();
