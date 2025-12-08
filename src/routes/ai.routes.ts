import { Router, Request, Response, NextFunction } from 'express';
import { authenticate } from '../middleware/auth.middleware';
import { geminiService } from '../services/ai/gemini.service';

const router = Router();

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

export default router;
