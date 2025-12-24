import { Request, Response, NextFunction } from 'express';
import { authorizeJobAccess } from '../utils/authorization';
import { Job } from '@prisma/client';

declare global {
  namespace Express {
    interface Request {
      job?: Job;
    }
  }
}

export const authorizeJob = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const jobId = req.params.jobId;
    const userId = req.user?.id;
    
    if (!userId) {
      res.status(401).json({ 
        success: false,
        error: { message: 'Authentication required' }
      });
      return;
    }
    
    if (!jobId) {
      res.status(400).json({ 
        success: false,
        error: { message: 'Job ID is required' }
      });
      return;
    }
    
    const job = await authorizeJobAccess(jobId, userId);
    req.job = job;
    next();
  } catch {
    res.status(404).json({ 
      success: false,
      error: { message: 'Resource not found or access denied' }
    });
    return;
  }
};

export const authorizeAcr = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const acrId = req.params.acrId;
    const userId = req.user?.id;

    if (!userId) {
      res.status(401).json({ 
        success: false, 
        error: { message: 'Authentication required' } 
      });
      return;
    }

    if (!acrId) {
      res.status(400).json({ 
        success: false, 
        error: { message: 'ACR ID is required' } 
      });
      return;
    }

    const job = await authorizeJobAccess(acrId, userId);
    req.job = job;
    next();
  } catch {
    res.status(404).json({ 
      success: false, 
      error: { message: 'Resource not found or access denied' } 
    });
    return;
  }
};
