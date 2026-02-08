# PDF Structure Validator

Validates PDF document structure for accessibility compliance according to WCAG 2.1 and Matterhorn Protocol standards.

## Features

- **Document Structure Validation**
  - PDF tagging verification (Matterhorn 01-003)
  - Suspect tag structure detection (Matterhorn 01-004)
  - Heading hierarchy validation (Matterhorn 06-001, WCAG 2.4.6)
  - Reading order verification (Matterhorn 09-004, WCAG 1.3.2)
  - Document language check (Matterhorn 11-001, WCAG 3.1.1)
  - Document title verification (WCAG 2.4.2)

- **Content Structure Validation**
  - List markup verification (L, LI, Lbl, LBody tags)
  - Table structure validation (Table, TR, TH, TD tags)
  - Table header and summary checks
  - Figure element verification

## Usage

### Basic Usage

```typescript
import { pdfStructureValidator } from './pdf-structure.validator';

// Validate from file path
const result = await pdfStructureValidator.validateFromFile('/path/to/document.pdf');

console.log(`Found ${result.issues.length} issues`);
console.log(`Critical: ${result.summary.critical}`);
console.log(`Serious: ${result.summary.serious}`);
console.log(`Moderate: ${result.summary.moderate}`);
console.log(`Minor: ${result.summary.minor}`);

// Check specific metadata
console.log(`Tagged PDF: ${result.metadata.isTaggedPDF}`);
console.log(`Has Language: ${result.metadata.hasDocumentLanguage}`);
console.log(`Has Title: ${result.metadata.hasDocumentTitle}`);
```

### Advanced Usage with Parsed PDF

```typescript
import { pdfStructureValidator } from './pdf-structure.validator';
import { pdfParserService } from '../pdf-parser.service';

// Parse PDF first
const parsedPdf = await pdfParserService.parse('/path/to/document.pdf');

try {
  // Validate the parsed PDF
  const result = await pdfStructureValidator.validate(parsedPdf);

  // Process issues
  for (const issue of result.issues) {
    console.log(`[${issue.severity}] ${issue.code}: ${issue.message}`);
    console.log(`  Location: ${issue.location}`);
    console.log(`  WCAG: ${issue.wcagCriteria?.join(', ')}`);
    console.log(`  Suggestion: ${issue.suggestion}`);
  }
} finally {
  // Always close the parsed PDF
  await pdfParserService.close(parsedPdf);
}
```

## Issue Types

### Critical Issues
- **MATTERHORN-01-003**: PDF is not tagged
  - The document lacks structural tags required for accessibility

### Serious Issues
- **MATTERHORN-01-004**: Suspect tag structure
  - The document has potential tagging problems
- **MATTERHORN-06-001**: Missing H1 heading
  - Document lacks a main heading
- **MATTERHORN-09-004**: Illogical reading order
  - Document content may not be read in logical sequence
- **MATTERHORN-11-001**: Missing document language
  - Document language not specified in metadata
- **WCAG-2.4.2**: Missing document title
  - Document title not present in metadata
- **HEADING-SKIP**: Skipped heading levels
  - Heading hierarchy has gaps (e.g., H1 → H3)
- **TABLE-INACCESSIBLE**: Table accessibility issues
  - Table missing headers or summary

### Moderate Issues
- **HEADING-MULTIPLE-H1**: Multiple H1 headings
  - Document has more than one main heading
- **READING-ORDER-***: Reading order issues
  - Multi-column layouts or visual order problems
- **LIST-NOT-TAGGED**: Lists in untagged PDF
  - Lists detected but document not tagged
- **LIST-IMPROPER-MARKUP**: Improper list markup
  - List not properly tagged with L, LI, Lbl, LBody

## WCAG Criteria Mapping

| Criterion | Level | Description |
|-----------|-------|-------------|
| 1.3.1 | A | Info and Relationships |
| 1.3.2 | A | Meaningful Sequence |
| 2.4.1 | A | Bypass Blocks |
| 2.4.2 | A | Page Titled |
| 2.4.6 | AA | Headings and Labels |
| 3.1.1 | A | Language of Page |

## Matterhorn Protocol Checkpoints

| Checkpoint | Description |
|------------|-------------|
| 01-003 | Document not tagged |
| 01-004 | Suspect tag structure |
| 06-001 | Heading structure |
| 09-004 | Reading order |
| 11-001 | Document language |

## Integration with BaseAuditService

The validator follows the BaseAuditService pattern and returns AuditIssue objects compatible with the standard audit workflow:

```typescript
interface AuditIssue {
  id: string;
  source: string;
  severity: 'critical' | 'serious' | 'moderate' | 'minor';
  code: string;
  message: string;
  wcagCriteria?: string[];
  location?: string;
  suggestion?: string;
  category?: string;
  element?: string;
  context?: string;
}
```

## Testing

Tests are located in `tests/unit/services/pdf/pdf-structure.validator.test.ts`.

Run tests:
```bash
npm test pdf-structure.validator.test.ts
```

## Dependencies

- `pdf-parser.service`: Parses PDF files
- `structure-analyzer.service`: Analyzes PDF structure and extracts accessibility information
- `base-audit.service`: Provides shared types and patterns
