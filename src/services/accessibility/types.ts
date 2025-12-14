export interface StructureValidationResult {
  isValid: boolean;
  score: number;
  issues: AccessibilityIssue[];
  summary: {
    totalChecks: number;
    passed: number;
    failed: number;
    warnings: number;
  };
  metadata: {
    documentId: string;
    fileName?: string;
    validatedAt: Date;
    duration: number;
  };
}

export interface AccessibilityIssue {
  id: string;
  wcagCriterion: string;
  wcagLevel: 'A' | 'AA' | 'AAA';
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  title: string;
  description: string;
  location: {
    page?: number;
    element?: string;
    xpath?: string;
  };
  remediation: string;
}

export interface HeadingInfo {
  level: number;
  text: string;
  page: number;
  isEmpty: boolean;
}

export interface HeadingValidationResult {
  issues: AccessibilityIssue[];
  headingOutline: HeadingInfo[];
  hasH1: boolean;
  hasSkippedLevels: boolean;
  hasEmptyHeadings: boolean;
}

export interface ReadingOrderValidationResult {
  issues: AccessibilityIssue[];
  hasProperOrder: boolean;
  orderDiscrepancies: {
    page: number;
    expected: string;
    actual: string;
    description: string;
  }[];
}

export interface LanguageValidationResult {
  issues: AccessibilityIssue[];
  documentLanguage: string | null;
  isValidLanguageCode: boolean;
  hasLanguageDeclaration: boolean;
}

export interface ImageAltTextStatus {
  imageId: string;
  page: number;
  position: { x: number; y: number; width: number; height: number };
  hasAltText: boolean;
  altText: string | null;
  isDecorative: boolean;
  wcagCompliant: boolean;
  issue?: AccessibilityIssue;
  qualityFlags: string[];
}

export interface AltTextValidationResult {
  totalImages: number;
  withAltText: number;
  missingAltText: number;
  decorativeImages: number;
  compliancePercentage: number;
  images: ImageAltTextStatus[];
  issues: AccessibilityIssue[];
  summary: {
    totalChecks: number;
    passed: number;
    failed: number;
    warnings: number;
  };
}

export interface ValidatorContext {
  documentId: string;
  fileName?: string;
  isTaggedPdf: boolean;
  pageCount: number;
}
