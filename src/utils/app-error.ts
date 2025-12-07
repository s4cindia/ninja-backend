export class AppError extends Error {
  public statusCode: number;
  public isOperational: boolean;
  public code?: string;

  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    this.code = code;

    Error.captureStackTrace(this, this.constructor);
  }

  static badRequest(message: string, code?: string): AppError {
    return new AppError(message, 400, code || 'BAD_REQUEST');
  }

  static unauthorized(message: string = 'Unauthorized', code?: string): AppError {
    return new AppError(message, 401, code || 'UNAUTHORIZED');
  }

  static forbidden(message: string = 'Forbidden', code?: string): AppError {
    return new AppError(message, 403, code || 'FORBIDDEN');
  }

  static notFound(message: string = 'Resource not found', code?: string): AppError {
    return new AppError(message, 404, code || 'NOT_FOUND');
  }

  static conflict(message: string, code?: string): AppError {
    return new AppError(message, 409, code || 'CONFLICT');
  }

  static unprocessable(message: string, code?: string): AppError {
    return new AppError(message, 422, code || 'UNPROCESSABLE_ENTITY');
  }

  static internal(message: string = 'Internal server error', code?: string): AppError {
    return new AppError(message, 500, code || 'INTERNAL_ERROR');
  }

  static serviceUnavailable(message: string = 'Service unavailable', code?: string): AppError {
    return new AppError(message, 503, code || 'SERVICE_UNAVAILABLE');
  }
}
