import { Request, Response, NextFunction } from 'express';
import { confidenceAnalyzerService, ValidationResultInput } from '../services/acr/confidence-analyzer.service';
import prisma from '../lib/prisma';

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
}

export const confidenceController = new ConfidenceController();
