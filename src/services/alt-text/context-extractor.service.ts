import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';

interface DocumentContext {
  textBefore: string;
  textAfter: string;
  nearestHeading: string;
  caption?: string;
  documentTitle: string;
  chapterTitle?: string;
  pageNumber?: number;
}

interface ParsedElement {
  type: string;
  id?: string;
  src?: string;
  content?: string;
  text?: string;
  tag?: string;
  level?: number;
  page?: number;
}

interface ParsedContent {
  title?: string;
  elements?: ParsedElement[];
}

interface ImagePosition {
  index: number;
  page?: number;
}

class ContextExtractorService {
  async extractContext(
    jobId: string,
    imageId: string
  ): Promise<DocumentContext> {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
    });

    if (!job) {
      logger.warn(`Context extraction: Job not found for jobId=${jobId}, using default context`);
      return this.getDefaultContext();
    }

    const jobInput = job.input as Record<string, unknown>;
    const jobOutput = job.output as Record<string, unknown>;
    const parsedContent = this.getParsedContent(jobOutput);
    const documentName = (jobInput?.fileName || jobInput?.documentName || 'Unknown Document') as string;
    
    if (!parsedContent) {
      logger.warn(`Context extraction: No parsed content for jobId=${jobId}, imageId=${imageId}, using default context`);
      return {
        ...this.getDefaultContext(),
        documentTitle: documentName,
      };
    }

    const imagePosition = this.findImagePosition(parsedContent, imageId);
    
    return {
      textBefore: this.extractTextBefore(parsedContent, imagePosition, 500),
      textAfter: this.extractTextAfter(parsedContent, imagePosition, 500),
      nearestHeading: this.findNearestHeading(parsedContent, imagePosition),
      caption: this.detectCaption(parsedContent, imagePosition),
      documentTitle: parsedContent.title || documentName,
      chapterTitle: this.findChapterTitle(parsedContent, imagePosition),
      pageNumber: imagePosition?.page,
    };
  }

  private getParsedContent(jobOutput: Record<string, unknown>): ParsedContent | null {
    try {
      if (!jobOutput) return null;
      
      if (jobOutput.parsedContent) {
        return typeof jobOutput.parsedContent === 'string'
          ? JSON.parse(jobOutput.parsedContent)
          : jobOutput.parsedContent as ParsedContent;
      }
      
      if (jobOutput.elements) {
        return jobOutput as unknown as ParsedContent;
      }

      return null;
    } catch (error) {
      console.error('Failed to get parsed content:', error);
      return null;
    }
  }

  private findImagePosition(
    parsedContent: ParsedContent, 
    imageId: string
  ): ImagePosition | null {
    if (!parsedContent.elements) return null;

    const index = parsedContent.elements.findIndex(
      (el: ParsedElement) => el.type === 'image' && (el.id === imageId || el.src?.includes(imageId))
    );

    if (index === -1) return null;

    return {
      index,
      page: parsedContent.elements[index]?.page,
    };
  }

  private extractTextBefore(
    parsedContent: ParsedContent, 
    position: ImagePosition | null, 
    maxChars: number
  ): string {
    if (!position || !parsedContent.elements) return '';

    let text = '';
    for (let i = position.index - 1; i >= 0 && text.length < maxChars; i--) {
      const el = parsedContent.elements[i];
      if (el.type === 'text' || el.type === 'paragraph' || el.type === 'heading') {
        text = (el.content || el.text || '') + ' ' + text;
      }
    }

    return text.trim().slice(-maxChars);
  }

  private extractTextAfter(
    parsedContent: ParsedContent, 
    position: ImagePosition | null, 
    maxChars: number
  ): string {
    if (!position || !parsedContent.elements) return '';

    let text = '';
    for (let i = position.index + 1; i < parsedContent.elements.length && text.length < maxChars; i++) {
      const el = parsedContent.elements[i];
      if (el.type === 'text' || el.type === 'paragraph' || el.type === 'heading') {
        text += ' ' + (el.content || el.text || '');
      }
    }

    return text.trim().slice(0, maxChars);
  }

  private findNearestHeading(
    parsedContent: ParsedContent, 
    position: ImagePosition | null
  ): string {
    if (!position || !parsedContent.elements) return 'Document Content';

    for (let i = position.index - 1; i >= 0; i--) {
      const el = parsedContent.elements[i];
      if (el.type === 'heading' || el.tag?.match(/^h[1-6]$/i)) {
        return el.content || el.text || 'Untitled Section';
      }
    }

    return 'Document Content';
  }

  private detectCaption(
    parsedContent: ParsedContent, 
    position: ImagePosition | null
  ): string | undefined {
    if (!position || !parsedContent.elements) return undefined;

    const nextElement = parsedContent.elements[position.index + 1];
    if (!nextElement) return undefined;

    const text = nextElement.content || nextElement.text || '';
    
    if (this.isLikelyCaption(text)) {
      return text.slice(0, 200);
    }

    return undefined;
  }

  private findChapterTitle(
    parsedContent: ParsedContent, 
    position: ImagePosition | null
  ): string | undefined {
    if (!position || !parsedContent.elements) return undefined;

    for (let i = position.index - 1; i >= 0; i--) {
      const el = parsedContent.elements[i];
      if (el.type === 'heading' && (el.level === 1 || el.tag === 'h1')) {
        return el.content || el.text;
      }
    }

    return undefined;
  }

  private isLikelyCaption(text: string): boolean {
    if (!text || text.length > 300) return false;
    
    const captionPatterns = [
      /^(figure|fig\.?|image|photo|illustration|diagram|chart|table)\s*\d*/i,
      /^(source|credit|courtesy|photo by|image by):/i,
      /^\d+\.\s*(figure|fig)/i,
    ];
    
    return captionPatterns.some(p => p.test(text.trim()));
  }

  private getDefaultContext(): DocumentContext {
    return {
      textBefore: '',
      textAfter: '',
      nearestHeading: 'Document Content',
      documentTitle: 'Unknown Document',
    };
  }
}

export const contextExtractor = new ContextExtractorService();
export type { DocumentContext };
