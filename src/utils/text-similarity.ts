/**
 * Text similarity utilities — word-level Jaccard, sequence LCS, and tokenization.
 * Used by docx-conversion for change detection and available for plagiarism scoring.
 */

/**
 * Tokenize text into lowercase words with punctuation stripped for similarity comparison.
 * Lowercasing prevents 'Introduction' vs 'introduction' from counting as different tokens.
 * Stripping punctuation prevents 'word,' vs 'word' from counting as different tokens.
 */
export function tokenize(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(Boolean).map(w => w.replace(/[^\w]/g, '')).filter(Boolean);
}

/**
 * Compute word-level Jaccard similarity between two texts (order-insensitive).
 * Uses multiset word counts so repeated words are handled correctly.
 * Returns a value between 0 (completely different) and 1 (identical).
 */
export function computeWordSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const wordsA = tokenize(a);
  const wordsB = tokenize(b);
  if (!wordsA.length || !wordsB.length) return 0;

  const countA = new Map<string, number>();
  for (const w of wordsA) countA.set(w, (countA.get(w) || 0) + 1);

  const countB = new Map<string, number>();
  for (const w of wordsB) countB.set(w, (countB.get(w) || 0) + 1);

  let intersection = 0;
  for (const [w, count] of countA) {
    intersection += Math.min(count, countB.get(w) || 0);
  }

  const allWords = new Set([...countA.keys(), ...countB.keys()]);
  let union = 0;
  for (const w of allWords) {
    union += Math.max(countA.get(w) || 0, countB.get(w) || 0);
  }

  return union > 0 ? intersection / union : 0;
}

/**
 * Bigram sequence overlap for large documents where full LCS is too expensive.
 * Compares ordered bigram sequences — reordering breaks bigram continuity.
 */
function computeBigramSequenceOverlap(tokensA: string[], tokensB: string[]): number {
  if (tokensA.length < 2 || tokensB.length < 2) {
    return tokensA.length === tokensB.length && tokensA.every((t, i) => t === tokensB[i]) ? 1 : 0;
  }

  const bigramsA = new Map<string, number>();
  for (let i = 0; i < tokensA.length - 1; i++) {
    const bg = tokensA[i] + '\0' + tokensA[i + 1];
    bigramsA.set(bg, (bigramsA.get(bg) || 0) + 1);
  }

  const bigramsB = new Map<string, number>();
  for (let i = 0; i < tokensB.length - 1; i++) {
    const bg = tokensB[i] + '\0' + tokensB[i + 1];
    bigramsB.set(bg, (bigramsB.get(bg) || 0) + 1);
  }

  let intersection = 0;
  for (const [bg, count] of bigramsA) {
    intersection += Math.min(count, bigramsB.get(bg) || 0);
  }

  // Use max (not avg) as denominator — conservative for DOCX change detection.
  // A short text fully contained in a long text still scores low, which is correct
  // for detecting edits (length change = significant edit). If reused for plagiarism
  // scoring where containment matters, consider avg or Jaccard union instead.
  const totalBigrams = Math.max(tokensA.length - 1, tokensB.length - 1);
  return totalBigrams > 0 ? intersection / totalBigrams : 0;
}

/**
 * Compute order-sensitive sequence similarity using longest common subsequence (LCS)
 * on token lists. Returns ratio of LCS length to the longer token list length.
 * Catches reordering that bag-of-words Jaccard misses.
 */
export function computeSequenceSimilarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const tokensA = tokenize(a);
  const tokensB = tokenize(b);
  if (!tokensA.length || !tokensB.length) return 0;

  const m = tokensA.length;
  const n = tokensB.length;

  // For very large documents, use a windowed approach to avoid O(m*n) memory.
  // LCS on 50k+ tokens would be expensive; fall back to bigram overlap.
  if (m * n > 4_000_000) {
    return computeBigramSequenceOverlap(tokensA, tokensB);
  }

  // Standard LCS with two-row DP (O(min(m,n)) space)
  const shorter = m <= n ? tokensA : tokensB;
  const longer = m <= n ? tokensB : tokensA;
  const sLen = shorter.length;
  const lLen = longer.length;

  let prev = new Array<number>(sLen + 1).fill(0);
  let curr = new Array<number>(sLen + 1).fill(0);

  for (let i = 1; i <= lLen; i++) {
    for (let j = 1; j <= sLen; j++) {
      if (longer[i - 1] === shorter[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    [prev, curr] = [curr, prev];
    curr.fill(0);
  }

  const lcsLength = prev[sLen];
  return lcsLength / Math.max(m, n);
}
