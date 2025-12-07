import multer from 'multer';
import path from 'path';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import { Request } from 'express';
import { uploadConfig } from '../config/upload.config';
import { AppError } from '../utils/app-error';
import { ErrorCodes } from '../utils/error-codes';

const storage = multer.diskStorage({
  destination: (req: Request, file, cb) => {
    const tenantId = req.user?.tenantId;
    if (!tenantId) {
      return cb(AppError.unauthorized('Authentication required'), '');
    }
    
    const uploadPath = path.join(uploadConfig.uploadDir, tenantId);
    
    fs.mkdirSync(uploadPath, { recursive: true });
    
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueId = uuidv4();
    const extension = path.extname(file.originalname);
    cb(null, `${uniqueId}${extension}`);
  },
});

const fileFilter = (
  req: Request,
  file: Express.Multer.File,
  cb: multer.FileFilterCallback
) => {
  if (uploadConfig.allowedMimeTypes.includes(file.mimetype)) {
    cb(null, true);
  } else {
    cb(
      AppError.badRequest(
        `Invalid file type. Allowed types: ${uploadConfig.allowedMimeTypes.join(', ')}`,
        ErrorCodes.FILE_INVALID_TYPE
      )
    );
  }
};

export const upload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: uploadConfig.maxFileSize,
  },
});

export const uploadSingle = upload.single('file');
