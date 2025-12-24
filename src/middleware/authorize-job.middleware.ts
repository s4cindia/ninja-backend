import { Request, Response, NextFunction } from 'express';
import { authorizeJobAccess } from '../utils/authorization';

declare global {
  namespace Express {
    interface Request {
      job?: Awaited<ReturnType<typeof authorizeJobAccess>>;
    }
  }
}

export const authorizeJob = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const jobId = req.params.jobId;
    const userId = req.user?.id;
    
    if (!userId || !jobId) {
      return res.status(401).json({ 
        success: false,
        error: { message: 'Unauthorized' }
      });
    }
    
    const job = await authorizeJobAccess(jobId, userId);
    req.job = job;
    next();
  } catch (error) {
    return res.status(404).json({ 
      success: false,
      error: { message: 'Resource not found or access denied' }
    });
  }
};

export const authorizeAcr = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const acrId = req.params.acrId;
    const userId = req.user?.id;

    if (!userId) {
      return res.status(401).json({ 
        success: false, 
        error: { message: 'Authentication required' } 
      });
    }

    if (!acrId) {
      return res.status(400).json({ 
        success: false, 
        error: { message: 'ACR ID is required' } 
      });
    }

    const job = await authorizeJobAccess(acrId, userId);
    req.job = job;
    next();
  } catch (error) {
    return res.status(404).json({ 
      success: false, 
      error: { message: 'Resource not found or access denied' } 
    });
  }
};
