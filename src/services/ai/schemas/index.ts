import { z } from 'zod';

export const wcagLevelSchema = z.enum(['A', 'AA', 'AAA']);
export type WcagLevel = z.infer<typeof wcagLevelSchema>;

export const severitySchema = z.enum(['critical', 'serious', 'moderate', 'minor']);
export type Severity = z.infer<typeof severitySchema>;

export const altTextResponseSchema = z.object({
  altText: z.string().min(1).max(500),
  isDecorative: z.boolean(),
  confidence: z.number().min(0).max(1),
  context: z.string().optional(),
  reasoning: z.string().optional(),
});
export type AltTextResponse = z.infer<typeof altTextResponseSchema>;

export const accessibilityIssueSchema = z.object({
  id: z.string(),
  type: z.string(),
  severity: severitySchema,
  wcagCriteria: z.string(),
  wcagLevel: wcagLevelSchema,
  description: z.string(),
  element: z.string().optional(),
  location: z.object({
    line: z.number().optional(),
    column: z.number().optional(),
    xpath: z.string().optional(),
    selector: z.string().optional(),
  }).optional(),
  recommendation: z.string(),
  impact: z.string().optional(),
});
export type AccessibilityIssue = z.infer<typeof accessibilityIssueSchema>;

export const documentAnalysisSchema = z.object({
  summary: z.object({
    totalIssues: z.number(),
    criticalCount: z.number(),
    seriousCount: z.number(),
    moderateCount: z.number(),
    minorCount: z.number(),
    conformanceLevel: wcagLevelSchema.nullable(),
  }),
  issues: z.array(accessibilityIssueSchema),
  recommendations: z.array(z.string()),
  passedCriteria: z.array(z.string()).optional(),
});
export type DocumentAnalysis = z.infer<typeof documentAnalysisSchema>;

export const wcagConformanceSchema = z.object({
  level: wcagLevelSchema,
  criteria: z.string(),
  status: z.enum(['pass', 'fail', 'not-applicable', 'cannot-tell']),
  findings: z.string(),
  evidence: z.array(z.string()).optional(),
});
export type WcagConformance = z.infer<typeof wcagConformanceSchema>;

export const vpatSectionSchema = z.object({
  criterion: z.string(),
  conformanceLevel: z.enum(['Supports', 'Partially Supports', 'Does Not Support', 'Not Applicable']),
  remarks: z.string(),
  recommendations: z.string().optional(),
});
export type VpatSection = z.infer<typeof vpatSectionSchema>;

export const headingStructureSchema = z.object({
  headings: z.array(z.object({
    level: z.number().min(1).max(6),
    text: z.string(),
    isValid: z.boolean(),
    issue: z.string().optional(),
  })),
  isLogicalStructure: z.boolean(),
  skippedLevels: z.array(z.number()),
  recommendations: z.array(z.string()),
});
export type HeadingStructure = z.infer<typeof headingStructureSchema>;

export const tableAnalysisSchema = z.object({
  hasHeaders: z.boolean(),
  headerType: z.enum(['row', 'column', 'both', 'none']),
  hasCaption: z.boolean(),
  hasSummary: z.boolean(),
  isDataTable: z.boolean(),
  isLayoutTable: z.boolean(),
  issues: z.array(z.object({
    type: z.string(),
    description: z.string(),
    recommendation: z.string(),
  })),
  wcagCompliance: z.object({
    criterion_1_3_1: z.boolean(),
    criterion_1_3_2: z.boolean(),
  }),
});
export type TableAnalysis = z.infer<typeof tableAnalysisSchema>;

export const colorContrastSchema = z.object({
  foreground: z.string(),
  background: z.string(),
  contrastRatio: z.number(),
  passesAA: z.boolean(),
  passesAAA: z.boolean(),
  largeText: z.boolean(),
  recommendation: z.string().optional(),
});
export type ColorContrast = z.infer<typeof colorContrastSchema>;

export const imageAnalysisSchema = z.object({
  description: z.string(),
  containsText: z.boolean(),
  extractedText: z.string().optional(),
  isDecorative: z.boolean(),
  suggestedAltText: z.string(),
  contentType: z.enum(['photo', 'chart', 'diagram', 'icon', 'logo', 'decorative', 'complex', 'unknown']),
  accessibilityConsiderations: z.array(z.string()),
});
export type ImageAnalysis = z.infer<typeof imageAnalysisSchema>;

export const linkAnalysisSchema = z.object({
  text: z.string(),
  href: z.string().optional(),
  isDescriptive: z.boolean(),
  issue: z.string().optional(),
  suggestedText: z.string().optional(),
  opensNewWindow: z.boolean(),
  hasWarning: z.boolean(),
});
export type LinkAnalysis = z.infer<typeof linkAnalysisSchema>;

export const formFieldAnalysisSchema = z.object({
  type: z.string(),
  hasLabel: z.boolean(),
  labelText: z.string().optional(),
  hasAssociatedLabel: z.boolean(),
  hasPlaceholder: z.boolean(),
  hasAriaLabel: z.boolean(),
  hasAriaDescribedBy: z.boolean(),
  isRequired: z.boolean(),
  hasRequiredIndicator: z.boolean(),
  hasErrorHandling: z.boolean(),
  issues: z.array(z.string()),
  recommendations: z.array(z.string()),
});
export type FormFieldAnalysis = z.infer<typeof formFieldAnalysisSchema>;

export const accessibilityScoreSchema = z.object({
  overall: z.number().min(0).max(100),
  perceivable: z.number().min(0).max(100),
  operable: z.number().min(0).max(100),
  understandable: z.number().min(0).max(100),
  robust: z.number().min(0).max(100),
  breakdown: z.record(z.string(), z.number()),
});
export type AccessibilityScore = z.infer<typeof accessibilityScoreSchema>;
