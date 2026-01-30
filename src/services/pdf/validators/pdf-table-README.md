## PDF Table Validator

Validates table accessibility in PDF documents, checking structure, headers, summaries, and layout table detection.

## Features

- **Table Structure Validation**
  - Checks if tables are properly tagged (Table, TR, TH, TD elements)
  - Validates proper nesting hierarchy
  - Detects irregular table structures
  - Verifies consistent row and column organization

- **Table Headers Validation**
  - Ensures tables have header rows or columns
  - Checks for scope attributes on headers
  - Validates header completeness for complex tables
  - Identifies tables needing both row and column headers

- **Table Summaries**
  - Checks for summary or caption on complex tables
  - Validates table descriptions for screen reader users

- **Layout Table Detection**
  - Automatically detects tables used for layout
  - Identifies single-column/row tables
  - Validates layout tables are marked as artifacts
  - Confidence scoring for layout detection

## Usage

### Basic Usage

```typescript
import { pdfTableValidator } from './pdf-table.validator';

// Validate tables in a PDF
const result = await pdfTableValidator.validateFromFile('/path/to/document.pdf');

console.log(`Total Tables: ${result.metadata.totalTables}`);
console.log(`Data Tables: ${result.metadata.dataTables}`);
console.log(`Layout Tables: ${result.metadata.layoutTables}`);
console.log(`Tables with Headers: ${result.metadata.tablesWithHeaders}`);
console.log(`Critical Issues: ${result.summary.critical}`);
```

### With Parsed PDF

```typescript
import { pdfTableValidator } from './pdf-table.validator';
import { pdfParserService } from '../pdf-parser.service';

const parsedPdf = await pdfParserService.parse('/path/to/document.pdf');

try {
  const result = await pdfTableValidator.validate(parsedPdf);

  // Process issues by severity
  const critical = result.issues.filter(i => i.severity === 'critical');
  const serious = result.issues.filter(i => i.severity === 'serious');

  console.log(`Critical table issues: ${critical.length}`);
  console.log(`Serious table issues: ${serious.length}`);

  // Display table metadata
  console.log('\nTable Summary:');
  console.log(`  Total: ${result.metadata.totalTables}`);
  console.log(`  With Headers: ${result.metadata.tablesWithHeaders}`);
  console.log(`  Without Headers: ${result.metadata.tablesWithoutHeaders}`);
  console.log(`  With Summary: ${result.metadata.tablesWithSummary}`);
} finally {
  await pdfParserService.close(parsedPdf);
}
```

### Processing Results

```typescript
const result = await pdfTableValidator.validateFromFile('/path/to/document.pdf');

// Group issues by table
const issuesByTable = new Map<string, AuditIssue[]>();

for (const issue of result.issues) {
  if (!issue.element) continue;

  if (!issuesByTable.has(issue.element)) {
    issuesByTable.set(issue.element, []);
  }
  issuesByTable.get(issue.element)!.push(issue);
}

// Display issues per table
for (const [tableId, issues] of issuesByTable) {
  console.log(`\nTable ${tableId}:`);
  for (const issue of issues) {
    console.log(`  [${issue.severity}] ${issue.message}`);
    console.log(`  💡 ${issue.suggestion}`);
  }
}
```

## Issue Types

### Critical Issues

**MATTERHORN-15-001**: Table not properly tagged
- **Severity**: Critical
- **WCAG**: 1.3.1 (Level A)
- **Description**: Table is not tagged with proper structure elements in a tagged PDF
- **Example**: Missing Table element or TR/TH/TD tags
- **Fix**: Add proper table tagging: Table > TR > TH/TD

### Serious Issues

**MATTERHORN-15-002**: Data table without headers
- **Severity**: Serious
- **WCAG**: 1.3.1 (Level A)
- **Description**: Table has no header row or column
- **Example**: Table with all TD cells, no TH cells
- **Fix**: Add TH (header) elements in first row or column

**MATTERHORN-15-003**: Irregular table structure
- **Severity**: Serious
- **WCAG**: 1.3.1, 1.3.2 (Level A)
- **Description**: Table has inconsistent or improper structure
- **Example**: Missing rows, inconsistent column counts, improper nesting
- **Fix**: Ensure consistent table structure with proper nesting

