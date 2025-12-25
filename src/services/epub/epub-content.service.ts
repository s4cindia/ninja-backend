import * as path from 'path';
import AdmZip from 'adm-zip';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { fileStorageService } from '../storage/file-storage.service';

export class EpubContentService {
  async getContent(jobId: string, filePath: string, userId?: string): Promise<{ content: string; contentType: string } | null> {
    const whereClause: { id: string; userId?: string } = { id: jobId };
    if (userId) {
      whereClause.userId = userId;
    }

    const job = await prisma.job.findFirst({
      where: whereClause,
    });

    if (!job) {
      throw new Error('Job not found or access denied');
    }

    const jobInput = job.input as Record<string, unknown> | null;
    const fileName = (jobInput?.fileName as string) || 'document.epub';

    const epubBuffer = await fileStorageService.getFile(jobId, fileName);
    if (!epubBuffer) {
      throw new Error('EPUB file not found');
    }

    const normalizedPath = path.normalize(filePath).replace(/^(\.\.(\/|\\|$))+/, '');
    if (normalizedPath.includes('..')) {
      throw new Error('Invalid file path');
    }

    try {
      const zip = new AdmZip(epubBuffer);
      
      let entry = zip.getEntry(normalizedPath);

      if (!entry) {
        const searchFileName = path.basename(normalizedPath);
        const entries = zip.getEntries();

        for (const e of entries) {
          if (e.entryName.endsWith(searchFileName) || e.entryName.endsWith('/' + searchFileName)) {
            entry = e;
            logger.info(`[EPUB Content] Found file at: ${e.entryName}`);
            break;
          }
        }
      }

      if (!entry) {
        const availableFiles = zip.getEntries().map(e => e.entryName).slice(0, 20);
        logger.warn(`[EPUB Content] File not found: ${normalizedPath}. Available: ${availableFiles.join(', ')}`);
        throw new Error('File not found in EPUB');
      }

      const contentType = this.getContentType(entry.entryName);
      
      const isBinary = contentType.startsWith('image/') ||
                       contentType === 'application/octet-stream';

      let content: string;
      let finalContentType: string;

      if (isBinary) {
        content = entry.getData().toString('base64');
        finalContentType = `${contentType};base64`;
      } else {
        content = entry.getData().toString('utf8');
        finalContentType = contentType;
      }

      logger.info(`[EPUB Content] Served ${entry.entryName} from job ${jobId} (binary: ${isBinary})`);

      return { content, contentType: finalContentType };
    } catch (error) {
      if (error instanceof Error && error.message.includes('not found')) {
        throw error;
      }
      logger.error(`[EPUB Content] Failed to extract content from ${jobId}`, error as Error);
      throw new Error('Failed to extract EPUB content');
    }
  }

  private getContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const types: Record<string, string> = {
      '.xhtml': 'application/xhtml+xml',
      '.html': 'text/html',
      '.htm': 'text/html',
      '.xml': 'application/xml',
      '.css': 'text/css',
      '.js': 'application/javascript',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.ncx': 'application/x-dtbncx+xml',
      '.opf': 'application/oebps-package+xml',
    };
    return types[ext] || 'text/plain';
  }
}

export const epubContentService = new EpubContentService();
