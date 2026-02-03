import { Request, Response, NextFunction } from 'express';
import { confidenceAnalyzerService, ValidationResultInput } from '../services/acr/confidence-analyzer.service';
import { acrGeneratorService, AcrEdition } from '../services/acr/acr-generator.service';
import { AuditIssueInput, wcagIssueMapperService, RULE_TO_CRITERIA_MAP } from '../services/acr/wcag-issue-mapper.service';
import prisma from '../lib/prisma';
import { logger } from '../lib/logger';

// Helper to check if a rule maps to any WCAG criterion
function mapsToWcagCriteria(ruleId: string): boolean {
  const criteria = RULE_TO_CRITERIA_MAP[ruleId];
  return criteria !== undefined && criteria.length > 0;
}

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
        location?: string;
        status?: string;
        completedAt?: string;
        resolvedAt?: string;
        remediationMethod?: string;
        completionMethod?: 'auto' | 'manual' | 'verified';
        description?: string;
        resolution?: string;
        notes?: string;
        resolvedBy?: string;
        resolvedLocation?: string;
        resolvedFiles?: string[];
        context?: string;
        html?: string;
        element?: string;
      }
      
      // Key by issueCode + location to avoid marking all same-code issues as remediated
      let completedTasksMap = new Map<string, RemediationTaskInfo>();
      let failedTasksMap = new Map<string, RemediationTaskInfo>();
      let skippedTasksMap = new Map<string, RemediationTaskInfo>();
      
      // Helper to safely coerce location to string (declare early for reuse)
      const toLocationStringInner = (loc: unknown): string => {
        if (!loc) return '';
        if (typeof loc === 'string') return loc;
        if (typeof loc === 'object') {
          try { return JSON.stringify(loc); } catch { return ''; }
        }
        return String(loc);
      };
      
      // Helper to normalize remediationInfo values to conform to frontend enums
      // status -> [completed, fixed, failed, skipped]
      // method -> [auto, manual, automated]
      const normalizeRemediationInfo = (info: RemediationTaskInfo | undefined, fallbackStatus?: string) => {
        if (!info) return undefined;
        
        // Normalize status: map variations to canonical values
        const rawStatus = info.status || fallbackStatus || 'completed';
        let normalizedStatus: 'completed' | 'fixed' | 'failed' | 'skipped';
        if (rawStatus === 'auto-fixed' || rawStatus === 'verified') {
          normalizedStatus = 'completed';
        } else if (['completed', 'fixed', 'failed', 'skipped'].includes(rawStatus)) {
          normalizedStatus = rawStatus as 'completed' | 'fixed' | 'failed' | 'skipped';
        } else {
          normalizedStatus = 'completed'; // safe default
        }
        
        // Normalize method: map variations to canonical values
        const rawMethod = info.completionMethod || info.remediationMethod || 'automated';
        let normalizedMethod: 'auto' | 'manual' | 'automated';
        if (rawMethod === 'auto-fixed' || rawMethod === 'auto') {
          normalizedMethod = 'auto';
        } else if (rawMethod === 'verified' || rawMethod === 'manual') {
          normalizedMethod = 'manual';
        } else if (rawMethod === 'automated') {
          normalizedMethod = 'automated';
        } else {
          normalizedMethod = 'automated'; // safe default
        }
        
        return {
          status: normalizedStatus,
          method: normalizedMethod,
          completedAt: info.resolvedAt || info.completedAt,
          description: info.resolution || info.description || 'Fixed during remediation',
          details: {
            notes: info.notes,
            resolvedBy: info.resolvedBy,
            resolvedLocation: info.resolvedLocation,
            resolvedFiles: info.resolvedFiles,
            context: info.context,
            element: info.element,
          }
        };
      };
      
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
            for (const task of batchOutput.tasks) {
              if (task.issueCode) {
                const taskLocationStr = toLocationStringInner(task.location);
                const key = taskLocationStr ? `${task.issueCode}::${taskLocationStr}` : task.issueCode;
                
                if (task.status === 'fixed' || task.status === 'completed' || task.status === 'auto-fixed') {
                  completedTasksMap.set(key, task);
                } else if (task.status === 'failed') {
                  failedTasksMap.set(key, task);
                } else if (task.status === 'skipped') {
                  skippedTasksMap.set(key, task);
                }
              }
            }
            logger.info(`[Confidence] Found ${completedTasksMap.size} fixed, ${failedTasksMap.size} failed, ${skippedTasksMap.size} skipped tasks from BATCH_VALIDATION`);
          }
        }
      }

      // Helper to safely coerce location to string (duplicate for scope)
      const toLocationString = (loc: unknown): string => {
        if (!loc) return '';
        if (typeof loc === 'string') return loc;
        if (typeof loc === 'object') {
          try { return JSON.stringify(loc); } catch { return ''; }
        }
        return String(loc);
      };

      // Separate issues into: WCAG-mapped (pending/remediated) vs Other Issues (non-WCAG)
      // Also track failed/skipped Other Issues
      type OtherIssueStatus = 'pending' | 'fixed' | 'failed' | 'skipped';
      const pendingIssues: OutputIssue[] = [];
      const remediatedIssues: Array<OutputIssue & { remediationInfo?: RemediationTaskInfo }> = [];
      const otherIssuesWithStatus: Array<OutputIssue & { taskStatus: OtherIssueStatus; remediationInfo?: RemediationTaskInfo }> = [];
      
      for (const issue of allOutputIssues) {
        const issueCode = issue.ruleId || issue.code || '';
        // Normalize issue location to string
        const issueLocation = toLocationString(issue.filePath || issue.location);
        
        // Check if this issue maps to WCAG criteria
        const isWcagMapped = mapsToWcagCriteria(issueCode);
        
        // Build lookup keys
        const specificKey = issueCode && issueLocation ? `${issueCode}::${issueLocation}` : null;
        
        // Check in order: completed, failed, skipped
        let matchedKey: string | null = null;
        let taskStatus: OtherIssueStatus = 'pending';
        let taskInfo: RemediationTaskInfo | undefined;
        
        // Check for completed/fixed tasks
        if (specificKey && completedTasksMap.has(specificKey)) {
          matchedKey = specificKey;
          taskStatus = 'fixed';
          taskInfo = completedTasksMap.get(matchedKey);
        } else if (issueCode && completedTasksMap.has(issueCode)) {
          const storedTask = completedTasksMap.get(issueCode);
          const storedTaskLocation = toLocationString(storedTask?.location);
          if (!storedTaskLocation || !issueLocation) {
            matchedKey = issueCode;
            taskStatus = 'fixed';
            taskInfo = storedTask;
          }
        }
        
        // Check for failed tasks (if not already matched)
        if (!matchedKey) {
          if (specificKey && failedTasksMap.has(specificKey)) {
            matchedKey = specificKey;
            taskStatus = 'failed';
            taskInfo = failedTasksMap.get(matchedKey);
          } else if (issueCode && failedTasksMap.has(issueCode)) {
            const storedTask = failedTasksMap.get(issueCode);
            const storedTaskLocation = toLocationString(storedTask?.location);
            if (!storedTaskLocation || !issueLocation) {
              matchedKey = issueCode;
              taskStatus = 'failed';
              taskInfo = storedTask;
            }
          }
        }
        
        // Check for skipped tasks (if not already matched)
        if (!matchedKey) {
          if (specificKey && skippedTasksMap.has(specificKey)) {
            matchedKey = specificKey;
            taskStatus = 'skipped';
            taskInfo = skippedTasksMap.get(matchedKey);
          } else if (issueCode && skippedTasksMap.has(issueCode)) {
            const storedTask = skippedTasksMap.get(issueCode);
            const storedTaskLocation = toLocationString(storedTask?.location);
            if (!storedTaskLocation || !issueLocation) {
              matchedKey = issueCode;
              taskStatus = 'skipped';
              taskInfo = storedTask;
            }
          }
        }
        
        if (isWcagMapped) {
          if (taskStatus === 'fixed' && matchedKey) {
            remediatedIssues.push({ ...issue, remediationInfo: taskInfo });
            completedTasksMap.delete(matchedKey);
          } else {
            pendingIssues.push(issue);
          }
        } else {
          otherIssuesWithStatus.push({ ...issue, taskStatus, remediationInfo: taskInfo });
          // Clean up from maps
          if (matchedKey) {
            completedTasksMap.delete(matchedKey);
            failedTasksMap.delete(matchedKey);
            skippedTasksMap.delete(matchedKey);
          }
        }
      }
      
      // Separate Other Issues by status for counting
      const pendingOtherIssues = otherIssuesWithStatus.filter(i => i.taskStatus === 'pending');
      const remediatedOtherIssues = otherIssuesWithStatus.filter(i => i.taskStatus === 'fixed');
      const failedOtherIssues = otherIssuesWithStatus.filter(i => i.taskStatus === 'failed');
      const skippedOtherIssues = otherIssuesWithStatus.filter(i => i.taskStatus === 'skipped');
      
      const outputIssues = pendingIssues;
      
      logger.info(`[Confidence] WCAG issues: ${pendingIssues.length} pending, ${remediatedIssues.length} remediated`);
      logger.info(`[Confidence] Other issues: ${pendingOtherIssues.length} pending, ${remediatedOtherIssues.length} remediated`);

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

      // Format remediated issues for response (normalize filePath to string)
      const formattedRemediatedIssues = remediatedIssues.map(issue => {
        const normalizedFilePath = toLocationString(issue.filePath || issue.location);
        return {
          id: issue.id,
          code: issue.ruleId || issue.code,
          message: issue.message || issue.description,
          severity: issue.impact || issue.severity,
          filePath: normalizedFilePath,
          status: 'remediated',
          remediationInfo: normalizeRemediationInfo(issue.remediationInfo)
        };
      });

      // Map remediated issues to their WCAG criteria (normalize filePath to string)
      const remediatedAuditIssues: AuditIssueInput[] = remediatedIssues.map((issue, idx) => {
        const normalizedFilePath = toLocationString(issue.filePath || issue.location);
        return {
          id: issue.id || `remediated-${idx}`,
          ruleId: issue.ruleId || issue.code || 'unknown',
          message: issue.message || issue.description || '',
          impact: (issue.impact || issue.severity || 'moderate') as 'critical' | 'serious' | 'moderate' | 'minor',
          filePath: normalizedFilePath
        };
      });
      
      const remediatedIssueMapping = wcagIssueMapperService.mapIssuesToCriteria(remediatedAuditIssues);
      logger.info(`[Confidence] Mapped remediated issues to ${remediatedIssueMapping.size} criteria`);

      // Build keyed lookup for formattedRemediatedIssues using normalized code + filePath
      const remediatedLookup = new Map<string, typeof formattedRemediatedIssues[0]>();
      for (const r of formattedRemediatedIssues) {
        const normalizedPath = toLocationString(r.filePath);
        const key = normalizedPath ? `${r.code}::${normalizedPath}` : r.code;
        if (key) remediatedLookup.set(key, r);
      }

      // Enhance criteria with needsVerification, remediationSummary, and recalculated confidence
      const enhancedCriteria = confidenceAnalysis.map(criterion => {
        const criterionRemediatedIssues = remediatedIssueMapping.get(criterion.criterionId) || [];
        const pendingCount = criterion.issueCount || 0;
        const fixedCount = criterionRemediatedIssues.length;
        const totalIssues = pendingCount + fixedCount;
        const allFixed = pendingCount === 0 && fixedCount > 0;
        
        // Get latest fixedAt timestamp from remediated issues
        let latestFixedAt: string | undefined;
        const mappedRemediatedIssues = criterionRemediatedIssues.map(issue => {
          const normalizedPath = toLocationString(issue.filePath);
          const specificKey = normalizedPath ? `${issue.ruleId}::${normalizedPath}` : issue.ruleId;
          const fullInfo = remediatedLookup.get(specificKey) || remediatedLookup.get(issue.ruleId);
          
          if (fullInfo?.remediationInfo?.completedAt) {
            if (!latestFixedAt || fullInfo.remediationInfo.completedAt > latestFixedAt) {
              latestFixedAt = fullInfo.remediationInfo.completedAt;
            }
          }
          
          return {
            ...issue,
            status: 'remediated',
            remediationInfo: fullInfo?.remediationInfo
          };
        });
        
        // Recalculate confidence based on fix ratio (per spec) - deterministic formula
        // Note: criterion.confidenceScore may be 0-1 (float) or 0-100 (percentage)
        // Normalize to 0-100 scale for consistent output
        const baseConfidence = criterion.confidenceScore <= 1 
          ? criterion.confidenceScore * 100 
          : criterion.confidenceScore;
        let recalculatedConfidence = baseConfidence;
        
        if (totalIssues > 0 && fixedCount > 0) {
          const fixRatio = fixedCount / totalIssues;
          if (fixRatio === 1.0) {
            // All issues fixed - high confidence: 80 + (baseFactor * 12), capped at 92
            // baseFactor = min(1, baseConfidence / 100) provides deterministic variation
            // Result range: 80-92 (when baseFactor is 0-1)
            const baseFactor = Math.min(1, baseConfidence / 100);
            recalculatedConfidence = Math.min(92, 80 + (baseFactor * 12));
          } else {
            // Partial fix: 40 + (fixRatio * 40)
            recalculatedConfidence = Math.round(40 + (fixRatio * 40));
          }
        }
        
        // Compute updatedStatus first: 'pass' if all issues were fixed (and there were issues to fix)
        const updatedStatus = allFixed ? 'pass' : criterion.status;
        
        // Derive needsVerification from updatedStatus for consistency
        // needsVerification = true only when there are unresolved issues or status requires review
        const hasRemainingIssues = pendingCount > 0;
        const needsVerification = hasRemainingIssues || updatedStatus === 'needs_review';
        
        return {
          ...criterion,
          confidenceScore: Math.round(recalculatedConfidence),
          status: updatedStatus,
          needsVerification,
          remediationSummary: fixedCount > 0 ? {
            totalIssues,
            fixedIssues: fixedCount,
            remainingIssues: pendingCount,
            fixedAt: latestFixedAt
          } : undefined,
          remediatedIssues: mappedRemediatedIssues,
          remediatedCount: fixedCount
        };
      });
      
      // Format Other Issues for response with all status types
      const formatOtherIssue = (issue: OutputIssue & { taskStatus: OtherIssueStatus; remediationInfo?: RemediationTaskInfo }) => {
        const normalizedFilePath = toLocationString(issue.filePath || issue.location);
        const hasRemediationAttempt = issue.taskStatus !== 'pending';
        return {
          code: issue.ruleId || issue.code,
          severity: (issue.impact || issue.severity || 'moderate') as 'critical' | 'serious' | 'moderate' | 'minor',
          message: issue.message || issue.description || '',
          location: normalizedFilePath,
          status: issue.taskStatus,
          remediationInfo: hasRemediationAttempt ? normalizeRemediationInfo(issue.remediationInfo, issue.taskStatus) : undefined
        };
      };
      
      const formattedOtherIssues = {
        count: otherIssuesWithStatus.length,
        pendingCount: pendingOtherIssues.length,
        fixedCount: remediatedOtherIssues.length,
        failedCount: failedOtherIssues.length,
        skippedCount: skippedOtherIssues.length,
        issues: otherIssuesWithStatus.map(formatOtherIssue)
      };

      const summary = {
        totalCriteria: enhancedCriteria.length,
        passingCriteria: enhancedCriteria.filter(c => c.status === 'pass').length,
        failingCriteria: enhancedCriteria.filter(c => c.status === 'fail').length,
        needsReviewCriteria: enhancedCriteria.filter(c => c.status === 'needs_review').length,
        notApplicableCriteria: enhancedCriteria.filter(c => c.status === 'not_applicable').length,
        criteriaWithIssuesCount: criteriaWithIssues.length,
        totalIssues: auditIssues.length,
        remediatedIssuesCount: remediatedIssues.length,
        averageConfidence: enhancedCriteria.length > 0
          ? Math.round((enhancedCriteria.reduce((sum, c) => sum + c.confidenceScore, 0) / enhancedCriteria.length) * 100) / 100
          : 0
      };

      logger.info(`[Confidence] Summary: total=${summary.totalCriteria}, pass=${summary.passingCriteria}, fail=${summary.failingCriteria}, needsReview=${summary.needsReviewCriteria}, criteriaWithIssues=${summary.criteriaWithIssuesCount}, totalIssues=${summary.totalIssues}, remediated=${summary.remediatedIssuesCount}`);
      logger.info(`[Confidence] Other Issues: count=${formattedOtherIssues.count}, pending=${formattedOtherIssues.pendingCount}, fixed=${formattedOtherIssues.fixedCount}`);
      
      res.json({
        success: true,
        data: {
          jobId,
          edition: editionCode,
          summary,
          criteria: enhancedCriteria,
          remediatedIssues: formattedRemediatedIssues,
          otherIssues: formattedOtherIssues
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
