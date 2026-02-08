export const ACCESSIBILITY_PROMPTS = {
  ALT_TEXT_GENERATION: `You are an accessibility expert. Analyze this image and generate appropriate alt text.

Consider:
- The purpose and context of the image
- Key visual elements that convey meaning
- Whether the image is decorative or informational
- Text within the image that needs to be conveyed

Respond with a JSON object:
{
  "altText": "Descriptive alt text (1-125 characters preferred, max 500)",
  "isDecorative": false,
  "confidence": 0.95,
  "context": "Optional context about the image purpose",
  "reasoning": "Why this alt text was chosen"
}`,

  DOCUMENT_ANALYSIS: `You are a WCAG 2.1 accessibility expert. Analyze this document content for accessibility issues.

Evaluate against:
- WCAG 2.1 Level A, AA, and AAA criteria
- Section 508 requirements
- European Accessibility Act standards

For each issue found, provide:
- Specific WCAG criterion violated
- Severity (critical, serious, moderate, minor)
- Clear description of the problem
- Actionable recommendation to fix

Respond with a JSON object:
{
  "summary": {
    "totalIssues": 0,
    "criticalCount": 0,
    "seriousCount": 0,
    "moderateCount": 0,
    "minorCount": 0,
    "conformanceLevel": "AA" or null
  },
  "issues": [
    {
      "id": "issue-1",
      "type": "image-alt",
      "severity": "serious",
      "wcagCriteria": "1.1.1",
      "wcagLevel": "A",
      "description": "Image missing alternative text",
      "element": "<img src='...' />",
      "location": { "line": 42 },
      "recommendation": "Add descriptive alt attribute",
      "impact": "Screen reader users cannot understand image content"
    }
  ],
  "recommendations": ["General recommendation 1"],
  "passedCriteria": ["1.1.1", "1.2.1"]
}`,

  HEADING_STRUCTURE_ANALYSIS: `You are an accessibility expert. Analyze the heading structure of this document.

Check for:
- Logical heading hierarchy (h1 -> h2 -> h3, etc.)
- Skipped heading levels
- Multiple h1 elements
- Empty headings
- Headings used for styling rather than structure

Respond with a JSON object:
{
  "headings": [
    { "level": 1, "text": "Main Title", "isValid": true },
    { "level": 3, "text": "Section", "isValid": false, "issue": "Skipped h2 level" }
  ],
  "isLogicalStructure": false,
  "skippedLevels": [2],
  "recommendations": ["Add h2 headings before h3 sections"]
}`,

  TABLE_ANALYSIS: `You are an accessibility expert. Analyze this HTML table for accessibility compliance.

Check for:
- Proper header cells (th elements)
- Header associations (scope or headers attributes)
- Caption or summary for data tables
- Distinction between data and layout tables
- WCAG 1.3.1 and 1.3.2 compliance

Respond with a JSON object:
{
  "hasHeaders": true,
  "headerType": "row" | "column" | "both" | "none",
  "hasCaption": false,
  "hasSummary": false,
  "isDataTable": true,
  "isLayoutTable": false,
  "issues": [
    { "type": "missing-scope", "description": "Header cells lack scope attribute", "recommendation": "Add scope='col' or scope='row'" }
  ],
  "wcagCompliance": {
    "criterion_1_3_1": true,
    "criterion_1_3_2": false
  }
}`,

  COLOR_CONTRAST_ANALYSIS: `You are an accessibility expert. Analyze the color contrast between the foreground and background colors.

Calculate the contrast ratio and determine compliance with:
- WCAG 2.1 AA (4.5:1 for normal text, 3:1 for large text)
- WCAG 2.1 AAA (7:1 for normal text, 4.5:1 for large text)

Respond with a JSON object:
{
  "foreground": "#333333",
  "background": "#ffffff",
  "contrastRatio": 12.63,
  "passesAA": true,
  "passesAAA": true,
  "largeText": false,
  "recommendation": null
}`,

  LINK_ANALYSIS: `You are an accessibility expert. Analyze this link for accessibility best practices.

Check for:
- Descriptive link text (not "click here" or "read more")
- Purpose clear from context
- Opens in new window indication
- Distinguishable from surrounding text

Respond with a JSON object:
{
  "text": "Learn more about accessibility",
  "href": "/accessibility-guide",
  "isDescriptive": true,
  "issue": null,
  "suggestedText": null,
  "opensNewWindow": false,
  "hasWarning": false
}`,

  FORM_FIELD_ANALYSIS: `You are an accessibility expert. Analyze this form field for accessibility compliance.

Check for:
- Associated label element
- Aria-label or aria-labelledby
- Required field indication
- Error handling and messaging
- Placeholder misuse as label

Respond with a JSON object:
{
  "type": "text",
  "hasLabel": true,
  "labelText": "Email Address",
  "hasAssociatedLabel": true,
  "hasPlaceholder": true,
  "hasAriaLabel": false,
  "hasAriaDescribedBy": false,
  "isRequired": true,
  "hasRequiredIndicator": true,
  "hasErrorHandling": true,
  "issues": [],
  "recommendations": []
}`,

  WCAG_CONFORMANCE_CHECK: `You are a WCAG conformance expert. Evaluate the provided content against the specified WCAG criterion.

Provide a detailed assessment including:
- Pass/Fail/Not Applicable status
- Specific findings and evidence
- Recommendations for remediation if failing

Respond with a JSON object:
{
  "level": "A" | "AA" | "AAA",
  "criteria": "1.1.1",
  "status": "pass" | "fail" | "not-applicable" | "cannot-tell",
  "findings": "Detailed description of findings",
  "evidence": ["Screenshot reference", "Code snippet"]
}`,

  VPAT_SECTION_GENERATION: `You are a VPAT documentation expert. Generate a VPAT section entry for the specified WCAG criterion.

Use the standard VPAT 2.4 format with:
- Conformance level assessment
- Detailed remarks explaining the assessment
- Recommendations for improvement if not fully supporting

Respond with a JSON object:
{
  "criterion": "1.1.1 Non-text Content",
  "conformanceLevel": "Supports" | "Partially Supports" | "Does Not Support" | "Not Applicable",
  "remarks": "All images have appropriate alternative text...",
  "recommendations": "Consider adding long descriptions for complex images"
}`,

  IMAGE_ANALYSIS: `You are an accessibility expert analyzing images for alternative text requirements.

Determine:
- Image content and purpose
- Whether image contains text
- If decorative or informational
- Appropriate alt text suggestion
- Content type classification

Respond with a JSON object:
{
  "description": "Detailed description of the image",
  "containsText": false,
  "extractedText": null,
  "isDecorative": false,
  "suggestedAltText": "Suggested alt text for this image",
  "contentType": "photo" | "chart" | "diagram" | "icon" | "logo" | "decorative" | "complex" | "unknown",
  "accessibilityConsiderations": ["Consider providing long description for this complex chart"]
}`,

  ACCESSIBILITY_SCORE: `You are an accessibility scoring expert. Evaluate the overall accessibility of the provided content.

Score each WCAG principle from 0-100:
- Perceivable: Can users perceive all content?
- Operable: Can users navigate and interact?
- Understandable: Is content clear and predictable?
- Robust: Is content compatible with assistive technologies?

Respond with a JSON object:
{
  "overall": 75,
  "perceivable": 80,
  "operable": 70,
  "understandable": 85,
  "robust": 65,
  "breakdown": {
    "images": 90,
    "headings": 60,
    "forms": 80,
    "navigation": 70
  }
}`,
};

export function buildPromptWithContent(
  promptKey: keyof typeof ACCESSIBILITY_PROMPTS,
  content: string,
  additionalContext?: string
): string {
  const basePrompt = ACCESSIBILITY_PROMPTS[promptKey];
  
  let fullPrompt = `${basePrompt}

Content to analyze:
---
${content}
---`;

  if (additionalContext) {
    fullPrompt += `

Additional context:
${additionalContext}`;
  }

  fullPrompt += '\n\nIMPORTANT: Respond ONLY with valid JSON. No markdown, no explanation, just the JSON object.';

  return fullPrompt;
}

export function buildBatchPrompt(
  promptKey: keyof typeof ACCESSIBILITY_PROMPTS,
  items: string[],
  itemLabel = 'item'
): string {
  const basePrompt = ACCESSIBILITY_PROMPTS[promptKey];
  
  const itemsList = items.map((item, index) => 
    `${itemLabel} ${index + 1}:\n${item}`
  ).join('\n\n');

  return `${basePrompt}

Analyze each of the following ${items.length} ${itemLabel}s:

${itemsList}

IMPORTANT: Respond with a JSON array containing the analysis for each ${itemLabel} in order.`;
}
