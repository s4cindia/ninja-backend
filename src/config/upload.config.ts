import path from 'path';

/**
 * Upload Configuration
 * Defines file upload limits and allowed types
 */
export const uploadConfig = {
  /**
   * Base upload directory
   */
  uploadDir: process.env.UPLOAD_DIR
    ? path.resolve(process.env.UPLOAD_DIR)
    : path.join(process.cwd(), 'data', 'uploads'),

  /**
   * Maximum file size for uploads (50MB - reduced from 100MB for memory safety)
   * This aligns with memoryConfig.maxUploadFileSize
   */
  maxFileSize: parseInt(process.env.MAX_UPLOAD_FILE_SIZE || '52428800', 10),

  /**
   * Allowed MIME types for upload
   */
  allowedMimeTypes: [
    'application/pdf',
    'application/epub+zip',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ],

  /**
   * Maximum file size for memory-based processing (5MB)
   * Larger files will use disk-based streaming
   */
  memoryProcessingLimit: parseInt(process.env.MEMORY_PROCESSING_LIMIT || '5242880', 10),
};
