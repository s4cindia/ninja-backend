export const aiConfig = {
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    model: 'gemini-2.0-flash-lite',
    modelPro: 'gemini-2.5-pro',
    maxRetries: 3,
    retryDelay: 1000,
    timeout: 60000,
    rateLimit: {
      requestsPerMinute: 60,
      tokensPerMinute: 1000000,
    },
  },
  defaults: {
    temperature: 0.2,
    topP: 0.8,
    topK: 40,
    maxOutputTokens: 8192,
  },
};
