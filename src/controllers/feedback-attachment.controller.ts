import { Request, Response, NextFunction } from 'express';
import { FeedbackAttachmentService } from '../services/feedback/attachment.service';
import { logger } from '../lib/logger';

interface MulterFile {
  fieldname: string;
  originalname: string;
  encoding: string;
  mimetype: string;
  size: number;
  buffer: Buffer;
}

export class FeedbackAttachmentController {
  constructor(private service: FeedbackAttachmentService) {}

  upload = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { feedbackId } = req.params;
      const userId = req.user?.id;
      const files = req.files as MulterFile[];

      logger.info(`Attachment upload request - feedbackId: ${feedbackId}, files count: ${files?.length || 0}, content-type: ${req.headers['content-type']}`);

      if (!files || files.length === 0) {
        logger.warn(`No files in upload request. req.file: ${JSON.stringify(req.file)}, body keys: ${Object.keys(req.body || {}).join(', ')}`);
        return res.status(400).json({
          success: false,
          error: { code: 'NO_FILES', message: 'No files provided. Send files with field name "files"' },
        });
      }

      const attachments = await Promise.all(
        files.map(file => this.service.upload(feedbackId, file, userId))
      );

      res.status(201).json({ success: true, data: attachments });
    } catch (error) {
      next(error);
    }
  };

  list = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { feedbackId } = req.params;
      const attachments = await this.service.list(feedbackId);
      res.json({ success: true, data: attachments });
    } catch (error) {
      next(error);
    }
  };

  download = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { id } = req.params;
      const result = await this.service.getDownloadUrl(id);
      res.json({ success: true, data: result });
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
