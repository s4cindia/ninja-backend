import { Router, Request, Response } from 'express';
import * as path from 'path';
import * as fs from 'fs/promises';

const router = Router();

const EXPORTS_DIR = path.join(process.cwd(), 'exports');

const MIME_TYPES: Record<string, string> = {
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.pdf': 'application/pdf',
  '.html': 'text/html'
};

router.get('/:filename', async (req: Request, res: Response) => {
  try {
    const { filename } = req.params;
    
    const safeFilename = path.basename(filename);
    if (safeFilename !== filename || filename.includes('..')) {
      res.status(400).json({
        success: false,
        error: { message: 'Invalid filename' }
      });
      return;
    }

    const filepath = path.join(EXPORTS_DIR, safeFilename);
    
    try {
      await fs.access(filepath);
    } catch {
      res.status(404).json({
        success: false,
        error: { message: 'File not found or expired' }
      });
      return;
    }

    const ext = path.extname(filename).toLowerCase();
    const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

    res.setHeader('Content-Type', mimeType);
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
    
    const fileBuffer = await fs.readFile(filepath);
    res.send(fileBuffer);
  } catch (error) {
    console.error('Export download error:', error);
    res.status(500).json({
      success: false,
      error: { message: 'Failed to download file' }
    });
  }
});

export default router;
