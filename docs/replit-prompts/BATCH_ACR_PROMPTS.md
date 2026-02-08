# Batch ACR/VPAT Generation - Replit Implementation Prompts

**Project:** Ninja Platform - Batch ACR/VPAT Feature
**Date:** January 21, 2026

This document contains detailed Replit prompts for implementing the Batch ACR/VPAT feature, organized by backend and frontend tasks.

---

## Table of Contents

- [Backend Prompts](#backend-prompts)
  - [Prompt 1: Database Schema & Type Definitions](#backend-prompt-1-database-schema--type-definitions)
  - [Prompt 2: Batch ACR Generator Service (Individual Mode)](#backend-prompt-2-batch-acr-generator-service-individual-mode)
  - [Prompt 3: Batch ACR Generator Service (Aggregate Mode)](#backend-prompt-3-batch-acr-generator-service-aggregate-mode)
  - [Prompt 4: API Routes & Controller](#backend-prompt-4-api-routes--controller)
  - [Prompt 5: Batch Remediation Service Extension](#backend-prompt-5-batch-remediation-service-extension)
  - [Prompt 6: Testing](#backend-prompt-6-testing)

- [Frontend Prompts](#frontend-prompts)
  - [Prompt 1: API Service & React Query Hooks](#frontend-prompt-1-api-service--react-query-hooks)
  - [Prompt 2: Batch ACR Configuration Modal](#frontend-prompt-2-batch-acr-configuration-modal)
  - [Prompt 3: Individual ACR List Component](#frontend-prompt-3-individual-acr-list-component)
  - [Prompt 4: Aggregate ACR Viewer Components](#frontend-prompt-4-aggregate-acr-viewer-components)
  - [Prompt 5: Batch Remediation Page Integration](#frontend-prompt-5-batch-remediation-page-integration)
  - [Prompt 6: Routing & Navigation](#frontend-prompt-6-routing--navigation)

---

# Backend Prompts

## Backend Prompt 1: Database Schema & Type Definitions

```
Context:
I'm working on the Ninja Backend (Node.js/Express/TypeScript/Prisma/PostgreSQL) to implement Batch ACR/VPAT generation. The system currently supports individual ACR workflows for single EPUB files. We need to extend the schema and create type definitions to support batch ACR generation in two modes: individual (1 ACR per EPUB) and aggregate (1 ACR for all EPUBs).

Task:
Implement database schema changes and TypeScript type definitions for batch ACR support.

Requirements:

1. Database Schema Updates (prisma/schema.prisma):
   - Extend the Job model with two new fields:
     * batchSourceJobIds  String[]  // Array of job IDs if this is a batch ACR
     * isBatchAcr         Boolean   @default(false)
   - Run migration: npx prisma migrate dev --name add-batch-acr-fields
   - Generate Prisma client: npx prisma generate

2. Create Type Definitions (src/types/batch-acr.types.ts):

   interface BatchAcrOptions {
     edition: 'VPAT2.5-508' | 'VPAT2.5-WCAG' | 'VPAT2.5-EU' | 'VPAT2.5-INT';
     batchName: string;
     vendor: string;
     contactEmail: string;
     aggregationStrategy: 'conservative' | 'optimistic';
   }

   interface BatchAcrGenerationRequest {
     batchId: string;
     mode: 'individual' | 'aggregate';
     options?: BatchAcrOptions;  // Required for aggregate mode
   }

   interface IndividualAcrGenerationResult {
     mode: 'individual';
     acrWorkflowIds: string[];
     totalAcrs: number;
     message: string;
   }

   interface AggregateAcrGenerationResult {
     mode: 'aggregate';
     acrWorkflowId: string;
     totalDocuments: number;
     totalCriteria: number;
     message: string;
   }

   type BatchAcrGenerationResult = IndividualAcrGenerationResult | AggregateAcrGenerationResult;

   interface AggregateAcrDocument extends AcrDocument {
     batchInfo: {
       isBatch: true;
       totalDocuments: number;
       documentList: Array<{
         fileName: string;
         jobId: string;
       }>;
       aggregationStrategy: 'conservative' | 'optimistic';
       sourceJobIds: string[];
     };
   }

   interface AggregateAcrCriterion {
     criterionId: string;
     criterionName: string;
     level: 'A' | 'AA' | 'AAA';
     conformanceLevel: ConformanceLevel;
     remarks: string;
     perEpubDetails: Array<{
       fileName: string;
       jobId: string;
       status: ConformanceLevel;
       issueCount: number;
       issues?: Array<{
         code: string;
         message: string;
         location?: string;
       }>;
     }>;
   }

   type ConformanceLevel = 'Supports' | 'Partially Supports' | 'Does Not Support' | 'Not Applicable';

3. Extend BatchRemediationResult (src/services/epub/batch-remediation.service.ts):
   - Add optional fields to BatchRemediationResult interface:
     * acrGenerated?: boolean;
     * acrMode?: 'individual' | 'aggregate';
     * acrWorkflowIds?: string[];
     * acrGeneratedAt?: string;
     * acrGenerationHistory?: Array<{
         mode: 'individual' | 'aggregate';
         acrWorkflowIds: string[];
         generatedAt: string;
         generatedBy: string;
       }>;

4. Error Handling:
   - Create custom error types for batch ACR operations
   - BatchNotFoundError
   - IncompleteBatchError
   - TenantMismatchError
   - InvalidAcrOptionsError

File Locations:
- Schema: prisma/schema.prisma
- Types: src/types/batch-acr.types.ts
- Batch service: src/services/epub/batch-remediation.service.ts

Follow existing code patterns from src/types/acr.types.ts and src/services/epub/batch-remediation.service.ts.
```

---

## Backend Prompt 2: Batch ACR Generator Service (Individual Mode)

```
Context:
Continuing Batch ACR implementation in Ninja Backend. Database schema and types are now complete. I need to implement the Batch ACR Generator Service, starting with individual mode (1 ACR per EPUB).

Task:
Create the BatchAcrGeneratorService with individual ACR generation capability.

Requirements:

1. Create Service (src/services/acr/batch-acr-generator.service.ts):

   import prisma from '../../lib/prisma';
   import { logger } from '../../lib/logger';
   import { remediationService } from '../epub/remediation.service';
   import { batchRemediationService } from '../epub/batch-remediation.service';
   import type {
     BatchAcrOptions,
     BatchAcrGenerationResult,
     IndividualAcrGenerationResult,
   } from '../../types/batch-acr.types';

   class BatchAcrGeneratorService {
     async generateBatchAcr(
       batchId: string,
       tenantId: string,
       userId: string,
       mode: 'individual' | 'aggregate',
       options?: BatchAcrOptions
     ): Promise<BatchAcrGenerationResult> {
       // Validate batch exists and belongs to tenant
       // Check batch status is 'completed'
       // Route to individual or aggregate method
     }

     async generateIndividualAcrs(
       batchId: string,
       tenantId: string,
       userId: string
     ): Promise<IndividualAcrGenerationResult> {
       // 1. Fetch batch status
       const batch = await batchRemediationService.getBatchStatus(batchId, tenantId);
       if (!batch) throw new Error('Batch not found');

       // 2. Filter only successful jobs
       const successfulJobs = batch.jobs.filter(j => j.status === 'completed');

       if (successfulJobs.length === 0) {
         throw new Error('No successful jobs to generate ACRs from');
       }

       // 3. For each successful job, create ACR workflow
       const acrWorkflowIds: string[] = [];

       for (const job of successfulJobs) {
         try {
           const result = await remediationService.transferToAcr(job.jobId);
           acrWorkflowIds.push(result.acrWorkflowId);
           logger.info(`Created ACR workflow ${result.acrWorkflowId} for job ${job.jobId}`);
         } catch (error) {
           logger.error(`Failed to create ACR for job ${job.jobId}:`, error);
           // Continue with other jobs even if one fails
         }
       }

       // 4. Update batch metadata with ACR info
       await this.updateBatchAcrMetadata(batchId, {
         acrGenerated: true,
         acrMode: 'individual',
         acrWorkflowIds,
         acrGeneratedAt: new Date().toISOString(),
       });

       // 5. Return result
       return {
         mode: 'individual',
         acrWorkflowIds,
         totalAcrs: acrWorkflowIds.length,
         message: `Created ${acrWorkflowIds.length} ACR workflows`,
       };
     }

     private async updateBatchAcrMetadata(
       batchId: string,
       metadata: {
         acrGenerated: boolean;
         acrMode: 'individual' | 'aggregate';
         acrWorkflowIds: string[];
         acrGeneratedAt: string;
       }
     ): Promise<void> {
       // Fetch current batch job
       const batchJob = await prisma.job.findUnique({
         where: { id: batchId },
       });

       if (!batchJob || !batchJob.output) {
         throw new Error('Batch job not found');
       }

       // Update output with ACR metadata
       const currentOutput = batchJob.output as Record<string, unknown>;
       const history = (currentOutput.acrGenerationHistory as any[]) || [];

       const updatedOutput = {
         ...currentOutput,
         ...metadata,
         acrGenerationHistory: [
           ...history,
           {
             mode: metadata.acrMode,
             acrWorkflowIds: metadata.acrWorkflowIds,
             generatedAt: metadata.acrGeneratedAt,
           },
         ],
       };

       await prisma.job.update({
         where: { id: batchId },
         data: { output: updatedOutput as any },
       });
     }
   }

   export const batchAcrGeneratorService = new BatchAcrGeneratorService();

2. Error Handling:
   - Validate batch exists and belongs to tenant
   - Check batch status is 'completed' before generating ACRs
   - Handle individual job ACR creation failures gracefully (log and continue)
   - Return partial success if some ACRs fail to generate

3. Logging:
   - Log start of ACR generation
   - Log each ACR creation success/failure
   - Log final result with count

File Location:
- src/services/acr/batch-acr-generator.service.ts

Follow existing patterns from:
- src/services/epub/remediation.service.ts (transferToAcr method)
- src/services/epub/batch-remediation.service.ts
```

---

## Backend Prompt 3: Batch ACR Generator Service (Aggregate Mode)

```
Context:
Continuing Batch ACR implementation. Individual mode is complete. Now implementing aggregate mode where a single ACR is generated for all EPUBs in the batch with aggregated conformance levels and composite remarks.

Task:
Extend BatchAcrGeneratorService with aggregate ACR generation capability.

Requirements:

1. Add Aggregate Generation Method (src/services/acr/batch-acr-generator.service.ts):

   async generateAggregateAcr(
     batchId: string,
     tenantId: string,
     userId: string,
     options: BatchAcrOptions
   ): Promise<AggregateAcrGenerationResult> {
     // 1. Validate options
     if (!options.batchName || !options.vendor || !options.contactEmail || !options.edition) {
       throw new Error('Missing required options for aggregate ACR');
     }

     // 2. Fetch batch and successful jobs
     const batch = await batchRemediationService.getBatchStatus(batchId, tenantId);
     if (!batch) throw new Error('Batch not found');

     const successfulJobs = batch.jobs.filter(j => j.status === 'completed');
     if (successfulJobs.length === 0) {
       throw new Error('No successful jobs to generate aggregate ACR from');
     }

     // 3. Fetch remediation plans for all successful jobs
     const jobPlans = await Promise.all(
       successfulJobs.map(async (job) => {
         const plan = await remediationService.getRemediationPlan(job.jobId);
         return { jobId: job.jobId, fileName: job.fileName, plan };
       })
     );

     // 4. Extract pending tasks (unresolved issues) from all jobs
     const allPendingTasks = jobPlans.flatMap(({ jobId, fileName, plan }) => {
       if (!plan) return [];
       const pendingTasks = plan.tasks.filter(t => t.status === 'pending');
       return pendingTasks.map(task => ({
         ...task,
         jobId,
         fileName,
       }));
     });

     // 5. Group tasks by WCAG criterion
     const criteriaMap = new Map<string, any[]>();
     for (const task of allPendingTasks) {
       const wcagCriteria = Array.isArray(task.wcagCriteria)
         ? task.wcagCriteria
         : task.wcagCriteria ? [task.wcagCriteria] : [];

       for (const criterion of wcagCriteria) {
         if (!criteriaMap.has(criterion)) {
           criteriaMap.set(criterion, []);
         }
         criteriaMap.get(criterion)!.push(task);
       }
     }

     // 6. For each WCAG criterion, aggregate conformance
     const aggregateCriteria: any[] = [];

     for (const [criterionId, tasks] of criteriaMap.entries()) {
       // Group tasks by job
       const tasksByJob = new Map<string, any[]>();
       for (const task of tasks) {
         if (!tasksByJob.has(task.jobId)) {
           tasksByJob.set(task.jobId, []);
         }
         tasksByJob.get(task.jobId)!.push(task);
       }

       // Build per-EPUB details
       const perEpubDetails = successfulJobs.map(job => {
         const jobTasks = tasksByJob.get(job.jobId) || [];
         const issueCount = jobTasks.length;

         return {
           fileName: job.fileName,
           jobId: job.jobId,
           status: issueCount === 0 ? 'Supports' : 'Does Not Support',
           issueCount,
           issues: jobTasks.map(t => ({
             code: t.issueCode,
             message: t.issueMessage,
             location: t.location,
           })),
         };
       });

       // Aggregate conformance level
       const conformanceLevel = this.aggregateConformance(
         criterionId,
         perEpubDetails,
         options.aggregationStrategy
       );

       // Generate composite remarks
       const remarks = this.generateCompositeRemarks(criterionId, perEpubDetails);

       aggregateCriteria.push({
         criterionId,
         criterionName: `WCAG ${criterionId}`,
         level: this.getWcagLevel(criterionId),
         conformanceLevel,
         remarks,
         perEpubDetails,
       });
     }

     // 7. Create aggregate ACR document structure
     const acrDocument = {
       sourceJobId: batchId,
       fileName: options.batchName,
       epubTitle: options.batchName,
       status: 'needs_verification',
       sourceType: 'batch_remediation',
       totalCriteria: aggregateCriteria.length,
       verifiedCount: 0,
       criteria: aggregateCriteria,
       batchInfo: {
         isBatch: true,
         totalDocuments: successfulJobs.length,
         documentList: successfulJobs.map(j => ({
           fileName: j.fileName,
           jobId: j.jobId,
         })),
         aggregationStrategy: options.aggregationStrategy,
         sourceJobIds: successfulJobs.map(j => j.jobId),
       },
       productInfo: {
         name: options.batchName,
         vendor: options.vendor,
         contactEmail: options.contactEmail,
         edition: options.edition,
       },
       createdAt: new Date(),
       updatedAt: new Date(),
     };

     // 8. Create ACR_WORKFLOW job
     const acrJob = await prisma.job.create({
       data: {
         tenantId,
         userId,
         type: 'ACR_WORKFLOW',
         status: 'PROCESSING',
         input: {
           sourceJobId: batchId,
           sourceType: 'batch_remediation',
           mode: 'aggregate',
         },
         output: acrDocument,
         startedAt: new Date(),
         batchSourceJobIds: successfulJobs.map(j => j.jobId),
         isBatchAcr: true,
       },
     });

     // 9. Create AcrJob record for UI
     const acrJobRecord = await prisma.acrJob.create({
       data: {
         jobId: acrJob.id,
         tenantId,
         userId,
         edition: options.edition,
         documentTitle: options.batchName,
         status: 'in_progress',
       },
     });

     // 10. Create AcrCriterionReview records for each criterion
     for (const criterion of aggregateCriteria) {
       await prisma.acrCriterionReview.create({
         data: {
           acrJobId: acrJobRecord.id,
           criterionId: criterion.criterionId,
           criterionNumber: criterion.criterionId,
           criterionName: criterion.criterionName,
           level: criterion.level,
           conformanceLevel: criterion.conformanceLevel,
           remarks: criterion.remarks,
           confidence: 50,
           aiStatus: 'needs_review',
         },
       });
     }

     // 11. Update batch metadata
     await this.updateBatchAcrMetadata(batchId, {
       acrGenerated: true,
       acrMode: 'aggregate',
       acrWorkflowIds: [acrJob.id],
       acrGeneratedAt: new Date().toISOString(),
     });

     // 12. Return result
     return {
       mode: 'aggregate',
       acrWorkflowId: acrJob.id,
       totalDocuments: successfulJobs.length,
       totalCriteria: aggregateCriteria.length,
       message: `Created aggregate ACR for ${successfulJobs.length} EPUBs`,
     };
   }

2. Implement Aggregation Methods:

   private aggregateConformance(
     criterionId: string,
     perEpubDetails: Array<{
       fileName: string;
       status: string;
       issueCount: number;
     }>,
     strategy: 'conservative' | 'optimistic'
   ): ConformanceLevel {
     if (strategy === 'conservative') {
       return this.aggregateConformanceConservative(perEpubDetails);
     } else {
       return this.aggregateConformanceOptimistic(perEpubDetails);
     }
   }

   private aggregateConformanceConservative(
     results: Array<{ status: string; issueCount: number }>
   ): ConformanceLevel {
     const allNotApplicable = results.every(r => r.status === 'Not Applicable');
     if (allNotApplicable) return 'Not Applicable';

     const hasDoesNotSupport = results.some(r => r.status === 'Does Not Support');
     if (hasDoesNotSupport) return 'Does Not Support';

     const hasPartiallySupports = results.some(r => r.status === 'Partially Supports');
     if (hasPartiallySupports) return 'Partially Supports';

     return 'Supports';
   }

   private aggregateConformanceOptimistic(
     results: Array<{ status: string; issueCount: number }>
   ): ConformanceLevel {
     const allNotApplicable = results.every(r => r.status === 'Not Applicable');
     if (allNotApplicable) return 'Not Applicable';

     const supportsCount = results.filter(r => r.status === 'Supports').length;
     const total = results.length;

     if (supportsCount === total) return 'Supports';
     if (supportsCount >= total * 0.5) return 'Partially Supports';

     return 'Does Not Support';
   }

   private generateCompositeRemarks(
     criterionId: string,
     perEpubDetails: Array<{
       fileName: string;
       issueCount: number;
       issues: Array<{ code: string; message: string }>;
     }>
   ): string {
     const supportsCount = perEpubDetails.filter(e => e.issueCount === 0).length;
     const total = perEpubDetails.length;
     const percentage = Math.round((supportsCount / total) * 100);

     let remarks = `${supportsCount} of ${total} EPUBs (${percentage}%) fully support this criterion.\n\n`;

     const failedEpubs = perEpubDetails.filter(e => e.issueCount > 0);

     if (failedEpubs.length > 0) {
       remarks += `EPUBs requiring attention:\n`;

       for (const epub of failedEpubs) {
         remarks += `\n- "${epub.fileName}" (${epub.issueCount} issue${epub.issueCount !== 1 ? 's' : ''})\n`;

         const issuesToShow = epub.issues.slice(0, 3);
         for (const issue of issuesToShow) {
           remarks += `  • ${issue.message}\n`;
         }

         if (epub.issues.length > 3) {
           remarks += `  • ... and ${epub.issues.length - 3} more\n`;
         }
       }
     }

     return remarks.trim();
   }

   private getWcagLevel(criterionId: string): 'A' | 'AA' | 'AAA' {
     // Simple heuristic - enhance as needed
     if (criterionId.startsWith('1.4.')) return 'AA';
     return 'A';
   }

File Location:
- src/services/acr/batch-acr-generator.service.ts

Follow patterns from:
- src/services/epub/remediation.service.ts (transferToAcr)
- src/services/acr/acr-generator.service.ts
```

---

## Backend Prompt 4: API Routes & Controller

```
Context:
Batch ACR Generator Service is complete with both individual and aggregate modes. Now creating API endpoints and controller methods to expose this functionality.

Task:
Create API routes and controller methods for batch ACR generation, retrieval, and export.

Requirements:

1. Create Routes (src/routes/acr.routes.ts):

   import { Router } from 'express';
   import { authenticate, authorize } from '../middleware/auth.middleware';
   import { validate } from '../middleware/validate.middleware';
   import { acrController } from '../controllers/acr.controller';
   import {
     batchAcrGenerateSchema,
     batchAcrExportSchema,
   } from '../schemas/acr.schemas';

   const router = Router();

   // ... existing ACR routes

   // Batch ACR routes
   router.post(
     '/batch/generate',
     authenticate,
     authorize('ADMIN', 'USER'),
     validate({ body: batchAcrGenerateSchema }),
     acrController.generateBatchAcr
   );

   router.get(
     '/batch/:batchAcrId',
     authenticate,
     acrController.getBatchAcr
   );

   router.post(
     '/batch/:batchAcrId/export',
     authenticate,
     validate({ body: batchAcrExportSchema }),
     acrController.exportBatchAcr
   );

   router.get(
     '/batch/:batchId/history',
     authenticate,
     acrController.getBatchAcrHistory
   );

   export default router;

2. Create Validation Schemas (src/schemas/acr.schemas.ts):

   import { z } from 'zod';

   export const batchAcrGenerateSchema = z.object({
     batchId: z.string().min(1, 'Batch ID is required'),
     mode: z.enum(['individual', 'aggregate'], {
       required_error: 'Mode is required',
       invalid_type_error: 'Mode must be individual or aggregate',
     }),
     options: z.object({
       edition: z.enum(['VPAT2.5-508', 'VPAT2.5-WCAG', 'VPAT2.5-EU', 'VPAT2.5-INT']),
       batchName: z.string().min(1, 'Batch name is required'),
       vendor: z.string().min(1, 'Vendor name is required'),
       contactEmail: z.string().email('Invalid email format'),
       aggregationStrategy: z.enum(['conservative', 'optimistic']),
     }).optional().refine((data, ctx) => {
       // Options required if mode is aggregate
       const parentData = ctx.path[0] as any;
       if (parentData?.mode === 'aggregate' && !data) {
         return false;
       }
       return true;
     }, {
       message: 'Options are required for aggregate mode',
     }),
   });

   export const batchAcrExportSchema = z.object({
     format: z.enum(['pdf', 'docx', 'html'], {
       required_error: 'Export format is required',
     }),
     includeMethodology: z.boolean().optional().default(true),
   });

3. Create Controller Methods (src/controllers/acr.controller.ts):

   import { Response } from 'express';
   import { AuthenticatedRequest } from '../types/auth.types';
   import { batchAcrGeneratorService } from '../services/acr/batch-acr-generator.service';
   import { logger } from '../lib/logger';

   // ... existing controller methods

   async generateBatchAcr(req: AuthenticatedRequest, res: Response) {
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
       logger.error('[Batch ACR] Generation failed', error);
       return res.status(500).json({
         success: false,
         error: {
           message: error instanceof Error ? error.message : 'Failed to generate batch ACR',
           code: 'BATCH_ACR_GENERATION_FAILED',
         },
       });
     }
   }

   async getBatchAcr(req: AuthenticatedRequest, res: Response) {
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
           },
         },
       });
     } catch (error) {
       logger.error('[Batch ACR] Retrieval failed', error);
       return res.status(500).json({
         success: false,
         error: {
           message: error instanceof Error ? error.message : 'Failed to retrieve batch ACR',
           code: 'BATCH_ACR_RETRIEVAL_FAILED',
         },
       });
     }
   }

   async exportBatchAcr(req: AuthenticatedRequest, res: Response) {
     try {
       const { batchAcrId } = req.params;
       const { format, includeMethodology } = req.body;
       const tenantId = req.user!.tenantId;

       // Reuse existing ACR export service
       const downloadUrl = await acrExporterService.exportAcr(
         batchAcrId,
         tenantId,
         format,
         { includeMethodology }
       );

       return res.json({
         success: true,
         data: {
           downloadUrl,
           format,
         },
       });
     } catch (error) {
       logger.error('[Batch ACR] Export failed', error);
       return res.status(500).json({
         success: false,
         error: {
           message: error instanceof Error ? error.message : 'Failed to export batch ACR',
           code: 'BATCH_ACR_EXPORT_FAILED',
         },
       });
     }
   }

   async getBatchAcrHistory(req: AuthenticatedRequest, res: Response) {
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

       const output = batchJob.output as any;
       const history = output?.acrGenerationHistory || [];

       return res.json({
         success: true,
         data: {
           history,
           currentAcr: {
             generated: output?.acrGenerated || false,
             mode: output?.acrMode,
             workflowIds: output?.acrWorkflowIds || [],
             generatedAt: output?.acrGeneratedAt,
           },
         },
       });
     } catch (error) {
       logger.error('[Batch ACR] History retrieval failed', error);
       return res.status(500).json({
         success: false,
         error: {
           message: error instanceof Error ? error.message : 'Failed to retrieve ACR history',
           code: 'BATCH_ACR_HISTORY_FAILED',
         },
       });
     }
   }

4. Error Handling:
   - 400 for validation errors
   - 404 for batch/ACR not found
   - 403 for tenant mismatch
   - 500 for server errors

File Locations:
- Routes: src/routes/acr.routes.ts
- Schemas: src/schemas/acr.schemas.ts
- Controller: src/controllers/acr.controller.ts

Follow patterns from:
- src/routes/epub.routes.ts
- src/controllers/epub.controller.ts
```

---

## Backend Prompt 5: Batch Remediation Service Extension

```
Context:
Batch ACR generation is complete. Now updating the Batch Remediation Service to display ACR metadata in batch results.

Task:
Extend BatchRemediationService to include ACR generation metadata in batch status responses.

Requirements:

1. Update getBatchStatus Method (src/services/epub/batch-remediation.service.ts):

   async getBatchStatus(batchId: string, tenantId: string): Promise<BatchRemediationResult | null> {
     // ... existing implementation

     // Ensure ACR metadata is included in response
     const rawOutput = batchJob.output as Record<string, unknown> | null;
     if (rawOutput) {
       // ACR metadata should already be in output from updateBatchAcrMetadata
       // Just ensure it's properly typed
       return {
         ...rawOutput,
         acrGenerated: rawOutput.acrGenerated as boolean | undefined,
         acrMode: rawOutput.acrMode as 'individual' | 'aggregate' | undefined,
         acrWorkflowIds: rawOutput.acrWorkflowIds as string[] | undefined,
         acrGeneratedAt: rawOutput.acrGeneratedAt as string | undefined,
         acrGenerationHistory: rawOutput.acrGenerationHistory as any[] | undefined,
       } as unknown as BatchRemediationResult;
     }

     return null;
   }

2. Update TypeScript Interface:
   - Ensure BatchRemediationResult interface includes ACR fields (should be done in Prompt 1)

3. No other changes needed:
   - updateBatchAcrMetadata is called by BatchAcrGeneratorService
   - Metadata is automatically included in subsequent getBatchStatus calls

File Location:
- src/services/epub/batch-remediation.service.ts

This is a minor update to ensure proper typing and metadata flow.
```

---

## Backend Prompt 6: Testing

```
Context:
All Batch ACR backend functionality is implemented. Now creating comprehensive tests.

Task:
Create unit and integration tests for batch ACR generation.

Requirements:

1. Unit Tests (src/services/acr/__tests__/batch-acr-generator.service.test.ts):

   import { describe, it, expect, beforeEach, vi } from 'vitest';
   import { batchAcrGeneratorService } from '../batch-acr-generator.service';
   import prisma from '../../../lib/prisma';

   describe('BatchAcrGeneratorService', () => {
     describe('aggregateConformanceConservative', () => {
       it('should return "Supports" when all EPUBs support', () => {
         const results = [
           { fileName: 'book1.epub', status: 'Supports', issueCount: 0 },
           { fileName: 'book2.epub', status: 'Supports', issueCount: 0 },
         ];
         // Call private method via type casting or make it public for testing
         // expect(...).toBe('Supports');
       });

       it('should return "Does Not Support" when any EPUB fails', () => {
         const results = [
           { fileName: 'book1.epub', status: 'Supports', issueCount: 0 },
           { fileName: 'book2.epub', status: 'Does Not Support', issueCount: 3 },
         ];
         // expect(...).toBe('Does Not Support');
       });
     });

     describe('aggregateConformanceOptimistic', () => {
       it('should return "Partially Supports" when majority pass', () => {
         const results = [
           { fileName: 'book1.epub', status: 'Supports', issueCount: 0 },
           { fileName: 'book2.epub', status: 'Supports', issueCount: 0 },
           { fileName: 'book3.epub', status: 'Does Not Support', issueCount: 3 },
         ];
         // expect(...).toBe('Partially Supports');
       });
     });

     describe('generateCompositeRemarks', () => {
       it('should format remarks with per-EPUB breakdown', () => {
         const details = [
           {
             fileName: 'book1.epub',
             issueCount: 0,
             issues: [],
           },
           {
             fileName: 'book2.epub',
             issueCount: 2,
             issues: [
               { code: 'EPUB-IMG-001', message: 'Missing alt text' },
               { code: 'EPUB-SEM-001', message: 'Missing semantic tag' },
             ],
           },
         ];
         const remarks = batchAcrGeneratorService['generateCompositeRemarks']('1.1.1', details);
         expect(remarks).toContain('1 of 2 EPUBs');
         expect(remarks).toContain('book2.epub');
         expect(remarks).toContain('Missing alt text');
       });
     });

     describe('generateIndividualAcrs', () => {
       it('should create ACR for each successful job', async () => {
         // Mock batch with 3 successful jobs
         // Mock remediationService.transferToAcr
         // Call generateIndividualAcrs
         // Expect 3 ACR workflows created
       });

       it('should exclude failed jobs', async () => {
         // Mock batch with 2 successful, 1 failed
         // Expect only 2 ACRs created
       });

       it('should throw error when no successful jobs', async () => {
         // Mock batch with all failed jobs
         // Expect error thrown
       });
     });

     describe('generateAggregateAcr', () => {
       it('should create single ACR with batch info', async () => {
         // Mock batch with multiple jobs
         // Call generateAggregateAcr with conservative strategy
         // Verify single ACR_WORKFLOW job created
         // Verify isBatchAcr = true
         // Verify batchSourceJobIds populated
       });

       it('should aggregate conformance conservatively', async () => {
         // Mock jobs with mixed conformance
         // Verify conservative aggregation applied
       });

       it('should aggregate conformance optimistically', async () => {
         // Mock jobs with mixed conformance
         // Verify optimistic aggregation applied
       });

       it('should throw error when missing required options', async () => {
         // Call without batchName
         // Expect error
       });
     });
   });

2. Integration Tests (src/controllers/__tests__/acr.controller.test.ts):

   import { describe, it, expect } from 'vitest';
   import request from 'supertest';
   import app from '../../app';

   describe('POST /api/v1/acr/batch/generate', () => {
     it('should generate individual ACRs with valid payload', async () => {
       const response = await request(app)
         .post('/api/v1/acr/batch/generate')
         .set('Authorization', `Bearer ${validToken}`)
         .send({
           batchId: 'batch-123',
           mode: 'individual',
         });

       expect(response.status).toBe(201);
       expect(response.body.success).toBe(true);
       expect(response.body.data.mode).toBe('individual');
       expect(response.body.data.acrWorkflowIds).toBeInstanceOf(Array);
     });

     it('should generate aggregate ACR with valid payload', async () => {
       const response = await request(app)
         .post('/api/v1/acr/batch/generate')
         .set('Authorization', `Bearer ${validToken}`)
         .send({
           batchId: 'batch-123',
           mode: 'aggregate',
           options: {
             edition: 'VPAT2.5-WCAG',
             batchName: 'Test Batch',
             vendor: 'Test Vendor',
             contactEmail: 'test@example.com',
             aggregationStrategy: 'conservative',
           },
         });

       expect(response.status).toBe(201);
       expect(response.body.success).toBe(true);
       expect(response.body.data.mode).toBe('aggregate');
       expect(response.body.data.acrWorkflowId).toBeDefined();
     });

     it('should return 400 when options missing for aggregate mode', async () => {
       const response = await request(app)
         .post('/api/v1/acr/batch/generate')
         .set('Authorization', `Bearer ${validToken}`)
         .send({
           batchId: 'batch-123',
           mode: 'aggregate',
           // Missing options
         });

       expect(response.status).toBe(400);
     });

     it('should return 404 when batch not found', async () => {
       const response = await request(app)
         .post('/api/v1/acr/batch/generate')
         .set('Authorization', `Bearer ${validToken}`)
         .send({
           batchId: 'nonexistent',
           mode: 'individual',
         });

       expect(response.status).toBe(404);
     });
   });

   describe('GET /api/v1/acr/batch/:batchAcrId', () => {
     it('should return batch ACR document', async () => {
       const response = await request(app)
         .get('/api/v1/acr/batch/acr-batch-123')
         .set('Authorization', `Bearer ${validToken}`);

       expect(response.status).toBe(200);
       expect(response.body.success).toBe(true);
       expect(response.body.data.acrDocument).toBeDefined();
     });
   });

3. Manual Testing Checklist:
   - [ ] Create batch with 5 EPUBs, all succeed
   - [ ] Generate individual ACRs → verify 5 ACRs created
   - [ ] Generate aggregate ACR (conservative) → verify single ACR
   - [ ] Generate aggregate ACR (optimistic) → verify different conformance levels
   - [ ] Test with batch where 2 jobs failed → verify only 3 ACRs created
   - [ ] Test with batch still processing → verify error
   - [ ] Test re-generation → verify history tracked
   - [ ] Export aggregate ACR to PDF → verify batch info included

File Locations:
- Unit tests: src/services/acr/__tests__/batch-acr-generator.service.test.ts
- Integration tests: src/controllers/__tests__/acr.controller.test.ts

Use Vitest as testing framework. Follow patterns from existing tests in src/**/__tests__/.
```

---

# Frontend Prompts

## Frontend Prompt 1: API Service & React Query Hooks

```
Context:
I'm working on the Ninja Frontend (React 18/TypeScript/React Query/Axios) to implement Batch ACR/VPAT generation UI. The backend APIs are ready. I need to create API service methods and React Query hooks to interact with the backend.

Task:
Create API service methods and React Query hooks for batch ACR generation, retrieval, and export.

Requirements:

1. Create Type Definitions (src/types/batch-acr.types.ts):

   export interface BatchAcrOptions {
     edition: 'VPAT2.5-508' | 'VPAT2.5-WCAG' | 'VPAT2.5-EU' | 'VPAT2.5-INT';
     batchName: string;
     vendor: string;
     contactEmail: string;
     aggregationStrategy: 'conservative' | 'optimistic';
   }

   export interface BatchAcrGenerationRequest {
     batchId: string;
     mode: 'individual' | 'aggregate';
     options?: BatchAcrOptions;
   }

   export interface IndividualAcrGenerationResult {
     mode: 'individual';
     acrWorkflowIds: string[];
     totalAcrs: number;
     message: string;
   }

   export interface AggregateAcrGenerationResult {
     mode: 'aggregate';
     acrWorkflowId: string;
     totalDocuments: number;
     totalCriteria: number;
     message: string;
   }

   export type BatchAcrGenerationResult =
     | IndividualAcrGenerationResult
     | AggregateAcrGenerationResult;

   export interface BatchAcrHistory {
     history: Array<{
       mode: 'individual' | 'aggregate';
       acrWorkflowIds: string[];
       generatedAt: string;
       generatedBy: string;
     }>;
     currentAcr: {
       generated: boolean;
       mode?: 'individual' | 'aggregate';
       workflowIds: string[];
       generatedAt?: string;
     };
   }

2. Add API Methods (src/services/acr.service.ts):

   import api from './api';
   import type {
     BatchAcrGenerationRequest,
     BatchAcrGenerationResult,
     BatchAcrHistory,
   } from '../types/batch-acr.types';

   // ... existing ACR service methods

   async generateBatchAcr(
     request: BatchAcrGenerationRequest
   ): Promise<BatchAcrGenerationResult> {
     const response = await api.post<{
       success: boolean;
       data: BatchAcrGenerationResult;
     }>('/acr/batch/generate', request);

     return response.data.data;
   }

   async getBatchAcr(batchAcrId: string): Promise<any> {
     const response = await api.get<{
       success: boolean;
       data: {
         acrDocument: any;
         metadata: any;
       };
     }>(`/acr/batch/${batchAcrId}`);

     return response.data.data;
   }

   async exportBatchAcr(
     batchAcrId: string,
     format: 'pdf' | 'docx' | 'html',
     includeMethodology: boolean = true
   ): Promise<{ downloadUrl: string; format: string }> {
     const response = await api.post<{
       success: boolean;
       data: { downloadUrl: string; format: string };
     }>(`/acr/batch/${batchAcrId}/export`, {
       format,
       includeMethodology,
     });

     return response.data.data;
   }

   async getBatchAcrHistory(batchId: string): Promise<BatchAcrHistory> {
     const response = await api.get<{
       success: boolean;
       data: BatchAcrHistory;
     }>(`/acr/batch/${batchId}/history`);

     return response.data.data;
   }

3. Create React Query Hooks (src/hooks/useBatchAcr.ts):

   import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
   import { acrService } from '../services/acr.service';
   import { toast } from 'react-hot-toast';
   import type {
     BatchAcrGenerationRequest,
     BatchAcrGenerationResult,
   } from '../types/batch-acr.types';

   export function useGenerateBatchAcr() {
     const queryClient = useQueryClient();

     return useMutation<BatchAcrGenerationResult, Error, BatchAcrGenerationRequest>({
       mutationFn: (request) => acrService.generateBatchAcr(request),
       onSuccess: (data, variables) => {
         // Invalidate batch query to refresh ACR metadata
         queryClient.invalidateQueries({ queryKey: ['batch', variables.batchId] });

         if (data.mode === 'individual') {
           toast.success(`Created ${data.totalAcrs} ACR workflows`);
         } else {
           toast.success(`Created aggregate ACR for ${data.totalDocuments} EPUBs`);
         }
       },
       onError: (error) => {
         toast.error(error.message || 'Failed to generate ACR');
       },
     });
   }

   export function useBatchAcr(batchAcrId: string | null) {
     return useQuery({
       queryKey: ['batchAcr', batchAcrId],
       queryFn: () => acrService.getBatchAcr(batchAcrId!),
       enabled: !!batchAcrId,
       staleTime: 5 * 60 * 1000, // 5 minutes
     });
   }

   export function useExportBatchAcr() {
     return useMutation<
       { downloadUrl: string; format: string },
       Error,
       { batchAcrId: string; format: 'pdf' | 'docx' | 'html'; includeMethodology?: boolean }
     >({
       mutationFn: ({ batchAcrId, format, includeMethodology }) =>
         acrService.exportBatchAcr(batchAcrId, format, includeMethodology),
       onSuccess: (data) => {
         // Open download URL
         window.open(data.downloadUrl, '_blank');
         toast.success(`Exporting ACR as ${data.format.toUpperCase()}...`);
       },
       onError: (error) => {
         toast.error(error.message || 'Failed to export ACR');
       },
     });
   }

   export function useBatchAcrHistory(batchId: string | null) {
     return useQuery({
       queryKey: ['batchAcrHistory', batchId],
       queryFn: () => acrService.getBatchAcrHistory(batchId!),
       enabled: !!batchId,
       staleTime: 1 * 60 * 1000, // 1 minute
     });
   }

4. Error Handling:
   - Display toast notifications for success/error
   - Invalidate queries to refresh UI after mutations
   - Handle loading and error states in components

File Locations:
- Types: src/types/batch-acr.types.ts
- Service: src/services/acr.service.ts
- Hooks: src/hooks/useBatchAcr.ts

Follow patterns from:
- src/services/jobs.service.ts
- src/hooks/useJobs.ts
```

---

## Frontend Prompt 2: Batch ACR Configuration Modal

```
Context:
Continuing Batch ACR frontend implementation. API service and hooks are ready. Now creating the modal that allows users to configure batch ACR generation (individual vs aggregate mode, batch details, aggregation strategy).

Task:
Create the BatchAcrConfigModal component with mode selection and configuration form.

Requirements:

1. Create Component (src/components/acr/BatchAcrConfigModal.tsx):

   import React, { useState, useEffect } from 'react';
   import { Dialog, DialogContent, DialogHeader, DialogTitle } from '../ui/Dialog';
   import { Button } from '../ui/Button';
   import { Input } from '../ui/Input';
   import { Label } from '../ui/Label';
   import { RadioGroup, RadioGroupItem } from '../ui/RadioGroup';
   import { Alert, AlertDescription } from '../ui/Alert';
   import { Info } from 'lucide-react';
   import type { BatchAcrOptions } from '../../types/batch-acr.types';

   interface BatchAcrConfigModalProps {
     isOpen: boolean;
     onClose: () => void;
     batchId: string;
     totalJobs: number;
     successfulJobs: number;
     failedJobs: number;
     onGenerate: (mode: 'individual' | 'aggregate', options?: BatchAcrOptions) => void;
   }

   export function BatchAcrConfigModal({
     isOpen,
     onClose,
     batchId,
     totalJobs,
     successfulJobs,
     failedJobs,
     onGenerate,
   }: BatchAcrConfigModalProps) {
     const [mode, setMode] = useState<'individual' | 'aggregate'>('aggregate');
     const [batchName, setBatchName] = useState('');
     const [vendor, setVendor] = useState('');
     const [contactEmail, setContactEmail] = useState('');
     const [edition, setEdition] = useState<BatchAcrOptions['edition']>('VPAT2.5-WCAG');
     const [aggregationStrategy, setAggregationStrategy] = useState<'conservative' | 'optimistic'>('conservative');
     const [errors, setErrors] = useState<Record<string, string>>({});

     // Auto-generate batch name
     useEffect(() => {
       const today = new Date().toISOString().split('T')[0];
       setBatchName(`Batch ${today} - ${successfulJobs} EPUBs`);
     }, [successfulJobs]);

     const validateForm = (): boolean => {
       const newErrors: Record<string, string> = {};

       if (mode === 'aggregate') {
         if (!batchName.trim()) {
           newErrors.batchName = 'Batch name is required';
         }
         if (!vendor.trim()) {
           newErrors.vendor = 'Vendor name is required';
         }
         if (!contactEmail.trim()) {
           newErrors.contactEmail = 'Contact email is required';
         } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) {
           newErrors.contactEmail = 'Invalid email format';
         }
       }

       setErrors(newErrors);
       return Object.keys(newErrors).length === 0;
     };

     const handleGenerate = () => {
       if (!validateForm()) return;

       if (mode === 'individual') {
         onGenerate('individual');
       } else {
         onGenerate('aggregate', {
           edition,
           batchName,
           vendor,
           contactEmail,
           aggregationStrategy,
         });
       }
     };

     return (
       <Dialog open={isOpen} onOpenChange={onClose}>
         <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
           <DialogHeader>
             <DialogTitle>Generate ACR/VPAT Report</DialogTitle>
           </DialogHeader>

           <div className="space-y-6">
             {/* Warning for failed jobs */}
             {failedJobs > 0 && (
               <Alert variant="warning">
                 <Info className="h-4 w-4" />
                 <AlertDescription>
                   {failedJobs} of {totalJobs} jobs failed and will be excluded from ACR generation.
                 </AlertDescription>
               </Alert>
             )}

             {/* Mode Selection */}
             <div className="space-y-4">
               <Label className="text-base font-semibold">Choose ACR Generation Mode:</Label>

               <RadioGroup value={mode} onValueChange={(value) => setMode(value as any)}>
                 {/* Individual Mode */}
                 <div className="border rounded-lg p-4 cursor-pointer hover:bg-gray-50">
                   <div className="flex items-start space-x-3">
                     <RadioGroupItem value="individual" id="individual" />
                     <div className="flex-1">
                       <Label htmlFor="individual" className="cursor-pointer font-medium">
                         Individual ACRs (1 per EPUB)
                       </Label>
                       <p className="text-sm text-gray-600 mt-1">
                         Generate separate ACR/VPAT for each EPUB.
                         <br />
                         <span className="font-medium">Best for:</span> Sharing individual reports
                         <br />
                         <span className="font-medium">Output:</span> {successfulJobs} separate ACR workflows
                       </p>
                     </div>
                   </div>
                 </div>

                 {/* Aggregate Mode */}
                 <div className="border rounded-lg p-4 cursor-pointer hover:bg-gray-50">
                   <div className="flex items-start space-x-3">
                     <RadioGroupItem value="aggregate" id="aggregate" />
                     <div className="flex-1">
                       <Label htmlFor="aggregate" className="cursor-pointer font-medium">
                         Aggregate ACR (1 for all EPUBs)
                       </Label>
                       <p className="text-sm text-gray-600 mt-1">
                         Generate single ACR/VPAT for the batch.
                         <br />
                         <span className="font-medium">Best for:</span> Procurement & compliance review
                         <br />
                         <span className="font-medium">Output:</span> 1 aggregate ACR workflow
                       </p>
                     </div>
                   </div>
                 </div>
               </RadioGroup>
             </div>

             {/* Aggregate Mode Configuration */}
             {mode === 'aggregate' && (
               <>
                 <div className="border-t pt-4 space-y-4">
                   <h3 className="font-semibold">Batch Information</h3>

                   <div className="space-y-2">
                     <Label htmlFor="batchName">
                       Batch Name <span className="text-red-500">*</span>
                     </Label>
                     <Input
                       id="batchName"
                       value={batchName}
                       onChange={(e) => setBatchName(e.target.value)}
                       placeholder="Q1 2026 EPUB Collection"
                     />
                     {errors.batchName && (
                       <p className="text-sm text-red-600">{errors.batchName}</p>
                     )}
                   </div>

                   <div className="space-y-2">
                     <Label htmlFor="vendor">
                       Vendor Name <span className="text-red-500">*</span>
                     </Label>
                     <Input
                       id="vendor"
                       value={vendor}
                       onChange={(e) => setVendor(e.target.value)}
                       placeholder="ACME Publishing"
                     />
                     {errors.vendor && <p className="text-sm text-red-600">{errors.vendor}</p>}
                   </div>

                   <div className="space-y-2">
                     <Label htmlFor="contactEmail">
                       Contact Email <span className="text-red-500">*</span>
                     </Label>
                     <Input
                       id="contactEmail"
                       type="email"
                       value={contactEmail}
                       onChange={(e) => setContactEmail(e.target.value)}
                       placeholder="a11y@acme.com"
                     />
                     {errors.contactEmail && (
                       <p className="text-sm text-red-600">{errors.contactEmail}</p>
                     )}
                   </div>

                   <div className="space-y-2">
                     <Label htmlFor="edition">VPAT Edition</Label>
                     <select
                       id="edition"
                       value={edition}
                       onChange={(e) => setEdition(e.target.value as any)}
                       className="w-full border rounded-md px-3 py-2"
                     >
                       <option value="VPAT2.5-WCAG">VPAT 2.5 WCAG</option>
                       <option value="VPAT2.5-508">VPAT 2.5 Section 508</option>
                       <option value="VPAT2.5-EU">VPAT 2.5 EU</option>
                       <option value="VPAT2.5-INT">VPAT 2.5 International</option>
                     </select>
                   </div>
                 </div>

                 <div className="border-t pt-4 space-y-4">
                   <Label className="text-base font-semibold">Aggregation Strategy:</Label>

                   <RadioGroup
                     value={aggregationStrategy}
                     onValueChange={(value) => setAggregationStrategy(value as any)}
                   >
                     <div className="border rounded-lg p-3">
                       <div className="flex items-start space-x-3">
                         <RadioGroupItem value="conservative" id="conservative" />
                         <div className="flex-1">
                           <Label htmlFor="conservative" className="cursor-pointer font-medium">
                             Conservative (Safer for compliance)
                           </Label>
                           <p className="text-sm text-gray-600 mt-1">
                             Any EPUB failure → "Does Not Support"
                           </p>
                         </div>
                       </div>
                     </div>

                     <div className="border rounded-lg p-3">
                       <div className="flex items-start space-x-3">
                         <RadioGroupItem value="optimistic" id="optimistic" />
                         <div className="flex-1">
                           <Label htmlFor="optimistic" className="cursor-pointer font-medium">
                             Optimistic (Shows progress)
                           </Label>
                           <p className="text-sm text-gray-600 mt-1">
                             Majority pass → "Partially Supports"
                           </p>
                         </div>
                       </div>
                     </div>
                   </RadioGroup>
                 </div>
               </>
             )}

             {/* Actions */}
             <div className="flex justify-end space-x-3 border-t pt-4">
               <Button variant="outline" onClick={onClose}>
                 Cancel
               </Button>
               <Button onClick={handleGenerate}>
                 Generate ACR{mode === 'individual' && 's'} →
               </Button>
             </div>
           </div>
         </DialogContent>
       </Dialog>
     );
   }

2. Styling:
   - Use Tailwind CSS with existing design system
   - Sky-blue primary color (#0ea5e9)
   - Clear visual hierarchy for mode selection
   - Red asterisk for required fields
   - Warning styling for failed jobs alert

3. Validation:
   - Client-side validation for required fields
   - Email format validation
   - Show inline error messages

File Location:
- src/components/acr/BatchAcrConfigModal.tsx

Follow patterns from:
- src/components/ui/Dialog.tsx
- src/components/ui/Button.tsx
- Existing modal components in src/components/
```

---

## Frontend Prompt 3: Individual ACR List Component

```
Context:
Batch ACR modal is complete. Now creating the component that displays the list of individual ACR workflows after generation in individual mode.

Task:
Create the BatchAcrList component to display individual ACR workflows with verification links.

Requirements:

1. Create Component (src/components/acr/BatchAcrList.tsx):

   import React from 'react';
   import { useNavigate } from 'react-router-dom';
   import { Card, CardHeader, CardTitle, CardContent } from '../ui/Card';
   import { Button } from '../ui/Button';
   import { Badge } from '../ui/Badge';
   import { CheckCircle, Clock, FileText } from 'lucide-react';

   interface AcrWorkflow {
     acrWorkflowId: string;
     epubFileName: string;
     status: 'pending' | 'in_progress' | 'completed';
     createdAt?: string;
   }

   interface BatchAcrListProps {
     batchId: string;
     acrWorkflowIds: string[];
     generatedAt?: string;
   }

   export function BatchAcrList({ batchId, acrWorkflowIds, generatedAt }: BatchAcrListProps) {
     const navigate = useNavigate();

     // In real implementation, fetch ACR details for each ID
     // For now, mock the data
     const acrWorkflows: AcrWorkflow[] = acrWorkflowIds.map((id, index) => ({
       acrWorkflowId: id,
       epubFileName: `book${index + 1}.epub`,
       status: 'pending',
     }));

     const handleVerify = (acrWorkflowId: string) => {
       navigate(`/acr/verification/${acrWorkflowId}`);
     };

     return (
       <div className="space-y-6">
         <div className="flex items-center justify-between">
           <div>
             <h2 className="text-2xl font-bold">ACR Workflows Created</h2>
             <p className="text-gray-600 mt-1">
               Successfully created {acrWorkflowIds.length} ACR workflows
             </p>
           </div>
           <Button variant="outline" onClick={() => navigate(`/remediation/batch`)}>
             ← Back to Batch
           </Button>
         </div>

         <Card>
           <CardHeader>
             <CardTitle>Batch Information</CardTitle>
           </CardHeader>
           <CardContent>
             <dl className="grid grid-cols-2 gap-4">
               <div>
                 <dt className="text-sm font-medium text-gray-500">Source Batch ID</dt>
                 <dd className="mt-1 text-sm text-gray-900">{batchId}</dd>
               </div>
               <div>
                 <dt className="text-sm font-medium text-gray-500">Generated At</dt>
                 <dd className="mt-1 text-sm text-gray-900">
                   {generatedAt
                     ? new Date(generatedAt).toLocaleString()
                     : 'Just now'}
                 </dd>
               </div>
             </dl>
           </CardContent>
         </Card>

         <Card>
           <CardHeader>
             <CardTitle>Individual ACR Workflows ({acrWorkflowIds.length})</CardTitle>
           </CardHeader>
           <CardContent>
             <div className="overflow-x-auto">
               <table className="min-w-full divide-y divide-gray-200">
                 <thead className="bg-gray-50">
                   <tr>
                     <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                       ACR ID
                     </th>
                     <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                       EPUB File
                     </th>
                     <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                       Status
                     </th>
                     <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                       Action
                     </th>
                   </tr>
                 </thead>
                 <tbody className="bg-white divide-y divide-gray-200">
                   {acrWorkflows.map((workflow) => (
                     <tr key={workflow.acrWorkflowId} className="hover:bg-gray-50">
                       <td className="px-6 py-4 whitespace-nowrap text-sm font-mono text-gray-900">
                         {workflow.acrWorkflowId.slice(0, 12)}...
                       </td>
                       <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                         <div className="flex items-center">
                           <FileText className="h-4 w-4 text-gray-400 mr-2" />
                           {workflow.epubFileName}
                         </div>
                       </td>
                       <td className="px-6 py-4 whitespace-nowrap">
                         <Badge
                           variant={
                             workflow.status === 'completed'
                               ? 'success'
                               : workflow.status === 'in_progress'
                               ? 'warning'
                               : 'default'
                           }
                         >
                           {workflow.status === 'completed' && (
                             <CheckCircle className="h-3 w-3 mr-1" />
                           )}
                           {workflow.status === 'pending' && (
                             <Clock className="h-3 w-3 mr-1" />
                           )}
                           {workflow.status.replace('_', ' ')}
                         </Badge>
                       </td>
                       <td className="px-6 py-4 whitespace-nowrap text-sm">
                         <Button
                           size="sm"
                           onClick={() => handleVerify(workflow.acrWorkflowId)}
                         >
                           Verify
                         </Button>
                       </td>
                     </tr>
                   ))}
                 </tbody>
               </table>
             </div>
           </CardContent>
         </Card>
       </div>
     );
   }

2. Features:
   - Display batch metadata (ID, generation timestamp)
   - Table showing all ACR workflows
   - Status badges (pending, in_progress, completed)
   - "Verify" button navigates to ACR verification page
   - "Back to Batch" button for navigation

3. Styling:
   - Responsive table layout
   - Hover effects on table rows
   - Color-coded status badges
   - Use existing Card, Badge, Button components

File Location:
- src/components/acr/BatchAcrList.tsx

Follow patterns from:
- src/components/jobs/JobsList.tsx
- Table components in src/components/
```

---

## Frontend Prompt 4: Aggregate ACR Viewer Components

```
Context:
Individual ACR list is complete. Now creating components for viewing and editing aggregate ACR documents with batch information, per-EPUB breakdown, and export functionality.

Task:
Create components for displaying aggregate ACR documents.

Requirements:

1. Create Batch Info Component (src/components/acr/BatchAcrInfo.tsx):

   import React from 'react';
   import { Card, CardHeader, CardTitle, CardContent } from '../ui/Card';
   import { Badge } from '../ui/Badge';
   import { FileText } from 'lucide-react';

   interface BatchInfo {
     isBatch: boolean;
     totalDocuments: number;
     documentList: Array<{
       fileName: string;
       jobId: string;
     }>;
     aggregationStrategy: 'conservative' | 'optimistic';
     sourceJobIds: string[];
   }

   interface BatchAcrInfoProps {
     batchInfo: BatchInfo;
     productInfo: {
       name: string;
       vendor: string;
       contactEmail: string;
       edition: string;
     };
   }

   export function BatchAcrInfo({ batchInfo, productInfo }: BatchAcrInfoProps) {
     return (
       <Card>
         <CardHeader>
           <CardTitle>Batch ACR Information</CardTitle>
         </CardHeader>
         <CardContent className="space-y-6">
           {/* Product Info */}
           <div className="grid grid-cols-2 gap-4">
             <div>
               <dt className="text-sm font-medium text-gray-500">Batch Name</dt>
               <dd className="mt-1 text-sm text-gray-900">{productInfo.name}</dd>
             </div>
             <div>
               <dt className="text-sm font-medium text-gray-500">Vendor</dt>
               <dd className="mt-1 text-sm text-gray-900">{productInfo.vendor}</dd>
             </div>
             <div>
               <dt className="text-sm font-medium text-gray-500">Contact Email</dt>
               <dd className="mt-1 text-sm text-gray-900">{productInfo.contactEmail}</dd>
             </div>
             <div>
               <dt className="text-sm font-medium text-gray-500">VPAT Edition</dt>
               <dd className="mt-1 text-sm text-gray-900">{productInfo.edition}</dd>
             </div>
           </div>

           {/* Batch Metadata */}
           <div className="border-t pt-4">
             <div className="grid grid-cols-2 gap-4">
               <div>
                 <dt className="text-sm font-medium text-gray-500">Total Documents</dt>
                 <dd className="mt-1 text-sm text-gray-900">{batchInfo.totalDocuments}</dd>
               </div>
               <div>
                 <dt className="text-sm font-medium text-gray-500">Aggregation Strategy</dt>
                 <dd className="mt-1">
                   <Badge variant={batchInfo.aggregationStrategy === 'conservative' ? 'default' : 'warning'}>
                     {batchInfo.aggregationStrategy}
                   </Badge>
                 </dd>
               </div>
             </div>
           </div>

           {/* Document List */}
           <div className="border-t pt-4">
             <h4 className="text-sm font-medium text-gray-900 mb-3">
               Documents Included ({batchInfo.documentList.length})
             </h4>
             <ul className="space-y-2 max-h-48 overflow-y-auto">
               {batchInfo.documentList.map((doc, index) => (
                 <li key={doc.jobId} className="flex items-center text-sm text-gray-700">
                   <FileText className="h-4 w-4 text-gray-400 mr-2" />
                   <span className="text-gray-500 mr-2">{index + 1}.</span>
                   {doc.fileName}
                 </li>
               ))}
             </ul>
           </div>
         </CardContent>
       </Card>
     );
   }

2. Create Summary Component (src/components/acr/BatchAcrSummary.tsx):

   import React from 'react';
   import { Card, CardHeader, CardTitle, CardContent } from '../ui/Card';
   import { Badge } from '../ui/Badge';
   import { CheckCircle, AlertCircle, MinusCircle, XCircle } from 'lucide-react';

   interface BatchAcrSummaryProps {
     criteria: Array<{
       conformanceLevel: string;
     }>;
   }

   export function BatchAcrSummary({ criteria }: BatchAcrSummaryProps) {
     const counts = criteria.reduce(
       (acc, c) => {
         acc[c.conformanceLevel] = (acc[c.conformanceLevel] || 0) + 1;
         return acc;
       },
       {} as Record<string, number>
     );

     const total = criteria.length;

     const stats = [
       {
         label: 'Supports',
         count: counts['Supports'] || 0,
         percentage: Math.round(((counts['Supports'] || 0) / total) * 100),
         color: 'text-green-600',
         bgColor: 'bg-green-100',
         icon: CheckCircle,
       },
       {
         label: 'Partially Supports',
         count: counts['Partially Supports'] || 0,
         percentage: Math.round(((counts['Partially Supports'] || 0) / total) * 100),
         color: 'text-yellow-600',
         bgColor: 'bg-yellow-100',
         icon: AlertCircle,
       },
       {
         label: 'Does Not Support',
         count: counts['Does Not Support'] || 0,
         percentage: Math.round(((counts['Does Not Support'] || 0) / total) * 100),
         color: 'text-red-600',
         bgColor: 'bg-red-100',
         icon: XCircle,
       },
       {
         label: 'Not Applicable',
         count: counts['Not Applicable'] || 0,
         percentage: Math.round(((counts['Not Applicable'] || 0) / total) * 100),
         color: 'text-gray-600',
         bgColor: 'bg-gray-100',
         icon: MinusCircle,
       },
     ];

     return (
       <Card>
         <CardHeader>
           <CardTitle>Overall Compliance Summary</CardTitle>
         </CardHeader>
         <CardContent>
           <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
             {stats.map((stat) => {
               const Icon = stat.icon;
               return (
                 <div key={stat.label} className="text-center">
                   <div className={`inline-flex items-center justify-center w-12 h-12 rounded-full ${stat.bgColor} mb-2`}>
                     <Icon className={`h-6 w-6 ${stat.color}`} />
                   </div>
                   <div className="text-2xl font-bold">{stat.count}</div>
                   <div className="text-sm text-gray-600">{stat.label}</div>
                   <div className="text-xs text-gray-500">{stat.percentage}%</div>
                 </div>
               );
             })}
           </div>
         </CardContent>
       </Card>
     );
   }

3. Create Criteria Table Component (src/components/acr/AggregateCriteriaTable.tsx):

   import React, { useState } from 'react';
   import { Card, CardHeader, CardTitle, CardContent } from '../ui/Card';
   import { Badge } from '../ui/Badge';
   import { ChevronDown, ChevronRight } from 'lucide-react';

   interface AggregateCriterion {
     criterionId: string;
     criterionName: string;
     level: 'A' | 'AA' | 'AAA';
     conformanceLevel: string;
     remarks: string;
     perEpubDetails: Array<{
       fileName: string;
       status: string;
       issueCount: number;
     }>;
   }

   interface AggregateCriteriaTableProps {
     criteria: AggregateCriterion[];
   }

   export function AggregateCriteriaTable({ criteria }: AggregateCriteriaTableProps) {
     const [expandedCriteria, setExpandedCriteria] = useState<Set<string>>(new Set());

     const toggleExpanded = (criterionId: string) => {
       const newExpanded = new Set(expandedCriteria);
       if (newExpanded.has(criterionId)) {
         newExpanded.delete(criterionId);
       } else {
         newExpanded.add(criterionId);
       }
       setExpandedCriteria(newExpanded);
     };

     const getConformanceBadge = (level: string) => {
       const variants: Record<string, any> = {
         'Supports': 'success',
         'Partially Supports': 'warning',
         'Does Not Support': 'destructive',
         'Not Applicable': 'secondary',
       };
       return <Badge variant={variants[level] || 'default'}>{level}</Badge>;
     };

     return (
       <div className="space-y-4">
         {criteria.map((criterion) => {
           const isExpanded = expandedCriteria.has(criterion.criterionId);

           return (
             <Card key={criterion.criterionId}>
               <CardContent className="p-4">
                 <div className="flex items-start justify-between">
                   <div className="flex-1">
                     <div className="flex items-center space-x-3">
                       <button
                         onClick={() => toggleExpanded(criterion.criterionId)}
                         className="text-gray-400 hover:text-gray-600"
                       >
                         {isExpanded ? (
                           <ChevronDown className="h-5 w-5" />
                         ) : (
                           <ChevronRight className="h-5 w-5" />
                         )}
                       </button>
                       <div>
                         <h4 className="font-semibold text-gray-900">
                           {criterion.criterionId} {criterion.criterionName}
                         </h4>
                         <p className="text-sm text-gray-500">Level {criterion.level}</p>
                       </div>
                     </div>

                     <div className="mt-3 ml-8">
                       <div className="flex items-center space-x-2 mb-2">
                         <span className="text-sm font-medium text-gray-700">Conformance:</span>
                         {getConformanceBadge(criterion.conformanceLevel)}
                       </div>

                       <div className="text-sm text-gray-700 whitespace-pre-wrap bg-gray-50 p-3 rounded">
                         {criterion.remarks}
                       </div>

                       {isExpanded && (
                         <div className="mt-4 border-t pt-4">
                           <h5 className="text-sm font-semibold mb-2">Per-EPUB Breakdown:</h5>
                           <div className="space-y-2">
                             {criterion.perEpubDetails.map((epub) => (
                               <div
                                 key={epub.fileName}
                                 className="flex items-center justify-between p-2 bg-white border rounded"
                               >
                                 <span className="text-sm">{epub.fileName}</span>
                                 <div className="flex items-center space-x-2">
                                   <span className="text-sm text-gray-600">
                                     {epub.issueCount} issue{epub.issueCount !== 1 ? 's' : ''}
                                   </span>
                                   {getConformanceBadge(epub.status)}
                                 </div>
                               </div>
                             ))}
                           </div>
                         </div>
                       )}
                     </div>
                   </div>
                 </div>
               </CardContent>
             </Card>
           );
         })}
       </div>
     );
   }

4. Features:
   - Batch info card with product and batch metadata
   - Document list with scrollable container
   - Summary statistics with icons and percentages
   - Expandable criteria table showing per-EPUB breakdown
   - Color-coded conformance badges

File Locations:
- src/components/acr/BatchAcrInfo.tsx
- src/components/acr/BatchAcrSummary.tsx
- src/components/acr/AggregateCriteriaTable.tsx

Use Tailwind CSS and existing UI components (Card, Badge, etc.).
```

---

## Frontend Prompt 5: Batch Remediation Page Integration

```
Context:
All Batch ACR components are complete. Now integrating the "Generate ACR" button and modal into the existing Batch Remediation page.

Task:
Update the BatchRemediation page to include ACR generation functionality.

Requirements:

1. Update Page Component (src/pages/BatchRemediation.tsx):

   import React, { useState } from 'react';
   import { useParams, useNavigate } from 'react-router-dom';
   import { Button } from '../components/ui/Button';
   import { Card, CardHeader, CardTitle, CardContent } from '../components/ui/Card';
   import { Badge } from '../components/ui/Badge';
   import { BatchAcrConfigModal } from '../components/acr/BatchAcrConfigModal';
   import { useGenerateBatchAcr, useBatchAcrHistory } from '../hooks/useBatchAcr';
   import { useBatch } from '../hooks/useBatch'; // Assuming this exists
   import { FileCheck } from 'lucide-react';
   import type { BatchAcrOptions } from '../types/batch-acr.types';

   export function BatchRemediation() {
     const { batchId } = useParams<{ batchId: string }>();
     const navigate = useNavigate();
     const [isModalOpen, setIsModalOpen] = useState(false);

     const { data: batch, isLoading } = useBatch(batchId);
     const { data: acrHistory } = useBatchAcrHistory(batchId);
     const generateBatchAcr = useGenerateBatchAcr();

     const handleGenerateAcr = async (
       mode: 'individual' | 'aggregate',
       options?: BatchAcrOptions
     ) => {
       try {
         const result = await generateBatchAcr.mutateAsync({
           batchId: batchId!,
           mode,
           options,
         });

         setIsModalOpen(false);

         // Redirect based on mode
         if (result.mode === 'individual') {
           navigate(`/acr/batch/${batchId}/list`, {
             state: { acrWorkflowIds: result.acrWorkflowIds },
           });
         } else {
           navigate(`/acr/editor/${result.acrWorkflowId}`);
         }
       } catch (error) {
         // Error handled by mutation hook (toast)
       }
     };

     if (isLoading) {
       return <div>Loading batch...</div>;
     }

     if (!batch) {
       return <div>Batch not found</div>;
     }

     const isBatchCompleted = batch.status === 'completed';
     const successfulJobs = batch.jobs.filter((j: any) => j.status === 'completed').length;
     const failedJobs = batch.jobs.filter((j: any) => j.status === 'failed').length;

     return (
       <div className="container mx-auto p-6 space-y-6">
         {/* Page Header */}
         <div className="flex items-center justify-between">
           <div>
             <h1 className="text-3xl font-bold">Batch Remediation Results</h1>
             <p className="text-gray-600 mt-1">Batch ID: {batchId}</p>
           </div>
           <Badge variant={batch.status === 'completed' ? 'success' : 'warning'}>
             {batch.status}
           </Badge>
         </div>

         {/* Summary Card */}
         <Card>
           <CardHeader>
             <CardTitle>Summary Statistics</CardTitle>
           </CardHeader>
           <CardContent>
             <dl className="grid grid-cols-2 md:grid-cols-4 gap-4">
               <div>
                 <dt className="text-sm font-medium text-gray-500">Total Jobs</dt>
                 <dd className="mt-1 text-2xl font-semibold">{batch.totalJobs}</dd>
               </div>
               <div>
                 <dt className="text-sm font-medium text-gray-500">Successful</dt>
                 <dd className="mt-1 text-2xl font-semibold text-green-600">{successfulJobs}</dd>
               </div>
               <div>
                 <dt className="text-sm font-medium text-gray-500">Failed</dt>
                 <dd className="mt-1 text-2xl font-semibold text-red-600">{failedJobs}</dd>
               </div>
               <div>
                 <dt className="text-sm font-medium text-gray-500">Success Rate</dt>
                 <dd className="mt-1 text-2xl font-semibold">{batch.summary.successRate}%</dd>
               </div>
             </dl>
           </CardContent>
         </Card>

         {/* Job Results Table */}
         <Card>
           <CardHeader>
             <CardTitle>Job Results ({batch.totalJobs})</CardTitle>
           </CardHeader>
           <CardContent>
             {/* ... existing job results table ... */}
           </CardContent>
         </Card>

         {/* ACR Generation Section */}
         <Card>
           <CardHeader>
             <CardTitle>ACR/VPAT Generation</CardTitle>
           </CardHeader>
           <CardContent className="space-y-4">
             <p className="text-sm text-gray-600">
               Generate Accessibility Conformance Reports (ACR/VPAT) for the remediated EPUBs.
             </p>

             <Button
               onClick={() => setIsModalOpen(true)}
               disabled={!isBatchCompleted || successfulJobs === 0}
               className="w-full sm:w-auto"
             >
               <FileCheck className="h-4 w-4 mr-2" />
               Generate ACR/VPAT Report
             </Button>

             {!isBatchCompleted && (
               <p className="text-sm text-amber-600">
                 Complete batch processing before generating ACR
               </p>
             )}

             {/* ACR Generation History */}
             {acrHistory?.history && acrHistory.history.length > 0 && (
               <div className="border-t pt-4 mt-4">
                 <h4 className="text-sm font-semibold mb-2">Previously Generated ACRs:</h4>
                 <ul className="space-y-2">
                   {acrHistory.history.map((entry, index) => (
                     <li key={index} className="flex items-center justify-between p-2 bg-gray-50 rounded">
                       <div className="flex items-center space-x-2">
                         <Badge variant="secondary">{entry.mode}</Badge>
                         <span className="text-sm">
                           {new Date(entry.generatedAt).toLocaleString()}
                         </span>
                       </div>
                       <Button
                         size="sm"
                         variant="outline"
                         onClick={() => {
                           if (entry.mode === 'individual') {
                             navigate(`/acr/batch/${batchId}/list`, {
                               state: { acrWorkflowIds: entry.acrWorkflowIds },
                             });
                           } else {
                             navigate(`/acr/editor/${entry.acrWorkflowIds[0]}`);
                           }
                         }}
                       >
                         View ACR
                       </Button>
                     </li>
                   ))}
                 </ul>
               </div>
             )}
           </CardContent>
         </Card>

         {/* Modal */}
         <BatchAcrConfigModal
           isOpen={isModalOpen}
           onClose={() => setIsModalOpen(false)}
           batchId={batchId!}
           totalJobs={batch.totalJobs}
           successfulJobs={successfulJobs}
           failedJobs={failedJobs}
           onGenerate={handleGenerateAcr}
         />
       </div>
     );
   }

2. Features:
   - "Generate ACR/VPAT Report" button (disabled until batch completed)
   - Opens BatchAcrConfigModal on click
   - Displays ACR generation history
   - "View ACR" button for previously generated ACRs
   - Tooltip explaining why button is disabled (if applicable)

3. Navigation:
   - Individual mode → redirects to ACR list page
   - Aggregate mode → redirects to ACR editor page

File Location:
- src/pages/BatchRemediation.tsx

Update existing page or create new one if it doesn't exist. Follow patterns from src/pages/Jobs.tsx or similar pages.
```

---

## Frontend Prompt 6: Routing & Navigation

```
Context:
All Batch ACR components and page integrations are complete. Now adding routes and navigation links.

Task:
Add routes for Batch ACR pages and update navigation.

Requirements:

1. Add Routes (src/App.tsx or src/routes/index.tsx):

   import { lazy } from 'react';
   import { Routes, Route } from 'react-router-dom';

   // ... existing imports

   const BatchRemediation = lazy(() => import('./pages/BatchRemediation'));
   const BatchAcrListPage = lazy(() => import('./pages/BatchAcrListPage'));
   const AcrEditor = lazy(() => import('./pages/AcrEditor')); // Assuming exists

   export function AppRoutes() {
     return (
       <Routes>
         {/* ... existing routes ... */}

         {/* Batch Remediation */}
         <Route path="/remediation/batch/:batchId" element={<BatchRemediation />} />

         {/* Batch ACR Routes */}
         <Route path="/acr/batch/:batchId/list" element={<BatchAcrListPage />} />

         {/* ACR Editor handles both single and batch ACRs */}
         <Route path="/acr/editor/:acrWorkflowId" element={<AcrEditor />} />

         {/* ... other routes ... */}
       </Routes>
     );
   }

2. Create BatchAcrListPage (src/pages/BatchAcrListPage.tsx):

   import React from 'react';
   import { useParams, useLocation } from 'react-router-dom';
   import { BatchAcrList } from '../components/acr/BatchAcrList';
   import { useBatchAcrHistory } from '../hooks/useBatchAcr';

   export default function BatchAcrListPage() {
     const { batchId } = useParams<{ batchId: string }>();
     const location = useLocation();
     const state = location.state as { acrWorkflowIds?: string[] };

     const { data: acrHistory } = useBatchAcrHistory(batchId);

     const acrWorkflowIds = state?.acrWorkflowIds || acrHistory?.currentAcr?.workflowIds || [];
     const generatedAt = acrHistory?.currentAcr?.generatedAt;

     return (
       <div className="container mx-auto p-6">
         <BatchAcrList
           batchId={batchId!}
           acrWorkflowIds={acrWorkflowIds}
           generatedAt={generatedAt}
         />
       </div>
     );
   }

3. Update Sidebar Navigation (src/components/layout/Sidebar.tsx):

   // Add to ACR Workflow section
   <NavLink to="/remediation/batch" icon={FileCheck}>
     Batch Remediation
   </NavLink>

4. Update Breadcrumbs:
   - Batch Remediation: Home > Remediation > Batch > [Batch ID]
   - Individual ACR List: Home > ACR Workflow > Batch ACR > List
   - Aggregate ACR Editor: Home > ACR Workflow > Batch ACR > [ACR ID]

File Locations:
- Routes: src/App.tsx or src/routes/index.tsx
- Page: src/pages/BatchAcrListPage.tsx
- Sidebar: src/components/layout/Sidebar.tsx

Follow existing routing patterns from the app.
```

---

# Git Commands for Feature Branch Creation

## Frontend Repository

```bash
# Navigate to frontend repository
cd C:\Users\avrve\projects\ninja-frontend

# Ensure you're on main branch and up to date
git checkout main
git pull origin main

# Create feature branch for batch ACR implementation
git checkout -b feature/batch-acr-generation

# Verify branch creation
git branch --show-current
```

## Backend Repository

```bash
# Navigate to backend repository
cd C:\Users\avrve\projects\ninja-backend

# Ensure you're on main branch and up to date
git checkout main
git pull origin main

# Create feature branch for batch ACR implementation
git checkout -b feature/batch-acr-generation

# Verify branch creation
git branch --show-current
```

## After Implementation - Push to Remote

### Backend

```bash
cd C:\Users\avrve\projects\ninja-backend

git add .
git commit -m "feat: implement batch ACR/VPAT generation backend

- Add database schema fields: batchSourceJobIds, isBatchAcr
- Create BatchAcrGeneratorService with individual and aggregate modes
- Implement conservative and optimistic aggregation strategies
- Add batch ACR routes: POST /acr/batch/generate, GET /acr/batch/:id, POST /acr/batch/:id/export
- Create Zod validation schemas for batch ACR requests
- Extend BatchRemediationResult with ACR metadata
- Add comprehensive unit and integration tests

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"

git push -u origin feature/batch-acr-generation
```

### Frontend

```bash
cd C:\Users\avrve\projects\ninja-frontend

git add .
git commit -m "feat: implement batch ACR/VPAT generation frontend

- Create BatchAcrConfigModal for mode selection and configuration
- Add BatchAcrList component for individual ACR workflows
- Implement aggregate ACR viewer components (BatchAcrInfo, BatchAcrSummary, AggregateCriteriaTable)
- Extend BatchRemediation page with ACR generation button
- Add React Query hooks: useGenerateBatchAcr, useBatchAcr, useExportBatchAcr
- Create API service methods for batch ACR operations
- Add routes for batch ACR pages
- Update navigation and breadcrumbs

Co-Authored-By: Claude Sonnet 4.5 <noreply@anthropic.com>"

git push -u origin feature/batch-acr-generation
```

---

**End of Document**
