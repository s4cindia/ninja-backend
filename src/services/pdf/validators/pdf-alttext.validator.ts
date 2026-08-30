/**
 * PDF Alt Text Validator
 *
 * Validates alternative text for images and figures in PDF documents.
 * Checks alt text presence, quality, and appropriateness using AI analysis.
 *
 * Maps issues to WCAG 1.1.1 and Matterhorn Protocol checkpoints.
 */

import { z } from 'zod';
import { SchemaType, Schema } from '@google/generative-ai';
import { AuditIssue, IssueTriage } from '../../audit/base-audit.service';
import { imageExtractorService, ImageInfo } from '../image-extractor.service';
import { pdfParserService, ParsedPDF } from '../pdf-parser.service';
import { geminiService } from '../../ai/gemini.service';
import { GeminiBlockedResponseError } from '../../ai/gemini-errors';
import { logger } from '../../../lib/logger';

// Gemini-side schema (forces valid JSON matching this shape — no markdown
// fences, no preamble, no truncated-before-closing-brace responses) plus a
// Zod schema to validate what comes back. Two layers: the model is
// constrained at generation time, and the response is still verified on
// receipt rather than trusted blindly.
const ASSESS_ALT_TEXT_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    matchesContent: { type: SchemaType.BOOLEAN },
    suggestedAltText: { type: SchemaType.STRING },
  },
  required: ['matchesContent', 'suggestedAltText'],
};
const AssessAltTextResult = z.object({
  matchesContent: z.boolean(),
  suggestedAltText: z.string(),
});

const CLASSIFY_IMAGE_SCHEMA: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    isDecorative: { type: SchemaType.BOOLEAN },
    altText: { type: SchemaType.STRING },
    confidence: { type: SchemaType.NUMBER },
  },
  required: ['isDecorative', 'altText', 'confidence'],
};
const ClassifyImageResult = z.object({
  isDecorative: z.boolean(),
  altText: z.string(),
  confidence: z.number(),
});

/**
 * Alt text quality assessment result
 */
interface AltTextQualityAssessment {
  isDescriptive: boolean;
  hasGenericText: boolean;
  hasRedundantPrefix: boolean;
  isAppropriateLength: boolean;
  matchesContent?: boolean;
  suggestedAltText?: string;
  issues: string[];
}

/**
 * Validation result for alt text checks
 */
export interface AltTextValidationResult {
  issues: AuditIssue[];
  summary: {
    critical: number;
    serious: number;
    moderate: number;
    minor: number;
    total: number;
  };
  metadata: {
    totalImages: number;
    imagesWithAltText: number;
    imagesWithoutAltText: number;
    decorativeImages: number;
    imagesWithQualityIssues: number;
  };
}

/**
 * PDF Alt Text Validator Service
 *
 * Validates alternative text for images and figures in PDF documents
 * following WCAG 1.1.1 and Matterhorn Protocol standards.
 */
class PDFAltTextValidator {
  private issueCounter = 0;
  private readonly GENERIC_ALT_TEXT = [
    'image',
    'photo',
    'picture',
    'graphic',
    'figure',
    'img',
    'icon',
    'logo',
  ];
  private readonly REDUNDANT_PREFIXES = [
    'image of',
    'picture of',
    'photo of',
    'graphic of',
    'figure of',
    'illustration of',
    'screenshot of',
  ];
  private readonly MIN_ALT_TEXT_LENGTH = 3;
  private readonly MAX_ALT_TEXT_LENGTH = 150;
  private readonly RECOMMENDED_MAX_LENGTH = 125;

  /**
   * Validate PDF alt text from file path
   *
   * @param filePath - Path to PDF file
   * @param useAI - Whether to use AI for quality assessment (default: true)
   * @returns Validation result with issues
   */
  async validateFromFile(filePath: string, useAI: boolean = true): Promise<AltTextValidationResult> {
    logger.info(`[PDFAltTextValidator] Starting validation for ${filePath}`);

    const parsedPdf = await pdfParserService.parse(filePath);

    try {
      return await this.validate(parsedPdf, useAI);
    } finally {
      await pdfParserService.close(parsedPdf);
    }
  }

