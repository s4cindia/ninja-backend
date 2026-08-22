import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const generateContentMock = vi.fn();

vi.mock('@google/generative-ai', () => ({
  // Must be a real `function` (not an arrow fn) — it's invoked with `new`, and arrow
  // functions cannot be constructors.
  GoogleGenerativeAI: vi.fn().mockImplementation(function () {
    return {
      getGenerativeModel: vi.fn().mockReturnValue({
        generateContent: generateContentMock,
      }),
    };
  }),
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

describe('GeminiService circuit breaker', () => {
  let geminiService: typeof import('../../../../src/services/ai/gemini.service').geminiService;

  beforeEach(async () => {
    vi.resetModules();
    generateContentMock.mockReset();
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
