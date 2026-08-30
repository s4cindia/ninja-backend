import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';

const generateContentMock = vi.fn();
const getGenerativeModelMock = vi.fn().mockReturnValue({ generateContent: generateContentMock });

vi.mock('@google/generative-ai', () => ({
  // Must be a real `function` (not an arrow fn) — it's invoked with `new`, and arrow
  // functions cannot be constructors.
  GoogleGenerativeAI: vi.fn().mockImplementation(function () {
    return {
      getGenerativeModel: getGenerativeModelMock,
    };
  }),
  SchemaType: { OBJECT: 'OBJECT', STRING: 'STRING', BOOLEAN: 'BOOLEAN', NUMBER: 'NUMBER' },
}));

vi.mock('../../../../src/utils/rate-limiter', () => ({
  geminiRateLimiter: { acquire: vi.fn().mockResolvedValue(undefined) },
}));

vi.mock('../../../../src/config/ai.config', () => ({
  aiConfig: {
    gemini: {
      apiKey: 'test-key',
      model: 'gemini-2.0-flash',
      modelPro: 'gemini-2.5-pro',
      maxRetries: 3,
      retryDelay: 1,
      timeout: 60000,
      rateLimit: { requestsPerMinute: 60, tokensPerMinute: 1_000_000 },
    },
    defaults: { temperature: 0.2, topP: 0.8, topK: 40, maxOutputTokens: 8192 },
  },
}));

function mockResponse(text: string) {
  return {
    response: {
      text: () => text,
      usageMetadata: undefined,
      candidates: [{ finishReason: 'STOP' }],
    },
  };
}

/** Mimics the real @google/generative-ai SDK: response.text() throws for a
 * candidate whose finishReason is SAFETY/RECITATION/LANGUAGE, instead of
 * returning -- rather than returning a candidates array a real GeminiService
 * caller could still read finishReason from after the fact. */
function mockBlockedResponse(finishReason: string) {
  return {
    response: {
      text: () => {
        throw new Error(`Candidate was blocked due to ${finishReason}`);
      },
      usageMetadata: undefined,
      candidates: [{ finishReason }],
    },
  };
}