### Moderate Issues

**MATTERHORN-15-004**: Missing scope on headers
- **Severity**: Moderate
- **WCAG**: 1.3.1 (Level A)
- **Description**: Header cells lack scope attribute
- **Example**: TH without scope="row" or scope="col"
- **Fix**: Add scope attribute to TH elements

**TABLE-HEADERS-INCOMPLETE**: Incomplete headers on complex table
- **Severity**: Moderate
- **WCAG**: 1.3.1 (Level A)
- **Description**: Large table has only row or column headers, not both
- **Example**: 10×8 table with only header row
- **Fix**: Add both row and column headers for easier navigation

**MATTERHORN-15-005**: Layout table not marked as artifact
- **Severity**: Moderate
- **WCAG**: 1.3.1, 1.3.2 (Level A)
- **Description**: Table used for layout should be marked as artifact
- **Example**: Single-column table used for spacing
- **Fix**: Mark layout table as artifact or use role="presentation"

### Minor Issues

**TABLE-MISSING-SUMMARY**: Missing summary or caption
- **Severity**: Minor
- **WCAG**: 1.3.1 (Level A)
- **Description**: Complex table lacks summary describing purpose/structure
- **Example**: Large table without caption or summary
- **Fix**: Add summary or caption to help users understand table

## WCAG Criteria

| Criterion | Level | Description |
|-----------|-------|-------------|
| 1.3.1 | A | Info and Relationships |
| 1.3.2 | A | Meaningful Sequence |

## Matterhorn Protocol Checkpoints

| Checkpoint | Description | Severity |
|------------|-------------|----------|
| 15-001 | Table not tagged | Critical |
| 15-002 | Table without headers | Serious |
| 15-003 | Irregular table structure | Serious |
| 15-004 | Missing scope on headers | Moderate |
| 15-005 | Layout table not marked as artifact | Moderate |

## Table Types

### Data Tables
Tables that present data or information:
- **Characteristics**: Has headers, multiple rows/columns, structured data
- **Requirements**: Must have TH elements, proper structure, optional summary
- **Examples**: Financial data, schedules, comparison charts

### Layout Tables
Tables used for visual layout, not data:
- **Characteristics**: Single row/column, no headers, used for spacing
- **Requirements**: Should be marked as artifact or role="presentation"
- **Examples**: Multi-column page layouts, spacing tables
- **Detection**: Automatic based on structure analysis

## Layout Table Detection

The validator automatically detects layout tables using these criteria:

### Strong Indicators (Layout Table)
- Single column table (+30 points)
- Single row table (+30 points)
- No headers (+20 points)
- Small (2×2 or less) without headers (+15 points)

### Strong Indicators (Data Table)
- Has header row or column (-40 points)
- Has summary or caption (-50 points)
- Large (5+ rows, 3+ columns) (-20 points)

### Detection Threshold
- **Layout table**: Score ≥ 30
- **Confidence**: Score converted to 0-100% confidence level

### Examples

```typescript
// Single column (1×5) - Detected as layout table
// Confidence: ~60%
// Reason: single column, no headers

// Table with headers (5×3) - Data table
// Confidence: N/A (not layout)
// Reason: has headers

// Small table (2×2) without headers - Layout table
// Confidence: ~65%
// Reason: small table, no headers
```

## Table Structure Best Practices

### Proper Table Structure
```
Table
├── TR (Row 1 - Headers)
│   ├── TH (Header 1) scope="col"
│   └── TH (Header 2) scope="col"
├── TR (Row 2 - Data)
│   ├── TD (Cell 1)
│   └── TD (Cell 2)
└── TR (Row 3 - Data)
    ├── TD (Cell 3)
    └── TD (Cell 4)
```

### Complex Table with Both Headers
```
Table
├── Summary: "Sales data by region and quarter"
├── TR (Header Row)
│   ├── TH scope="col" (Q1)
│   ├── TH scope="col" (Q2)
│   └── TH scope="col" (Q3)
├── TR (Data Row)
│   ├── TH scope="row" (North)
│   ├── TD ($100k)
│   ├── TD ($120k)
│   └── TD ($140k)
└── TR (Data Row)
    ├── TH scope="row" (South)
    ├── TD ($90k)
    ├── TD ($95k)
    └── TD ($110k)
```

