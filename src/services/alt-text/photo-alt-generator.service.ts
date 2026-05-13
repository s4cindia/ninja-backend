import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import type { DocumentContext } from './context-extractor.service';
import { logger } from '../../lib/logger';
import { aiConfig } from '../../config/ai.config';

const ACTIVE_MODEL = aiConfig.gemini.model;

/**
 * Generator output profile. The default profile produces standard
 * accessibility alt text. The `prh-uk` profile applies PRH UK
 * Style Guide Appendix 7 rules:
 *   - Literal / objective wording (no "appears to be", "perhaps").
 *   - End every description with a full stop.
 *   - Use neutral / non-gendered language unless context confirms.
 *   - Mention colour only when significant to identification or meaning.
 *   - No forbidden prefixes ("Image of", "Photo of", etc.) — enforced
 *     in the prompt AND post-hoc via stripForbiddenPrefixes.
 */
export type AltTextProfile = 'default' | 'prh-uk';

/**
 * Optional generation tweaks. Callers from PRH-UK audited jobs should
 * set `profile: 'prh-uk'`; for the cover image specifically, also
 * set `isCover: true` and pass the book's `dc:title` as `bookTitle`.
 * When isCover + prh-uk are both set, the generator short-circuits
 * to the PRH-documented template ("Cover for [Book Title].") and
 * skips the Gemini call entirely.
 */
export interface AltTextOptions {
  profile?: AltTextProfile;
  isCover?: boolean;
  bookTitle?: string | null;
}

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
  | 'PARSE_ERROR'
  | 'COVER_TEMPLATE';

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

/**
 * Build the cover-image alt text per PRH Style Guide Appendix 7.
 * `"Cover for [Book Title]."` when title is present; falls back to
 * `"Cover image."` when `dc:title` is missing. Both forms end with
 * the mandatory full stop. This is exported so callers (the
 * controllers wiring PRH-COVER-ALT-EMPTY quick-fix dialogs) can use
 * the same template logic without re-implementing it.
 */
export function buildPrhCoverAlt(bookTitle: string | null | undefined): string {
  const trimmed = (bookTitle ?? '').trim();
  return trimmed.length > 0 ? `Cover for ${trimmed}.` : 'Cover image.';
}

/**
 * Ensure a PRH-mode alt-text string ends with sentence-terminating
 * punctuation. PRH Style Guide Appendix 7 requires every description
 * to end with a full stop; the Gemini model usually complies but can
 * drop it, especially on short outputs. We accept `.`, `!`, `?`, and
 * `…` (the truncation ellipsis) as valid endings; anything else gets
 * a period appended.
 *
 * Empty / whitespace-only strings are returned untouched — callers
 * surface those as NEEDS_MANUAL_REVIEW via a separate code path.
 */
function ensurePrhSentenceEnding(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return text;
  // Treat ASCII `...` (3-char ellipsis), Unicode `…`, and standard
  // sentence terminators as already-ended. Don't append after them.
  if (/(?:\.\.\.|[.!?…])$/.test(trimmed)) return trimmed;
  return `${trimmed}.`;
}

/**
 * Build the standalone alt-text prompt. Two variants:
 *   - default: existing concise-description rules
 *   - prh-uk: PRH UK Style Guide Appendix 7 rules layered on top
 *
 * Both return JSON with shortAlt / extendedAlt / confidence / flags.
 */
