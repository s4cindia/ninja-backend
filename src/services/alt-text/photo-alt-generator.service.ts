import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import type { DocumentContext } from './context-extractor.service';
import { logger } from '../../lib/logger';

interface AltTextGenerationResult {
  imageId: string;
  shortAlt: string;
  extendedAlt: string;
  confidence: number;
  flags: AltTextFlag[];
  aiModel: string;
  generatedAt: Date;
}

type AltTextFlag = 
  | 'FACE_DETECTED'
  | 'TEXT_IN_IMAGE'
  | 'LOW_CONFIDENCE'
  | 'SENSITIVE_CONTENT'
  | 'COMPLEX_SCENE'
  | 'AUTO_CORRECTED'
  | 'NEEDS_MANUAL_REVIEW'
  | 'REGENERATED'
  | 'PARSE_ERROR';

const FORBIDDEN_PREFIXES = [
  /^image of\s+/i,
  /^photo of\s+/i,
  /^picture of\s+/i,
  /^photograph of\s+/i,
  /^a photo of\s+/i,
  /^an image of\s+/i,
  /^a picture of\s+/i,
];

const MAX_SHORT_ALT_LENGTH = 125;
const MAX_EXTENDED_ALT_LENGTH = 250;

class PhotoAltGeneratorService {
  private genAI: GoogleGenerativeAI;
  private model: GenerativeModel;

