import { Request, Response, NextFunction } from 'express';
import { Prisma } from '@prisma/client';
import { AppError } from '../utils/app-error';
import { ErrorCodes } from '../utils/error-codes';
import { config } from '../config';

interface ErrorResponse {
  success: false;
  error: {
    message: string;
    code?: string;
    details?: unknown;
    stack?: string;
  };
}

const handlePrismaError = (error: Prisma.PrismaClientKnownRequestError): AppError => {
  switch (error.code) {
    case 'P2002': {
      const target = (error.meta?.target as string[])?.join(', ') || 'field';
      return AppError.conflict(
        `A record with this ${target} already exists`,
        ErrorCodes.DB_UNIQUE_CONSTRAINT
      );
    }
    case 'P2003':
      return AppError.badRequest(
        'Referenced record not found',
        ErrorCodes.DB_FOREIGN_KEY_CONSTRAINT
      );
    case 'P2025':
      return AppError.notFound(
        'Record not found',
        ErrorCodes.DB_QUERY_ERROR
      );
    default:
      return AppError.internal(
        'Database error occurred',
        ErrorCodes.DB_QUERY_ERROR
      );
  }
};

interface ErrorWithStatus extends Error {
  statusCode?: number;
  status?: number;
  code?: string;
}

export const errorHandler = (
  err: ErrorWithStatus,
  req: Request,
  res: Response,
  _next: NextFunction
): void => {

  let error: AppError;

  if (err instanceof AppError) {
    error = err;
  } else if (err instanceof Prisma.PrismaClientKnownRequestError) {
    error = handlePrismaError(err);
  } else if (err instanceof Prisma.PrismaClientValidationError) {
    error = AppError.badRequest('Invalid data provided', ErrorCodes.VALIDATION_ERROR);
  } else if (err.name === 'JsonWebTokenError') {
    error = AppError.unauthorized('Invalid token', ErrorCodes.AUTH_TOKEN_INVALID);
  } else if (err.name === 'TokenExpiredError') {
    error = AppError.unauthorized('Token expired', ErrorCodes.AUTH_TOKEN_EXPIRED);
  } else if (err.statusCode || err.status) {
    const statusCode = err.statusCode || err.status || 500;
    error = new AppError(err.message, statusCode, err.code);
  } else {
    error = AppError.internal(
      config.nodeEnv === 'production' ? 'An unexpected error occurred' : err.message,
      ErrorCodes.INTERNAL_ERROR
    );
  }

  const response: ErrorResponse = {
    success: false,
    error: {
      message: error.message,
      code: error.code,
      ...((error as Record<string, unknown>).details && { details: (error as Record<string, unknown>).details }),
      ...(config.nodeEnv === 'development' && { stack: err.stack }),
    },
  };

  res.status(error.statusCode).json(response);
};