function buildAltTextPrompt(profile: AltTextProfile): string {
  if (profile === 'prh-uk') {
    return `
Describe this image for someone who cannot see it.

PRH UK Style Guide Appendix 7 requirements (STRICT — follow exactly):
- Be concise (under 125 characters preferred for short version).
- Use LITERAL, OBJECTIVE wording — describe what's visible. Do NOT
  speculate ("appears to be", "perhaps", "seems to") or interpret
  emotion / motive.
- END every description with a full stop.
- Use NEUTRAL / non-gendered language by default ("person", "they")
  unless visible context (uniform, caption text, etc.) confirms a
  specific identification.
- Mention COLOUR only when it is significant to identification or
  meaning — not as decoration.
- Use ACTION VERBS when motion is depicted ("a hummingbird in flight",
  not just "a hummingbird").
- For images of TEXT, mirror the text content in the description.
- Do NOT start with "Image of", "Photo of", "Picture of", "Photograph
  of", "An image of", "A picture of", "A photo of".
- Present tense.

Return JSON only (no markdown):
{
  "shortAlt": "concise description under 125 chars, ending with a full stop",
  "extendedAlt": "detailed description up to 250 chars, ending with a full stop",
  "confidence": 85,
  "flags": []
}

Flags to include if applicable:
- "FACE_DETECTED" if human faces are visible
- "TEXT_IN_IMAGE" if text appears in the image
- "COMPLEX_SCENE" if multiple distinct elements
- "SENSITIVE_CONTENT" if potentially sensitive
`;
  }
  return `
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
}

/**
 * Build the context-aware prompt. Same default vs prh-uk split as
 * buildAltTextPrompt, plus the surrounding-text context block. PRH
 * mode layers Style Guide Appendix 7 rules over the context-aware
 * directives.
 */
function buildContextAwarePrompt(profile: AltTextProfile, context: DocumentContext): string {
  const contextBlock = `
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
`;

  if (profile === 'prh-uk') {
    return `
Describe this image for someone who cannot see it.
${contextBlock}
PRH UK Style Guide Appendix 7 requirements (STRICT — follow exactly):
- Be concise (under 125 characters preferred for short version).
- Use LITERAL, OBJECTIVE wording — describe what's visible. Do NOT
  speculate ("appears to be", "perhaps", "seems to") or interpret
  emotion / motive.
- END every description with a full stop.
- Use NEUTRAL / non-gendered language by default unless context
  (uniform, caption text, document context) confirms identification.
- Mention COLOUR only when significant.
- Reference document context when it sharpens identification.
- Do NOT repeat the caption verbatim — provide complementary
  information.
- Do NOT start with "Image of", "Photo of", "Picture of", "Photograph
  of", "An image of", "A picture of", "A photo of".
- Present tense.

Return JSON only (no markdown):
{
  "shortAlt": "context-aware description under 125 chars, ending with a full stop",
  "extendedAlt": "detailed context-aware description up to 250 chars, ending with a full stop",
  "confidence": 85,
  "flags": [],
  "usedContext": ["nearestHeading", "caption"]
}
`;
  }
  return `
Describe this image for someone who cannot see it.
${contextBlock}
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
}

class PhotoAltGeneratorService {
  private genAI: GoogleGenerativeAI | null = null;
  private model: GenerativeModel | null = null;

  /**
   * Lazily initialize the Gemini client.
   * This allows the module to be imported without requiring GEMINI_API_KEY,
   * which is needed for CI/CD test runs that don't use this service.
   */
  private ensureInitialized(): void {
    if (this.model) return;

    if (!process.env.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY environment variable is required');
    }
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    this.model = this.genAI.getGenerativeModel({ model: ACTIVE_MODEL });
  }

  async generateAltText(
    imageBuffer: Buffer,
    mimeType: string = 'image/jpeg',
    options: AltTextOptions = {},
  ): Promise<AltTextGenerationResult> {
    const profile: AltTextProfile = options.profile ?? 'default';

    // Cover short-circuit: when the caller flags this as the cover
    // image AND we're in PRH-UK mode, return the documented template
    // ("Cover for [Book Title].") without invoking Gemini. Saves a
    // model call and guarantees the alt text matches PRH spec exactly.
    if (options.isCover && profile === 'prh-uk') {
      const alt = buildPrhCoverAlt(options.bookTitle);
      return {
        imageId: '',
        shortAlt: alt,
        extendedAlt: alt,
        confidence: 100,
        flags: ['COVER_TEMPLATE'],
        aiModel: 'prh-cover-template',
        generatedAt: new Date(),
      };
    }

    const prompt = buildAltTextPrompt(profile);

    const imagePart = {
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType,
      },
    };

    let result;
    let text: string;

    // Ensure Gemini client is initialized (lazy init for CI compatibility)
    this.ensureInitialized();

    try {
      result = await this.model!.generateContent([prompt, imagePart]);
      const response = await result.response;
      text = response.text();
    } catch (apiError) {
      logger.error('Gemini API call failed', apiError instanceof Error ? apiError : undefined);
      return {
        imageId: '',
        shortAlt: 'Image description unavailable',
        extendedAlt: '',
        confidence: 0,
        flags: ['LOW_CONFIDENCE', 'NEEDS_MANUAL_REVIEW'] as AltTextFlag[],
        aiModel: ACTIVE_MODEL,
        generatedAt: new Date(),
      };
    }
    
