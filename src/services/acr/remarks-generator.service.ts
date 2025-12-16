import { z } from 'zod';
import { geminiService } from '../ai/gemini.service';
import { ConformanceLevel, ValidationResult } from './conformance-engine.service';

export interface RemarksGenerationRequest {
  criterionId: string;
  wcagCriterion: string;
  validationResults: ValidationResult[];
  conformanceLevel: ConformanceLevel;
}

export interface QuantitativeData {
  metric: string;
  value: number;
  total: number;
  percentage: number;
}

export interface GeneratedRemarks {
  remarks: string;
  quantitativeData: QuantitativeData[];
  aiGenerated: boolean;
  suggestedEdits: string[];
}

const GeneratedRemarksSchema = z.object({
  remarks: z.string(),
  quantitativeData: z.array(z.object({
    metric: z.string(),
    value: z.number(),
    total: z.number(),
    percentage: z.number()
  })),
  suggestedEdits: z.array(z.string())
});

function extractQuantitativeData(validationResults: ValidationResult[]): {
  passCount: number;
  failCount: number;
  totalCount: number;
  passRate: number;
} {
  let totalPass = 0;
  let totalFail = 0;
  let totalItems = 0;

  for (const result of validationResults) {
    if (result.passCount !== undefined && result.totalCount !== undefined) {
      totalPass += result.passCount;
      totalFail += result.failCount ?? (result.totalCount - result.passCount);
      totalItems += result.totalCount;
    } else {
      totalItems += 1;
      if (result.passed) {
        totalPass += 1;
      } else {
        totalFail += 1;
      }
    }
  }

  const passRate = totalItems > 0 ? (totalPass / totalItems) * 100 : 0;

  return {
    passCount: totalPass,
    failCount: totalFail,
    totalCount: totalItems,
    passRate: Math.round(passRate * 10) / 10
  };
}

function buildPrompt(request: RemarksGenerationRequest, stats: ReturnType<typeof extractQuantitativeData>): string {
  const conformanceLevelRequirements: Record<ConformanceLevel, string> = {
    'Supports': 'Focus on what works well. Be concise.',
    'Partially Supports': 'Must explain both "what works" AND "limitations". Be specific about both.',
    'Does Not Support': 'Must explain the "reason" for non-compliance. Be direct about issues.',
    'Not Applicable': 'Must provide "justification" for why this criterion does not apply.'
  };

  return `You are an accessibility compliance expert generating remarks for a VPAT/ACR document.

CRITERION: ${request.criterionId} - ${request.wcagCriterion}
CONFORMANCE LEVEL: ${request.conformanceLevel}

VALIDATION STATISTICS:
- Passed: ${stats.passCount} of ${stats.totalCount} (${stats.passRate}%)
- Failed: ${stats.failCount} of ${stats.totalCount}

REQUIREMENTS FOR "${request.conformanceLevel}":
${conformanceLevelRequirements[request.conformanceLevel]}

Generate professional accessibility conformance remarks that:
1. Include specific quantitative data (e.g., "387 of 412 images have appropriate alt text")
2. Are factual and based on the validation statistics provided
3. Follow VPAT 2.5 best practices
4. Are credible for government procurement review

Respond with a JSON object containing:
{
  "remarks": "Your generated remarks text here",
  "quantitativeData": [
    { "metric": "Description of metric", "value": number, "total": number, "percentage": number }
  ],
  "suggestedEdits": ["Suggestion 1", "Suggestion 2"]
}

IMPORTANT: Respond ONLY with valid JSON. No markdown, no explanation.`;
}

async function generateRemarks(
  request: RemarksGenerationRequest
): Promise<GeneratedRemarks> {
  const stats = extractQuantitativeData(request.validationResults);
  
  if (request.validationResults.length === 0) {
    return generateFallbackRemarks(request, stats);
  }

  try {
    const prompt = buildPrompt(request, stats);
    
    const response = await geminiService.generateWithSchema(
      prompt,
      GeneratedRemarksSchema,
      { maxOutputTokens: 1024 }
    );

    return {
      remarks: response.data.remarks,
      quantitativeData: response.data.quantitativeData,
      aiGenerated: true,
      suggestedEdits: response.data.suggestedEdits
    };
  } catch (error) {
    console.error('AI remarks generation failed, using fallback:', error);
    return generateFallbackRemarks(request, stats);
  }
}

function generateFallbackRemarks(
  request: RemarksGenerationRequest,
  stats: ReturnType<typeof extractQuantitativeData>
): GeneratedRemarks {
  let remarks: string;
  const quantitativeData: QuantitativeData[] = [];

  if (stats.totalCount === 0) {
    remarks = `Justification: No items of this type were found in the document. Since no applicable content exists, this criterion does not apply.`;
  } else if (request.conformanceLevel === 'Supports') {
    remarks = `${stats.passCount} of ${stats.totalCount} items passed validation (${stats.passRate}%). All tested items meet the requirements for this criterion.`;
    quantitativeData.push({
      metric: 'Items passing validation',
      value: stats.passCount,
      total: stats.totalCount,
      percentage: stats.passRate
    });
  } else if (request.conformanceLevel === 'Partially Supports') {
    remarks = `What works: ${stats.passCount} of ${stats.totalCount} items passed validation (${stats.passRate}%). Limitations: ${stats.failCount} items require remediation to fully meet this criterion.`;
    quantitativeData.push(
      { metric: 'Items passing validation', value: stats.passCount, total: stats.totalCount, percentage: stats.passRate },
      { metric: 'Items requiring remediation', value: stats.failCount, total: stats.totalCount, percentage: Math.round((stats.failCount / stats.totalCount) * 1000) / 10 }
    );
  } else if (request.conformanceLevel === 'Does Not Support') {
    remarks = `Reason: Only ${stats.passCount} of ${stats.totalCount} items passed validation (${stats.passRate}%). The majority of content does not meet the requirements for this criterion.`;
    quantitativeData.push({
      metric: 'Items passing validation',
      value: stats.passCount,
      total: stats.totalCount,
      percentage: stats.passRate
    });
  } else {
    remarks = `Justification: This criterion is not applicable to the content type being evaluated.`;
  }

  return {
    remarks,
    quantitativeData,
    aiGenerated: false,
    suggestedEdits: [
      'Consider adding specific examples from validation results',
      'Include details about remediation steps if applicable'
    ]
  };
}

async function generateRemarksForCriterion(
  criterionId: string,
  wcagCriterion: string,
  validationResults: ValidationResult[],
  conformanceLevel: ConformanceLevel
): Promise<GeneratedRemarks> {
  return generateRemarks({
    criterionId,
    wcagCriterion,
    validationResults,
    conformanceLevel
  });
}

export const remarksGeneratorService = {
  generateRemarks,
  generateRemarksForCriterion,
  extractQuantitativeData
};

export { generateRemarks, generateRemarksForCriterion, extractQuantitativeData };
