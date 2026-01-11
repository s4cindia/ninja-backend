import { logger } from '../lib/logger';

export interface IssueContext {
  tableStructure?: 'simple' | 'complex';
  imageType?: 'decorative' | 'content' | 'chart' | 'diagram';
  hasExistingAlt?: boolean;
  riskLevel?: 'low' | 'medium' | 'high';
  source?: 'epubCheck' | 'ace' | 'jsAuditor';
}

export type FixClassification = 'autofix' | 'quickfix' | 'manual';

export function calculateConfidence(issueCode: string, context?: IssueContext): number {
  let confidence = 0.5;

  const code = issueCode.toUpperCase();

  if (code === 'EPUB-STRUCT-002' || code === 'EPUB_STRUCT_002') {
    if (context?.tableStructure === 'simple') {
      confidence = 0.95;
    } else if (context?.tableStructure === 'complex') {
      confidence = 0.70;
    } else {
      confidence = 0.80;
    }
  } else if (code === 'EPUB-IMG-001' || code === 'EPUB_A11Y_001') {
    if (context?.imageType === 'decorative') {
      confidence = 0.98;
    } else if (context?.imageType === 'content') {
      confidence = 0.60;
    } else if (context?.imageType === 'chart' || context?.imageType === 'diagram') {
      confidence = 0.40;
    } else {
      confidence = 0.65;
    }
  } else if (code === 'EPUB-SEM-001' || code === 'EPUB_LANG_001') {
    confidence = 0.90;
  } else if (code === 'EPUB-META-001') {
    confidence = 0.95;
  } else if (code === 'EPUB-META-002') {
    confidence = 0.92;
  } else if (code === 'EPUB-META-003') {
    confidence = 0.88;
  } else if (code === 'EPUB-META-004') {
    confidence = 0.90;
  } else if (code === 'EPUB-SEM-002') {
    confidence = 0.75;
  } else if (code === 'EPUB-STRUCT-003') {
    confidence = 0.85;
  } else if (code === 'EPUB-STRUCT-004') {
    confidence = 0.88;
  } else if (code === 'EPUB-NAV-001') {
    confidence = 0.90;
  } else if (code === 'EPUB-FIG-001') {
    confidence = 0.82;
  }

  return Math.min(1.0, Math.max(0.0, confidence));
}

export function classifyIssue(confidence: number, riskLevel: string = 'medium'): FixClassification {
  const risk = riskLevel === 'low' ? 0.1 : riskLevel === 'medium' ? 0.5 : 0.9;

  if (confidence >= 0.95 && risk <= 0.1) {
    return 'autofix';
  } else if (confidence >= 0.70) {
    return 'quickfix';
  } else {
    return 'manual';
  }
}

export function getConfidenceLabel(confidence: number): string {
  if (confidence >= 0.95) return 'Very High';
  if (confidence >= 0.85) return 'High';
  if (confidence >= 0.70) return 'Medium';
  if (confidence >= 0.50) return 'Low';
  return 'Very Low';
}

export function shouldAutoApply(confidence: number, riskLevel: string = 'medium'): boolean {
  return confidence >= 0.95 && riskLevel === 'low';
}

export function getConfidenceColor(confidence: number): string {
  if (confidence >= 0.90) return 'green';
  if (confidence >= 0.70) return 'yellow';
  if (confidence >= 0.50) return 'orange';
  return 'red';
}

export interface IssueWithConfidence {
  code: string;
  severity: string;
  message: string;
  filePath?: string;
  location?: string;
  context?: IssueContext;
  confidence: number;
  fixType: FixClassification;
  autoFixable: boolean;
  quickFixable: boolean;
}

export function enrichIssueWithConfidence(
  issue: { code: string; severity: string; message: string; filePath?: string; location?: string },
  context?: IssueContext
): IssueWithConfidence {
  const confidence = calculateConfidence(issue.code, context);
  const riskLevel = context?.riskLevel || 'medium';
  const fixType = classifyIssue(confidence, riskLevel);

  logger.debug(`[Confidence] Issue ${issue.code}: confidence=${confidence.toFixed(2)}, fixType=${fixType}`);

  return {
    ...issue,
    context,
    confidence,
    fixType,
    autoFixable: fixType === 'autofix',
    quickFixable: fixType === 'quickfix' || fixType === 'autofix',
  };
}