  /**
   * Validate PDF alt text from parsed PDF
   *
   * @param parsedPdf - Parsed PDF document
   * @param useAI - Whether to use AI for quality assessment
   * @returns Validation result with issues
   */
  async validate(parsedPdf: ParsedPDF, useAI: boolean = true): Promise<AltTextValidationResult> {
    this.issueCounter = 0;
    const issues: AuditIssue[] = [];

    logger.info('[PDFAltTextValidator] Extracting images from PDF...');

    // Extract all images from the PDF
    const documentImages = await imageExtractorService.extractImages(parsedPdf, {
      includeBase64: useAI, // Only include base64 if we're doing AI analysis
      maxImageSize: 1024,
      minWidth: 10,
      minHeight: 10,
    });

    logger.info(`[PDFAltTextValidator] Found ${documentImages.totalImages} images`);

    // Build page-dimension lookup (width/height at scale=1 in PDF points)
    const pageDims = new Map(
      parsedPdf.structure.pages.map(p => [p.pageNumber, { width: p.width, height: p.height }])
    );

    // Validate each image
    for (const pageImages of documentImages.pages) {
      for (const image of pageImages.images) {
        const pageSize = pageDims.get(image.pageNumber) ?? { width: 0, height: 0 };
        const imageIssues = await this.validateImage(image, useAI, pageSize);
        issues.push(...imageIssues);
      }
    }

    // Calculate summary
    const summary = this.calculateSummary(issues);

    const metadata = {
      totalImages: documentImages.totalImages,
      imagesWithAltText: documentImages.imagesWithAltText,
      imagesWithoutAltText: documentImages.imagesWithoutAltText,
      decorativeImages: documentImages.decorativeImages,
      imagesWithQualityIssues: issues.filter(i =>
        i.code === 'MATTERHORN-13-004' ||
        i.code === 'ALT-TEXT-QUALITY'
      ).length,
    };

    logger.info(`[PDFAltTextValidator] Validation complete - ${issues.length} issues found`);

    return {
      issues,
      summary,
      metadata,
    };
  }