## Validation Rules

### Table Size Thresholds
- **Simple table**: < 5 rows and < 5 columns
- **Complex table**: ≥ 5 rows or ≥ 5 columns
- **Large table**: ≥ 10 rows or ≥ 8 columns

### Header Requirements
- **All tables**: Should have header row OR column
- **Complex tables**: Should consider both row AND column headers
- **Large tables**: Headers must have scope attributes

### Summary Requirements
- **Simple tables**: Summary optional
- **Complex tables**: Summary recommended
- **Large tables**: Summary strongly recommended

## Integration Example

```typescript
async function validateAndReportTables(filePath: string) {
  console.log('Validating PDF tables...\n');

  const result = await pdfTableValidator.validateFromFile(filePath);

  // Display summary
  console.log('=== Table Validation Summary ===\n');
  console.log(`Total Tables: ${result.metadata.totalTables}`);
  console.log(`Data Tables: ${result.metadata.dataTables}`);
  console.log(`Layout Tables: ${result.metadata.layoutTables}`);
  console.log(`With Headers: ${result.metadata.tablesWithHeaders}`);
  console.log(`Without Headers: ${result.metadata.tablesWithoutHeaders}`);
  console.log(`With Summary: ${result.metadata.tablesWithSummary}`);

  console.log('\n=== Issues by Severity ===\n');
  console.log(`Critical: ${result.summary.critical}`);
  console.log(`Serious: ${result.summary.serious}`);
  console.log(`Moderate: ${result.summary.moderate}`);
  console.log(`Minor: ${result.summary.minor}`);
  console.log(`Total: ${result.summary.total}`);

  // Display critical issues
  if (result.summary.critical > 0) {
    console.log('\n🔴 CRITICAL ISSUES:\n');
    const critical = result.issues.filter(i => i.severity === 'critical');
    for (const issue of critical) {
      console.log(`  ${issue.message}`);
      console.log(`  Location: ${issue.location}`);
      console.log(`  Fix: ${issue.suggestion}\n`);
    }
  }

  // Display serious issues
  if (result.summary.serious > 0) {
    console.log('\n🟠 SERIOUS ISSUES:\n');
    const serious = result.issues.filter(i => i.severity === 'serious');
    for (const issue of serious) {
      console.log(`  ${issue.message}`);
      console.log(`  Location: ${issue.location}`);
      console.log(`  Fix: ${issue.suggestion}\n`);
    }
  }

  // Compliance check
  const isCompliant = result.summary.critical === 0 && result.summary.serious === 0;
  console.log(`\n${isCompliant ? '✓' : '✗'} Table Accessibility: ${isCompliant ? 'PASS' : 'FAIL'}`);

  return result;
}
```

## Testing

Tests are located in `tests/unit/services/pdf/pdf-table.validator.test.ts`.

Run tests:
```bash
npm test pdf-table.validator.test.ts
```

Test coverage includes:
- Well-structured tables
- Tables without tagging
- Tables without headers
- Incomplete headers on complex tables
- Missing scope attributes
- Irregular table structures
- Missing summaries
- Layout table detection
- WCAG and Matterhorn mapping

## Dependencies

- **structure-analyzer.service**: Analyzes PDF structure and extracts table information
- **pdf-parser.service**: Parses PDF files
- **base-audit.service**: Shared types and patterns

## Performance

- **Fast**: Uses existing structure analysis (no additional PDF parsing)
- **Efficient**: Validates all tables in single pass
- **Scalable**: Handles documents with hundreds of tables

## Common Issues and Solutions

### Issue: "Table not properly tagged"
**Solution**: Use PDF authoring tool to add proper table tags (Table, TR, TH, TD)

### Issue: "Table without headers"
**Solution**: Mark first row or column as headers using TH elements instead of TD

### Issue: "Irregular structure"
**Solution**: Ensure all rows have same number of columns, fix merged cells, verify nesting

### Issue: "Layout table not marked"
**Solution**: Mark layout table as artifact in PDF structure, or avoid using tables for layout

## Related Validators

- **pdf-structure.validator**: Validates overall document structure
- **pdf-alttext.validator**: Validates image alternative text
- **pdf-contrast.validator**: Validates color contrast (future)
