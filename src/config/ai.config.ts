export const aiConfig = {
  adobe: {
    clientId: process.env.ADOBE_PDF_SERVICES_CLIENT_ID || '',
    clientSecret: process.env.ADOBE_PDF_SERVICES_CLIENT_SECRET || '',
    enabled: !!process.env.ADOBE_PDF_SERVICES_CLIENT_ID,
  },
  // Seam C — the in-house detector-driven tagger. DEFAULT tagger for untagged PDFs
  // (Adobe is the fallback). Enabled whenever the YOLO detector is reachable, unless
  // explicitly turned off with SEAM_C_ENABLED=false.
  seamC: {
    enabled: process.env.SEAM_C_ENABLED !== 'false' && !!process.env.YOLO_SERVICE_URL,
  },
  gemini: {
    apiKey: process.env.GEMINI_API_KEY || '',
    // gemini-2.0-flash was retired by Google (404 NOT_FOUND) — gemini-3.6-flash is
    // the current suggested replacement per the API's own error message.
    model: 'gemini-3.6-flash',
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