  /**
   * Validate a single image for alt text
   *
   * @param image - Image information
   * @param useAI - Whether to use AI for quality assessment
   * @returns Array of issues for this image
   */
  private async validateImage(
    image: ImageInfo,
    useAI: boolean,
    pageSize: { width: number; height: number }
  ): Promise<AuditIssue[]> {
    const issues: AuditIssue[] = [];

    // Skip decorative images marked as artifacts
    if (image.isDecorative) {
      return issues;
    }

    // An explicitly empty /Alt ("") is the PDF/UA-compliant way to mark an image as
    // decorative without a full Artifact structural conversion — distinct from no /Alt
    // entry at all (image.altText === undefined). Treat it as already resolved, the
    // same as isDecorative above, rather than re-flagging it as missing alt text.
    if (image.altText === '') {
      return issues;
    }

    // Check if image has alt text
    if (!image.altText) {
      let suggestion: string;
      let triage: IssueTriage | undefined;

      if (useAI && image.base64) {
        const classified = await this.classifyAndGenerateAltText(image);
        if (classified.blocked) {
          // Content flagged by Gemini's safety filter -- no classification
          // or draft text exists at all, so present this honestly as a
          // manual-review item rather than the misleading
          // "AI-generated alt text: \"\"" the generic fallback would produce.
          triage = {
            disposition: 'manual',
            method: 'vision',
            confidence: 0,
          };
          suggestion = 'AI could not generate alt text for this image — content was flagged by an automated safety filter. Manual review required.';
        } else {
          triage = {
            disposition: classified.isDecorative ? 'auto-resolved' : 'ai-drafted',
            method: 'vision',
            confidence: classified.confidence,
            autoFix: {
              description: classified.isDecorative
                ? 'Image appears decorative — mark alt="" to suppress screen reader announcement'
                : 'AI-generated alt text — review and approve before applying',
              value: classified.isDecorative ? '' : classified.altText,
              requiresApproval: !classified.isDecorative,
            },
          };
          suggestion = classified.isDecorative
            ? 'Image appears decorative — set alt="" in the authoring tool'
            : `AI-generated alt text: "${classified.altText}"`;
        }
      } else {
        suggestion = 'Add descriptive alternative text to the image. Alt text should convey the same information as the image.';
      }

      const issue = this.createIssue({
        source: 'pdf-alttext',
        severity: 'critical',
        code: 'MATTERHORN-13-001',
        message: `Image on page ${image.pageNumber} has no alternative text`,
        wcagCriteria: ['1.1.1'],
        location: `Page ${image.pageNumber}, Image ${image.index + 1}`,
        suggestion,
        category: 'alt-text',
        element: image.id,
        pageNumber: image.pageNumber,
        matterhornCheckpoint: '13-001',
        matterhornHow: 'M',
        triage,
        boundingBox: {
          x: image.position.x,
          y: image.position.y,
          width: image.position.width,
          height: image.position.height,
          pageWidth: pageSize.width,
          pageHeight: pageSize.height,
        },
      });
      logger.debug(`[DEBUG] Created issue with pageNumber: ${issue.pageNumber} for image on page ${image.pageNumber}`);
      issues.push(issue);
      return issues;
    }

    // Assess alt text quality
    const quality = await this.assessAltTextQuality(image, useAI);

    // Check for generic alt text (serious issue)
    if (quality.hasGenericText) {
      issues.push(this.createIssue({
        source: 'pdf-alttext',
        severity: 'serious',
        code: 'MATTERHORN-13-004',
        message: `Image on page ${image.pageNumber} has generic alt text: "${image.altText}"`,
        wcagCriteria: ['1.1.1'],
        location: `Page ${image.pageNumber}, Image ${image.index + 1}`,
        suggestion: quality.suggestedAltText || 'Replace generic alt text with a meaningful description of the image content.',
        category: 'alt-text',
        element: image.id,
        context: `Current alt text: "${image.altText}"`,
        pageNumber: image.pageNumber,
        matterhornCheckpoint: '13-004',
        matterhornHow: 'M',
        boundingBox: {
          x: image.position.x,
          y: image.position.y,
          width: image.position.width,
          height: image.position.height,
          pageWidth: pageSize.width,
          pageHeight: pageSize.height,
        },
      }));
    }

    // Check for quality issues (moderate severity)
    if (quality.issues.length > 0 && !quality.hasGenericText) {
      const issueDescription = quality.issues.join('; ');

      issues.push(this.createIssue({
        source: 'pdf-alttext',
        severity: 'moderate',
        code: 'ALT-TEXT-QUALITY',
        message: `Image on page ${image.pageNumber} has alt text quality issues: ${issueDescription}`,
        wcagCriteria: ['1.1.1'],
        location: `Page ${image.pageNumber}, Image ${image.index + 1}`,
        suggestion: quality.suggestedAltText || this.getQualityImprovementSuggestion(quality),
        category: 'alt-text',
        element: image.id,
        context: `Current alt text: "${image.altText}"`,
        pageNumber: image.pageNumber,
        boundingBox: {
          x: image.position.x,
          y: image.position.y,
          width: image.position.width,
          height: image.position.height,
          pageWidth: pageSize.width,
          pageHeight: pageSize.height,
        },
      }));
    }

    // Check for redundant prefix (minor issue)
    if (quality.hasRedundantPrefix && !quality.hasGenericText && quality.issues.length === 0) {
      issues.push(this.createIssue({
        source: 'pdf-alttext',
        severity: 'minor',
        code: 'ALT-TEXT-REDUNDANT-PREFIX',
        message: `Image on page ${image.pageNumber} has redundant prefix in alt text`,
        wcagCriteria: ['1.1.1'],
        location: `Page ${image.pageNumber}, Image ${image.index + 1}`,
        suggestion: `Remove the redundant prefix. Alt text: "${image.altText}"`,
        category: 'alt-text',
        element: image.id,
        context: `Current alt text: "${image.altText}"`,
        pageNumber: image.pageNumber,
        boundingBox: {
          x: image.position.x,
          y: image.position.y,
          width: image.position.width,
          height: image.position.height,
          pageWidth: pageSize.width,
          pageHeight: pageSize.height,
        },
      }));
    }

    return issues;
  }

