import { Request, Response, NextFunction } from 'express';
import { confidenceAnalyzerService, ValidationResultInput } from '../services/acr/confidence-analyzer.service';
import { acrGeneratorService, AcrEdition } from '../services/acr/acr-generator.service';
import { AuditIssueInput, wcagIssueMapperService, FixedModification } from '../services/acr/wcag-issue-mapper.service';
import { contentDetectionService, ApplicabilitySuggestion } from '../services/acr/content-detection.service';
import { fileStorageService } from '../services/storage/file-storage.service';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';

export class ConfidenceController {
  async getConfidenceSummary(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        res.status(400).json({
          success: false,
          error: { message: 'Job ID is required' }
        });
        return;
      }

      const userId = req.user?.id;
      
      const job = await prisma.job.findFirst({
        where: {
          id: jobId,
          userId: userId,
        },
        include: {
          ValidationResult: {
            include: {
              Issue: true
            }
          }
        }
      });

      if (!job) {
        res.status(404).json({
          success: false,
          error: { message: 'Job not found or access denied' }
        });
        return;
      }

      let summary;

      if (job.ValidationResult && job.ValidationResult.length > 0) {
        const criteriaMap = new Map<string, ValidationResultInput>();

        for (const result of job.ValidationResult) {
          const details = result.details as Record<string, unknown> | null;
          
          if (details && typeof details === 'object') {
            const criteriaFromDetails = details.criteriaChecked as string[] | undefined;
            if (criteriaFromDetails && Array.isArray(criteriaFromDetails)) {
              for (const criterionId of criteriaFromDetails) {
                if (!criteriaMap.has(criterionId)) {
                  criteriaMap.set(criterionId, {
                    criterionId,
                    wcagCriterion: criterionId,
                    status: result.passed ? 'pass' : 'fail'
                  });
                }
              }
            }
          }
          
          if (result.issues && result.issues.length > 0) {
            for (const issue of result.issues) {
              if (issue.wcagCriteria) {
                criteriaMap.set(issue.wcagCriteria, {
                  criterionId: issue.wcagCriteria,
                  wcagCriterion: issue.wcagCriteria,
                  status: 'fail'
                });
              }
            }
          }
          
          if (result.checkType) {
            const checkTypeToCriteria: Record<string, string> = {
              'alt-text': '1.1.1',
              'color-contrast': '1.4.3',
              'heading-structure': '1.3.1',
              'language': '3.1.1',
              'reading-order': '1.3.2',
              'table-structure': '1.3.1',
              'parsing': '4.1.1'
            };
            
            const criterionId = checkTypeToCriteria[result.checkType];
            if (criterionId && !criteriaMap.has(criterionId)) {
              criteriaMap.set(criterionId, {
                criterionId,
                wcagCriterion: criterionId,
                status: result.passed ? 'pass' : 'fail'
              });
            }
          }
        }

        if (criteriaMap.size > 0) {
          summary = confidenceAnalyzerService.analyzeAllCriteria(Array.from(criteriaMap.values()));
        } else {
          summary = confidenceAnalyzerService.getDefaultCriteriaSummary();
        }
      } else {
        summary = confidenceAnalyzerService.getDefaultCriteriaSummary();
      }

