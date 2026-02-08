# Backend Terminal 2 (BE-T2) - Routes, Controllers & API Layer

**Branch:** `feature/ai-report-backend-2`
**Focus:** API routes, controllers, types, caching
**Duration:** 10 weeks (3 phases)
**No Conflicts With:** BE-T1, FE-T1, FE-T2 (separate files)

---

## Your Responsibilities

You own all **API layer** files for AI Report and verification integration:
- Route definitions
- Controllers (request/response handling)
- Type definitions and interfaces
- Response formatting
- Caching layer
- API validation schemas
- Error handlers

**DO NOT TOUCH:**
- Service files (`src/services/acr/*.service.ts` except types)
- Gemini integration
- Frontend files

---

## Setup

```bash
# Navigate to project root
cd /c/Users/avrve/projects/ninja-workspace

# Create your worktree
git worktree add ninja-backend-be-t2 -b feature/ai-report-backend-2

# Navigate to your worktree
cd ninja-backend-be-t2

# Install dependencies
npm install

# Create your work branch
git checkout -b feature/ai-report-backend-2

# Start development server on custom port
npm run dev -- --port 3002
```

---

## Phase 1: Basic AI Report API (Weeks 1-4)

### Week 1-2: API Foundation

#### Task 1.1: Create Report Types & Interfaces

**File:** `src/types/acr-report.types.ts` (NEW)

```typescript
// Response types for API
export interface ACRReportResponse {
  success: boolean;
  data: ACRAnalysisReportData;
  meta?: {
    cacheHit: boolean;
    generatedAt: string;
    expiresAt: string;
  };
}

export interface ACRAnalysisReportData {
  metadata: ReportMetadata;
  executiveSummary: ExecutiveSummary;
  aiInsights: AIInsights | null;
  statistics: ReportStatistics;
  actionPlan: ActionPlan;
}

export interface ReportMetadata {
  jobId: string;
  contentTitle: string;
  analysisDate: string; // ISO string for JSON
  reportVersion: string;
}

export interface ExecutiveSummary {
  overallConfidence: number;
  totalCriteria: number;
  automatedPassed: number;
  manualRequired: number;
  notApplicable: number;
  keyFindings: string[];
  criticalActions: CriticalAction[];
}

export interface CriticalAction {
  criterionId: string;
  name: string;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  estimatedTime: string;
}

export interface AIInsights {
  generatedAt: string;
  model: string;
  topPriorities: TopPriority[];
  riskAssessment: RiskAssessment;
  specificRecommendations: string[];
}

export interface TopPriority {
  criterionId: string;
  insight: string;
  recommendation: string;
  estimatedImpact: 'High' | 'Medium' | 'Low';
}

export interface RiskAssessment {
  level: 'HIGH' | 'MEDIUM' | 'LOW';
  factors: string[];
}

export interface ReportStatistics {
  totalCriteria: number;
  automatedPassed: number;
  manualRequired: number;
  notApplicable: number;
  highConfidence: number;
  mediumConfidence: number;
  lowConfidence: number;
  overallConfidence: number;
  levelACount: number;
  levelAACount: number;
}

export interface ActionPlan {
  phases: ActionPhase[];
  totalEstimatedTime: string;
}

export interface ActionPhase {
  name: string;
  priority: 'CRITICAL' | 'HIGH' | 'MEDIUM';
  estimatedTime: string;
  tasks: ActionTask[];
}

export interface ActionTask {
  criterionId: string;
  name: string;
  estimatedTime: string;
  status: 'pending' | 'in_progress' | 'completed';
}

// Error response type
export interface ACRReportErrorResponse {
  success: false;
  error: {
    code: string;
    message: string;
    details?: any;
  };
}
```

---

#### Task 1.2: Create Report Controller

**File:** `src/controllers/report.controller.ts` (NEW)

