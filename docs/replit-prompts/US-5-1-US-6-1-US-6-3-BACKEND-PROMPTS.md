# Citation Feature - Backend Replit Prompts

> **User Stories**: US-5.1, US-6.1, US-6.3
> **Branch**: `feature/citation/US-4-1-US-4-2` (existing, not yet pushed)
> **Repository**: ninja-backend
> **Prerequisites**: US-4.1 and US-4.2 already implemented on this branch

---

## Table of Contents

0. [Git Setup](#git-setup)
1. [US-5.1: Citation Format Validation](#us-51-citation-format-validation)
   - 5.1.1: Database Schema
   - 5.1.2: Style Rules Service
   - 5.1.3: Citation Validation Service
   - 5.1.4: Validation Controller & Routes
2. [US-6.1: Citation Format Correction](#us-61-citation-format-correction)
   - 6.1.1: Correction Service
   - 6.1.2: Correction Controller & Routes
3. [US-6.3: Reference List Generation](#us-63-reference-list-generation)
   - 6.3.1: CrossRef Service
   - 6.3.2: Reference List Service
   - 6.3.3: Reference List Controller & Routes

---

# Git Setup

## Step 0: Switch to Existing Feature Branch

You already have the branch `feature/citation/US-4-1-US-4-2` with US-4.1 and US-4.2 implemented.
Continue working on this branch to add US-5.1, US-6.1, and US-6.3.

Open the Shell tab in Replit and run:

```bash
# Check current branch
git branch

# If not on the feature branch, switch to it
git checkout feature/citation/US-4-1-US-4-2

# Verify you're on the correct branch
git status
```

### Verify Branch Setup

```bash
git branch
# Should show: * feature/citation/US-4-1-US-4-2

git log --oneline -5
# Should show your US-4.1 and US-4.2 commits
```

### Commit After Each Prompt (Local Only)

```bash
git add .
git commit -m "feat(citation): <description>"
# DO NOT push yet - we'll push everything together at the end
```

**Example commit messages:**
- `feat(citation): add validation schema and models`
- `feat(citation): implement style rules service`
- `feat(citation): add citation validation service`
- `feat(citation): add validation controller and routes`
- `feat(citation): add correction service`
- `feat(citation): add CrossRef integration`
- `feat(citation): add reference list generation`

### Push All Changes (After Completing All Prompts)

Only after completing ALL backend and frontend prompts:

```bash
# Backend - push all commits
git push -u origin feature/citation/US-4-1-US-4-2

# Then switch to frontend and push
```

---

# US-5.1: Citation Format Validation

## Backend Prompt 5.1.1: Database Schema for Validation

```
Add database models for citation validation in prisma/schema.prisma.

Add the following models:

```prisma
// Citation style guide definitions
model CitationStyle {
  id            String   @id @default(uuid())
  code          String   @unique  // "apa7", "mla9", "chicago17"
  name          String            // "APA 7th Edition"
  version       String?

  // Rule definitions stored as JSON
  inTextRules   Json     // Rules for in-text citations
  referenceRules Json    // Rules for reference entries

  // Formatting options
  sortOrder     String   @default("alphabetical") // "alphabetical", "numbered", "appearance"
  hangingIndent Boolean  @default(true)
  doubleSpacing Boolean  @default(true)

  isSystem      Boolean  @default(true)
  tenantId      String?

  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  @@index([tenantId])
}

// Validation results
model CitationValidation {
  id            String   @id @default(uuid())
  documentId    String
  document      EditorialDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)

  citationId    String
  citation      Citation @relation(fields: [citationId], references: [id], onDelete: Cascade)

  styleCode     String

  violationType String   // "punctuation", "capitalization", "author_format", "date_format", "italics"
  ruleReference String   // "APA 8.17"
  ruleName      String
  explanation   String?

  originalText  String
  suggestedFix  String

  severity      String   @default("warning") // "error", "warning", "info"

  status        String   @default("pending") // "pending", "accepted", "rejected", "edited"
  resolvedText  String?
  resolvedBy    String?
  resolvedAt    DateTime?

  createdAt     DateTime @default(now())

  @@index([documentId])
  @@index([citationId])
  @@index([status])
}

// Change tracking for corrections
model CitationChange {
  id            String   @id @default(uuid())
  documentId    String
  document      EditorialDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)

  citationId    String?
  changeType    String   // "correction", "format", "revert"

  beforeText    String
  afterText     String

  appliedBy     String
  appliedAt     DateTime @default(now())

  isReverted    Boolean  @default(false)
  revertedAt    DateTime?

  @@index([documentId])
}

// Reference list entries
model ReferenceListEntry {
  id            String   @id @default(uuid())
  documentId    String
  document      EditorialDocument @relation(fields: [documentId], references: [id], onDelete: Cascade)

  citationIds   String[]
  sortKey       String

  authors       Json
  year          String?
  title         String
  sourceType    String

  journalName   String?
  volume        String?
  issue         String?
  pages         String?
  publisher     String?
  doi           String?
  url           String?

  enrichmentSource     String   // "crossref", "pubmed", "manual", "ai"
  enrichmentConfidence Float

  formattedApa     String?
  formattedMla     String?
  formattedChicago String?

  isEdited      Boolean  @default(false)
  editedAt      DateTime?

  createdAt     DateTime @default(now())

  @@index([documentId])
}
```

Also update the Citation model to add:

```prisma
model Citation {
  // ... existing fields ...

  validations        CitationValidation[]
  validationStatus   String?    // "valid", "has_errors", "has_warnings", "not_validated"
  lastValidatedAt    DateTime?
  lastValidatedStyle String?
}
```

And update EditorialDocument:

```prisma
model EditorialDocument {
  // ... existing fields ...

  validations            CitationValidation[]
  citationChanges        CitationChange[]
  referenceListEntries   ReferenceListEntry[]
  referenceListStatus    String?    // "draft", "finalized"
  referenceListStyle     String?
  referenceListGeneratedAt DateTime?
}
```

Run: npx prisma migrate dev --name add_citation_validation
```

---

## Backend Prompt 5.1.2: Style Rules Service

```
Create the style rules service at src/services/citation/style-rules.service.ts.

This service defines citation style rules for APA, MLA, Chicago, etc.

```typescript
import { logger } from '../../lib/logger';

export interface StyleRule {
  id: string;
  reference: string;      // "APA 8.17"
  name: string;           // "Use ampersand in parenthetical citations"
  category: 'punctuation' | 'capitalization' | 'author_format' | 'date_format' | 'italics' | 'order';
  description: string;
  examples: {
    incorrect: string;
    correct: string;
  }[];
  severity: 'error' | 'warning';
}

export interface StyleDefinition {
  code: string;
  name: string;
  version: string;
  inTextRules: StyleRule[];
  referenceRules: StyleRule[];
  sortOrder: 'alphabetical' | 'numbered' | 'appearance';
}

// APA 7th Edition Rules
const APA7_RULES: StyleRule[] = [
  {
    id: 'apa7-ampersand-parenthetical',
    reference: 'APA 8.17',
    name: 'Use ampersand in parenthetical citations',
    category: 'author_format',
    description: 'In parenthetical citations, use "&" instead of "and" between author names.',
    examples: [
      { incorrect: '(Smith and Jones, 2020)', correct: '(Smith & Jones, 2020)' }
    ],
    severity: 'error'
  },
  {
    id: 'apa7-and-narrative',
    reference: 'APA 8.17',
    name: 'Use "and" in narrative citations',
    category: 'author_format',
    description: 'In narrative citations, use "and" instead of "&" between author names.',
    examples: [
      { incorrect: 'Smith & Jones (2020) found...', correct: 'Smith and Jones (2020) found...' }
    ],
    severity: 'error'
  },
  {
    id: 'apa7-et-al',
    reference: 'APA 8.17',
    name: 'Use et al. for three or more authors',
    category: 'author_format',
    description: 'For works with three or more authors, use the first author followed by "et al."',
    examples: [
      { incorrect: '(Smith, Jones, and Williams, 2020)', correct: '(Smith et al., 2020)' }
    ],
    severity: 'error'
  },
  {
    id: 'apa7-comma-before-year',
    reference: 'APA 8.11',
    name: 'Comma before year in parenthetical citations',
    category: 'punctuation',
    description: 'Place a comma between the author name(s) and year.',
    examples: [
      { incorrect: '(Smith 2020)', correct: '(Smith, 2020)' }
    ],
    severity: 'error'
  },
  {
    id: 'apa7-no-comma-narrative',
    reference: 'APA 8.11',
    name: 'No comma before year in narrative citations',
    category: 'punctuation',
    description: 'In narrative citations, do not place a comma before the year in parentheses.',
    examples: [
      { incorrect: 'Smith, (2020) found...', correct: 'Smith (2020) found...' }
    ],
    severity: 'error'
  },
  {
    id: 'apa7-nd-for-no-date',
    reference: 'APA 8.14',
    name: 'Use n.d. for no date',
    category: 'date_format',
    description: 'When no date is available, use "n.d." (no date).',
    examples: [
      { incorrect: '(Smith, no date)', correct: '(Smith, n.d.)' }
    ],
    severity: 'warning'
  },
  {
    id: 'apa7-multiple-citations-order',
    reference: 'APA 8.12',
    name: 'Alphabetize multiple citations',
    category: 'order',
    description: 'Multiple citations in the same parentheses should be alphabetized by first author.',
    examples: [
      { incorrect: '(Zebra, 2020; Apple, 2019)', correct: '(Apple, 2019; Zebra, 2020)' }
    ],
    severity: 'warning'
  },
  {
    id: 'apa7-semicolon-multiple',
    reference: 'APA 8.12',
    name: 'Semicolons between multiple citations',
    category: 'punctuation',
    description: 'Separate multiple citations in the same parentheses with semicolons.',
    examples: [
      { incorrect: '(Smith, 2020, Jones, 2019)', correct: '(Smith, 2020; Jones, 2019)' }
    ],
    severity: 'error'
  },
  {
    id: 'apa7-author-capitalization',
    reference: 'APA 6.14',
    name: 'Capitalize author surnames',
    category: 'capitalization',
    description: 'Author surnames should be capitalized.',
    examples: [
      { incorrect: '(smith, 2020)', correct: '(Smith, 2020)' }
    ],
    severity: 'error'
  },
  {
    id: 'apa7-page-number-format',
    reference: 'APA 8.13',
    name: 'Page number format',
    category: 'punctuation',
    description: 'Use "p." for single page, "pp." for page range.',
    examples: [
      { incorrect: '(Smith, 2020, page 45)', correct: '(Smith, 2020, p. 45)' },
      { incorrect: '(Smith, 2020, p. 45-50)', correct: '(Smith, 2020, pp. 45-50)' }
    ],
    severity: 'error'
  }
];

// MLA 9th Edition Rules
const MLA9_RULES: StyleRule[] = [
  {
    id: 'mla9-no-comma-author-page',
    reference: 'MLA 6.1',
    name: 'No comma between author and page',
    category: 'punctuation',
    description: 'In MLA, do not use a comma between author name and page number.',
    examples: [
      { incorrect: '(Smith, 45)', correct: '(Smith 45)' }
    ],
    severity: 'error'
  },
  {
    id: 'mla9-no-p-page',
    reference: 'MLA 6.1',
    name: 'No "p." before page numbers',
    category: 'punctuation',
    description: 'Do not use "p." or "pp." before page numbers.',
    examples: [
      { incorrect: '(Smith p. 45)', correct: '(Smith 45)' }
    ],
    severity: 'error'
  },
  {
    id: 'mla9-and-two-authors',
    reference: 'MLA 6.1',
    name: 'Use "and" for two authors',
    category: 'author_format',
    description: 'Use "and" between two author names.',
    examples: [
      { incorrect: '(Smith & Jones 45)', correct: '(Smith and Jones 45)' }
    ],
    severity: 'error'
  },
  {
    id: 'mla9-et-al-three-plus',
    reference: 'MLA 6.1',
    name: 'Use et al. for three or more authors',
    category: 'author_format',
    description: 'For three or more authors, use first author followed by "et al."',
    examples: [
      { incorrect: '(Smith, Jones, and Williams 45)', correct: '(Smith et al. 45)' }
    ],
    severity: 'error'
  }
];

// Chicago 17th Edition Rules (Author-Date)
const CHICAGO17_RULES: StyleRule[] = [
  {
    id: 'chicago17-comma-year',
    reference: 'Chicago 15.20',
    name: 'Comma before year',
    category: 'punctuation',
    description: 'Use comma between author and year.',
    examples: [
      { incorrect: '(Smith 2020)', correct: '(Smith, 2020)' }
    ],
    severity: 'error'
  },
  {
    id: 'chicago17-and-two-authors',
    reference: 'Chicago 15.21',
    name: 'Use "and" for two authors',
    category: 'author_format',
    description: 'Use "and" between two author names in citations.',
    examples: [
      { incorrect: '(Smith & Jones, 2020)', correct: '(Smith and Jones, 2020)' }
    ],
    severity: 'error'
  },
  {
    id: 'chicago17-et-al-four-plus',
    reference: 'Chicago 15.22',
    name: 'Use et al. for four or more authors',
    category: 'author_format',
    description: 'For four or more authors, use first author plus "et al."',
    examples: [
      { incorrect: '(Smith, Jones, Williams, and Brown, 2020)', correct: '(Smith et al., 2020)' }
    ],
    severity: 'error'
  }
];

// Vancouver/IEEE Rules
const VANCOUVER_RULES: StyleRule[] = [
  {
    id: 'vancouver-numeric-bracket',
    reference: 'Vancouver 1.1',
    name: 'Use bracketed numbers',
    category: 'punctuation',
    description: 'Citations should be numbered in brackets.',
    examples: [
      { incorrect: '(1)', correct: '[1]' },
      { incorrect: '¹', correct: '[1]' }
    ],
    severity: 'error'
  },
  {
    id: 'vancouver-sequential',
    reference: 'Vancouver 1.2',
    name: 'Sequential numbering',
    category: 'order',
    description: 'Citations should be numbered in order of appearance.',
    examples: [
      { incorrect: '[3] appears before [1]', correct: '[1] appears before [2]' }
    ],
    severity: 'error'
  }
];

class StyleRulesService {
  private styles: Map<string, StyleDefinition> = new Map();

  constructor() {
    this.initializeStyles();
  }

  private initializeStyles() {
    this.styles.set('apa7', {
      code: 'apa7',
      name: 'APA 7th Edition',
      version: '7th',
      inTextRules: APA7_RULES,
      referenceRules: [],
      sortOrder: 'alphabetical'
    });

    this.styles.set('mla9', {
      code: 'mla9',
      name: 'MLA 9th Edition',
      version: '9th',
      inTextRules: MLA9_RULES,
      referenceRules: [],
      sortOrder: 'alphabetical'
    });

    this.styles.set('chicago17', {
      code: 'chicago17',
      name: 'Chicago 17th Edition',
      version: '17th',
      inTextRules: CHICAGO17_RULES,
      referenceRules: [],
      sortOrder: 'alphabetical'
    });

    this.styles.set('vancouver', {
      code: 'vancouver',
      name: 'Vancouver',
      version: 'ICMJE',
      inTextRules: VANCOUVER_RULES,
      referenceRules: [],
      sortOrder: 'numbered'
    });

    this.styles.set('ieee', {
      code: 'ieee',
      name: 'IEEE',
      version: '2024',
      inTextRules: VANCOUVER_RULES, // Similar to Vancouver
      referenceRules: [],
      sortOrder: 'numbered'
    });
  }

  getAvailableStyles(): { code: string; name: string; version: string }[] {
    return Array.from(this.styles.values()).map(s => ({
      code: s.code,
      name: s.name,
      version: s.version
    }));
  }

  getStyle(code: string): StyleDefinition | undefined {
    return this.styles.get(code);
  }

  getRulesForStyle(code: string): StyleRule[] {
    const style = this.styles.get(code);
    return style?.inTextRules || [];
  }

  getRuleById(styleCode: string, ruleId: string): StyleRule | undefined {
    const rules = this.getRulesForStyle(styleCode);
    return rules.find(r => r.id === ruleId);
  }

  getRulesByCategory(styleCode: string, category: string): StyleRule[] {
    const rules = this.getRulesForStyle(styleCode);
    return rules.filter(r => r.category === category);
  }
}

export const styleRulesService = new StyleRulesService();
```

This service provides:
1. Style definitions for APA 7th, MLA 9th, Chicago 17th, Vancouver, IEEE
2. Detailed rules with examples for each style
3. Methods to retrieve rules by style, category, or ID
```

---

## Backend Prompt 5.1.3: Citation Validation Service

```
Create the citation validation service at src/services/citation/citation-validation.service.ts.

```typescript
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { geminiService } from '../ai/gemini.service';
import { styleRulesService, StyleRule } from './style-rules.service';
import { AppError } from '../../utils/app-error';

export interface ValidationViolation {
  citationId: string;
  citationText: string;
  violationType: string;
  ruleReference: string;
  ruleName: string;
  explanation: string;
  originalText: string;
  suggestedFix: string;
  correctedCitation: string;
  severity: 'error' | 'warning' | 'info';
}

export interface ValidationResult {
  documentId: string;
  styleCode: string;
  styleName: string;
  summary: {
    totalCitations: number;
    validCitations: number;
    citationsWithErrors: number;
    citationsWithWarnings: number;
    errorCount: number;
    warningCount: number;
  };
  violations: ValidationViolation[];
}

class CitationValidationService {
  /**
   * Validate all citations in a document against a style guide
   */
  async validateDocument(
    documentId: string,
    styleCode: string,
    tenantId: string
  ): Promise<ValidationResult> {
    // Verify document exists and belongs to tenant
    const document = await prisma.editorialDocument.findFirst({
      where: { id: documentId, tenantId }
    });

    if (!document) {
      throw AppError.notFound('Document not found');
    }

    // Get all citations for the document
    const citations = await prisma.citation.findMany({
      where: { documentId },
      include: {
        primaryComponent: true
      }
    });

    if (citations.length === 0) {
      return {
        documentId,
        styleCode,
        styleName: styleRulesService.getStyle(styleCode)?.name || styleCode,
        summary: {
          totalCitations: 0,
          validCitations: 0,
          citationsWithErrors: 0,
          citationsWithWarnings: 0,
          errorCount: 0,
          warningCount: 0
        },
        violations: []
      };
    }

    // Get style rules
    const style = styleRulesService.getStyle(styleCode);
    if (!style) {
      throw AppError.badRequest(`Unknown style code: ${styleCode}`);
    }

    // Clear previous validations for this document and style
    await prisma.citationValidation.deleteMany({
      where: { documentId, styleCode }
    });

    // Validate each citation
    const allViolations: ValidationViolation[] = [];

    for (const citation of citations) {
      const violations = await this.validateCitation(citation, styleCode);

      // Save violations to database
      for (const violation of violations) {
        await prisma.citationValidation.create({
          data: {
            documentId,
            citationId: citation.id,
            styleCode,
            violationType: violation.violationType,
            ruleReference: violation.ruleReference,
            ruleName: violation.ruleName,
            explanation: violation.explanation,
            originalText: violation.originalText,
            suggestedFix: violation.suggestedFix,
            severity: violation.severity,
            status: 'pending'
          }
        });
      }

      allViolations.push(...violations);

      // Update citation validation status
      const hasErrors = violations.some(v => v.severity === 'error');
      const hasWarnings = violations.some(v => v.severity === 'warning');

      await prisma.citation.update({
        where: { id: citation.id },
        data: {
          validationStatus: hasErrors ? 'has_errors' : hasWarnings ? 'has_warnings' : 'valid',
          lastValidatedAt: new Date(),
          lastValidatedStyle: styleCode
        }
      });
    }

    // Calculate summary
    const citationsWithErrors = new Set(
      allViolations.filter(v => v.severity === 'error').map(v => v.citationId)
    ).size;
    const citationsWithWarnings = new Set(
      allViolations.filter(v => v.severity === 'warning').map(v => v.citationId)
    ).size;

    return {
      documentId,
      styleCode,
      styleName: style.name,
      summary: {
        totalCitations: citations.length,
        validCitations: citations.length - citationsWithErrors - citationsWithWarnings,
        citationsWithErrors,
        citationsWithWarnings,
        errorCount: allViolations.filter(v => v.severity === 'error').length,
        warningCount: allViolations.filter(v => v.severity === 'warning').length
      },
      violations: allViolations
    };
  }

  /**
   * Validate a single citation using AI
   */
  private async validateCitation(
    citation: { id: string; rawText: string; citationType: string; detectedStyle?: string | null },
    styleCode: string
  ): Promise<ValidationViolation[]> {
    const style = styleRulesService.getStyle(styleCode);
    if (!style) return [];

    const rules = style.inTextRules;
    const rulesText = rules.map(r =>
      `- ${r.reference}: ${r.name} (${r.severity})\n  ${r.description}\n  Example: "${r.examples[0]?.incorrect}" → "${r.examples[0]?.correct}"`
    ).join('\n');

    const prompt = `You are an expert citation validator. Analyze this citation against ${style.name} rules.

CITATION TEXT:
"${citation.rawText}"

CITATION TYPE: ${citation.citationType}

${style.name} RULES TO CHECK:
${rulesText}

IMPORTANT CONTEXT:
- "n.d." is acceptable when no date is available
- "et al." usage depends on number of authors and citation occurrence
- Some variations may be acceptable - only flag clear violations

For each violation found, return a JSON array with objects containing:
- violationType: category (punctuation, capitalization, author_format, date_format, italics, order)
- ruleReference: the rule number (e.g., "APA 8.17")
- ruleName: brief rule name
- explanation: why this is a violation
- originalText: the specific problematic text
- suggestedFix: the corrected text
- correctedCitation: the full corrected citation
- severity: "error" or "warning"

Return an empty array [] if no violations found.
Return ONLY valid JSON array, no other text.`;

    try {
      const response = await geminiService.generateText(prompt, {
        temperature: 0.1,
        maxOutputTokens: 2048
      });

      const violations = JSON.parse(response.text);

      if (!Array.isArray(violations)) {
        return [];
      }

      return violations.map(v => ({
        citationId: citation.id,
        citationText: citation.rawText,
        violationType: v.violationType || 'unknown',
        ruleReference: v.ruleReference || '',
        ruleName: v.ruleName || '',
        explanation: v.explanation || '',
        originalText: v.originalText || '',
        suggestedFix: v.suggestedFix || '',
        correctedCitation: v.correctedCitation || citation.rawText,
        severity: v.severity === 'error' ? 'error' : 'warning'
      }));
    } catch (error) {
      logger.error('[Citation Validation] AI validation failed', error instanceof Error ? error : undefined);
      return [];
    }
  }

  /**
   * Get all validations for a document
   */
  async getValidations(
    documentId: string,
    tenantId: string,
    filters?: {
      status?: string;
      severity?: string;
      violationType?: string;
    }
  ) {
    const document = await prisma.editorialDocument.findFirst({
      where: { id: documentId, tenantId }
    });

    if (!document) {
      throw AppError.notFound('Document not found');
    }

    const where: any = { documentId };
    if (filters?.status) where.status = filters.status;
    if (filters?.severity) where.severity = filters.severity;
    if (filters?.violationType) where.violationType = filters.violationType;

    return prisma.citationValidation.findMany({
      where,
      include: {
        citation: true
      },
      orderBy: { createdAt: 'desc' }
    });
  }

  /**
   * Get available citation styles
   */
  getAvailableStyles() {
    return styleRulesService.getAvailableStyles();
  }
}

export const citationValidationService = new CitationValidationService();
```
```

---

## Backend Prompt 5.1.4: Validation Controller & Routes

```
Create the validation controller at src/controllers/citation-validation.controller.ts.

```typescript
import { Request, Response, NextFunction } from 'express';
import { citationValidationService } from '../services/citation/citation-validation.service';
import { logger } from '../lib/logger';

export class CitationValidationController {
  /**
   * POST /api/v1/citation/document/:documentId/validate
   * Validate all citations against a style guide
   */
  async validateDocument(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { styleCode } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      if (!styleCode) {
        res.status(400).json({ success: false, error: 'styleCode is required' });
        return;
      }

      const result = await citationValidationService.validateDocument(
        documentId,
        styleCode,
        tenantId
      );

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Validation Controller] validateDocument failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/document/:documentId/validations
   * Get all validation results for a document
   */
  async getValidations(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { status, severity, violationType } = req.query;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const validations = await citationValidationService.getValidations(
        documentId,
        tenantId,
        {
          status: status as string,
          severity: severity as string,
          violationType: violationType as string
        }
      );

      res.json({ success: true, data: validations });
    } catch (error) {
      logger.error('[Validation Controller] getValidations failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/styles
   * Get available citation styles
   */
  async getStyles(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const styles = citationValidationService.getAvailableStyles();
      res.json({ success: true, data: styles });
    } catch (error) {
      logger.error('[Validation Controller] getStyles failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }
}

export const citationValidationController = new CitationValidationController();
```

Now add the routes to src/routes/citation.routes.ts (or create if doesn't exist):

```typescript
// Add these routes to the citation router

import { citationValidationController } from '../controllers/citation-validation.controller';

// Validation routes
router.post(
  '/document/:documentId/validate',
  authenticate,
  citationValidationController.validateDocument.bind(citationValidationController)
);

router.get(
  '/document/:documentId/validations',
  authenticate,
  citationValidationController.getValidations.bind(citationValidationController)
);

router.get(
  '/styles',
  authenticate,
  citationValidationController.getStyles.bind(citationValidationController)
);
```
```

---

# US-6.1: Citation Format Correction

## Backend Prompt 6.1.1: Correction Service

```
Create the citation correction service at src/services/citation/citation-correction.service.ts.

```typescript
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { geminiService } from '../ai/gemini.service';
import { styleRulesService } from './style-rules.service';
import { AppError } from '../../utils/app-error';

export interface CorrectionResult {
  validationId: string;
  citationId: string;
  originalText: string;
  correctedText: string;
  changeId: string;
}

export interface BatchCorrectionResult {
  correctedCount: number;
  skippedCount: number;
  changes: CorrectionResult[];
}

class CitationCorrectionService {
  /**
   * Accept a validation suggestion and apply the correction
   */
  async acceptCorrection(
    validationId: string,
    tenantId: string
  ): Promise<CorrectionResult> {
    const validation = await prisma.citationValidation.findUnique({
      where: { id: validationId },
      include: {
        citation: true,
        document: true
      }
    });

    if (!validation) {
      throw AppError.notFound('Validation not found');
    }

    if (validation.document.tenantId !== tenantId) {
      throw AppError.forbidden('Access denied');
    }

    if (validation.status !== 'pending') {
      throw AppError.badRequest('Validation already resolved');
    }

    // Apply the correction to the citation
    const originalText = validation.citation.rawText;
    const correctedText = validation.suggestedFix;

    // Update the citation
    await prisma.citation.update({
      where: { id: validation.citationId },
      data: {
        rawText: originalText.replace(validation.originalText, correctedText)
      }
    });

    // Track the change
    const change = await prisma.citationChange.create({
      data: {
        documentId: validation.documentId,
        citationId: validation.citationId,
        changeType: 'correction',
        beforeText: originalText,
        afterText: originalText.replace(validation.originalText, correctedText),
        appliedBy: tenantId // Should be userId in real implementation
      }
    });

    // Update validation status
    await prisma.citationValidation.update({
      where: { id: validationId },
      data: {
        status: 'accepted',
        resolvedText: correctedText,
        resolvedAt: new Date()
      }
    });

    return {
      validationId,
      citationId: validation.citationId,
      originalText,
      correctedText: originalText.replace(validation.originalText, correctedText),
      changeId: change.id
    };
  }

  /**
   * Reject a validation (mark as intentional)
   */
  async rejectCorrection(
    validationId: string,
    tenantId: string,
    reason?: string
  ): Promise<void> {
    const validation = await prisma.citationValidation.findUnique({
      where: { id: validationId },
      include: { document: true }
    });

    if (!validation) {
      throw AppError.notFound('Validation not found');
    }

    if (validation.document.tenantId !== tenantId) {
      throw AppError.forbidden('Access denied');
    }

    await prisma.citationValidation.update({
      where: { id: validationId },
      data: {
        status: 'rejected',
        resolvedAt: new Date(),
        explanation: reason ? `Rejected: ${reason}` : validation.explanation
      }
    });
  }

  /**
   * Apply a manual edit instead of the suggestion
   */
  async applyManualEdit(
    validationId: string,
    correctedText: string,
    tenantId: string
  ): Promise<CorrectionResult> {
    const validation = await prisma.citationValidation.findUnique({
      where: { id: validationId },
      include: {
        citation: true,
        document: true
      }
    });

    if (!validation) {
      throw AppError.notFound('Validation not found');
    }

    if (validation.document.tenantId !== tenantId) {
      throw AppError.forbidden('Access denied');
    }

    const originalText = validation.citation.rawText;

    // Update the citation with manual edit
    await prisma.citation.update({
      where: { id: validation.citationId },
      data: { rawText: correctedText }
    });

    // Track the change
    const change = await prisma.citationChange.create({
      data: {
        documentId: validation.documentId,
        citationId: validation.citationId,
        changeType: 'correction',
        beforeText: originalText,
        afterText: correctedText,
        appliedBy: tenantId
      }
    });

    // Update validation status
    await prisma.citationValidation.update({
      where: { id: validationId },
      data: {
        status: 'edited',
        resolvedText: correctedText,
        resolvedAt: new Date()
      }
    });

    return {
      validationId,
      citationId: validation.citationId,
      originalText,
      correctedText,
      changeId: change.id
    };
  }

  /**
   * Batch correct similar violations
   */
  async batchCorrect(
    documentId: string,
    tenantId: string,
    options: {
      validationIds?: string[];
      violationType?: string;
      applyAll?: boolean;
    }
  ): Promise<BatchCorrectionResult> {
    const document = await prisma.editorialDocument.findFirst({
      where: { id: documentId, tenantId }
    });

    if (!document) {
      throw AppError.notFound('Document not found');
    }

    // Get validations to correct
    let validations;
    if (options.validationIds) {
      validations = await prisma.citationValidation.findMany({
        where: {
          id: { in: options.validationIds },
          documentId,
          status: 'pending'
        },
        include: { citation: true }
      });
    } else if (options.violationType && options.applyAll) {
      validations = await prisma.citationValidation.findMany({
        where: {
          documentId,
          violationType: options.violationType,
          status: 'pending'
        },
        include: { citation: true }
      });
    } else {
      throw AppError.badRequest('Provide validationIds or violationType with applyAll');
    }

    const results: CorrectionResult[] = [];
    let skippedCount = 0;

    for (const validation of validations) {
      try {
        const result = await this.acceptCorrection(validation.id, tenantId);
        results.push(result);
      } catch (error) {
        logger.warn(`[Correction] Skipped validation ${validation.id}`, error instanceof Error ? error : undefined);
        skippedCount++;
      }
    }

    return {
      correctedCount: results.length,
      skippedCount,
      changes: results
    };
  }

  /**
   * Get all changes for a document
   */
  async getChanges(documentId: string, tenantId: string) {
    const document = await prisma.editorialDocument.findFirst({
      where: { id: documentId, tenantId }
    });

    if (!document) {
      throw AppError.notFound('Document not found');
    }

    return prisma.citationChange.findMany({
      where: { documentId },
      orderBy: { appliedAt: 'desc' }
    });
  }

  /**
   * Revert a change
   */
  async revertChange(changeId: string, tenantId: string): Promise<void> {
    const change = await prisma.citationChange.findUnique({
      where: { id: changeId },
      include: { document: true }
    });

    if (!change) {
      throw AppError.notFound('Change not found');
    }

    if (change.document.tenantId !== tenantId) {
      throw AppError.forbidden('Access denied');
    }

    if (change.isReverted) {
      throw AppError.badRequest('Change already reverted');
    }

    // Revert the citation text
    if (change.citationId) {
      await prisma.citation.update({
        where: { id: change.citationId },
        data: { rawText: change.beforeText }
      });
    }

    // Mark change as reverted
    await prisma.citationChange.update({
      where: { id: changeId },
      data: {
        isReverted: true,
        revertedAt: new Date()
      }
    });
  }
}

export const citationCorrectionService = new CitationCorrectionService();
```
```

---

## Backend Prompt 6.1.2: Correction Controller & Routes

```
Create the correction controller at src/controllers/citation-correction.controller.ts.

```typescript
import { Request, Response, NextFunction } from 'express';
import { citationCorrectionService } from '../services/citation/citation-correction.service';
import { logger } from '../lib/logger';

export class CitationCorrectionController {
  /**
   * POST /api/v1/citation/validation/:validationId/accept
   */
  async acceptCorrection(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { validationId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationCorrectionService.acceptCorrection(validationId, tenantId);
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Correction Controller] acceptCorrection failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/validation/:validationId/reject
   */
  async rejectCorrection(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { validationId } = req.params;
      const { reason } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      await citationCorrectionService.rejectCorrection(validationId, tenantId, reason);
      res.json({ success: true });
    } catch (error) {
      logger.error('[Correction Controller] rejectCorrection failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/validation/:validationId/edit
   */
  async applyManualEdit(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { validationId } = req.params;
      const { correctedText } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      if (!correctedText) {
        res.status(400).json({ success: false, error: 'correctedText is required' });
        return;
      }

      const result = await citationCorrectionService.applyManualEdit(
        validationId,
        correctedText,
        tenantId
      );
      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Correction Controller] applyManualEdit failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/document/:documentId/correct/batch
   */
  async batchCorrect(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { validationIds, violationType, applyAll } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await citationCorrectionService.batchCorrect(documentId, tenantId, {
        validationIds,
        violationType,
        applyAll
      });

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Correction Controller] batchCorrect failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * GET /api/v1/citation/document/:documentId/changes
   */
  async getChanges(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const changes = await citationCorrectionService.getChanges(documentId, tenantId);
      res.json({ success: true, data: changes });
    } catch (error) {
      logger.error('[Correction Controller] getChanges failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/change/:changeId/revert
   */
  async revertChange(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { changeId } = req.params;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      await citationCorrectionService.revertChange(changeId, tenantId);
      res.json({ success: true });
    } catch (error) {
      logger.error('[Correction Controller] revertChange failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }
}

export const citationCorrectionController = new CitationCorrectionController();
```

Add these routes to src/routes/citation.routes.ts:

```typescript
import { citationCorrectionController } from '../controllers/citation-correction.controller';

// Correction routes
router.post(
  '/validation/:validationId/accept',
  authenticate,
  citationCorrectionController.acceptCorrection.bind(citationCorrectionController)
);

router.post(
  '/validation/:validationId/reject',
  authenticate,
  citationCorrectionController.rejectCorrection.bind(citationCorrectionController)
);

router.post(
  '/validation/:validationId/edit',
  authenticate,
  citationCorrectionController.applyManualEdit.bind(citationCorrectionController)
);

router.post(
  '/document/:documentId/correct/batch',
  authenticate,
  citationCorrectionController.batchCorrect.bind(citationCorrectionController)
);

router.get(
  '/document/:documentId/changes',
  authenticate,
  citationCorrectionController.getChanges.bind(citationCorrectionController)
);

router.post(
  '/change/:changeId/revert',
  authenticate,
  citationCorrectionController.revertChange.bind(citationCorrectionController)
);
```
```

---

# US-6.3: Reference List Generation

## Backend Prompt 6.3.1: CrossRef Service

```
Create the CrossRef API service at src/services/citation/crossref.service.ts.

```typescript
import { logger } from '../../lib/logger';

export interface CrossRefAuthor {
  given?: string;
  family: string;
  suffix?: string;
}

export interface EnrichedMetadata {
  authors: { firstName?: string; lastName: string; suffix?: string }[];
  title: string;
  year?: string;
  journalName?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  doi?: string;
  url?: string;
  publisher?: string;
  isbn?: string;
  sourceType: 'journal' | 'book' | 'chapter' | 'conference' | 'website' | 'unknown';
  source: 'crossref' | 'pubmed' | 'manual' | 'ai';
  confidence: number;
}

class CrossRefService {
  private baseUrl = 'https://api.crossref.org/works';
  private userAgent = 'Ninja-Citation-Tool/1.0 (mailto:support@ninja.com)';

  /**
   * Look up citation metadata by DOI
   */
  async lookupByDoi(doi: string): Promise<EnrichedMetadata | null> {
    try {
      const cleanDoi = doi.replace(/^https?:\/\/doi\.org\//, '');
      const url = `${this.baseUrl}/${encodeURIComponent(cleanDoi)}`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': this.userAgent
        }
      });

      if (!response.ok) {
        logger.warn(`[CrossRef] DOI lookup failed: ${response.status} for ${cleanDoi}`);
        return null;
      }

      const data = await response.json();
      const work = data.message;

      return this.mapCrossRefWork(work);
    } catch (error) {
      logger.error('[CrossRef] Lookup error', error instanceof Error ? error : undefined);
      return null;
    }
  }

  /**
   * Search for citations by title/author
   */
  async search(query: string, limit = 5): Promise<EnrichedMetadata[]> {
    try {
      const url = `${this.baseUrl}?query=${encodeURIComponent(query)}&rows=${limit}`;

      const response = await fetch(url, {
        headers: {
          'User-Agent': this.userAgent
        }
      });

      if (!response.ok) {
        return [];
      }

      const data = await response.json();
      const works = data.message?.items || [];

      return works.map((work: any) => this.mapCrossRefWork(work));
    } catch (error) {
      logger.error('[CrossRef] Search error', error instanceof Error ? error : undefined);
      return [];
    }
  }

  private mapCrossRefWork(work: any): EnrichedMetadata {
    const authors = (work.author || []).map((a: CrossRefAuthor) => ({
      firstName: a.given,
      lastName: a.family,
      suffix: a.suffix
    }));

    const year = work.published?.['date-parts']?.[0]?.[0]?.toString() ||
                 work.created?.['date-parts']?.[0]?.[0]?.toString();

    return {
      authors,
      title: work.title?.[0] || '',
      year,
      journalName: work['container-title']?.[0],
      volume: work.volume,
      issue: work.issue,
      pages: work.page,
      doi: work.DOI,
      url: work.URL || (work.DOI ? `https://doi.org/${work.DOI}` : undefined),
      publisher: work.publisher,
      sourceType: this.mapWorkType(work.type),
      source: 'crossref',
      confidence: 0.95
    };
  }

  private mapWorkType(type: string): EnrichedMetadata['sourceType'] {
    const typeMap: Record<string, EnrichedMetadata['sourceType']> = {
      'journal-article': 'journal',
      'book': 'book',
      'book-chapter': 'chapter',
      'proceedings-article': 'conference',
      'posted-content': 'website'
    };
    return typeMap[type] || 'unknown';
  }
}

export const crossRefService = new CrossRefService();
```
```

---

## Backend Prompt 6.3.2: Reference List Service

```
Create the reference list generation service at src/services/citation/reference-list.service.ts.

This is a large service - see the full implementation in the design document CITATION-VALIDATION-CORRECTION-DESIGN.md.

Key methods:
1. generateReferenceList(documentId, styleCode, tenantId, options)
2. formatReference(entry, styleCode) - uses AI
3. groupCitationsByReference(citations)
4. generateSortKey(entry)
5. updateEntry(entryId, updates, tenantId)
6. finalizeReferenceList(documentId, styleCode, tenantId)

The service should:
- Extract unique references from in-text citations
- Enrich metadata from CrossRef API when DOI is available
- Use AI to format references according to selected style
- Allow manual editing of entries
- Generate final formatted reference list
```

---

## Backend Prompt 6.3.3: Reference List Controller & Routes

```
Create the reference list controller at src/controllers/reference-list.controller.ts.

```typescript
import { Request, Response, NextFunction } from 'express';
import { referenceListService } from '../services/citation/reference-list.service';
import { logger } from '../lib/logger';

export class ReferenceListController {
  /**
   * POST /api/v1/citation/document/:documentId/reference-list/generate
   */
  async generateReferenceList(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { styleCode, options } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      if (!styleCode) {
        res.status(400).json({ success: false, error: 'styleCode is required' });
        return;
      }

      const result = await referenceListService.generateReferenceList(
        documentId,
        styleCode,
        tenantId,
        options
      );

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Reference List Controller] generate failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * PATCH /api/v1/citation/reference-list/:entryId
   */
  async updateEntry(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { entryId } = req.params;
      const updates = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const entry = await referenceListService.updateEntry(entryId, updates, tenantId);
      res.json({ success: true, data: entry });
    } catch (error) {
      logger.error('[Reference List Controller] updateEntry failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }

  /**
   * POST /api/v1/citation/document/:documentId/reference-list/finalize
   */
  async finalizeReferenceList(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { documentId } = req.params;
      const { styleCode } = req.body;
      const tenantId = req.user?.tenantId;

      if (!tenantId) {
        res.status(401).json({ success: false, error: 'Authentication required' });
        return;
      }

      const result = await referenceListService.finalizeReferenceList(
        documentId,
        styleCode,
        tenantId
      );

      res.json({ success: true, data: result });
    } catch (error) {
      logger.error('[Reference List Controller] finalize failed', error instanceof Error ? error : undefined);
      next(error);
    }
  }
}

export const referenceListController = new ReferenceListController();
```

Add routes to src/routes/citation.routes.ts:

```typescript
import { referenceListController } from '../controllers/reference-list.controller';

// Reference list routes
router.post(
  '/document/:documentId/reference-list/generate',
  authenticate,
  referenceListController.generateReferenceList.bind(referenceListController)
);

router.patch(
  '/reference-list/:entryId',
  authenticate,
  referenceListController.updateEntry.bind(referenceListController)
);

router.post(
  '/document/:documentId/reference-list/finalize',
  authenticate,
  referenceListController.finalizeReferenceList.bind(referenceListController)
);
```
```

---

## Implementation Order

**Do these prompts in sequence:**

1. **5.1.1**: Database Schema (run migration)
2. **5.1.2**: Style Rules Service
3. **5.1.3**: Citation Validation Service
4. **5.1.4**: Validation Controller & Routes
5. **6.1.1**: Correction Service
6. **6.1.2**: Correction Controller & Routes
7. **6.3.1**: CrossRef Service
8. **6.3.2**: Reference List Service
9. **6.3.3**: Reference List Controller & Routes

After completing backend, switch to frontend prompts.

---

**Last Updated**: February 2026
