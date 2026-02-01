# PDF Alt Text Validator

Validates alternative text for images and figures in PDF documents using AI-powered quality assessment.

## Features

- **Alt Text Presence Validation**
  - Detects images without alternative text (critical issue)
  - Skips decorative images marked as artifacts
  - Identifies all non-decorative images requiring alt text

- **Alt Text Quality Assessment**
  - Detects generic alt text (serious issue)
  - Validates alt text length (too short or too long)
  - Identifies redundant prefixes ("image of", "picture of")
  - AI-powered content matching verification

- **AI Integration (Gemini)**
  - Generates alt text suggestions for images without alt text
  - Verifies existing alt text matches image content
  - Provides improved alt text recommendations

## Usage

### Basic Usage (Without AI)

```typescript
import { pdfAltTextValidator } from './pdf-alttext.validator';

// Validate without AI (faster, but no content matching)
const result = await pdfAltTextValidator.validateFromFile(
  '/path/to/document.pdf',
  false // useAI = false
);

console.log(`Found ${result.issues.length} alt text issues`);
console.log(`Images without alt text: ${result.metadata.imagesWithoutAltText}`);
console.log(`Critical: ${result.summary.critical}`);
console.log(`Serious: ${result.summary.serious}`);
```

### Advanced Usage (With AI)

```typescript
import { pdfAltTextValidator } from './pdf-alttext.validator';

// Validate with AI (slower, but provides better suggestions)
const result = await pdfAltTextValidator.validateFromFile(
  '/path/to/document.pdf',
  true // useAI = true
);

// Process issues with AI suggestions
for (const issue of result.issues) {
  console.log(`[${issue.severity}] ${issue.message}`);
  console.log(`Location: ${issue.location}`);

  if (issue.suggestion?.includes('AI suggestion')) {
    console.log(`💡 ${issue.suggestion}`);
  }
}
```

### With Parsed PDF

```typescript
import { pdfAltTextValidator } from './pdf-alttext.validator';
import { pdfParserService } from '../pdf-parser.service';

const parsedPdf = await pdfParserService.parse('/path/to/document.pdf');

try {
  const result = await pdfAltTextValidator.validate(parsedPdf, true);

  console.log('Alt Text Summary:');
  console.log(`Total Images: ${result.metadata.totalImages}`);
  console.log(`With Alt Text: ${result.metadata.imagesWithAltText}`);
  console.log(`Without Alt Text: ${result.metadata.imagesWithoutAltText}`);
  console.log(`Decorative: ${result.metadata.decorativeImages}`);
  console.log(`Quality Issues: ${result.metadata.imagesWithQualityIssues}`);
} finally {
  await pdfParserService.close(parsedPdf);
}
```

## Issue Types

### Critical Issues

**MATTERHORN-13-002**: Image with no alternative text
- **Severity**: Critical
- **WCAG**: 1.1.1 (Level A)
- **Description**: Image is not marked as decorative but has no alt text
- **Example**: `<img>` with no alt attribute or empty alt text
- **Fix**: Add descriptive alternative text

### Serious Issues

**MATTERHORN-13-003**: Generic alternative text
- **Severity**: Serious
- **WCAG**: 1.1.1 (Level A)
- **Description**: Alt text is too generic and not descriptive
- **Examples**: "image", "photo", "picture", "figure", "graphic"
- **Fix**: Replace with meaningful description of image content

### Moderate Issues

**ALT-TEXT-QUALITY**: Alt text quality issues
- **Severity**: Moderate
- **WCAG**: 1.1.1 (Level A)
- **Description**: Alt text has quality problems
- **Issues Detected**:
  - Too short (less than 3 characters)
  - Too long (over 150 characters)
  - Doesn't match image content (AI detection)
- **Fix**: Improve alt text to be descriptive and appropriate length

### Minor Issues

**ALT-TEXT-REDUNDANT-PREFIX**: Redundant prefix in alt text
- **Severity**: Minor
- **WCAG**: 1.1.1 (Level A)
- **Description**: Alt text starts with unnecessary prefix
- **Examples**: "image of", "picture of", "photo of", "graphic of"
- **Fix**: Remove the redundant prefix

## WCAG Criteria

All issues map to **WCAG 1.1.1 Non-text Content (Level A)**:

> All non-text content that is presented to the user has a text alternative that serves the equivalent purpose.

## Matterhorn Protocol Checkpoints

| Checkpoint | Description |
|------------|-------------|
| 13-001 | Graphics not tagged as Figure |
| 13-002 | Figure without alt text |
| 13-003 | Alt text not meaningful |

## Alt Text Best Practices

### Good Alt Text
✅ **Descriptive**: "Bar chart showing 25% sales increase from Q1 to Q4 2024"
✅ **Concise**: Under 125 characters when possible
✅ **Informative**: Conveys the purpose and content of the image
✅ **Context-appropriate**: Describes what's important in this context

### Bad Alt Text
❌ **Generic**: "image", "photo", "graphic"
❌ **Redundant**: "image of a chart", "picture of data"
❌ **Too vague**: "chart", "data"
❌ **Too long**: Paragraph-length descriptions