```typescript
import { Request, Response, NextFunction } from 'express';
import { reportGeneratorService } from '../services/acr/report-generator.service';
import { logger } from '../lib/logger';
import { ReportCache } from '../lib/cache';
import { ACRReportResponse, ACRReportErrorResponse } from '../types/acr-report.types';

export class ReportController {
  /**
   * GET /api/v1/acr/reports/:jobId/analysis
   * Generate or retrieve AI Analysis Report
   */
  async getAnalysisReport(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;
      const forceRefresh = req.query.forceRefresh === 'true';

      if (!jobId) {
        const errorResponse: ACRReportErrorResponse = {
          success: false,
          error: {
            code: 'MISSING_JOB_ID',
            message: 'Job ID is required'
          }
        };
        return res.status(400).json(errorResponse);
      }

      logger.info(`[ReportController] Generating report for job ${jobId}`);

      // Check cache first (unless force refresh)
      if (!forceRefresh) {
        const cached = await ReportCache.get(jobId);
        if (cached) {
          logger.info(`[ReportController] Cache hit for job ${jobId}`);

          const response: ACRReportResponse = {
            success: true,
            data: cached,
            meta: {
              cacheHit: true,
              generatedAt: cached.metadata.analysisDate,
              expiresAt: new Date(Date.now() + 3600000).toISOString() // 1 hour
            }
          };

          return res.json(response);
        }
      }

      // Generate new report
      logger.info(`[ReportController] Generating fresh report for job ${jobId}`);
      const report = await reportGeneratorService.generateAnalysisReport(jobId);

      // Cache for 1 hour
      await ReportCache.set(jobId, report, 3600);

      // Format response
      const response: ACRReportResponse = {
        success: true,
        data: {
          metadata: {
            jobId: report.metadata.jobId,
            contentTitle: report.metadata.contentTitle,
            analysisDate: report.metadata.analysisDate.toISOString(),
            reportVersion: report.metadata.reportVersion
          },
          executiveSummary: report.executiveSummary,
          aiInsights: report.aiInsights ? {
            ...report.aiInsights,
            generatedAt: report.aiInsights.generatedAt.toISOString()
          } : null,
          statistics: report.statistics,
          actionPlan: report.actionPlan
        },
        meta: {
          cacheHit: false,
          generatedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 3600000).toISOString()
        }
      };

      res.json(response);
    } catch (error: any) {
      logger.error('[ReportController] Error generating report:', error);

      if (error.message.includes('No ACR results found')) {
        const errorResponse: ACRReportErrorResponse = {
          success: false,
          error: {
            code: 'ACR_RESULTS_NOT_FOUND',
            message: 'No ACR analysis results found for this job',
            details: { jobId: req.params.jobId }
          }
        };
        return res.status(404).json(errorResponse);
      }

      next(error);
    }
  }

  /**
   * POST /api/v1/acr/reports/:jobId/analysis/refresh
   * Force refresh report cache
   */
  async refreshReport(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        return res.status(400).json({
          success: false,
          error: { code: 'MISSING_JOB_ID', message: 'Job ID is required' }
        });
      }

      logger.info(`[ReportController] Force refresh for job ${jobId}`);

      // Invalidate cache
      await ReportCache.invalidate(jobId);

      // Generate new report
      const report = await reportGeneratorService.generateAnalysisReport(jobId);

      // Cache new report
      await ReportCache.set(jobId, report, 3600);

      res.json({
        success: true,
        data: report,
        meta: {
          cacheHit: false,
          generatedAt: new Date().toISOString(),
          refreshed: true
        }
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/acr/reports/:jobId/status
   * Get report generation status
   */
  async getReportStatus(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;

      if (!jobId) {
        return res.status(400).json({
          success: false,
          error: { code: 'MISSING_JOB_ID', message: 'Job ID is required' }
        });
      }

      // Check if report exists in cache
      const cached = await ReportCache.get(jobId);

      if (cached) {
        return res.json({
          success: true,
          data: {
            status: 'ready',
            cachedAt: cached.metadata.analysisDate,
            expiresAt: new Date(Date.now() + 3600000).toISOString()
          }
        });
      }

      // Check if ACR results exist
      try {
        await reportGeneratorService.generateAnalysisReport(jobId);

        res.json({
          success: true,
          data: {
            status: 'can_generate',
            message: 'ACR results found, report can be generated'
          }
        });
      } catch (error: any) {
        if (error.message.includes('No ACR results found')) {
          res.json({
            success: true,
            data: {
              status: 'not_available',
              message: 'ACR analysis not complete or not found'
            }
          });
        } else {
          throw error;
        }
      }
    } catch (error) {
      next(error);
    }
  }
}

export const reportController = new ReportController();
```

---

#### Task 1.3: Create Report Routes

**File:** `src/routes/report.routes.ts` (NEW)