  /**
   * Assess alt text quality
   *
   * @param image - Image information
   * @param useAI - Whether to use AI for assessment
   * @returns Quality assessment result
   */
  private async assessAltTextQuality(
    image: ImageInfo,
    useAI: boolean
  ): Promise<AltTextQualityAssessment> {
    const altText = image.altText || '';
    const altTextLower = altText.toLowerCase().trim();
    const issues: string[] = [];

    // Check for generic text
    const hasGenericText = this.GENERIC_ALT_TEXT.some(generic =>
      altTextLower === generic || altTextLower === `${generic}.`
    );

    // Check for redundant prefix
    const hasRedundantPrefix = this.REDUNDANT_PREFIXES.some(prefix =>
      altTextLower.startsWith(prefix)
    );

    // Check length appropriateness
    const isAppropriateLength =
      altText.length >= this.MIN_ALT_TEXT_LENGTH &&
      altText.length <= this.MAX_ALT_TEXT_LENGTH;

    if (altText.length < this.MIN_ALT_TEXT_LENGTH) {
      issues.push('too short');
    } else if (altText.length > this.MAX_ALT_TEXT_LENGTH) {
      issues.push('too long (over 150 characters)');
    } else if (altText.length > this.RECOMMENDED_MAX_LENGTH) {
      issues.push('longer than recommended (over 125 characters)');
    }

    // Check if descriptive (not just generic)
    const isDescriptive = !hasGenericText && altText.length > this.MIN_ALT_TEXT_LENGTH;

    let matchesContent: boolean | undefined;
    let suggestedAltText: string | undefined;

    // Use AI to verify alt text matches image content
    if (useAI && image.base64 && !hasGenericText) {
      try {
        const aiAssessment = await this.assessAltTextWithAI(image);
        matchesContent = aiAssessment.matchesContent;

        if (!matchesContent || issues.length > 0) {
          suggestedAltText = aiAssessment.suggestedAltText;
        }

        if (!matchesContent) {
          issues.push('does not accurately describe image content');
        }
      } catch (error) {
        if (error instanceof GeminiBlockedResponseError) {
          // A durable, non-retryable signal (content flagged by Gemini's
          // safety filter) -- unlike a generic/transient failure, silently
          // continuing here would let an image whose alt text can never be
          // AI-verified pass through with no issue at all whenever the
          // existing alt text otherwise happens to pass the basic heuristic
          // checks above. Surface it as an explicit issue instead.
          logger.warn(`[PDFAltTextValidator] AI assessment blocked by safety filter for image ${image.id} (finishReason: ${error.finishReason})`);
          issues.push('AI could not verify this image — content was flagged by an automated safety filter');
          suggestedAltText = 'Manual review required: automated content verification was blocked for this image. Confirm the existing alt text accurately describes its content.';
        } else {
          logger.warn(`[PDFAltTextValidator] AI assessment failed for image ${image.id}:`, error);
          // Continue without AI assessment
        }
      }
    }

    return {
      isDescriptive,
      hasGenericText,
      hasRedundantPrefix,
      isAppropriateLength,
      matchesContent,
      suggestedAltText,
      issues,
    };
  }