describe('GeminiService circuit breaker', () => {
  let geminiService: typeof import('../../../../src/services/ai/gemini.service').geminiService;

  beforeEach(async () => {
    vi.resetModules();
    generateContentMock.mockReset();
    getGenerativeModelMock.mockClear();
    getGenerativeModelMock.mockReturnValue({ generateContent: generateContentMock });
    ({ geminiService } = await import('../../../../src/services/ai/gemini.service'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('trips the circuit on an API-key-invalid error and reports degraded status', async () => {
    generateContentMock.mockRejectedValue(new Error('[400 Bad Request] API key not valid.'));

    await expect(geminiService.generateText('prompt')).rejects.toThrow('API key not valid');

    const status = geminiService.getCircuitStatus();
    expect(status.open).toBe(true);
    expect(status.reason).toContain('API key not valid');
  });

  it('fails fast without calling the model again once the circuit is open', async () => {
    generateContentMock.mockRejectedValue(new Error('quota exceeded for this project'));

    await expect(geminiService.generateText('prompt')).rejects.toThrow('quota exceeded');
    expect(generateContentMock).toHaveBeenCalledTimes(1);

    await expect(geminiService.generateText('prompt 2')).rejects.toThrow('GEMINI_SERVICE_UNAVAILABLE');
    // No second network call — the circuit breaker short-circuited before reaching the model.
    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });

  it('closes the circuit and resumes calls after the cooldown window elapses', async () => {
    vi.useFakeTimers();
    generateContentMock.mockRejectedValueOnce(new Error('API_KEY_INVALID'));

    await expect(geminiService.generateText('prompt')).rejects.toThrow();
    expect(geminiService.getCircuitStatus().open).toBe(true);

    vi.advanceTimersByTime(60_001);
    expect(geminiService.getCircuitStatus().open).toBe(false);

    generateContentMock.mockResolvedValueOnce(mockResponse('ok'));
    const result = await geminiService.generateText('prompt');
    expect(result.text).toBe('ok');
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it('does not trip the circuit for a transient (non-infrastructure) error and still retries', async () => {
    generateContentMock
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce(mockResponse('recovered'));

    const result = await geminiService.generateText('prompt');

    expect(result.text).toBe('recovered');
    expect(geminiService.getCircuitStatus().open).toBe(false);
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });
});

describe('GeminiService structured output (responseSchema)', () => {
  let geminiService: typeof import('../../../../src/services/ai/gemini.service').geminiService;

  beforeEach(async () => {
    vi.resetModules();
    generateContentMock.mockReset();
    getGenerativeModelMock.mockClear();
    getGenerativeModelMock.mockReturnValue({ generateContent: generateContentMock });
    ({ geminiService } = await import('../../../../src/services/ai/gemini.service'));
  });

  it('sets responseMimeType and responseSchema on generationConfig when a schema is passed', async () => {
    generateContentMock.mockResolvedValue(mockResponse('{"ok":true}'));
    const schema = { type: 'OBJECT', properties: { ok: { type: 'BOOLEAN' } }, required: ['ok'] };

    await geminiService.analyzeImage('base64data', 'image/png', 'prompt', {
      model: 'flash',
      responseSchema: schema as never,
    });

    expect(getGenerativeModelMock).toHaveBeenCalledTimes(1);
    const { generationConfig } = getGenerativeModelMock.mock.calls[0][0];
    expect(generationConfig.responseMimeType).toBe('application/json');
    expect(generationConfig.responseSchema).toEqual(schema);
  });

  it('omits responseMimeType/responseSchema entirely when no schema is passed (unaffected callers)', async () => {
    generateContentMock.mockResolvedValue(mockResponse('plain text'));

    await geminiService.generateText('prompt', { model: 'flash' });

    const { generationConfig } = getGenerativeModelMock.mock.calls[0][0];
    expect(generationConfig.responseMimeType).toBeUndefined();
    expect(generationConfig.responseSchema).toBeUndefined();
  });
});

describe('GeminiService.analyzeImageWithSchema (retry on malformed response)', () => {
  let geminiService: typeof import('../../../../src/services/ai/gemini.service').geminiService;
  const schema = z.object({ isDecorative: z.boolean(), altText: z.string(), confidence: z.number() });

  beforeEach(async () => {
    vi.resetModules();
    generateContentMock.mockReset();
    getGenerativeModelMock.mockClear();
    getGenerativeModelMock.mockReturnValue({ generateContent: generateContentMock });
    ({ geminiService } = await import('../../../../src/services/ai/gemini.service'));
  });

  it('retries with a correction prompt when the first response is not valid JSON, and succeeds on the second', async () => {
    generateContentMock
      .mockResolvedValueOnce(mockResponse('Here is the analysis: {"isDecorative": false, "altText"'))
      .mockResolvedValueOnce(mockResponse('{"isDecorative": false, "altText": "A red apple", "confidence": 0.85}'));

    const result = await geminiService.analyzeImageWithSchema(
      'base64data', 'image/png', 'Analyze this image', schema, { model: 'flash' }
    );

    expect(result.data).toEqual({ isDecorative: false, altText: 'A red apple', confidence: 0.85 });
    expect(result.attempts).toBe(2);
    expect(generateContentMock).toHaveBeenCalledTimes(2);
    // The retry attaches a correction prompt referencing the failure, not the bare original prompt again.
    const secondCallArgs = generateContentMock.mock.calls[1][0];
    expect(secondCallArgs[0]).toContain('Analyze this image');
    expect(secondCallArgs[0]).not.toBe('Analyze this image');
  });

  it('throws after exhausting retries when every response stays malformed', async () => {
    generateContentMock.mockResolvedValue(mockResponse('Here is the analysis, no JSON at all'));

    await expect(
      geminiService.analyzeImageWithSchema('base64data', 'image/png', 'Analyze this image', schema, { model: 'flash' }, { maxRetries: 2 })
    ).rejects.toThrow();

    expect(generateContentMock).toHaveBeenCalledTimes(3); // initial attempt + 2 retries
  });
});

describe('GeminiService blocked-response finishReason recovery', () => {
  let geminiService: typeof import('../../../../src/services/ai/gemini.service').geminiService;

  beforeEach(async () => {
    vi.resetModules();
    generateContentMock.mockReset();
    getGenerativeModelMock.mockClear();
    getGenerativeModelMock.mockReturnValue({ generateContent: generateContentMock });
    ({ geminiService } = await import('../../../../src/services/ai/gemini.service'));
  });

  it('analyzeImage surfaces finishReason via GeminiBlockedResponseError when response.text() throws', async () => {
    const { GeminiBlockedResponseError } = await import('../../../../src/services/ai/gemini-errors');
    generateContentMock.mockResolvedValue(mockBlockedResponse('SAFETY'));

    let caught: unknown;
    try {
      await geminiService.analyzeImage('base64data', 'image/png', 'prompt', { model: 'flash' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GeminiBlockedResponseError);
    expect((caught as InstanceType<typeof GeminiBlockedResponseError>).finishReason).toBe('SAFETY');
  });

  it('generateText surfaces finishReason via GeminiBlockedResponseError when response.text() throws', async () => {
    const { GeminiBlockedResponseError } = await import('../../../../src/services/ai/gemini-errors');
    generateContentMock.mockResolvedValue(mockBlockedResponse('RECITATION'));

    let caught: unknown;
    try {
      await geminiService.generateText('prompt', { model: 'flash' });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(GeminiBlockedResponseError);
    expect((caught as InstanceType<typeof GeminiBlockedResponseError>).finishReason).toBe('RECITATION');
  });

  it('does not trip the circuit breaker for a blocked-content error (not an infrastructure failure)', async () => {
    generateContentMock.mockResolvedValue(mockBlockedResponse('SAFETY'));

    await expect(geminiService.generateText('prompt', { model: 'flash' })).rejects.toThrow();

    expect(geminiService.getCircuitStatus().open).toBe(false);
  });
});
