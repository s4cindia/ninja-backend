/**
 * Duplicate content detection.
 * Uses shingle-based (n-gram) Jaccard similarity to find near-duplicate paragraphs.
 * Flags paragraph pairs with similarity above 0.7 threshold.
 */

export interface CheckIssue {
  checkType: string;
  severity: 'ERROR' | 'WARNING' | 'SUGGESTION';
  title: string;
  description: string;
  startOffset?: number;
  endOffset?: number;
  originalText?: string;
  expectedValue?: string;
  actualValue?: string;
  suggestedFix?: string;
  context?: string;
}

export interface CheckResult {
  checkType: string;
  issues: CheckIssue[];
  metadata: Record<string, unknown>;
}

const SIMILARITY_THRESHOLD = 0.7;
const SHINGLE_SIZE = 3; // 3-word shingles
const MIN_PARAGRAPH_WORDS = 15; // Ignore very short paragraphs

interface Paragraph {
  text: string;
  offset: number;
  index: number;
}

/** Split text into paragraphs by double newlines or blank lines. */
function splitParagraphs(text: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const parts = text.split(/\n\s*\n/);
  let offset = 0;
  let index = 0;

  for (const part of parts) {
    const trimmed = part.trim();
    if (trimmed.length > 0) {
      const partOffset = text.indexOf(part, offset);
      paragraphs.push({
        text: trimmed,
        offset: partOffset >= 0 ? partOffset : offset,
        index,
      });
      index++;
    }
    offset += part.length + 1; // +1 for the newline consumed by split
  }

  return paragraphs;
}

/** Generate word-level shingles (n-grams) from text. */
function generateShingles(text: string, size: number): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 0);

  const shingles = new Set<string>();
  for (let i = 0; i <= words.length - size; i++) {
    shingles.add(words.slice(i, i + size).join(' '));
  }
  return shingles;
}

/** Jaccard similarity between two sets. */
function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function truncate(text: string, maxLen: number = 100): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '...';
}

export function checkDuplicateContent(text: string, _html: string): CheckResult {
  const issues: CheckIssue[] = [];
  const paragraphs = splitParagraphs(text);

  // Filter out short paragraphs (headings, captions, etc.)
  const substantive = paragraphs.filter(
    (p) => p.text.split(/\s+/).length >= MIN_PARAGRAPH_WORDS,
  );

  // Pre-compute shingles for each paragraph
  const shingleSets = substantive.map((p) => generateShingles(p.text, SHINGLE_SIZE));

  // Compare all pairs
  const duplicatePairs: { i: number; j: number; similarity: number }[] = [];

  for (let i = 0; i < substantive.length; i++) {
    for (let j = i + 1; j < substantive.length; j++) {
      const sim = jaccardSimilarity(shingleSets[i], shingleSets[j]);
      if (sim >= SIMILARITY_THRESHOLD) {
        duplicatePairs.push({ i, j, similarity: sim });
      }
    }
  }

  for (const pair of duplicatePairs) {
    const paraA = substantive[pair.i];
    const paraB = substantive[pair.j];
    const isExact = pair.similarity > 0.95;

    issues.push({
      checkType: 'DUPLICATE_CONTENT',
      severity: isExact ? 'ERROR' : 'WARNING',
      title: isExact ? 'Duplicate paragraph detected' : 'Near-duplicate paragraph detected',
      description: `Paragraph ${paraB.index + 1} is ${(pair.similarity * 100).toFixed(0)}% similar to paragraph ${paraA.index + 1}.${isExact ? ' This appears to be an exact or near-exact copy.' : ''}`,
      startOffset: paraB.offset,
      endOffset: paraB.offset + paraB.text.length,
      originalText: truncate(paraB.text),
      expectedValue: truncate(paraA.text),
      actualValue: truncate(paraB.text),
      suggestedFix: isExact
        ? `Remove the duplicate paragraph or consolidate with paragraph ${paraA.index + 1}.`
        : `Review paragraphs ${paraA.index + 1} and ${paraB.index + 1} for unintentional repetition.`,
    });
  }

  return {
    checkType: 'DUPLICATE_CONTENT',
    issues,
    metadata: {
      totalParagraphs: paragraphs.length,
      substantiveParagraphs: substantive.length,
      duplicatePairsFound: duplicatePairs.length,
      averageSimilarity:
        duplicatePairs.length > 0
          ? duplicatePairs.reduce((sum, p) => sum + p.similarity, 0) / duplicatePairs.length
          : 0,
    },
  };
}
