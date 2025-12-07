import path from 'path';

export const uploadConfig = {
  uploadDir: process.env.UPLOAD_DIR 
    ? path.resolve(process.env.UPLOAD_DIR)
    : path.join(process.cwd(), 'data', 'uploads'),
  maxFileSize: 100 * 1024 * 1024,
  allowedMimeTypes: ['application/pdf', 'application/epub+zip'],
};