    let parsed;
    try {
      parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, ''));
    } catch (parseError) {
      logger.error(`Failed to parse Gemini response as JSON. Response preview: ${text.substring(0, 200)}`, parseError instanceof Error ? parseError : undefined);
      return {
        imageId: '',
        shortAlt: 'Image description unavailable',
        extendedAlt: '',
        confidence: 0,
        flags: ['LOW_CONFIDENCE', 'PARSE_ERROR'] as AltTextFlag[],
        aiModel: ACTIVE_MODEL,
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
      parsed.flags || [],
      profile,
    );

    return {
      imageId: '',
      shortAlt: sanitized.shortAlt,
      extendedAlt: sanitized.extendedAlt,
      confidence: parsed.confidence,
      flags: sanitized.flags,
      aiModel: ACTIVE_MODEL,
      generatedAt: new Date(),
    };
  }

  private sanitizeAndValidate(
    shortAlt: string,
    extendedAlt: string,
    flags: AltTextFlag[],
    profile: AltTextProfile = 'default',
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

    // PRH mode: enforce the trailing-full-stop rule on both lengths.
    // The model may drop it (especially after truncation reshapes the
    // tail to "...") so we re-enforce here. Truncated text ending in
    // ellipsis ("...") keeps the ellipsis — adding a period after it
    // produces "....", which is uglier than just the ellipsis.
    if (profile === 'prh-uk') {
      const shortFixed = ensurePrhSentenceEnding(sanitizedShort);
      const extendedFixed = ensurePrhSentenceEnding(sanitizedExtended);
      if (shortFixed !== sanitizedShort || extendedFixed !== sanitizedExtended) {
        sanitizedShort = shortFixed;
        sanitizedExtended = extendedFixed;
        corrected = true;
      }
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
    images: Array<{ id: string; buffer: Buffer; mimeType: string; isCover?: boolean }>,
    options: AltTextOptions = {},
  ): Promise<AltTextGenerationResult[]> {
    const results: AltTextGenerationResult[] = [];

    for (const image of images) {
      try {
        // Per-image isCover overrides any batch-level setting — useful
        // when the batch contains exactly one cover plus N body images.
        const perImageOptions: AltTextOptions = {
          ...options,
          isCover: image.isCover ?? options.isCover,
        };
        const result = await this.generateAltText(image.buffer, image.mimeType, perImageOptions);
        result.imageId = image.id;
        results.push(result);
      } catch (error) {
        logger.error(`Failed to generate alt text for image ${image.id}`, error instanceof Error ? error : undefined);
        results.push({
          imageId: image.id,
          shortAlt: '',
          extendedAlt: '',
          confidence: 0,
          flags: ['LOW_CONFIDENCE', 'NEEDS_MANUAL_REVIEW'],
          aiModel: ACTIVE_MODEL,
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
    context: DocumentContext,
    options: AltTextOptions = {},
  ): Promise<{
    contextAware: AltTextGenerationResult;
    standalone: AltTextGenerationResult;
  }> {
    const profile: AltTextProfile = options.profile ?? 'default';
    const standalone = await this.generateAltText(imageBuffer, mimeType, options);

    // Cover short-circuit: when this is the cover image AND we're in
    // PRH mode, the standalone path already returned the template;
    // context-aware adds nothing useful (the template is fixed).
    if (options.isCover && profile === 'prh-uk') {
      return { contextAware: standalone, standalone };
    }

    const contextPrompt = buildContextAwarePrompt(profile, context);

    const imagePart = {
      inlineData: {
        data: imageBuffer.toString('base64'),
        mimeType,
      },
    };

    // Ensure Gemini client is initialized (lazy init for CI compatibility)
    this.ensureInitialized();

    try {
      const result = await this.model!.generateContent([contextPrompt, imagePart]);
      const response = await result.response;
      const text = response.text();

      let parsed;
      try {
        parsed = JSON.parse(text.replace(/```json\n?|\n?```/g, ''));
      } catch (parseError) {
        logger.error(`Failed to parse context-aware JSON. Response preview: ${text.substring(0, 200)}`, parseError instanceof Error ? parseError : undefined);
        return { contextAware: standalone, standalone };
      }

      const sanitized = this.sanitizeAndValidate(
        parsed.shortAlt || '',
        parsed.extendedAlt || '',
        parsed.flags || [],
        profile,
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
        aiModel: ACTIVE_MODEL,
        generatedAt: new Date(),
      };

      return { contextAware, standalone };
    } catch (error) {
      logger.error('Context-aware generation failed, returning standalone', error instanceof Error ? error : undefined);
      return { contextAware: standalone, standalone };
    }
  }
}

export const photoAltGenerator = new PhotoAltGeneratorService();
export type { AltTextGenerationResult, AltTextFlag };
