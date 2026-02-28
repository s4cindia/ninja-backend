/**
 * Split text into chunks at paragraph boundaries.
 * Breaks at `\n\n` first, then falls back to sentence boundaries (`. `).
 */
export function splitTextIntoChunks(
  text: string,
  maxChunkSize = 20_000
): Array<{ text: string; offset: number }> {
  if (maxChunkSize <= 0) {
    throw new Error(`maxChunkSize must be positive, got ${maxChunkSize}`);
  }

  const chunks: Array<{ text: string; offset: number }> = [];
  let currentOffset = 0;

  while (currentOffset < text.length) {
    let endOffset = Math.min(currentOffset + maxChunkSize, text.length);

    if (endOffset < text.length) {
      const lastParagraph = text.lastIndexOf('\n\n', endOffset);
      if (lastParagraph > currentOffset + maxChunkSize / 2) {
        endOffset = lastParagraph + 2;
      } else {
        const lastSentence = text.lastIndexOf('. ', endOffset);
        if (lastSentence > currentOffset + maxChunkSize / 2) {
          endOffset = lastSentence + 2;
        }
      }
    }

    chunks.push({
      text: text.slice(currentOffset, endOffset),
      offset: currentOffset,
    });

    currentOffset = endOffset;
  }

  return chunks;
}
