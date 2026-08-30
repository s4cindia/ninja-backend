/**
 * Shared error types for the Gemini integration. Kept in their own module
 * (rather than in gemini.service.ts or response-parser.service.ts) so both
 * of those files can import from here without creating a circular
 * dependency between them.
 */

/**
 * Thrown when the underlying @google/generative-ai SDK's response.text()
 * itself throws -- which it does (as of SDK 0.24.1) instead of returning,
 * whenever the candidate's finishReason is SAFETY, RECITATION, or LANGUAGE.
 * Reading finishReason happens before text() is called specifically so a
 * blocked response's reason is still recoverable via this error, rather
 * than being unreachable code once text() has already thrown.
 */
export class GeminiBlockedResponseError extends Error {
  constructor(message: string, public readonly finishReason: string | undefined) {
    super(message);
    this.name = 'GeminiBlockedResponseError';
  }
}
