/**
 * Prompt templates for AI-powered zone classification.
 * Used by the AI annotation service to classify zones on a per-page basis.
 */

export const PROMPT_VERSION = 'v2';

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
1. **Headings**: Use h1-h6 based on document hierarchy. Only classify as heading if the text is short (typically <100 chars), appears to introduce a section, and is stylistically distinct from body text. Long text blocks (>100 chars) are almost never headings — classify as "paragraph" even if the source says "section-header". When both Docling and pdfxt label as paragraph/text but AI considers heading, trust the extractors. "section-header" should be refined to a specific h-level only when genuine heading structure is evident.
2. **List items**: Only classify as "list-item" if content has explicit list markers: bullets (•, ▪, -, *), numbered prefixes (1., 2., a), b)), or is part of a clearly structured enumeration. Regular body text that happens to contain colons, numbers, or short sentences is still "paragraph". When in doubt between list-item and paragraph, prefer "paragraph".
3. **Headers/footers**: Running headers/footers on page edges = "header" or "footer". On page 1 they may be content.
4. **Figures**: Images, photos, diagrams = "figure". Must have visual content.
5. **Tables**: Tabular data with rows/columns = "table".
6. **Captions**: Text directly below/above a figure or table describing it = "caption".
7. **TOCI**: Table of contents items = "toci".
8. **Paragraphs**: Regular body text = "paragraph".
9. **Ghost/duplicate zones**: ONLY reject zones that have no content AND no bbox. These are extraction artifacts.
10. **Missing labels**: If a zone has content or a bbox but its label/type is null or empty, classify it based on its content — do NOT reject it. These zones need labels, not rejection.
11. **Case normalization**: Labels like "H3", "H2", "LI", "P" are equivalent to "h3", "h2", "list-item", "paragraph". If the existing label matches the correct type (ignoring case and format aliases), use CONFIRMED — not CORRECTED. Only use CORRECTED when the semantic type is actually wrong.

## Context Clues
- If content starts with "Chapter" or a number followed by a title → heading
- If content has explicit bullet markers (•, -, *, ▪) or numbered prefixes (1., 2., a)) → list-item
- Body text with colons or numbers but no list markers → paragraph (not list-item)
- If content is very short (< 10 chars) and at page top/bottom → likely header/footer
- Page ${pageNumber} of ${totalPages}: ${pageNumber <= 2 ? 'front matter (title, TOC likely)' : pageNumber >= totalPages - 1 ? 'back matter (index, references likely)' : 'body content'}

## Zones to Classify
\`\`\`json
${JSON.stringify(zonesJson, null, 2)}
\`\`\`

## Confidence Calibration
- Be conservative with confidence scores. Only use >= 0.95 when classification is unambiguous (e.g., both extractors agree, content clearly matches the type).
- Use 0.70-0.85 when the zone could plausibly be one of two types (e.g., could be paragraph or list-item).
- Use < 0.70 when you are guessing based on limited evidence.
- If the reconciliation bucket is RED (extractors disagree or one source is missing), confidence should rarely exceed 0.85.
- If you are changing the label (CORRECTED), be especially conservative with confidence unless the correct type is obvious from the content.

## Required Output Format
Return a JSON object with a "zones" array. Each entry must have:
- "zoneId": the zone ID from input
- "decision": "CONFIRMED" | "CORRECTED" | "REJECTED"
- "label": the correct zone type (use current type if CONFIRMED)
- "confidence": 0.0 to 1.0
- "reason": brief explanation (1 sentence)

Respond ONLY with valid JSON, no markdown or explanation.`;
}
