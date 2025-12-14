import path from 'path';
import fs from 'fs/promises';
import { AppError } from './app-error';
import { uploadConfig } from '../config/upload.config';

export async function validateFilePath(filePath: string): Promise<string> {
  const resolvedPath = path.resolve(filePath);
  const uploadsDir = path.resolve(uploadConfig.uploadDir);
  
  let canonicalPath: string;
  let canonicalUploadsDir: string;
  
  try {
    canonicalPath = await fs.realpath(resolvedPath);
    canonicalUploadsDir = await fs.realpath(uploadsDir);
  } catch {
    throw AppError.notFound('File not found');
  }
  
  const relativePath = path.relative(canonicalUploadsDir, canonicalPath);
  
  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw AppError.forbidden('Access denied: file path is outside allowed directory');
  }
  
  return canonicalPath;
}

export async function assertValidFilePath(filePath: string): Promise<string> {
  return validateFilePath(filePath);
}
