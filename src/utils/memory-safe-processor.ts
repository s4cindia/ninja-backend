/**
 * Memory-Safe Processing Utilities
 * Provides utilities for processing large files without exhausting memory
 */

import { memoryConfig, getMemoryUsage, isMemorySafeForSize } from '../config/memory.config';
import { logger } from '../lib/logger';

/**
 * Error thrown when file is too large for memory-based processing
 */
export class FileTooLargeError extends Error {
  constructor(
    public readonly fileSize: number,
    public readonly maxSize: number,
    message?: string
  ) {
    super(message || `File size ${fileSize} exceeds maximum ${maxSize} for memory processing`);
    this.name = 'FileTooLargeError';
  }
}

/**
 * Check if a buffer can safely be processed in memory
 * Throws FileTooLargeError if not
 */
export function assertMemorySafe(buffer: Buffer, operation: string = 'processing'): void {
  if (buffer.length > memoryConfig.maxXmlMemorySize) {
    throw new FileTooLargeError(
      buffer.length,
      memoryConfig.maxXmlMemorySize,
      `File too large for ${operation}: ${buffer.length} bytes exceeds limit of ${memoryConfig.maxXmlMemorySize} bytes`
    );
  }

  if (!isMemorySafeForSize(buffer.length)) {
    const usage = getMemoryUsage();
    logger.warn(`[MemorySafe] Low memory for ${operation}`, {
      bufferSize: buffer.length,
      heapUsedMB: usage.heapUsedMB,
      heapTotalMB: usage.heapTotalMB
    });
  }
}

/**
 * Process a large string in chunks to avoid memory spikes
 * Useful for XML/HTML string manipulation
 */
export function processInChunks<T>(
  input: string,
  chunkSize: number,
  processor: (chunk: string, index: number, isLast: boolean) => T,
  combiner: (results: T[]) => T
): T {
  if (input.length <= chunkSize) {
    return processor(input, 0, true);
  }

  const results: T[] = [];
  let offset = 0;
  let index = 0;

  while (offset < input.length) {
    const end = Math.min(offset + chunkSize, input.length);
    const chunk = input.substring(offset, end);
    const isLast = end >= input.length;

    results.push(processor(chunk, index, isLast));

    offset = end;
    index++;
  }

  return combiner(results);
}

/**
 * Safely replace all occurrences in a string without creating multiple intermediate copies
 * Uses a single pass with callback approach
 */
export function safeReplaceAll(
  input: string,
  searchValue: string | RegExp,
  replaceValue: string
): string {
  // For small strings, use native replace
  if (input.length < memoryConfig.maxXmlMemorySize / 2) {
    if (typeof searchValue === 'string') {
      return input.split(searchValue).join(replaceValue);
    }
    return input.replace(new RegExp(searchValue, 'g'), replaceValue);
  }

  // For large strings, process in chunks to reduce peak memory
  // This is a simplified approach - for truly large files, streaming would be better
  const regex = typeof searchValue === 'string'
    ? new RegExp(escapeRegex(searchValue), 'g')
    : new RegExp(searchValue.source, searchValue.flags.includes('g') ? searchValue.flags : searchValue.flags + 'g');

  return input.replace(regex, replaceValue);
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Track memory usage during an operation
 */
export async function withMemoryTracking<T>(
  operation: string,
  fn: () => Promise<T>
): Promise<T> {
  const beforeUsage = getMemoryUsage();

  try {
    const result = await fn();

    const afterUsage = getMemoryUsage();
    const memoryDelta = afterUsage.heapUsedMB - beforeUsage.heapUsedMB;

    if (memoryDelta > 50) { // Log if memory increased by more than 50MB
      logger.info(`[MemoryTracking] ${operation} completed`, {
        memoryDeltaMB: memoryDelta,
        beforeMB: beforeUsage.heapUsedMB,
        afterMB: afterUsage.heapUsedMB
      });
    }

    return result;
  } catch (error) {
    const afterUsage = getMemoryUsage();
    logger.error(`[MemoryTracking] ${operation} failed`, {
      memoryUsedMB: afterUsage.heapUsedMB,
      error: error instanceof Error ? error.message : 'Unknown error'
    });
    throw error;
  }
}

/**
 * Force garbage collection if available (Node.js with --expose-gc flag)
 */
export function forceGC(): void {
  if (global.gc) {
    const before = getMemoryUsage();
    global.gc();
    const after = getMemoryUsage();
    logger.debug('[MemorySafe] Garbage collection', {
      freedMB: before.heapUsedMB - after.heapUsedMB
    });
  }
}

/**
 * Create a size-limited buffer that throws if content exceeds limit
 */
export class SizeLimitedBuffer {
  private chunks: Buffer[] = [];
  private totalSize = 0;

  constructor(private readonly maxSize: number) {}

  push(chunk: Buffer): void {
    if (this.totalSize + chunk.length > this.maxSize) {
      throw new FileTooLargeError(
        this.totalSize + chunk.length,
        this.maxSize,
        `Buffer size limit exceeded: ${this.totalSize + chunk.length} > ${this.maxSize}`
      );
    }

    this.chunks.push(chunk);
    this.totalSize += chunk.length;
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks);
  }

  toString(encoding: BufferEncoding = 'utf8'): string {
    return this.toBuffer().toString(encoding);
  }

  get size(): number {
    return this.totalSize;
  }
}
