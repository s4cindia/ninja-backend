/**
 * Memory Configuration
 * Defines thresholds and limits for memory-safe file processing
 */

export const memoryConfig = {
  /**
   * Maximum file size for in-memory processing (5MB)
   * Files larger than this will use streaming/disk-based processing
   */
  maxMemoryFileSize: parseInt(process.env.MAX_MEMORY_FILE_SIZE || '5242880', 10),

  /**
   * Maximum size for in-memory XML processing (10MB)
   * Larger XML documents will use chunked processing
   */
  maxXmlMemorySize: parseInt(process.env.MAX_XML_MEMORY_SIZE || '10485760', 10),

  /**
   * Chunk size for streaming operations (64KB)
   */
  streamChunkSize: parseInt(process.env.STREAM_CHUNK_SIZE || '65536', 10),

  /**
   * Maximum buffer size for magic byte validation (4KB)
   * Only need first few bytes to validate file type
   */
  magicByteBufferSize: 4096,

  /**
   * Maximum file size for upload (50MB - reduced from 100MB)
   */
  maxUploadFileSize: parseInt(process.env.MAX_UPLOAD_FILE_SIZE || '52428800', 10),

  /**
   * Memory warning threshold (80% of available memory)
   */
  memoryWarningThreshold: 0.8,

  /**
   * Enable memory monitoring logs
   */
  enableMemoryLogging: process.env.ENABLE_MEMORY_LOGGING === 'true',
};

/**
 * Get current memory usage stats
 */
export function getMemoryUsage(): {
  heapUsed: number;
  heapTotal: number;
  external: number;
  rss: number;
  heapUsedMB: number;
  heapTotalMB: number;
} {
  const usage = process.memoryUsage();
  return {
    heapUsed: usage.heapUsed,
    heapTotal: usage.heapTotal,
    external: usage.external,
    rss: usage.rss,
    heapUsedMB: Math.round(usage.heapUsed / 1024 / 1024),
    heapTotalMB: Math.round(usage.heapTotal / 1024 / 1024),
  };
}

/**
 * Check if processing a file of given size is safe for memory
 */
export function isMemorySafeForSize(fileSize: number): boolean {
  const usage = getMemoryUsage();
  const availableHeap = usage.heapTotal - usage.heapUsed;
  // Require at least 3x the file size available (for processing overhead)
  return availableHeap > fileSize * 3;
}