      res.json({
        success: true,
        data: {
          jobId,
          jobStatus: job.status,
          ...summary
        }
      });
    } catch (error) {
      next(error);
    }
  }

  async getDefaultConfidenceSummary(_req: Request, res: Response) {
    const summary = confidenceAnalyzerService.getDefaultCriteriaSummary();

    res.json({
      success: true,
      data: summary,
      note: 'Default confidence summary for all WCAG 2.1 Level A and AA criteria'
    });
  }

  async getCriterionConfidence(req: Request, res: Response) {
    const { criterionId } = req.params;

    if (!criterionId) {
      res.status(400).json({
        success: false,
        error: { message: 'Criterion ID is required' }
      });
      return;
    }

    const assessment = confidenceAnalyzerService.analyzeConfidence(criterionId);

    res.json({
      success: true,
      data: assessment
    });
  }

  async getConfidenceWithIssues(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;
      const { edition = 'VPAT2.5-INT' } = req.query;
      const userId = req.user?.id;

      logger.debug(`[Confidence] Getting confidence with issues for job: ${jobId}`);

      if (!jobId) {
        res.status(400).json({
          success: false,
          error: { message: 'Job ID is required' }
        });
        return;
      }

      const validEditions: AcrEdition[] = ['VPAT2.5-508', 'VPAT2.5-WCAG', 'VPAT2.5-EU', 'VPAT2.5-INT'];
      const editionCode = this.normalizeEditionCode(edition as string);
      
      if (!validEditions.includes(editionCode)) {
        res.status(400).json({
          success: false,
          error: { message: `Invalid edition. Must be one of: ${validEditions.join(', ')}` }
        });
        return;
      }

      const job = await prisma.job.findFirst({
        where: {
          id: jobId,
          userId: userId
        }
      });

      if (!job) {
        logger.warn(`[Confidence] Job not found: ${jobId}`);
        res.status(404).json({
          success: false,
          error: { message: 'Job not found' }
        });
        return;
      }

      logger.debug(`[Confidence] Job found: ${jobId}, type: ${job.type}`);

      interface OutputIssue {
        id?: string;
        ruleId?: string;
        code?: string;
        message?: string;
        description?: string;
        impact?: string;
        severity?: string;
        filePath?: string;
        location?: string;
      }

      let auditOutput = job.output as Record<string, unknown> | null;
      
      // For ACR_WORKFLOW jobs, fetch issues from the source job
      if (job.type === 'ACR_WORKFLOW') {
        const jobInput = job.input as { sourceJobId?: string } | null;
        const sourceJobId = jobInput?.sourceJobId;
        
        if (sourceJobId) {
          logger.debug(`[Confidence] ACR_WORKFLOW detected, fetching from source job: ${sourceJobId}`);
          const sourceJob = await prisma.job.findUnique({
            where: { id: sourceJobId }
          });
          
          if (sourceJob?.output) {
            auditOutput = sourceJob.output as Record<string, unknown>;
            logger.debug(`[Confidence] Found source job output with keys: ${Object.keys(auditOutput || {})}`);
          }
        }
      }
      
      const outputIssues = (auditOutput?.combinedIssues || auditOutput?.issues || []) as OutputIssue[];

      logger.debug(`[Confidence] Issues from job.output: ${outputIssues.length}`);

      const auditIssues: AuditIssueInput[] = outputIssues.map((issue, idx) => {
        const ruleId = issue.ruleId || issue.code || 'unknown';
        logger.debug(`[Confidence] Issue ${idx}: ${ruleId} - ${(issue.message || issue.description || '')?.substring(0, 50)}`);
        return {
          id: issue.id || `issue-${idx}`,
          ruleId,
          message: issue.message || issue.description || '',
          impact: (issue.impact || issue.severity || 'moderate') as 'critical' | 'serious' | 'moderate' | 'minor',
          filePath: issue.filePath || issue.location || ''
        };
      });

      logger.debug(`[Confidence] Total issues extracted: ${auditIssues.length}`);
      logger.debug(`[Confidence] Rule IDs: ${auditIssues.map(i => i.ruleId).join(', ')}`);

      // Run content detection to get N/A suggestions
      let naSuggestions: ApplicabilitySuggestion[] = [];
      try {
        const jobInput = job.input as Record<string, unknown> | null;
        const jobOutput = job.output as Record<string, unknown> | null;

        // Try input first (for direct uploads), then output (for ACR workflow jobs)
        const epubFileName = (jobInput?.fileName || jobOutput?.fileName) as string | undefined;

        // For ACR workflow jobs, file is stored under source job ID
        const sourceJobId = (jobInput?.sourceJobId || jobOutput?.sourceJobId) as string | undefined;
        const fileJobId = sourceJobId || jobId;

        if (epubFileName) {
          logger.info(`[Confidence] Running content detection on EPUB: ${epubFileName} (using job ID: ${fileJobId})`);
          const epubBuffer = await fileStorageService.getFile(fileJobId, epubFileName);

          if (epubBuffer) {
            naSuggestions = await contentDetectionService.analyzeEPUBContent(epubBuffer);
            logger.info(`[Confidence] Content detection generated ${naSuggestions.length} N/A suggestions`);
          } else {
            logger.warn(`[Confidence] EPUB file not found in storage: ${epubFileName} (job ID: ${fileJobId})`);
          }
        } else {
          logger.debug('[Confidence] No epubFileName in job input or output, skipping content detection');
        }
      } catch (error) {
        logger.error('[Confidence] Content detection failed, continuing without N/A suggestions', error instanceof Error ? error : undefined);
        naSuggestions = [];
      }

      // Extract fixed issues from autoRemediation.modifications BEFORE analyzing
      const modifications = (auditOutput?.autoRemediation as Record<string, unknown>)?.modifications as FixedModification[] | undefined;

      const fixedModifications = modifications?.filter(m => m.success !== false) || [];
      logger.debug(`[Confidence] Found ${fixedModifications.length} fixed modifications from autoRemediation`);

      // Map fixed issues to WCAG criteria
      const fixedIssuesMap = wcagIssueMapperService.mapFixedIssuesToCriteria(
        fixedModifications,
        auditIssues
      );
      logger.info(`[Confidence] Mapped fixed issues to ${fixedIssuesMap.size} criteria`);

      // Filter out fixed issues BEFORE passing to confidence analysis
      const remainingAuditIssues = auditIssues.filter(issue => {
        const issueCode = issue.ruleId || 'unknown';
        const isFixed = fixedModifications.some(mod =>
          mod.issueCode === issueCode ||
          mod.ruleId === issueCode ||
          (mod.issueCode && issueCode.includes(mod.issueCode))
        );
        return !isFixed;
      });

      logger.info(`[Confidence] Filtered issues: ${auditIssues.length} total, ${remainingAuditIssues.length} remaining after removing fixed`);

      // Generate confidence analysis with REMAINING issues only, but include fixed issues and N/A suggestions
      const confidenceAnalysis = await acrGeneratorService.generateConfidenceAnalysis(
        editionCode,
        remainingAuditIssues,
        fixedIssuesMap,
        naSuggestions
      );

      // Add remaining count to each criterion
      const enhancedAnalysis = confidenceAnalysis.map(criterion => {
        const remainingIssues = criterion.relatedIssues || [];
        const remainingCount = remainingIssues.length;

        logger.debug(`[Confidence] Criterion ${criterion.criterionId}: ${remainingCount} remaining, ${criterion.fixedCount || 0} fixed, confidence=${criterion.confidenceScore}`);

        return {
          ...criterion,
          remainingCount,
          issueCount: remainingCount
        };
      });

      // Only count criteria with REMAINING issues, not fixed ones
      const criteriaWithIssues = enhancedAnalysis.filter(c => (c.issueCount || 0) > 0);
      logger.info(`[Confidence] Criteria with issues: ${criteriaWithIssues.length}`);
      criteriaWithIssues.forEach(c => {
        logger.info(`[Confidence] Criterion ${c.criterionId}: ${c.fixedCount || 0} fixed, ${c.issueCount} remaining, status=${c.status}, confidence=${c.confidenceScore}`);
      });

      const summary = {
        totalCriteria: enhancedAnalysis.length,
        notApplicableCriteria: enhancedAnalysis.filter(c => c.isNotApplicable).length,
        // Exclude N/A from pass/fail counts
        passingCriteria: enhancedAnalysis.filter(c =>
          !c.isNotApplicable && c.status === 'pass'
        ).length,
        failingCriteria: enhancedAnalysis.filter(c =>
          !c.isNotApplicable && c.status === 'fail'
        ).length,
        needsReviewCriteria: enhancedAnalysis.filter(c =>
          !c.isNotApplicable && c.status === 'needs_review'
        ).length,
        criteriaWithIssuesCount: criteriaWithIssues.length,
        totalIssues: enhancedAnalysis
          .filter(c => !c.isNotApplicable)
          .reduce((sum, c) => sum + (c.issueCount || 0), 0),
        // Average confidence excludes N/A
        averageConfidence: (() => {
          const applicableCriteria = enhancedAnalysis.filter(c => !c.isNotApplicable);
          return applicableCriteria.length > 0
            ? Math.round((applicableCriteria.reduce((sum, c) => sum + c.confidenceScore, 0) / applicableCriteria.length) * 100) / 100
            : 0;
        })()
      };

      logger.info(`[Confidence] Summary: total=${summary.totalCriteria}, pass=${summary.passingCriteria}, fail=${summary.failingCriteria}, needsReview=${summary.needsReviewCriteria}, criteriaWithIssues=${summary.criteriaWithIssuesCount}, totalIssues=${summary.totalIssues}`);

      res.json({
        success: true,
        data: {
          jobId,
          edition: editionCode,
          summary,
          criteria: enhancedAnalysis
        }
      });
    } catch (error) {
      next(error);
    }
  }

  private normalizeEditionCode(edition: string): AcrEdition {
    const editionMap: Record<string, AcrEdition> = {
      'section508': 'VPAT2.5-508',
      'wcag': 'VPAT2.5-WCAG',
      'eu': 'VPAT2.5-EU',
      'international': 'VPAT2.5-INT',
      'VPAT2.5-508': 'VPAT2.5-508',
      'VPAT2.5-WCAG': 'VPAT2.5-WCAG',
      'VPAT2.5-EU': 'VPAT2.5-EU',
      'VPAT2.5-INT': 'VPAT2.5-INT'
    };
    return editionMap[edition] || 'VPAT2.5-INT';
  }
}

export const confidenceController = new ConfidenceController();