### Alt Text Length Guidelines
- **Minimum**: 3 characters
- **Recommended**: 10-125 characters
- **Maximum**: 150 characters
- **For complex images**: Use long description (longdesc) attribute for detailed explanations

### Decorative Images
Images that are purely decorative (e.g., design elements, spacers) should be:
- Marked as artifacts in the PDF structure
- Given empty alt text (alt="") in HTML
- Not announced by screen readers

## AI-Powered Features

### Alt Text Generation
When `useAI = true`, the validator uses Gemini AI to:
1. Analyze image content
2. Generate descriptive alt text (max 125 characters)
3. Provide suggestions in validation results

### Content Matching
The AI verifies that existing alt text accurately describes the image:
1. Compares alt text with actual image content
2. Flags mismatches as quality issues
3. Provides improved suggestions

### Performance Considerations
- AI analysis adds ~1-2 seconds per image
- Recommended for final validation or critical documents
- Use `useAI = false` for quick checks or large documents

## Integration Example

```typescript
// Complete validation workflow
async function validatePdfAltText(filePath: string) {
  console.log('Starting PDF alt text validation...');

  const result = await pdfAltTextValidator.validateFromFile(filePath, true);

  // Group issues by severity
  const critical = result.issues.filter(i => i.severity === 'critical');
  const serious = result.issues.filter(i => i.severity === 'serious');
  const moderate = result.issues.filter(i => i.severity === 'moderate');
  const minor = result.issues.filter(i => i.severity === 'minor');

  // Display results
  console.log('\n=== Alt Text Validation Results ===\n');
  console.log(`Total Images: ${result.metadata.totalImages}`);
  console.log(`Images with Alt Text: ${result.metadata.imagesWithAltText}`);
  console.log(`Images without Alt Text: ${result.metadata.imagesWithoutAltText}`);
  console.log(`Decorative Images: ${result.metadata.decorativeImages}`);
  console.log(`Quality Issues: ${result.metadata.imagesWithQualityIssues}`);

  console.log('\n=== Issues by Severity ===\n');
  console.log(`Critical: ${critical.length}`);
  console.log(`Serious: ${serious.length}`);
  console.log(`Moderate: ${moderate.length}`);
  console.log(`Minor: ${minor.length}`);

  // Display critical issues with suggestions
  if (critical.length > 0) {
    console.log('\n🔴 CRITICAL - Images Without Alt Text:\n');
    for (const issue of critical) {
      console.log(`  ${issue.location}`);
      if (issue.suggestion) {
        console.log(`  💡 ${issue.suggestion}\n`);
      }
    }
  }

  // Compliance check
  const isCompliant = result.summary.critical === 0 && result.summary.serious === 0;
  console.log(`\n${isCompliant ? '✓' : '✗'} WCAG 1.1.1 Compliance: ${isCompliant ? 'PASS' : 'FAIL'}`);

  return result;
}
```

## Testing

Tests are located in `tests/unit/services/pdf/pdf-alttext.validator.test.ts`.

Run tests:
```bash
npm test pdf-alttext.validator.test.ts
```

Test coverage includes:
- Images with and without alt text
- Generic alt text detection
- Alt text length validation
- Redundant prefix detection
- Decorative image handling
- AI integration (with mocked responses)
- Error handling

## Dependencies

- **image-extractor.service**: Extracts images from PDF with metadata
- **pdf-parser.service**: Parses PDF files
- **gemini.service**: AI-powered image analysis and text generation
- **base-audit.service**: Shared types and patterns

## Configuration

The validator uses these configurable thresholds:

```typescript
private readonly GENERIC_ALT_TEXT = [
  'image', 'photo', 'picture', 'graphic', 'figure', 'img', 'icon', 'logo'
];

private readonly REDUNDANT_PREFIXES = [
  'image of', 'picture of', 'photo of', 'graphic of',
  'figure of', 'illustration of', 'screenshot of'
];

private readonly MIN_ALT_TEXT_LENGTH = 3;
private readonly MAX_ALT_TEXT_LENGTH = 150;
private readonly RECOMMENDED_MAX_LENGTH = 125;
```

## Performance Tips

1. **Disable AI for quick scans**: Use `useAI = false` for faster validation
2. **Enable AI for quality checks**: Use `useAI = true` when accuracy is critical
3. **Batch processing**: Process multiple PDFs in parallel for better throughput
4. **Cache results**: Store validation results to avoid re-processing

## Common Issues and Solutions

### Issue: "Gemini API error"
**Solution**: Check that `GEMINI_API_KEY` is configured in environment variables

### Issue: "Image extraction failed"
**Solution**: Ensure PDF is not corrupted and contains valid image streams

### Issue: "AI suggestions not appearing"
**Solution**: Verify `useAI = true` and images have base64 data included

## Related Validators

- **pdf-structure.validator**: Validates document structure and headings
- **pdf-contrast.validator**: Validates color contrast (future)
- **pdf-table.validator**: Validates table accessibility and structure per US-PDF-2.4