```typescript
import { Router } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { reportController } from '../controllers/report.controller';

const router = Router();

// All routes require authentication
router.use(authenticate);

/**
 * GET /api/v1/acr/reports/:jobId/analysis
 * Get AI Analysis Report
 * Query params: ?forceRefresh=true to bypass cache
 */
router.get(
  '/:jobId/analysis',
  reportController.getAnalysisReport.bind(reportController)
);

/**
 * POST /api/v1/acr/reports/:jobId/analysis/refresh
 * Force refresh report cache
 */
router.post(
  '/:jobId/analysis/refresh',
  reportController.refreshReport.bind(reportController)
);

/**
 * GET /api/v1/acr/reports/:jobId/status
 * Get report generation status
 */
router.get(
  '/:jobId/status',
  reportController.getReportStatus.bind(reportController)
);

export default router;
```

---

#### Task 1.4: Register Routes in Main App

**File:** `src/index.ts` or `src/app.ts` (MODIFY)

Add to existing route registrations:

```typescript
import reportRoutes from './routes/report.routes';

// ... existing code ...

// Register report routes
app.use('/api/v1/acr/reports', reportRoutes);
```

---

### Week 3-4: Caching Layer

#### Task 1.5: Implement Report Cache

**File:** `src/lib/cache.ts` (ENHANCE existing or CREATE)

```typescript
import Redis from 'ioredis';

const redis = new Redis({
  host: process.env.REDIS_HOST || 'localhost',
  port: parseInt(process.env.REDIS_PORT || '6379'),
  password: process.env.REDIS_PASSWORD,
  db: 0
});

export class ReportCache {
  private static PREFIX = 'acr:report:';

  static async get(jobId: string): Promise<any | null> {
    try {
      const key = `${this.PREFIX}${jobId}`;
      const cached = await redis.get(key);

      if (!cached) {
        return null;
      }

      return JSON.parse(cached);
    } catch (error) {
      console.error('[ReportCache] Get error:', error);
      return null;
    }
  }

  static async set(jobId: string, report: any, ttlSeconds: number = 3600): Promise<void> {
    try {
      const key = `${this.PREFIX}${jobId}`;
      await redis.setex(key, ttlSeconds, JSON.stringify(report));
    } catch (error) {
      console.error('[ReportCache] Set error:', error);
    }
  }

  static async invalidate(jobId: string): Promise<void> {
    try {
      const key = `${this.PREFIX}${jobId}`;
      await redis.del(key);
    } catch (error) {
      console.error('[ReportCache] Invalidate error:', error);
    }
  }

  static async exists(jobId: string): Promise<boolean> {
    try {
      const key = `${this.PREFIX}${jobId}`;
      const exists = await redis.exists(key);
      return exists === 1;
    } catch (error) {
      console.error('[ReportCache] Exists error:', error);
      return false;
    }
  }

  static async getTTL(jobId: string): Promise<number> {
    try {
      const key = `${this.PREFIX}${jobId}`;
      return await redis.ttl(key);
    } catch (error) {
      console.error('[ReportCache] TTL error:', error);
      return -1;
    }
  }
}
```

---

## Phase 2: Integration APIs (Weeks 5-8)

### Week 5-6: Verification Integration Endpoints

#### Task 2.1: Create Verification Integration Types

**File:** `src/types/verification-integration.types.ts` (NEW)

```typescript
export interface InitFromReportRequest {
  criteriaIds: string[];
  aiInsights?: any;
  reportId?: string;
  source: 'ai-analysis-report' | 'manual';
}

export interface InitFromReportResponse {
  success: boolean;
  data: {
    sessionId: string;
    jobId: string;
    queueUrl: string;
    itemsInitialized: number;
    estimatedTime: string;
  };
}

export interface EnhancedQueueResponse {
  success: boolean;
  data: {
    jobId: string;
    sessionId?: string;
    totalItems: number;
    pendingItems: number;
    verifiedItems: number;
    estimatedRemainingTime: string;
    items: EnhancedQueueItem[];
  };
}

export interface EnhancedQueueItem {
  id: string;
  criterionId: string;
  wcagCriterion: string;
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  confidenceLevel: string;
  status: string;
  aiContext: {
    priority: 'CRITICAL' | 'HIGH' | 'MEDIUM';
    priorityReason: string;
    estimatedTime: string;
    riskScore: number;
    detectedIssues: string[];
    recommendations: string[];
  };
  relatedIssues?: any[];
  fixedIssues?: any[];
}
```

---

#### Task 2.2: Enhance Verification Controller

**File:** `src/controllers/verification.controller.ts` (MODIFY existing)

Add new methods:

