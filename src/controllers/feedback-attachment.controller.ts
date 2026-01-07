import { Request, Response, NextFunction } from 'express';
import { FeedbackAttachmentService } from '../services/feedback/attachment.service';
import { logger } from '../lib/logger';

type MulterFile = Express.Multer.File;

export class FeedbackAttachmentController {
  constructor(private service: FeedbackAttachmentService) {}

  upload = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { feedbackId } = req.params;
      const userId = req.user?.id;
      const files = req.files as MulterFile[];

      logger.info(`Attachment upload request - feedbackId: ${feedbackId}, userId: ${userId}, files: ${files?.length || 0}`);

      if (!files || files.length === 0) {
        return res.status(400).json({
          success: false,
          error: { code: 'NO_FILES', message: 'No files provided' },
        });
      }

      const attachments = [];

      try {
        for (const file of files) {
          const attachment = await this.service.upload(feedbackId, file, userId);
          attachments.push(attachment);
        }
      } catch (uploadError) {
        logger.warn(`Partial upload failure after ${attachments.length} files: ${(uploadError as Error).message}`);
        if (attachments.length === 0) {
          throw uploadError;
        }
        return res.status(207).json({
          success: true,
          data: attachments,
          warning: `Only ${attachments.length} of ${files.length} files uploaded successfully`
        });
      }

      res.status(201).json({ success: true, data: attachments });
    } catch (error) {
      next(error);
    }
  };

  list = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { feedbackId } = req.params;
      const userId = req.user?.id;

      const attachments = await this.service.list(feedbackId, userId);
      res.json({ success: true, data: attachments });
    } catch (error) {
      next(error);
    }
  };

  download = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const userId = req.user?.id;

      const result = await this.service.getDownloadUrl(id, userId);
      res.json({ success: true, data: result });
    } catch (error) {
      next(error);
    }
  };

  serveLocalFile = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const userId = req.user?.id;

      const { buffer, attachment } = await this.service.getLocalFile(id, userId);

      const safeFilename = attachment.originalName
        .replace(/[^\w\s.-]/g, '_')
        .replace(/"/g, '\\"');

      res.setHeader('Content-Type', attachment.mimeType);
      res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
      res.setHeader('Content-Length', buffer.length);
      res.send(buffer);
    } catch (error) {
      next(error);
    }
  };

  delete = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const userId = req.user?.id;

      if (!userId) {
        return res.status(401).json({
          success: false,
          error: { code: 'UNAUTHORIZED', message: 'Authentication required' },
        });
      }

      await this.service.delete(id, userId);
      res.json({ success: true, data: { deleted: true } });
    } catch (error) {
      next(error);
    }
  };
}
