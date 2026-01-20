import { Request, Response, NextFunction } from 'express';
import { authorizeJobAccess } from '../utils/authorization';
import { Job } from '@prisma/client';
import { logger } from '../lib/logger';

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
  } catch (error) {
    logger.warn(`Authorization failed for job ${req.params.jobId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    res.status(404).json({ 
      success: false,
      error: { message: 'Resource not found or access denied' }
    });
    return;
  }
};

export const authorizeAcr = async (req: Request, res: Response, next: NextFunction) => {
  try {
    // ACR (Accessibility Conformance Report) is generated from job audit results
    // The acrId parameter is actually the jobId of the source audit job
    // Strip 'acr-' prefix if present (frontend may add this prefix)
    let acrId = req.params.acrId;
    if (acrId && acrId.startsWith('acr-')) {
      acrId = acrId.substring(4);
    }
    // Also strip 'upload-' prefix if present
    if (acrId && acrId.startsWith('upload-')) {
      acrId = acrId.substring(7);
    }
    // Update params with cleaned acrId for downstream use
    req.params.acrId = acrId;
    
    const userId = req.user?.id;
    const tenantId = req.user?.tenantId;

    if (!userId || !tenantId) {
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

    // Try to authorize by job ID first (for backwards compatibility)
    // Then check if this is an acrJob ID and validate ownership
    try {
      const job = await authorizeJobAccess(acrId, userId);
      req.job = job;
    } catch (jobError) {
      // If job not found, check if acrId is an ACR job ID with tenant/user validation
      const prisma = (await import('../lib/prisma')).default;
      const acrJob = await prisma.acrJob.findFirst({
        where: {
          id: acrId,
          userId: userId,
          tenantId: tenantId,
        },
        include: { job: true }
      });
      
      if (acrJob && acrJob.job) {
        req.job = acrJob.job;
      } else {
        throw jobError;
      }
    }
    next();
  } catch (error) {
    logger.warn(`Authorization failed for ACR ${req.params.acrId}: ${error instanceof Error ? error.message : 'Unknown error'}`);
    res.status(404).json({ 
      success: false, 
      error: { message: 'Resource not found or access denied' } 
    });
    return;
  }
};