```typescript
import { aiContextEnricher } from '../services/acr/ai-context-enricher.service';
import { reportGeneratorService } from '../services/acr/report-generator.service';
import { v4 as uuidv4 } from 'uuid';

// Add to existing VerificationController class

/**
 * POST /api/v1/verification/:jobId/init-from-report
 * Initialize verification queue from AI Analysis Report
 */
async initFromReport(req: Request, res: Response, next: NextFunction) {
  try {
    const { jobId } = req.params;
    const body = req.body as InitFromReportRequest;

    if (!jobId) {
      return res.status(400).json({
        success: false,
        error: { message: 'Job ID is required' }
      });
    }

    if (!body.criteriaIds || body.criteriaIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: { message: 'Criteria IDs are required' }
      });
    }

    logger.info(`[Verification] Initializing from report for job ${jobId}`);

    // Generate session ID
    const sessionId = uuidv4();

    // Get ACR results
    const acrResults = await acrAnalysisService.getAnalysisForJob(jobId);

    // Enrich queue items with AI context
    const enrichedItems = await aiContextEnricher.enrichVerificationQueue(
      jobId,
      body.criteriaIds,
      body.aiInsights,
      acrResults
    );

    // Initialize verification queue
    await humanVerificationService.initializeQueueWithItems(jobId, enrichedItems);

    // Calculate total time
    const totalMinutes = enrichedItems.reduce((sum, item) => {
      const minutes = parseInt(item.aiContext.estimatedTime.split('-')[1] || '15');
      return sum + minutes;
    }, 0);

    const estimatedTime = `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;

    const response: InitFromReportResponse = {
      success: true,
      data: {
        sessionId,
        jobId,
        queueUrl: `/verification/${jobId}?session=${sessionId}`,
        itemsInitialized: enrichedItems.length,
        estimatedTime
      }
    };

    res.status(201).json(response);
  } catch (error) {
    logger.error('[Verification] Init from report error:', error);
    next(error);
  }
}

/**
 * GET /api/v1/verification/:jobId/queue/enhanced
 * Get verification queue with AI context
 */
async getEnhancedQueue(req: Request, res: Response, next: NextFunction) {
  try {
    const { jobId } = req.params;
    const { sessionId } = req.query;

    if (!jobId) {
      return res.status(400).json({
        success: false,
        error: { message: 'Job ID is required' }
      });
    }

    logger.info(`[Verification] Getting enhanced queue for job ${jobId}`);

    // Get base queue
    const queue = await humanVerificationService.getQueueFromJob(jobId);

    // Calculate remaining time
    const pendingItems = queue.items.filter(i => i.status === 'PENDING');
    const totalMinutes = pendingItems.reduce((sum, item: any) => {
      const time = item.aiContext?.estimatedTime || '10 minutes';
      const minutes = parseInt(time.split('-')[1] || '10');
      return sum + minutes;
    }, 0);

    const estimatedRemainingTime = totalMinutes < 60
      ? `${totalMinutes} min`
      : `${Math.floor(totalMinutes / 60)}h ${totalMinutes % 60}m`;

    const response: EnhancedQueueResponse = {
      success: true,
      data: {
        jobId,
        sessionId: sessionId as string,
        totalItems: queue.totalItems,
        pendingItems: queue.pendingItems,
        verifiedItems: queue.verifiedItems,
        estimatedRemainingTime,
        items: queue.items
      }
    };

    res.json(response);
  } catch (error) {
    logger.error('[Verification] Enhanced queue error:', error);
    next(error);
  }
}
```

---

#### Task 2.3: Add Verification Routes

**File:** `src/routes/verification.routes.ts` (MODIFY existing)

Add new routes:

```typescript
// Add to existing routes

/**
 * POST /api/v1/verification/:jobId/init-from-report
 * Initialize verification from AI Report
 */
router.post(
  '/:jobId/init-from-report',
  verificationController.initFromReport.bind(verificationController)
);

/**
 * GET /api/v1/verification/:jobId/queue/enhanced
 * Get enhanced queue with AI context
 */
router.get(
  '/:jobId/queue/enhanced',
  verificationController.getEnhancedQueue.bind(verificationController)
);
```

---

### Week 7-8: Testing Guide Templates

#### Task 2.4: Create Testing Guide Templates

**File:** `src/utils/testing-guides.ts` (NEW)

```typescript
export interface TestingGuideTemplate {
  criterionId: string;
  steps: TestingStep[];
  tools: Tool[];
  resources: Resource[];
  passCriteria: string[];
}

export interface TestingStep {
  order: number;
  instruction: string;
  helpText: string;
  helpLink?: string;
  estimatedTime: string;
}