  /**
   * Assess alt text using AI (Gemini)
   *
   * @param image - Image with base64 data
   * @returns AI assessment result
   */
  private async assessAltTextWithAI(image: ImageInfo): Promise<{
    matchesContent: boolean;
    suggestedAltText: string;
  }> {
    if (!image.base64) {
      throw new Error('Image base64 data required for AI assessment');
    }

    const prompt = `Analyze this image and evaluate the provided alternative text.

Current alt text: "${image.altText}"

Tasks:
1. Determine if the alt text accurately describes the image content (yes/no)
2. Generate an improved alt text suggestion (max 125 characters) that:
   - Describes the essential information in the image
   - Does not start with "image of" or "picture of"
   - Is concise and clear
   - Focuses on what's important for understanding the content

Respond with ONLY the raw JSON object below — no preamble, no explanation, no
markdown code fences. Your response must start with "{" and contain nothing else:
{
  "matchesContent": true or false,
  "suggestedAltText": "your suggestion here"
}`;

    try {
      // responseSchema alone doesn't guarantee compliance — retry with a
      // correction prompt (same image re-attached) on a parse miss rather
      // than giving up after one attempt. maxOutputTokens raised 300 -> 600:
      // the model would often prefix responses with an unwanted "Here is
      // the analysis..." preamble despite instructions, and at 300 tokens
      // that preamble frequently ate enough of the budget to truncate the
      // JSON itself mid-string (seen live as sustained "Unexpected end of
      // JSON input" / "Here is th"-prefixed parse failures on a real trial).
      // Since maxOutputTokens is fixed per call and reused unchanged on
      // every retry attempt, a too-tight budget made retries just as likely
      // to truncate as the first attempt — a stronger-worded retry prompt
      // alone can't fix a budget problem.
      const { data } = await geminiService.analyzeImageWithSchema(
        image.base64,
        image.mimeType,
        prompt,
        AssessAltTextResult,
        { model: 'flash', temperature: 0.3, maxOutputTokens: 600, responseSchema: ASSESS_ALT_TEXT_SCHEMA },
        { maxRetries: 2 }
      );
      return { matchesContent: data.matchesContent, suggestedAltText: data.suggestedAltText };
    } catch (error) {
      logger.error('[PDFAltTextValidator] Failed to parse AI assessment response:', error);
      throw error;
    }
  }

  /**
   * Classify image as decorative or content, and generate alt text if content.
   * Used for MATTERHORN-13-001 (missing alt text) triage annotation.
   */
  private async classifyAndGenerateAltText(image: ImageInfo): Promise<{
    isDecorative: boolean;
    altText: string;
    confidence: number;
    /** True when Gemini's safety filter blocked this request -- distinguishes
     * a durable "AI cannot process this image" outcome from the generic
     * fallback below, which the caller renders as a legitimate manual-review
     * signal instead of a fake auto-drafted result. */
    blocked?: boolean;
  }> {
    const prompt = `Analyze this image from a PDF document.

Tasks:
1. Is this image decorative? (ornamental borders, horizontal rules, background textures, and page decorations with no information content are decorative; treat logos and brand marks as informative unless surrounding text already conveys the same information)
2. If not decorative, write concise alt text in 1-2 sentences (max 125 characters).

Respond with ONLY the raw JSON object below — no preamble, no explanation, no
markdown code fences. Your response must start with "{" and contain nothing else:
{
  "isDecorative": true|false,
  "altText": "description here, or empty string if decorative",
  "confidence": 0.0-1.0
}`;

    try {
      // responseSchema alone doesn't guarantee compliance — retry with a
      // correction prompt (same image re-attached) on a parse miss rather
      // than giving up after one attempt. maxOutputTokens raised 300 -> 600 —
      // see the matching comment in assessAltTextWithAI above for why.
      const { data } = await geminiService.analyzeImageWithSchema(
        image.base64!,
        image.mimeType,
        prompt,
        ClassifyImageResult,
        { model: 'flash', temperature: 0.2, maxOutputTokens: 600, responseSchema: CLASSIFY_IMAGE_SCHEMA },
        { maxRetries: 2 }
      );

      return {
        isDecorative: data.isDecorative,
        altText: data.altText.trim().substring(0, 125),
        confidence: Math.min(1, Math.max(0, data.confidence)),
      };
    } catch (err) {
      if (err instanceof GeminiBlockedResponseError) {
        logger.warn(`[PDFAltTextValidator] AI classification blocked by safety filter for image ${image.id} (finishReason: ${err.finishReason})`);
        // Genuine confidence here is zero -- there is no classification at
        // all, unlike the generic-failure fallback below (which keeps its
        // existing 0.5 "we don't know" value). The caller uses `blocked` to
        // present this honestly instead of as a fake auto-drafted result.
        return { isDecorative: false, altText: '', confidence: 0, blocked: true };
      }
      logger.warn(`[PDFAltTextValidator] AI classification failed for image ${image.id}: ${err instanceof Error ? err.message : String(err)}`);
      return { isDecorative: false, altText: '', confidence: 0.5 };
    }
  }

