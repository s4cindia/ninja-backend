import { Request, Response, NextFunction } from 'express';
import { epubContentService } from '../services/epub/epub-content.service';
import { logger } from '../lib/logger';

export const epubContentController = {
  async getContent(req: Request, res: Response, next: NextFunction) {
    try {
      const { jobId } = req.params;
      const filePath = req.query.path as string;
      const userId = req.user?.id;

      if (!filePath) {
        res.status(400).json({
          success: false,
          error: { message: 'File path required' },
        });
        return;
      }

      const result = await epubContentService.getContent(jobId, filePath, userId);
      
      if (!result) {
        res.status(404).json({
          success: false,
          error: { message: 'Content not found' },
        });
        return;
      }

      res.setHeader('Content-Type', result.contentType);
      res.send(result.content);
    } catch (error) {
      if (error instanceof Error) {
        if (error.message === 'Job not found or access denied') {
          res.status(404).json({
            success: false,
            error: { message: error.message },
          });
          return;
        }
        if (error.message === 'Invalid file path' || error.message === 'File not found in EPUB') {
          res.status(400).json({
            success: false,
            error: { message: error.message },
          });
          return;
        }
      }
      logger.error('Failed to get EPUB content', error as Error);
      next(error);
    }
  },
};