export interface Tool {
  name: string;
  type: 'screen-reader' | 'keyboard' | 'visual' | 'analyzer';
  downloadUrl?: string;
  tutorialUrl?: string;
  isRecommended: boolean;
}

export interface Resource {
  title: string;
  url: string;
  type: 'documentation' | 'tutorial' | 'example';
  duration?: string;
}

export const TESTING_GUIDE_TEMPLATES: Record<string, TestingGuideTemplate> = {
  '1.1.1': {
    criterionId: '1.1.1',
    steps: [
      {
        order: 1,
        instruction: 'Open content with NVDA screen reader',
        helpText: 'Press Ctrl+Alt+N to start NVDA. Navigate using arrow keys.',
        helpLink: 'https://www.nvaccess.org/get-help/',
        estimatedTime: '2 min'
      },
      {
        order: 2,
        instruction: 'Navigate to each image using "G" key',
        helpText: 'NVDA will read the alt text for each image as you navigate.',
        estimatedTime: '10 min'
      },
      {
        order: 3,
        instruction: 'Verify alt text conveys equivalent information',
        helpText: 'Ask: Does the alt text communicate the same message as the image?',
        estimatedTime: '5 min'
      },
      {
        order: 4,
        instruction: 'Check decorative images have empty alt',
        helpText: 'Decorative images should have alt="" (empty string).',
        estimatedTime: '3 min'
      }
    ],
    tools: [
      {
        name: 'NVDA Screen Reader',
        type: 'screen-reader',
        downloadUrl: 'https://www.nvaccess.org/download/',
        tutorialUrl: 'https://www.nvaccess.org/get-help/',
        isRecommended: true
      },
      {
        name: 'JAWS',
        type: 'screen-reader',
        downloadUrl: 'https://www.freedomscientific.com/products/software/jaws/',
        isRecommended: false
      }
    ],
    resources: [
      {
        title: 'WCAG 1.1.1 Quick Reference',
        url: 'https://www.w3.org/WAI/WCAG21/quickref/#non-text-content',
        type: 'documentation'
      },
      {
        title: 'How to Write Alt Text',
        url: 'https://webaim.org/techniques/alttext/',
        type: 'tutorial'
      }
    ],
    passCriteria: [
      'All non-decorative images have meaningful alt text',
      'Alt text conveys equivalent information to visual content',
      'Decorative images have empty alt attribute (alt="")',
      'Complex images have detailed descriptions or long descriptions'
    ]
  },

  '1.3.1': {
    criterionId: '1.3.1',
    steps: [
      {
        order: 1,
        instruction: 'Navigate with screen reader',
        helpText: 'Use heading navigation (H key in NVDA) to check structure.',
        estimatedTime: '5 min'
      },
      {
        order: 2,
        instruction: 'Verify heading hierarchy is logical',
        helpText: 'Check: H1 → H2 → H3 (no skipped levels).',
        estimatedTime: '5 min'
      },
      {
        order: 3,
        instruction: 'Test table header associations',
        helpText: 'Navigate tables and verify headers are announced correctly.',
        estimatedTime: '3 min'
      },
      {
        order: 4,
        instruction: 'Check semantic markup',
        helpText: 'Verify lists, landmarks, and structural elements.',
        estimatedTime: '2 min'
      }
    ],
    tools: [
      {
        name: 'NVDA Screen Reader',
        type: 'screen-reader',
        isRecommended: true
      }
    ],
    resources: [
      {
        title: 'WCAG 1.3.1 Quick Reference',
        url: 'https://www.w3.org/WAI/WCAG21/quickref/#info-and-relationships',
        type: 'documentation'
      }
    ],
    passCriteria: [
      'Heading hierarchy is logical and sequential',
      'Table headers are properly associated',
      'Lists use proper markup',
      'Landmarks define page regions'
    ]
  },

  '2.1.1': {
    criterionId: '2.1.1',
    steps: [
      {
        order: 1,
        instruction: 'Disconnect mouse or trackpad',
        helpText: 'Test with keyboard only - no mouse interaction.',
        estimatedTime: '1 min'
      },
      {
        order: 2,
        instruction: 'Tab through all interactive elements',
        helpText: 'Use Tab (forward) and Shift+Tab (backward) to navigate.',
        estimatedTime: '8 min'
      },
      {
        order: 3,
        instruction: 'Verify visible focus indicators',
        helpText: 'Ensure focused elements have clear visual indicators.',
        estimatedTime: '5 min'
      },
      {
        order: 4,
        instruction: 'Test all functionality',
        helpText: 'Complete key workflows using only keyboard.',
        estimatedTime: '6 min'
      }
    ],
    tools: [
      {
        name: 'Keyboard Only',
        type: 'keyboard',
        isRecommended: true
      }
    ],
    resources: [
      {
        title: 'WCAG 2.1.1 Quick Reference',
        url: 'https://www.w3.org/WAI/WCAG21/quickref/#keyboard',
        type: 'documentation'
      }
    ],
    passCriteria: [
      'All interactive elements reachable with Tab key',
      'Focus indicators are visible',
      'All functionality available via keyboard',
      'No keyboard traps'
    ]
  }

  // Add more templates for other criteria...
};

