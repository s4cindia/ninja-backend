import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { geminiService } from '../services/ai/gemini.service';
import { claudeService } from '../services/ai/claude.service';
import { tokenCounterService } from '../services/ai/token-counter.service';
import { aiConfig } from '../config/ai.config';

const router = Router();

// Gemini health check (original)
router.get('/health', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const isHealthy = await geminiService.healthCheck();
    res.json({
      success: true,
      data: {
        service: 'gemini',
        status: isHealthy ? 'healthy' : 'unhealthy',
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Claude health check (for citation detection)
router.get('/health/claude', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const healthResult = await claudeService.healthCheck();
    res.json({
      success: true,
      data: {
        service: 'claude',
        status: healthResult.healthy ? 'healthy' : 'unhealthy',
        details: healthResult.details,
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

// Combined health check for all AI services
router.get('/health/all', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [geminiHealthy, claudeResult] = await Promise.all([
      geminiService.healthCheck().catch(() => false),
      claudeService.healthCheck().catch((e) => ({ healthy: false, details: { error: String(e) } }))
    ]);

    res.json({
      success: true,
      data: {
        gemini: {
          status: geminiHealthy ? 'healthy' : 'unhealthy',
        },
        claude: {
          status: claudeResult.healthy ? 'healthy' : 'unhealthy',
          details: claudeResult.details,
        },
        timestamp: new Date().toISOString(),
      },
    });
  } catch (error) {
    next(error);
  }
});

router.post('/test', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { prompt, model } = req.body;
    
    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: { message: 'Prompt is required' },
      });
    }
    
    const response = await geminiService.generateText(prompt, {
      model: model === 'pro' ? 'pro' : 'flash',
    });
    
    res.json({
      success: true,
      data: response,
    });
  } catch (error) {
    next(error);
  }
});

router.post('/estimate', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { prompt, model = 'flash', expectedOutputTokens = 1000 } = req.body;
    
    if (!prompt) {
      return res.status(400).json({
        success: false,
        error: { message: 'Prompt is required' },
      });
    }
    
    const modelName = model === 'pro' ? aiConfig.gemini.modelPro : aiConfig.gemini.model;
    const estimate = tokenCounterService.estimateCost(prompt, modelName, expectedOutputTokens);
    const estimatedTokens = tokenCounterService.estimateTokens(prompt);
    
    res.json({
      success: true,
      data: {
        estimatedInputTokens: estimatedTokens,
        estimatedOutputTokens: expectedOutputTokens,
        estimatedTotalTokens: estimatedTokens + expectedOutputTokens,
        estimatedCost: estimate,
        model: modelName,
      },
    });
  } catch (error) {
    next(error);
  }
});

router.get('/usage', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user?.tenantId || 'default';
    const { startDate, endDate } = req.query;
    
    const summary = tokenCounterService.getTenantUsageSummary(
      tenantId,
      startDate ? new Date(startDate as string) : undefined,
      endDate ? new Date(endDate as string) : undefined
    );
    
    res.json({
      success: true,
      data: summary,
    });
  } catch (error) {
    next(error);
  }
});

router.get('/usage/recent', authenticate, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const tenantId = req.user?.tenantId || 'default';
    const limit = parseInt(req.query.limit as string) || 100;
    
    const records = tokenCounterService.getRecentUsage(tenantId, limit);
    
    res.json({
      success: true,
      data: records,
    });
  } catch (error) {
    next(error);
  }
});

export default router;
