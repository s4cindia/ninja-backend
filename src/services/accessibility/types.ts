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

export interface ContrastIssue {
  page: number;
  elementId: string;
  text: string;
  foregroundColor: string;
  backgroundColor: string;
  contrastRatio: number;
  requiredRatio: number;
  isLargeText: boolean;
  wcagCriterion: '1.4.3' | '1.4.6';
}

export interface ContrastValidationResult {
  totalTextElements: number;
  passing: number;
  failing: number;
  issues: ContrastIssue[];
  accessibilityIssues: AccessibilityIssue[];
  needsManualReview: number;
  summary: {
    totalChecks: number;
    passed: number;
    failed: number;
    warnings: number;
  };
}

export interface TextColorInfo {
  id: string;
  pageNumber: number;
  text: string;
  position: { x: number; y: number; width: number; height: number };
  fontSize: number;
  isBold: boolean;
  foregroundColor: string | null;
  backgroundColor: string | null;
  needsManualReview: boolean;
}

export interface ValidatorContext {
  documentId: string;
  fileName?: string;
  isTaggedPdf: boolean;
  pageCount: number;
}

export interface TableStatus {
  tableId: string;
  page: number;
  position: { x: number; y: number; width: number; height: number };
  rowCount: number;
  columnCount: number;
  hasHeaderRow: boolean;
  hasHeaderColumn: boolean;
  hasSummary: boolean;
  hasCaption: boolean;
  isLayoutTable: boolean;
  isComplexTable: boolean;
  isAccessible: boolean;
  issues: AccessibilityIssue[];
}

export interface TableValidationResult {
  totalTables: number;
  compliantTables: number;
  compliancePercentage: number;
  tables: TableStatus[];
  issues: AccessibilityIssue[];
  summary: {
    totalChecks: number;
    passed: number;
    failed: number;
    warnings: number;
  };
}

export interface MatterhornCheckpoint {
  id: string;
  category: string;
  description: string;
  status: 'pass' | 'fail' | 'manual';
  details?: string;
}

export interface PdfUaValidationResult {
  isPdfUaCompliant: boolean;
  pdfUaVersion: string | null;
  matterhornCheckpoints: MatterhornCheckpoint[];
  summary: {
    passed: number;
    failed: number;
    manual: number;
  };
}