export function getTestingGuide(criterionId: string): TestingGuideTemplate | null {
  return TESTING_GUIDE_TEMPLATES[criterionId] || null;
}
```

---

## Phase 3: Progress Tracking API (Weeks 9-10)

#### Task 3.1: Create Progress Endpoint

**File:** `src/controllers/verification.controller.ts` (ADD METHOD)

```typescript
/**
 * GET /api/v1/verification/:jobId/progress
 * Get current verification progress
 */
async getProgress(req: Request, res: Response, next: NextFunction) {
  try {
    const { jobId } = req.params;

    if (!jobId) {
      return res.status(400).json({
        success: false,
        error: { message: 'Job ID is required' }
      });
    }

    // Get progress from tracker service
    const progress = await progressTracker.getCurrentProgress(jobId);

    // Get completed criteria details
    const queue = await humanVerificationService.getQueue(jobId);
    const completedCriteria = queue.items
      .filter(i =>
        i.status === 'VERIFIED_PASS' ||
        i.status === 'VERIFIED_FAIL' ||
        i.status === 'VERIFIED_PARTIAL'
      )
      .map(i => ({
        criterionId: i.criterionId,
        status: i.status,
        verifiedBy: i.verificationHistory[i.verificationHistory.length - 1]?.verifiedBy,
        verifiedAt: i.verificationHistory[i.verificationHistory.length - 1]?.verifiedAt
      }));

    res.json({
      success: true,
      data: {
        jobId,
        ...progress,
        completedCriteria
      }
    });
  } catch (error) {
    logger.error('[Verification] Progress error:', error);
    next(error);
  }
}
```

**Add route:**

```typescript
// In verification.routes.ts

router.get(
  '/:jobId/progress',
  verificationController.getProgress.bind(verificationController)
);
```

---

## Testing Requirements

### API Tests

**File:** `tests/api/report.test.ts`

```typescript
import request from 'supertest';
import app from '../src/app';

describe('Report API', () => {
  describe('GET /api/v1/acr/reports/:jobId/analysis', () => {
    it('should return 401 without auth', async () => {
      const res = await request(app)
        .get('/api/v1/acr/reports/test-job/analysis');

      expect(res.status).toBe(401);
    });

    it('should return 404 for non-existent job', async () => {
      const res = await request(app)
        .get('/api/v1/acr/reports/fake-job/analysis')
        .set('Authorization', 'Bearer test-token');

      expect(res.status).toBe(404);
    });

    it('should return report for valid job', async () => {
      const res = await request(app)
        .get('/api/v1/acr/reports/valid-job/analysis')
        .set('Authorization', 'Bearer test-token');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveProperty('executiveSummary');
    });
  });
});
```

**Run tests:**
```bash
npm test -- tests/api/report.test.ts
```

---

## Commit Strategy

```bash
# After completing a task
git add src/types/acr-report.types.ts
git add src/controllers/report.controller.ts
git add src/routes/report.routes.ts

git commit -m "feat(be-t2): Add report API endpoints

- Create report types and interfaces
- Implement ReportController with caching
- Add report routes with authentication
- Add comprehensive error handling

Phase: 1
Task: 1.1-1.3"

git push origin feature/ai-report-backend-2
```

---

## Definition of Done

Per Task:
- [ ] Types/interfaces defined
- [ ] Controller methods implemented
- [ ] Routes registered
- [ ] Error handling added
- [ ] API tests written and passing
- [ ] OpenAPI/Swagger docs updated
- [ ] Committed and pushed

Per Phase:
- [ ] All endpoints working
- [ ] Integration tests passing
- [ ] Postman collection updated
- [ ] Ready for frontend integration

---

**Status:** Ready to start
**Estimated Completion:** 10 weeks
**Next:** Set up worktree, start Phase 1 Task 1.1