  /**
   * Generate alt text suggestion using AI
   *
   * @param image - Image with base64 data
   * @returns Suggested alt text
   */
  private async generateAltTextSuggestion(image: ImageInfo): Promise<string> {
    if (!image.base64) {
      return 'Add descriptive alternative text to the image.';
    }

    try {
      const prompt = `Generate alternative text for this image. The alt text should:
- Describe the essential information in the image
- Be concise (max 125 characters)
- Not start with "image of" or "picture of"
- Focus on what's important for understanding the content

Respond with ONLY the alt text, no additional explanation.`;

      const response = await geminiService.analyzeImage(
        image.base64,
        image.mimeType,
        prompt,
        {
          model: 'flash',
          temperature: 0.5,
          maxOutputTokens: 100,
        }
      );

      const suggestion = response.text.trim().replace(/^["']|["']$/g, '');
      return `AI suggestion: "${suggestion}"`;
    } catch (error) {
      logger.warn(`[PDFAltTextValidator] Failed to generate AI suggestion:`, error);
      return 'Add descriptive alternative text to the image.';
    }
  }

  /**
   * Get quality improvement suggestion based on assessment
   *
   * @param quality - Quality assessment
   * @returns Improvement suggestion
   */
  private getQualityImprovementSuggestion(quality: AltTextQualityAssessment): string {
    const suggestions: string[] = [];

    if (quality.issues.includes('too short')) {
      suggestions.push('Make the alt text more descriptive');
    }
    if (quality.issues.includes('too long (over 150 characters)')) {
      suggestions.push('Shorten the alt text to under 150 characters');
    } else if (quality.issues.includes('longer than recommended (over 125 characters)')) {
      suggestions.push('Consider shortening the alt text to under 125 characters');
    }
    if (quality.issues.includes('does not accurately describe image content')) {
      suggestions.push('Ensure the alt text accurately describes what is shown in the image');
    }

    if (suggestions.length === 0) {
      return 'Review and improve the alt text to better describe the image content.';
    }

    return suggestions.join('. ') + '.';
  }

  /**
   * Create an audit issue with auto-incremented ID
   *
   * @param data - Issue data without ID
   * @returns Complete audit issue
   */
  private createIssue(data: Omit<AuditIssue, 'id'>): AuditIssue {
    return {
      id: `pdf-alttext-${++this.issueCounter}`,
      ...data,
    };
  }

  /**
   * Calculate summary counts by severity
   *
   * @param issues - Array of issues
   * @returns Summary with counts
   */
  private calculateSummary(issues: AuditIssue[]): AltTextValidationResult['summary'] {
    return {
      critical: issues.filter(i => i.severity === 'critical').length,
      serious: issues.filter(i => i.severity === 'serious').length,
      moderate: issues.filter(i => i.severity === 'moderate').length,
      minor: issues.filter(i => i.severity === 'minor').length,
      total: issues.length,
    };
  }
}

export const pdfAltTextValidator = new PDFAltTextValidator();
