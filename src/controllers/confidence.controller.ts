import { Request, Response, NextFunction } from 'express';
import { confidenceAnalyzerService, ValidationResultInput } from '../services/acr/confidence-analyzer.service';
import { acrGeneratorService, AcrEdition } from '../services/acr/acr-generator.service';
import { AuditIssueInput, wcagIssueMapperService } from '../services/acr/wcag-issue-mapper.service';
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
          validationResults: {
            include: {
              issues: true
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

      if (job.validationResults && job.validationResults.length > 0) {
        const criteriaMap = new Map<string, ValidationResultInput>();
        
        for (const result of job.validationResults) {
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
          tenant: { users: { some: { id: userId } } }
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
      
      const allOutputIssues = (auditOutput?.combinedIssues || auditOutput?.issues || []) as OutputIssue[];

      logger.debug(`[Confidence] Issues from job.output: ${allOutputIssues.length}`);

      // Check BATCH_VALIDATION job for completed/fixed tasks to categorize issues
      const sourceJobId = job.type === 'ACR_WORKFLOW' 
        ? (job.input as { sourceJobId?: string })?.sourceJobId 
        : jobId;
      
      interface RemediationTaskInfo {
        issueCode?: string;
        status?: string;
        completedAt?: string;
        remediationMethod?: string;
        description?: string;
      }
      
      let completedTasksMap = new Map<string, RemediationTaskInfo>();
      
      if (sourceJobId) {
        const batchValidationJob = await prisma.job.findFirst({
          where: {
            type: 'BATCH_VALIDATION',
            input: {
              path: ['sourceJobId'],
              equals: sourceJobId,
            },
          },
          orderBy: { createdAt: 'desc' },
        });

        if (batchValidationJob?.output) {
          const batchOutput = batchValidationJob.output as { tasks?: Array<RemediationTaskInfo> };
          
          if (batchOutput.tasks) {
            const fixedTasks = batchOutput.tasks.filter(task =>
              task.status === 'fixed' || task.status === 'completed' || task.status === 'auto-fixed'
            );
            fixedTasks.forEach(task => {
              if (task.issueCode) {
                completedTasksMap.set(task.issueCode, task);
              }
            });
            logger.info(`[Confidence] Found ${completedTasksMap.size} completed issue codes from BATCH_VALIDATION`);
          }
        }
      }

      // Separate pending and remediated issues
      const pendingIssues: OutputIssue[] = [];
      const remediatedIssues: Array<OutputIssue & { remediationInfo?: RemediationTaskInfo }> = [];
      
      for (const issue of allOutputIssues) {
        const issueCode = issue.ruleId || issue.code;
        if (issueCode && completedTasksMap.has(issueCode)) {
          remediatedIssues.push({
            ...issue,
            remediationInfo: completedTasksMap.get(issueCode)
          });
        } else {
          pendingIssues.push(issue);
        }
      }
      
      const outputIssues = pendingIssues;

      logger.info(`[Confidence] After categorizing: ${pendingIssues.length} pending issues, ${remediatedIssues.length} remediated`);

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

      const confidenceAnalysis = await acrGeneratorService.generateConfidenceAnalysis(
        editionCode,
        auditIssues
      );

      const criteriaWithIssues = confidenceAnalysis.filter(c => (c.issueCount || 0) > 0);
      logger.info(`[Confidence] Criteria with issues: ${criteriaWithIssues.length}`);
      criteriaWithIssues.forEach(c => {
        logger.info(`[Confidence] Criterion ${c.criterionId}: ${c.issueCount} issues, status=${c.status}, confidence=${c.confidenceScore}`);
      });

      // Format remediated issues for response
      const formattedRemediatedIssues = remediatedIssues.map(issue => ({
        id: issue.id,
        code: issue.ruleId || issue.code,
        message: issue.message || issue.description,
        severity: issue.impact || issue.severity,
        filePath: issue.filePath || issue.location,
        status: 'remediated',
        remediationInfo: issue.remediationInfo ? {
          status: issue.remediationInfo.status,
          completedAt: issue.remediationInfo.completedAt,
          method: issue.remediationInfo.remediationMethod,
          description: issue.remediationInfo.description
        } : undefined
      }));

      // Map remediated issues to their WCAG criteria
      const remediatedAuditIssues: AuditIssueInput[] = remediatedIssues.map((issue, idx) => ({
        id: issue.id || `remediated-${idx}`,
        ruleId: issue.ruleId || issue.code || 'unknown',
        message: issue.message || issue.description || '',
        impact: (issue.impact || issue.severity || 'moderate') as 'critical' | 'serious' | 'moderate' | 'minor',
        filePath: issue.filePath || issue.location || ''
      }));
      
      const remediatedIssueMapping = wcagIssueMapperService.mapIssuesToCriteria(remediatedAuditIssues);
      logger.info(`[Confidence] Mapped remediated issues to ${remediatedIssueMapping.size} criteria`);

      // Enhance criteria with remediated issues
      const enhancedCriteria = confidenceAnalysis.map(criterion => {
        const criterionRemediatedIssues = remediatedIssueMapping.get(criterion.criterionId) || [];
        return {
          ...criterion,
          remediatedIssues: criterionRemediatedIssues.map(issue => {
            // Find the full remediation info from formattedRemediatedIssues
            const fullInfo = formattedRemediatedIssues.find(r => r.code === issue.ruleId);
            return {
              ...issue,
              status: 'remediated',
              remediationInfo: fullInfo?.remediationInfo
            };
          }),
          remediatedCount: criterionRemediatedIssues.length
        };
      });

      const summary = {
        totalCriteria: confidenceAnalysis.length,
        passingCriteria: confidenceAnalysis.filter(c => c.status === 'pass').length,
        failingCriteria: confidenceAnalysis.filter(c => c.status === 'fail').length,
        needsReviewCriteria: confidenceAnalysis.filter(c => c.status === 'needs_review').length,
        notApplicableCriteria: confidenceAnalysis.filter(c => c.status === 'not_applicable').length,
        criteriaWithIssuesCount: criteriaWithIssues.length,
        totalIssues: auditIssues.length,
        remediatedIssuesCount: remediatedIssues.length,
        averageConfidence: confidenceAnalysis.length > 0
          ? Math.round((confidenceAnalysis.reduce((sum, c) => sum + c.confidenceScore, 0) / confidenceAnalysis.length) * 100) / 100
          : 0
      };

      logger.info(`[Confidence] Summary: total=${summary.totalCriteria}, pass=${summary.passingCriteria}, fail=${summary.failingCriteria}, needsReview=${summary.needsReviewCriteria}, criteriaWithIssues=${summary.criteriaWithIssuesCount}, totalIssues=${summary.totalIssues}, remediated=${summary.remediatedIssuesCount}`);
      
      res.json({
        success: true,
        data: {
          jobId,
          edition: editionCode,
          summary,
          criteria: enhancedCriteria,
          remediatedIssues: formattedRemediatedIssues
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
