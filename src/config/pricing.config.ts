export const aiPricing = {
  'gemini-1.5-flash': {
    input: 0.075,
    output: 0.30,
    cached: 0.01875,
  },
  'gemini-1.5-pro': {
    input: 1.25,
    output: 5.00,
    cached: 0.3125,
  },
  'gemini-2.0-flash': {
    input: 0.10,
    output: 0.40,
    cached: 0.025,
  },
  'gemini-2.0-flash-lite': {
    input: 0.075,
    output: 0.30,
    cached: 0.01875,
  },
  'gemini-2.5-flash': {
    input: 0.15,
    output: 0.60,
    cached: 0.0375,
  },
  'gemini-2.5-pro': {
    input: 1.25,
    output: 5.00,
    cached: 0.3125,
  },
} as const;

export type SupportedModel = keyof typeof aiPricing;

export function getModelPricing(model: string): { input: number; output: number; cached: number } {
  const normalizedModel = model.toLowerCase();
  
  if (normalizedModel.includes('2.5-pro')) {
    return aiPricing['gemini-2.5-pro'];
  }
  if (normalizedModel.includes('2.5-flash')) {
    return aiPricing['gemini-2.5-flash'];
  }
  if (normalizedModel.includes('flash-lite') || normalizedModel.includes('2.0-flash-lite')) {
    return aiPricing['gemini-2.0-flash-lite'];
  }
  if (normalizedModel.includes('2.0-flash')) {
    return aiPricing['gemini-2.0-flash'];
  }
  if (normalizedModel.includes('1.5-flash')) {
    return aiPricing['gemini-1.5-flash'];
  }
  if (normalizedModel.includes('1.5-pro')) {
    return aiPricing['gemini-1.5-pro'];
  }
  if (normalizedModel.includes('pro')) {
    return aiPricing['gemini-2.5-pro'];
  }
  
  return aiPricing['gemini-2.0-flash-lite'];
}