  constructor() {
    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY environment variable is required');
    }
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.model = this.genAI.getGenerativeModel({ model: 'gemini-1.5-pro' });
  }

  async generateAltText(
    imageBuffer: Buffer,
    mimeType: string = 'image/jpeg'
  ): Promise<AltTextGenerationResult> {
    const prompt = `
Describe this image for someone who cannot see it.
Requirements:
- Be concise (under 125 characters preferred for short version)
- Focus on: subjects, actions, setting, important colors
- Do NOT start with "Image of", "Photo of", or "Picture of"
- Use present tense
- If text appears in the image, include it

Return JSON only (no markdown):
{
  "shortAlt": "concise description under 125 chars",
  "extendedAlt": "detailed description up to 250 chars",
  "confidence": 85,
  "flags": []
}

Flags to include if applicable:
- "FACE_DETECTED" if human faces are visible
- "TEXT_IN_IMAGE" if text appears in the image
- "COMPLEX_SCENE" if multiple distinct elements
- "SENSITIVE_CONTENT" if potentially sensitive
`;

    const imagePart = {
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType,
      },
    };

    const result = await this.model.generateContent([prompt, imagePart]);
    const response = await result.response;
    const text = response.text();
    
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, ''));
    } catch (parseError) {
      logger.error('Failed to parse Gemini response as JSON:', { text: text.substring(0, 500), error: parseError });
      return {
        imageId: '',
        shortAlt: 'Image description unavailable',
        extendedAlt: '',
        confidence: 0,
        flags: ['LOW_CONFIDENCE', 'PARSE_ERROR'] as AltTextFlag[],
        aiModel: 'gemini-1.5-pro',
        generatedAt: new Date(),
      };
    }
    
    if (parsed.confidence < 70 && !parsed.flags?.includes('LOW_CONFIDENCE')) {
      parsed.flags = parsed.flags || [];
      parsed.flags.push('LOW_CONFIDENCE');
    }

    const sanitized = this.sanitizeAndValidate(
      parsed.shortAlt || '',
      parsed.extendedAlt || '',
      parsed.flags || []
    );

    return {
      imageId: '',
      shortAlt: sanitized.shortAlt,
      extendedAlt: sanitized.extendedAlt,
      confidence: parsed.confidence,
      flags: sanitized.flags,
      aiModel: 'gemini-1.5-pro',
      generatedAt: new Date(),
    };
  }

  private sanitizeAndValidate(
    shortAlt: string,
    extendedAlt: string,
    flags: AltTextFlag[]
  ): { shortAlt: string; extendedAlt: string; flags: AltTextFlag[] } {
    const resultFlags: AltTextFlag[] = [...flags];
    let corrected = false;

    let sanitizedShort = this.stripForbiddenPrefixes(shortAlt);
    let sanitizedExtended = this.stripForbiddenPrefixes(extendedAlt);

    if (sanitizedShort !== shortAlt || sanitizedExtended !== extendedAlt) {
      corrected = true;
    }

    if (sanitizedShort.length > MAX_SHORT_ALT_LENGTH) {
      const truncated = sanitizedShort.substring(0, MAX_SHORT_ALT_LENGTH - 3).trim();
      const lastSpace = truncated.lastIndexOf(' ');
      sanitizedShort = lastSpace > MAX_SHORT_ALT_LENGTH * 0.5 
        ? truncated.substring(0, lastSpace) + '...'
        : truncated + '...';
      corrected = true;
    }

    if (sanitizedExtended.length > MAX_EXTENDED_ALT_LENGTH) {
      const truncated = sanitizedExtended.substring(0, MAX_EXTENDED_ALT_LENGTH - 3).trim();
      const lastSpace = truncated.lastIndexOf(' ');
      sanitizedExtended = lastSpace > MAX_EXTENDED_ALT_LENGTH * 0.5
        ? truncated.substring(0, lastSpace) + '...'
        : truncated + '...';
      corrected = true;
    }

    if (corrected && !resultFlags.includes('AUTO_CORRECTED')) {
      resultFlags.push('AUTO_CORRECTED');
    }

    if (!sanitizedShort || sanitizedShort.length < 10) {
      if (!resultFlags.includes('NEEDS_MANUAL_REVIEW')) {
        resultFlags.push('NEEDS_MANUAL_REVIEW');
      }
    }

    return {
      shortAlt: sanitizedShort,
      extendedAlt: sanitizedExtended,
      flags: resultFlags,
    };
  }

  private stripForbiddenPrefixes(text: string): string {
    let result = text.trim();
    for (const prefix of FORBIDDEN_PREFIXES) {
      result = result.replace(prefix, '');
    }
    if (result !== text.trim() && result.length > 0) {
      result = result.charAt(0).toUpperCase() + result.slice(1);
    }
    return result;
  }

  async generateBatch(
    images: Array<{ id: string; buffer: Buffer; mimeType: string }>
  ): Promise<AltTextGenerationResult[]> {
    const results: AltTextGenerationResult[] = [];
    
    for (const image of images) {
      try {
        const result = await this.generateAltText(image.buffer, image.mimeType);
        result.imageId = image.id;
        results.push(result);
      } catch (error) {
        console.error(`Failed to generate alt text for image ${image.id}:`, error);
        results.push({
          imageId: image.id,
          shortAlt: '',
          extendedAlt: '',
          confidence: 0,
          flags: ['LOW_CONFIDENCE', 'NEEDS_MANUAL_REVIEW'],
          aiModel: 'gemini-1.5-pro',
          generatedAt: new Date(),
        });
      }
      
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    
    return results;
  }

  needsHumanReview(result: AltTextGenerationResult): boolean {
    return (
      result.confidence < 70 ||
      result.flags.includes('FACE_DETECTED') ||
      result.flags.includes('SENSITIVE_CONTENT') ||
      result.flags.includes('LOW_CONFIDENCE') ||
      result.flags.includes('NEEDS_MANUAL_REVIEW')
    );
  }

  async generateContextAwareAltText(
    imageBuffer: Buffer,
    mimeType: string,
    context: DocumentContext
  ): Promise<{
    contextAware: AltTextGenerationResult;
    standalone: AltTextGenerationResult;
  }> {
    const standalone = await this.generateAltText(imageBuffer, mimeType);

    const contextPrompt = `
Describe this image for someone who cannot see it.

DOCUMENT CONTEXT:
- Document: ${context.documentTitle}
${context.chapterTitle ? `- Chapter: ${context.chapterTitle}` : ''}
- Section: ${context.nearestHeading}
${context.caption ? `- Caption: ${context.caption}` : ''}
${context.pageNumber ? `- Page: ${context.pageNumber}` : ''}

TEXT BEFORE IMAGE:
${context.textBefore || '(none available)'}

TEXT AFTER IMAGE:
${context.textAfter || '(none available)'}

Requirements:
- Be concise (under 125 characters for short version)
- Use context to make description more specific and relevant
- Reference document context when it helps understanding
- Do NOT start with "Image of", "Photo of", or "Picture of"
- Do NOT repeat the caption verbatim - provide complementary information
- Use present tense

Return JSON only (no markdown):
{
  "shortAlt": "context-aware description under 125 chars",
  "extendedAlt": "detailed context-aware description up to 250 chars",
  "confidence": 85,
  "flags": [],
  "usedContext": ["nearestHeading", "caption"]
}
`;

    const imagePart = {
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType,
      },
    };

    try {
      const result = await this.model.generateContent([contextPrompt, imagePart]);
      const response = await result.response;
      const text = response.text();
      const parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, ''));

      const sanitized = this.sanitizeAndValidate(
        parsed.shortAlt || '',
        parsed.extendedAlt || '',
        parsed.flags || []
      );

      if (parsed.confidence < 70 && !sanitized.flags.includes('LOW_CONFIDENCE')) {
        sanitized.flags.push('LOW_CONFIDENCE');
      }

      const contextAware: AltTextGenerationResult = {
        imageId: '',
        shortAlt: sanitized.shortAlt,
        extendedAlt: sanitized.extendedAlt,
        confidence: parsed.confidence || 75,
        flags: sanitized.flags,
        aiModel: 'gemini-1.5-pro',
        generatedAt: new Date(),
      };

      return { contextAware, standalone };
    } catch (error) {
      console.error('Context-aware generation failed, returning standalone:', error);
      return { contextAware: standalone, standalone };
    }
  }
}

export const photoAltGenerator = new PhotoAltGeneratorService();
export type { AltTextGenerationResult, AltTextFlag };
