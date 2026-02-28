/**
 * Text Similarity Utilities
 *
 * Provides algorithmic similarity functions for plagiarism detection.
 * No external API calls needed — pure computation.
 */

/**
 * Cosine similarity between two numeric vectors.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let magnitudeA = 0;
  let magnitudeB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    magnitudeA += a[i] * a[i];
    magnitudeB += b[i] * b[i];
  }

  const magnitude = Math.sqrt(magnitudeA) * Math.sqrt(magnitudeB);
  if (magnitude === 0) return 0;

  return dotProduct / magnitude;
}

/**
 * Generate word n-gram shingles from text.
 * E.g., "the quick brown fox" with n=3 → {"the quick brown", "quick brown fox"}
 */
function getShingles(text: string, n: number = 3): Set<string> {
  const words = text.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
  const shingles = new Set<string>();

  for (let i = 0; i <= words.length - n; i++) {
    shingles.add(words.slice(i, i + n).join(' '));
  }

  return shingles;
}

/**
 * Jaccard similarity on word shingles (3-word n-grams).
 * Returns a value between 0 and 1.
 * Good for detecting verbatim and near-verbatim copying without embeddings.
 */
export function shingleSimilarity(textA: string, textB: string, shingleSize: number = 3): number {
  const shinglesA = getShingles(textA, shingleSize);
  const shinglesB = getShingles(textB, shingleSize);

  if (shinglesA.size === 0 || shinglesB.size === 0) return 0;

  let intersection = 0;
  for (const shingle of shinglesA) {
    if (shinglesB.has(shingle)) intersection++;
  }

  const union = shinglesA.size + shinglesB.size - intersection;
  if (union === 0) return 0;

  return intersection / union;
}
