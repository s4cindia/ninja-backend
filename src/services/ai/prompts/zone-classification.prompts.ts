/**
 * Prompt templates for AI-powered zone classification.
 * Used by the AI annotation service to classify zones on a per-page basis.
 */

export const PROMPT_VERSION = 'v1';

export const VALID_ZONE_TYPES = [
  'paragraph', 'section-header', 'table', 'figure', 'caption',
  'footnote', 'header', 'footer', 'list-item', 'toci',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'formula',
] as const;

export interface ZoneInput {
  zoneId: string;
  type: string;
  label: string | null;
  source: string | null;
  content: string | null;
  bbox: { x: number; y: number; w: number; h: number } | null;
  pageNumber: number;
  reconciliationBucket: string | null;
  doclingLabel: string | null;
  pdfxtLabel: string | null;
}

export interface ZoneClassification {
  zoneId: string;
  decision: 'CONFIRMED' | 'CORRECTED' | 'REJECTED';
  label: string;
  confidence: number;
  reason: string;
}

export interface PageClassificationResponse {
  zones: ZoneClassification[];
}

export function buildPageClassificationPrompt(
  pageNumber: number,
  totalPages: number,
  zones: ZoneInput[],
): string {
  const zonesJson = zones.map((z) => ({
    id: z.zoneId,
    type: z.type,
    label: z.label,
    source: z.source,
    bucket: z.reconciliationBucket,
    doclingLabel: z.doclingLabel,
    pdfxtLabel: z.pdfxtLabel,
    content: z.content ? z.content.substring(0, 300) : null,
    bbox: z.bbox,
  }));

  return `You are an expert PDF accessibility analyst classifying structural zones extracted from a tagged PDF document.

## Task
Classify each zone on page ${pageNumber} of ${totalPages}. For each zone, decide:
- **CONFIRMED**: The current type/label is correct
- **CORRECTED**: The type is wrong — provide the correct label
- **REJECTED**: This zone should be excluded (ghost zone, duplicate, non-content artifact)

## Valid Zone Types
${VALID_ZONE_TYPES.join(', ')}

## Classification Rules
1. **Headings**: Use h1-h6 based on hierarchy. Chapter numbers = h1, chapter titles = h2, section headings = h3+. "section-header" should be refined to a specific h-level.
2. **List items**: Salary lists, bullet points, numbered items = "list-item" (not "paragraph").
3. **Headers/footers**: Running headers/footers on page edges = "header" or "footer". On page 1 they may be content.
4. **Figures**: Images, photos, diagrams = "figure". Must have visual content.
5. **Tables**: Tabular data with rows/columns = "table".
6. **Captions**: Text directly below/above a figure or table describing it = "caption".
7. **TOCI**: Table of contents items = "toci".
8. **Paragraphs**: Regular body text = "paragraph".
9. **Ghost/duplicate zones**: Zones with no content and no bbox = REJECTED.

## Context Clues
- If content starts with "Chapter" or a number followed by a title → heading
- If content contains ":" with a currency/number → likely list-item (salary/data list)
- If content is very short (< 10 chars) and at page top/bottom → likely header/footer
- Page ${pageNumber} of ${totalPages}: ${pageNumber <= 2 ? 'front matter (title, TOC likely)' : pageNumber >= totalPages - 1 ? 'back matter (index, references likely)' : 'body content'}

## Zones to Classify
\`\`\`json
${JSON.stringify(zonesJson, null, 2)}
\`\`\`

## Required Output Format
Return a JSON object with a "zones" array. Each entry must have:
- "zoneId": the zone ID from input
- "decision": "CONFIRMED" | "CORRECTED" | "REJECTED"
- "label": the correct zone type (use current type if CONFIRMED)
- "confidence": 0.0 to 1.0
- "reason": brief explanation (1 sentence)

Respond ONLY with valid JSON, no markdown or explanation.`;
}
