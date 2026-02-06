import { Request, Response, NextFunction } from 'express';
import { acrGeneratorService, AcrGenerationOptions, AcrDocument, AcrCriterion, AcrEdition } from '../services/acr/acr-generator.service';
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
import { batchAcrGeneratorService } from '../services/acr/batch-acr-generator.service';
import { 
  BatchNotFoundError, 
  TenantMismatchError, 
  IncompleteBatchError,
  InvalidAcrOptionsError 
} from '../types/batch-acr.types';
import { z } from 'zod';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';

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
      const editionParam = req.params.edition;

      // Map friendly names to full edition codes
      const editionMap: Record<string, 'VPAT2.5-508' | 'VPAT2.5-WCAG' | 'VPAT2.5-EU' | 'VPAT2.5-INT'> = {
        'VPAT2.5-508': 'VPAT2.5-508',
        'VPAT2.5-WCAG': 'VPAT2.5-WCAG',
        'VPAT2.5-EU': 'VPAT2.5-EU',
        'VPAT2.5-INT': 'VPAT2.5-INT',
        'section508': 'VPAT2.5-508',
        '508': 'VPAT2.5-508',
        'wcag': 'VPAT2.5-WCAG',
        'eu': 'VPAT2.5-EU',
        'international': 'VPAT2.5-INT',
        'int': 'VPAT2.5-INT'
      };

      const edition = editionMap[editionParam] || editionMap[editionParam.toLowerCase()];

      if (!edition) {
        res.status(400).json({
          success: false,
          error: { message: 'Invalid edition. Valid options: VPAT2.5-508, VPAT2.5-WCAG, VPAT2.5-EU, VPAT2.5-INT, section508, wcag, eu, international' }
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
          productInfo: ProductInfoSchema.partial()
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

      // 1. Find the source Job (ACR_WORKFLOW type) - this has all the analysis data
      // First try finding as ACR_WORKFLOW job directly
      let sourceJob = await prisma.job.findFirst({
        where: { 
          id: acrId,
          type: 'ACR_WORKFLOW'
        }
      });

      // If not found, check if acrId is an AcrJob.id and find the source Job via jobId
      if (!sourceJob) {
        const acrJobRecord = await prisma.acrJob.findFirst({
          where: { id: acrId }
        });
        
        if (acrJobRecord) {
          // Look for ACR_WORKFLOW job that references this job
          sourceJob = await prisma.job.findFirst({
            where: {
              type: 'ACR_WORKFLOW',
              input: {
                path: ['sourceJobId'],
                equals: acrJobRecord.jobId
              }
            }
          });
          
          // If still no ACR_WORKFLOW job, create export from AcrJob data directly
          if (!sourceJob) {
            // Build export from AcrJob and its criteria
            const acrJobWithCriteria = await prisma.acrJob.findFirst({
              where: { id: acrId },
              include: { criteria: true }
            });
            
            if (acrJobWithCriteria) {
              // Get the source job for document title AND criteria from output
              const origJob = await prisma.job.findFirst({
                where: { id: acrJobWithCriteria.jobId }
              });
              
              const origJobOutput = origJob?.output as Record<string, unknown> | null;
              const documentTitle = acrJobWithCriteria.documentTitle || 
                                   origJobOutput?.epubTitle as string ||
                                   'Unnamed Product';
              
              // Build criteria - first try AcrCriterionReview, then fallback to Job output
              let criteriaForExport: AcrCriterion[] = [];
              
              if (acrJobWithCriteria.criteria.length > 0) {
                // Use database-stored criteria reviews
                criteriaForExport = acrJobWithCriteria.criteria.map(c => ({
                  id: c.criterionNumber,
                  criterionId: c.criterionId,
                  name: c.criterionName,
                  level: c.level as 'A' | 'AA' | 'AAA',
                  conformanceLevel: (c.conformanceLevel || c.aiStatus || 'Not Applicable') as 'Supports' | 'Partially Supports' | 'Does Not Support' | 'Not Applicable',
                  remarks: c.reviewerNotes || ''
                }));
              } else if (origJobOutput?.acrAnalysis) {
                // Fallback to Job output acrAnalysis.criteria
                const acrAnalysis = origJobOutput.acrAnalysis as { criteria?: Array<{
                  id: string;
                  name: string;
                  level: string;
                  status: string;
                  findings?: string[];
                  recommendation?: string;
                }> };
                
                if (acrAnalysis.criteria && Array.isArray(acrAnalysis.criteria)) {
                  criteriaForExport = acrAnalysis.criteria.map(c => {
                    // Map status to conformance level
                    const statusMap: Record<string, 'Supports' | 'Partially Supports' | 'Does Not Support' | 'Not Applicable'> = {
                      'supports': 'Supports',
                      'partially_supports': 'Partially Supports',
                      'does_not_support': 'Does Not Support',
                      'not_applicable': 'Not Applicable'
                    };
                    const conformanceLevel = statusMap[c.status] || 'Not Applicable';
                    
                    // Build remarks from findings
                    const remarks = c.findings?.join('. ') || c.recommendation || '';
                    
                    return {
                      id: c.id,
                      criterionId: c.id,
                      name: c.name,
                      level: c.level as 'A' | 'AA' | 'AAA',
                      conformanceLevel,
                      remarks
                    };
                  });
                }
              }
              
              const TOOL_VERSION = '1.0.0';
              const AI_MODEL_INFO = { name: 'Gemini 2.0', purpose: 'Accessibility Analysis' };
              const LEGAL_DISCLAIMER = 'This report contains AI-assisted accessibility analysis. Results should be verified by accessibility professionals.';
              
              const acrDocumentFallback: AcrDocument = {
                id: acrId,
                edition: acrJobWithCriteria.edition as AcrEdition,
                productInfo: {
                  name: documentTitle,
                  version: '1.0',
                  description: `Accessibility Conformance Report for ${documentTitle}`,
                  vendor: 'Unknown',
                  contactEmail: 'accessibility@example.com',
                  evaluationDate: acrJobWithCriteria.createdAt
                },
                evaluationMethods: [
                  { type: 'hybrid', description: 'AI-assisted automated analysis with human verification' }
                ],
                criteria: criteriaForExport,
                generatedAt: new Date(),
                version: 1,
                status: acrJobWithCriteria.status === 'completed' ? 'final' : 'draft',
                methodology: exportOptions.includeMethodology ? {
                  assessmentDate: acrJobWithCriteria.createdAt,
                  toolVersion: TOOL_VERSION,
                  aiModelInfo: `${AI_MODEL_INFO.name} (${AI_MODEL_INFO.purpose})`,
                  disclaimer: LEGAL_DISCLAIMER
                } : undefined,
                footerDisclaimer: LEGAL_DISCLAIMER
              };
              
              const exportResultFallback = await acrExporterService.exportAcr(acrDocumentFallback, exportOptions);
              
              // Read file and return as base64
              const fsFallback = await import('fs/promises');
              const pathFallback = await import('path');
              const EXPORTS_DIR_FALLBACK = pathFallback.join(process.cwd(), 'exports');
              const filepathFallback = pathFallback.join(EXPORTS_DIR_FALLBACK, exportResultFallback.filename);
              const fileBufferFallback = await fsFallback.readFile(filepathFallback);
              const base64ContentFallback = fileBufferFallback.toString('base64');

              res.status(200).json({
                success: true,
                data: {
                  ...exportResultFallback,
                  content: base64ContentFallback
                },
                message: `ACR exported successfully as ${exportOptions.format.toUpperCase()}`
              });
              return;
            }
          }
        }
      }

      if (!sourceJob) {
        res.status(404).json({
          success: false,
          error: { message: 'ACR job not found' }
        });
        return;
      }

      // 2. Parse the output JSON - THIS HAS ALL THE DATA
      const jobOutput = sourceJob.output as Record<string, unknown> | null;
      
      logger.debug('[ACR Export] Job output info', { 
        epubTitle: jobOutput?.epubTitle,
        criteriaType: typeof jobOutput?.criteria,
        acrAnalysisType: typeof jobOutput?.acrAnalysis,
        acrAnalysisIsArray: Array.isArray(jobOutput?.acrAnalysis)
      });

      // 3. Get document title from job output
      const documentTitle = (jobOutput?.epubTitle as string) || 
                           (jobOutput?.fileName as string) ||
                           'Unnamed Product';

      // 4. Get criteria from Job output (use acrAnalysis which has the full criteria)
      // Handle various possible structures
      let rawCriteria = jobOutput?.acrAnalysis || jobOutput?.criteria;
      
      // If criteria is an object with a 'criteria' property, extract it
      if (rawCriteria && typeof rawCriteria === 'object' && !Array.isArray(rawCriteria) && 'criteria' in (rawCriteria as Record<string, unknown>)) {
        rawCriteria = (rawCriteria as Record<string, unknown>).criteria;
      }
      
      // Ensure it's an array
      const criteriaFromOutput = (Array.isArray(rawCriteria) ? rawCriteria : []) as Array<{
        criterionId?: string;
        id?: string;
        name?: string;
        level?: string;
        status?: string;
        conformanceLevel?: string;
        remarks?: string;
      }>;
      
      logger.debug('[ACR Export] criteriaFromOutput', { length: criteriaFromOutput.length });

      // 5. Also get any human-edited criteria from AcrCriterionReview to merge
      const acrJob = await prisma.acrJob.findFirst({
        where: { 
          OR: [
            { id: acrId },
            { jobId: acrId }
          ]
        },
        include: { criteria: true }
      });

      // Create a map of human-edited criteria
      const editedCriteria = new Map<string, { conformanceLevel: string; remarks: string; reviewedBy: string | null }>();
      if (acrJob?.criteria) {
        for (const review of acrJob.criteria) {
          editedCriteria.set(review.criterionId, {
            conformanceLevel: review.conformanceLevel || '',
            remarks: review.reviewerNotes || '',
            reviewedBy: review.reviewedBy
          });
        }
      }

      logger.debug('[ACR Export] Human-edited criteria', { count: editedCriteria.size });

      // Conformance level mapping (snake_case to Title Case)
      const conformanceLevelMap: Record<string, AcrCriterion['conformanceLevel']> = {
        'supports': 'Supports',
        'partially_supports': 'Partially Supports',
        'does_not_support': 'Does Not Support',
        'not_applicable': 'Not Applicable',
        'Supports': 'Supports',
        'Partially Supports': 'Partially Supports',
        'Does Not Support': 'Does Not Support',
        'Not Applicable': 'Not Applicable',
        'Not Evaluated': 'Not Applicable'
      };

      // 6. Build final criteria array - merge Job output with human edits
      const finalCriteria: AcrCriterion[] = criteriaFromOutput.map((c) => {
        const criterionId = c.criterionId || c.id || '';
        const edited = editedCriteria.get(criterionId);
        
        const rawConformance = edited?.conformanceLevel || c.conformanceLevel || c.status || 'Not Applicable';
        const conformanceLevel = conformanceLevelMap[rawConformance] || 'Not Applicable';
        const level = (c.level as 'A' | 'AA' | 'AAA') || 'A';
        const remarks = edited?.remarks || c.remarks || '';
        const isHumanVerified = !!edited?.reviewedBy;
        const tag = isHumanVerified ? '[HUMAN-VERIFIED]' : '[AI-SUGGESTED]';
        const attributedRemarks = remarks ? `${tag} ${remarks.trim()}` : '';

        return {
          id: criterionId,
          criterionId: criterionId,
          name: c.name || criterionId,
          level,
          conformanceLevel,
          remarks: remarks.trim(),
          attributionTag: isHumanVerified ? 'HUMAN_VERIFIED' as const : 'AI_SUGGESTED' as const,
          attributedRemarks
        };
      });

      logger.debug('[ACR Export] Final criteria', { 
        count: finalCriteria.length,
        firstCriterion: finalCriteria.length > 0 ? finalCriteria[0] : null
      });

      const providedProductInfo = validatedData.acrData?.productInfo || {};
      const edition = (validatedData.acrData?.edition || acrJob?.edition || 'VPAT2.5-INT') as AcrEdition;

      // 7. Build AcrDocument with ACTUAL data
      const acrDocument: AcrDocument = {
        id: acrJob?.id || sourceJob.id,
        edition,
        productInfo: {
          name: providedProductInfo.name || documentTitle,
          version: providedProductInfo.version || '1.0.0',
          description: providedProductInfo.description || 'Accessibility Conformance Report',
          vendor: providedProductInfo.vendor || 'S4Carlisle',
          contactEmail: providedProductInfo.contactEmail || 'accessibility@s4carlisle.com',
          evaluationDate: providedProductInfo.evaluationDate || sourceJob.createdAt
        },
        evaluationMethods: [
          { type: 'hybrid', tools: ['Ninja Platform v1.0', 'Ace by DAISY'], aiModels: ['Google Gemini'], description: 'Human verification and AI-assisted analysis' }
        ],
        criteria: finalCriteria,
        generatedAt: new Date(),
        version: 1,
        status: acrJob?.status === 'completed' ? 'final' : 'draft',
        methodology: exportOptions.includeMethodology ? {
          assessmentDate: sourceJob.createdAt,
          toolVersion: TOOL_VERSION,
          aiModelInfo: `${AI_MODEL_INFO.name} (${AI_MODEL_INFO.purpose})`,
          disclaimer: LEGAL_DISCLAIMER
        } : undefined,
        footerDisclaimer: LEGAL_DISCLAIMER
      };

      // 8. Export
      logger.debug('[ACR Export] Calling exporter', { criteriaCount: finalCriteria.length });
      
      let exportResult;
      try {
        exportResult = await acrExporterService.exportAcr(acrDocument, exportOptions);
      } catch (exportError) {
        logger.error('[ACR Export] Export service error', exportError instanceof Error ? exportError : undefined);
        throw exportError;
      }

      // Read the file and return as base64 to avoid proxy issues
      const fs = await import('fs/promises');
      const path = await import('path');
      const EXPORTS_DIR = path.join(process.cwd(), 'exports');
      const filepath = path.join(EXPORTS_DIR, exportResult.filename);
      const fileBuffer = await fs.readFile(filepath);
      const base64Content = fileBuffer.toString('base64');

      res.status(200).json({
        success: true,
        data: {
          ...exportResult,
          content: base64Content  // Include file content directly
        },
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
      logger.error('[ACR Export] Unhandled error', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  async getVersions(req: Request, res: Response, next: NextFunction) {
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
      
      let acrId = req.params.acrId;
      
      // Strip 'acr-' prefix if present
      if (acrId && acrId.startsWith('acr-')) {
        acrId = acrId.substring(4);
      }

      // Check if this is an acrJob ID (with tenant/user validation)
      let acrJob = await prisma.acrJob.findFirst({
        where: { 
          id: acrId,
          userId,
          tenantId
        }
      });

      // If not found by acrJob ID, try finding by jobId
      if (!acrJob) {
        acrJob = await prisma.acrJob.findFirst({
          where: { 
            jobId: acrId,
            userId,
            tenantId
          }
        });
      }

      if (!acrJob) {
        // ACR not created yet or no access - return empty array
        res.json({
          success: true,
          data: [],
          total: 0,
          message: 'No ACR document created yet. Complete AI Analysis step first.'
        });
        return;
      }
      
      // Get versions using the actual acrJob.id
      const versions = await acrVersioningService.getVersions(acrJob.id);

      // Also check for versions by jobId for backwards compatibility
      let allVersions = versions;
      if (acrJob.jobId !== acrJob.id) {
        const jobVersions = await acrVersioningService.getVersions(acrJob.jobId);
        // Merge and deduplicate by id
        const versionIds = new Set(versions.map(v => v.id));
        const uniqueJobVersions = jobVersions.filter(v => !versionIds.has(v.id));
        allVersions = [...versions, ...uniqueJobVersions];
      }
      
      // Sort by version number descending (newest first)
      allVersions.sort((a, b) => b.version - a.version);

      // Return empty array gracefully if no versions exist yet
      if (!allVersions || allVersions.length === 0) {
        res.json({
          success: true,
          data: [],
          total: 0,
          message: 'No versions found. ACR document may not be created yet.'
        });
        return;
      }

      res.json({
        success: true,
        data: allVersions.map(v => ({
          id: v.id,
          acrId: v.acrId,
          version: v.version,
          createdAt: v.createdAt,
          createdBy: v.createdBy,
          changeCount: v.changeLog.length
        })),
        total: allVersions.length
      });
    } catch (error) {
      logger.error('Error fetching ACR versions', error instanceof Error ? error : undefined);
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
        acrDocument,
        userId,
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
      const { refresh } = req.query;

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

      const forceRefresh = refresh === 'true';
      const analysis = await acrAnalysisService.getAnalysisForJob(jobId, userId, forceRefresh);

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
        return;
      }
      next(error);
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
        return;
      }
      next(error);
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

      const validEditions = [
        'section508', '508', 'VPAT2.5-508',
        'wcag', 'VPAT2.5-WCAG',
        'eu', 'VPAT2.5-EU',
        'international', 'int', 'VPAT2.5-INT'
      ];
      if (!validEditions.includes(edition)) {
        res.status(400).json({
          success: false,
          error: {
            message: `Invalid edition. Must be one of: section508, wcag, eu, international (or canonical codes like VPAT2.5-508)`,
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
        data: {
          jobId: result.acrJob.jobId,
          acrId: result.acrJob.id,
          acrJob: result.acrJob,
          criteriaCount: result.criteriaCount,
        },
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

  async createAnalysisWithUpload(req: Request, res: Response, next: NextFunction) {
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

      if (!req.file) {
        res.status(400).json({
          success: false,
          error: { message: 'No EPUB file uploaded', code: 'FILE_REQUIRED' }
        });
        return;
      }

      const { edition, documentTitle } = req.body;

      if (!edition) {
        res.status(400).json({
          success: false,
          error: { message: 'edition is required', code: 'INVALID_REQUEST' }
        });
        return;
      }

      const validEditions = [
        'section508', '508', 'VPAT2.5-508',
        'wcag', 'VPAT2.5-WCAG',
        'eu', 'VPAT2.5-EU',
        'international', 'int', 'VPAT2.5-INT'
      ];
      if (!validEditions.includes(edition)) {
        res.status(400).json({
          success: false,
          error: { message: 'Invalid edition', code: 'INVALID_EDITION' }
        });
        return;
      }

      // Import required services dynamically to avoid circular dependencies
      const { epubAuditService } = await import('../services/epub/epub-audit.service');
      const { fileStorageService } = await import('../services/storage/file-storage.service');

      // Step 1: Create job and run EPUB audit
      const job = await prisma.job.create({
        data: {
          tenantId,
          userId,
          type: 'EPUB_ACCESSIBILITY',
          status: 'PROCESSING',
          input: {
            fileName: req.file.originalname,
            mimeType: req.file.mimetype,
            size: req.file.size,
          },
          startedAt: new Date(),
        },
      });

      await fileStorageService.saveFile(job.id, req.file.originalname, req.file.buffer);

      const auditResult = await epubAuditService.runAudit(
        req.file.buffer,
        job.id,
        req.file.originalname
      );

      await prisma.job.update({
        where: { id: job.id },
        data: {
          status: 'COMPLETED',
          completedAt: new Date(),
          output: JSON.parse(JSON.stringify(auditResult)),
        },
      });

      // Step 2: Create ACR analysis
      const result = await acrService.createAcrAnalysis(
        userId,
        tenantId,
        job.id,
        edition,
        documentTitle || req.file.originalname
      );

      logger.info(`Created ACR analysis for job ${job.id} with acrId ${result.acrJob.id}`);

      res.status(201).json({
        success: true,
        data: {
          jobId: job.id,
          acrId: result.acrJob.id,
          acrJob: result.acrJob,
          criteriaCount: result.criteriaCount,
          auditResult,
        },
      });
    } catch (error) {
      logger.error('Error in createAnalysisWithUpload', error instanceof Error ? error : undefined);
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

  async getAcrJobByJobId(req: Request, res: Response, next: NextFunction) {
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

      // Look up AcrJob by its jobId field (which links to the ACR_WORKFLOW Job)
      const acrJob = await prisma.acrJob.findFirst({
        where: {
          jobId,
          tenantId,
        },
      });

      if (!acrJob) {
        res.status(404).json({
          success: false,
          error: { message: 'No ACR job found for this workflow job ID' }
        });
        return;
      }

      res.json({
        success: true,
        data: acrJob,
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
      const { conformanceLevel, remarks, reviewerNotes } = req.body;

      logger.debug('[ACR] Updating criterion', { 
        acrJobId, 
        criterionId, 
        conformanceLevel,
        hasRemarks: !!remarks,
        hasReviewerNotes: !!reviewerNotes
      });

      let normalizedLevel: 'supports' | 'partially_supports' | 'does_not_support' | 'not_applicable' | undefined;
      
      if (conformanceLevel) {
        normalizedLevel = conformanceLevel.toLowerCase().replace(/\s+/g, '_') as typeof normalizedLevel;
        const validLevels = ['supports', 'partially_supports', 'does_not_support', 'not_applicable'];
        if (!validLevels.includes(normalizedLevel!)) {
          res.status(400).json({
            success: false,
            error: {
              message: `Invalid conformanceLevel. Must be one of: ${validLevels.join(', ')}`,
              code: 'INVALID_CONFORMANCE_LEVEL',
            },
          });
          return;
        }
      }

      const remarksValue = remarks || reviewerNotes;
      
      if (!conformanceLevel && !remarksValue) {
        res.status(400).json({
          success: false,
          error: {
            message: 'Either conformanceLevel or remarks is required',
            code: 'INVALID_REQUEST',
          },
        });
        return;
      }

      const result = await acrService.saveCriterionReview(
        acrJobId,
        criterionId,
        userId,
        tenantId,
        { conformanceLevel: normalizedLevel, remarks: remarksValue }
      );

      // Create version after successful criterion update
      try {
        const latestVersion = await acrVersioningService.getLatestVersion(acrJobId);
        if (latestVersion) {
          // Update the criterion in the snapshot - match by c.id OR c.criterionId
          const updatedCriteria = latestVersion.snapshot.criteria.map(c => {
            const isMatch = c.id === criterionId || c.criterionId === criterionId;
            if (!isMatch) return c;
            return { 
              ...c, 
              conformanceLevel: normalizedLevel ? (
                normalizedLevel === 'supports' ? 'Supports' :
                normalizedLevel === 'partially_supports' ? 'Partially Supports' :
                normalizedLevel === 'does_not_support' ? 'Does Not Support' :
                'Not Applicable'
              ) as 'Supports' | 'Partially Supports' | 'Does Not Support' | 'Not Applicable' : c.conformanceLevel,
              remarks: remarksValue || c.remarks,
              attributionTag: 'HUMAN_VERIFIED' as const,
              attributedRemarks: `[HUMAN-VERIFIED] ${remarksValue || c.remarks}`,
            };
          });
          
          const updatedAcrDocument = {
            ...latestVersion.snapshot,
            criteria: updatedCriteria,
          };

          await acrVersioningService.createVersion(
            acrJobId,
            updatedAcrDocument,
            userId,
            `Updated criterion ${criterionId}`
          );
          logger.info(`Created version for ACR ${acrJobId} after user update`);
        }
      } catch (versionError) {
        logger.error(`Failed to create version for ACR ${acrJobId}`, versionError instanceof Error ? versionError : undefined);
        // Don't throw - version creation failure shouldn't stop update
      }

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

      // Create version after successful bulk update
      try {
        const latestVersion = await acrVersioningService.getLatestVersion(acrJobId);
        if (latestVersion) {
          const reviewMap = new Map(reviews.map((r: { criterionId: string; conformanceLevel?: string; remarks?: string }) => [r.criterionId, r]));
          
          const updatedCriteria = latestVersion.snapshot.criteria.map(c => {
            // Match by c.id OR c.criterionId for dual-key lookup
            const review = (reviewMap.get(c.id) || reviewMap.get(c.criterionId)) as { conformanceLevel?: string; remarks?: string } | undefined;
            if (!review) return c;
            
            const normalizedLevel = review.conformanceLevel?.toLowerCase().replace(/\s+/g, '_');
            return {
              ...c,
              conformanceLevel: normalizedLevel ? (
                normalizedLevel === 'supports' ? 'Supports' :
                normalizedLevel === 'partially_supports' ? 'Partially Supports' :
                normalizedLevel === 'does_not_support' ? 'Does Not Support' :
                'Not Applicable'
              ) as 'Supports' | 'Partially Supports' | 'Does Not Support' | 'Not Applicable' : c.conformanceLevel,
              remarks: review.remarks || c.remarks,
              attributionTag: 'HUMAN_VERIFIED' as const,
              attributedRemarks: `[HUMAN-VERIFIED] ${review.remarks || c.remarks}`,
            };
          });
          
          const updatedAcrDocument = {
            ...latestVersion.snapshot,
            criteria: updatedCriteria,
          };

          await acrVersioningService.createVersion(
            acrJobId,
            updatedAcrDocument,
            userId,
            `Updated ${reviews.length} criteria`
          );
          logger.info(`Created version for ACR ${acrJobId} after bulk update`);
        }
      } catch (versionError) {
        logger.error(`Failed to create version for ACR ${acrJobId}`, versionError instanceof Error ? versionError : undefined);
        // Don't throw - version creation failure shouldn't stop update
      }

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

  async getCriterionGuidance(_req: Request, res: Response) {
    try {
      const guidance = {
        '1.1.1': {
          intent: 'The intent of this Success Criterion is to make information conveyed by non-text content accessible through the use of a text alternative. Text alternatives are a primary way for making information accessible because they can be rendered through any sensory modality (for example, visual, auditory or tactile) to match the needs of the user.',
          whoBenefits: [
            'Screen reader users can access descriptions of images, charts, and other visual content',
            'Users with cognitive disabilities benefit from text descriptions that explain complex images',
            'Text alternatives can be translated into other languages or presented in different modalities'
          ],
          commonIssues: [
            'Missing alt attributes on images',
            'Generic alt text like "image" or "photo"',
            'Decorative images not marked with empty alt text',
            'Complex images (charts, diagrams) lacking adequate descriptions',
            'Alt text duplicating nearby caption text'
          ],
          testingSteps: [
            'Inspect all <img> elements in the EPUB content',
            'Verify each image has an alt attribute',
            'Check that alt text is descriptive and meaningful',
            'Confirm decorative images use alt=""',
            'Test with screen reader to verify alt text is announced'
          ],
          successIndicators: [
            'All images have alt attributes',
            'Alt text conveys the same information as the image',
            'Decorative images properly marked',
            'Complex images have extended descriptions (longdesc or aria-describedby)'
          ],
          remediationSteps: [
            'Add alt attributes to all <img> elements',
            'Write descriptive alt text that conveys the image purpose',
            'Use alt="" for purely decorative images',
            'Provide extended descriptions for complex images',
            'Avoid redundant alt text that duplicates nearby text'
          ],
          bestPractices: [
            'Keep alt text concise (under 150 characters)',
            'Describe the content and function, not just appearance',
            'Don\'t include "image of" or "picture of" in alt text',
            'Use surrounding context to inform alt text',
            'Test with actual screen reader users when possible'
          ]
        },
      };

      res.json({
        success: true,
        data: guidance
      });
    } catch {
      res.status(500).json({
        success: false,
        error: 'Failed to fetch criterion guidance'
      });
    }
  }

  async finalizeAcr(req: Request, res: Response) {
    try {
      const { jobId } = req.params;

      const acrJob = await acrService.resolveAcrJob(jobId);
      if (!acrJob) {
        return res.status(404).json({
          success: false,
          error: 'ACR job not found',
        });
      }

      await acrService.updateAcrJobStatus(acrJob.id, 'finalized');

      return res.json({
        success: true,
        data: {
          id: acrJob.id,
          status: 'finalized',
          finalizedAt: new Date().toISOString(),
        },
        message: 'ACR successfully finalized',
      });
    } catch (error) {
      logger.error('Failed to finalize ACR', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: 'Failed to finalize ACR',
      });
    }
  }

  async generateBatchAcr(req: Request, res: Response) {
    try {
      const { batchId, mode, options } = req.body;
      const tenantId = req.user!.tenantId;
      const userId = req.user!.id;

      logger.info(`[Batch ACR] Generating ${mode} ACR for batch ${batchId}`);

      const result = await batchAcrGeneratorService.generateBatchAcr(
        batchId,
        tenantId,
        userId,
        mode,
        options
      );

      return res.status(201).json({
        success: true,
        data: result,
      });
    } catch (error) {
      logger.error('[Batch ACR] Generation failed', error instanceof Error ? error : undefined);
      
      let statusCode = 500;
      let errorCode = 'BATCH_ACR_GENERATION_FAILED';
      
      if (error instanceof BatchNotFoundError) {
        statusCode = 404;
        errorCode = 'BATCH_NOT_FOUND';
      } else if (error instanceof TenantMismatchError) {
        statusCode = 403;
        errorCode = 'TENANT_MISMATCH';
      } else if (error instanceof IncompleteBatchError) {
        statusCode = 400;
        errorCode = 'INCOMPLETE_BATCH';
      } else if (error instanceof InvalidAcrOptionsError) {
        statusCode = 400;
        errorCode = 'INVALID_ACR_OPTIONS';
      }
      
      return res.status(statusCode).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to generate batch ACR',
          code: errorCode,
        },
      });
    }
  }

  async getBatchAcr(req: Request, res: Response) {
    try {
      const { batchAcrId } = req.params;
      const tenantId = req.user!.tenantId;

      const acrJob = await prisma.job.findFirst({
        where: {
          id: batchAcrId,
          tenantId,
          type: 'ACR_WORKFLOW',
          isBatchAcr: true,
        },
      });

      if (!acrJob) {
        return res.status(404).json({
          success: false,
          error: {
            message: 'Batch ACR not found',
            code: 'BATCH_ACR_NOT_FOUND',
          },
        });
      }

      return res.json({
        success: true,
        data: {
          acrDocument: acrJob.output,
          metadata: {
            id: acrJob.id,
            status: acrJob.status,
            createdAt: acrJob.createdAt,
            completedAt: acrJob.completedAt,
            sourceJobIds: acrJob.batchSourceJobIds,
          },
        },
      });
    } catch (error) {
      logger.error('[Batch ACR] Retrieval failed', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to retrieve batch ACR',
          code: 'BATCH_ACR_RETRIEVAL_FAILED',
        },
      });
    }
  }

  async exportBatchAcr(req: Request, res: Response) {
    try {
      const { batchAcrId } = req.params;
      const { format, includeMethodology } = req.body;
      const tenantId = req.user!.tenantId;
      const userId = req.user!.id;

      const acrJob = await prisma.job.findFirst({
        where: {
          id: batchAcrId,
          tenantId,
          type: 'ACR_WORKFLOW',
          isBatchAcr: true,
        },
      });

      if (!acrJob) {
        return res.status(404).json({
          success: false,
          error: {
            message: 'Batch ACR not found',
            code: 'BATCH_ACR_NOT_FOUND',
          },
        });
      }

      const acrJobRecord = await prisma.acrJob.findFirst({
        where: { 
          jobId: batchAcrId,
          tenantId,
          userId,
        },
        include: { criteria: true },
      });

      if (!acrJobRecord) {
        return res.status(404).json({
          success: false,
          error: {
            message: 'ACR job record not found',
            code: 'ACR_JOB_NOT_FOUND',
          },
        });
      }

      const jobOutput = acrJob.output as Record<string, unknown> | null;
      const documentTitle = (jobOutput?.documentTitle as string) || 
                           (jobOutput?.batchName as string) ||
                           'Batch ACR Document';

      const conformanceLevelMap: Record<string, AcrCriterion['conformanceLevel']> = {
        'supports': 'Supports',
        'partially_supports': 'Partially Supports',
        'does_not_support': 'Does Not Support',
        'not_applicable': 'Not Applicable',
        'Supports': 'Supports',
        'Partially Supports': 'Partially Supports',
        'Does Not Support': 'Does Not Support',
        'Not Applicable': 'Not Applicable',
        'Not Evaluated': 'Not Applicable'
      };

      const criteria: AcrCriterion[] = acrJobRecord.criteria.map((review) => {
        const rawConformance = review.conformanceLevel || 'Not Applicable';
        const conformanceLevel = conformanceLevelMap[rawConformance] || 'Not Applicable';
        const level = (review.level as 'A' | 'AA' | 'AAA') || 'A';
        const remarks = review.reviewerNotes || '';
        const isHumanVerified = !!review.reviewedBy;
        const tag = isHumanVerified ? '[HUMAN-VERIFIED]' : '[AI-SUGGESTED]';
        const attributedRemarks = remarks ? `${tag} ${remarks.trim()}` : '';

        return {
          id: review.criterionId,
          criterionId: review.criterionId,
          name: review.criterionName,
          level,
          conformanceLevel,
          remarks: remarks.trim(),
          attributionTag: isHumanVerified ? 'HUMAN_VERIFIED' as const : 'AI_SUGGESTED' as const,
          attributedRemarks
        };
      });

      const acrDocument: AcrDocument = {
        id: acrJobRecord.id,
        edition: (acrJobRecord.edition || 'VPAT2.5-INT') as AcrEdition,
        productInfo: {
          name: documentTitle,
          version: '1.0.0',
          description: 'Batch Accessibility Conformance Report',
          vendor: (jobOutput?.vendor as string) || 'S4Carlisle',
          contactEmail: (jobOutput?.contactEmail as string) || 'accessibility@s4carlisle.com',
          evaluationDate: acrJob.createdAt,
        },
        evaluationMethods: [
          { type: 'hybrid', tools: ['Ninja Platform v1.0', 'Ace by DAISY'], aiModels: ['Google Gemini'], description: 'Human verification and AI-assisted analysis' }
        ],
        criteria,
        generatedAt: new Date(),
        version: 1,
        status: acrJobRecord.status === 'completed' ? 'final' : 'draft',
        methodology: includeMethodology ? {
          assessmentDate: acrJob.createdAt,
          toolVersion: TOOL_VERSION,
          aiModelInfo: `${AI_MODEL_INFO.name} (${AI_MODEL_INFO.purpose})`,
          disclaimer: LEGAL_DISCLAIMER
        } : undefined,
        footerDisclaimer: LEGAL_DISCLAIMER
      };

      const exportOptions: ExportOptions = {
        format: format as ExportFormat,
        includeMethodology: includeMethodology ?? true,
        includeAttribution: true,
      };

      const exportResult = await acrExporterService.exportAcr(acrDocument, exportOptions);

      const fs = await import('fs/promises');
      const path = await import('path');
      const EXPORTS_DIR = path.join(process.cwd(), 'exports');
      const filepath = path.join(EXPORTS_DIR, exportResult.filename);
      const fileBuffer = await fs.readFile(filepath);
      const base64Content = fileBuffer.toString('base64');

      return res.json({
        success: true,
        data: {
          ...exportResult,
          content: base64Content,
        },
      });
    } catch (error) {
      logger.error('[Batch ACR] Export failed', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to export batch ACR',
          code: 'BATCH_ACR_EXPORT_FAILED',
        },
      });
    }
  }

  async getBatchAcrHistory(req: Request, res: Response) {
    try {
      const { batchId } = req.params;
      const tenantId = req.user!.tenantId;

      const batchJob = await prisma.job.findFirst({
        where: {
          id: batchId,
          tenantId,
          type: 'BATCH_VALIDATION',
        },
      });

      if (!batchJob) {
        return res.status(404).json({
          success: false,
          error: {
            message: 'Batch not found',
            code: 'BATCH_NOT_FOUND',
          },
        });
      }

      const output = batchJob.output as Record<string, unknown> | null;
      const history = (output?.acrGenerationHistory as unknown[]) || [];

      return res.json({
        success: true,
        data: {
          history,
          currentAcr: {
            generated: (output?.acrGenerated as boolean) || false,
            mode: output?.acrMode as string | undefined,
            workflowIds: (output?.acrWorkflowIds as string[]) || [],
            generatedAt: output?.acrGeneratedAt as string | undefined,
          },
        },
      });
    } catch (error) {
      logger.error('[Batch ACR] History retrieval failed', error instanceof Error ? error : undefined);
      return res.status(500).json({
        success: false,
        error: {
          message: error instanceof Error ? error.message : 'Failed to retrieve ACR history',
          code: 'BATCH_ACR_HISTORY_FAILED',
        },
      });
    }
  }
}

export const acrController = new AcrController();
