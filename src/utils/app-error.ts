/**
 * @fileoverview Custom application error class for consistent error handling.
 * Provides factory methods for common HTTP error responses.
 */

/**
 * Custom error class for application-level errors.
 * Extends built-in Error with HTTP status codes and error codes.
 * Distinguishes operational errors from programming errors.
 */
export class AppError extends Error {
  /** HTTP status code for the error response */
  public statusCode: number;
  /** Indicates this is an expected operational error, not a bug */
  public isOperational: boolean;
  /** Optional machine-readable error code */
  public code?: string;

  /**
   * Creates a new AppError instance.
   * @param message - Human-readable error message
   * @param statusCode - HTTP status code (4xx for client, 5xx for server errors)
   * @param code - Optional machine-readable error code for API consumers
   */
  constructor(message: string, statusCode: number, code?: string) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    this.code = code;

    Error.captureStackTrace(this, this.constructor);
  }

  /**
   * Creates a 400 Bad Request error.
   * @param message - Error message describing the invalid request
   * @param code - Optional error code
   */
  static badRequest(message: string, code?: string): AppError {
    return new AppError(message, 400, code || 'BAD_REQUEST');
  }

  /**
   * Creates a 401 Unauthorized error.
   * @param message - Error message (defaults to 'Unauthorized')
   * @param code - Optional error code
   */
  static unauthorized(message: string = 'Unauthorized', code?: string): AppError {
    return new AppError(message, 401, code || 'UNAUTHORIZED');
  }

  /**
   * Creates a 403 Forbidden error.
   * @param message - Error message (defaults to 'Forbidden')
   * @param code - Optional error code
   */
  static forbidden(message: string = 'Forbidden', code?: string): AppError {
    return new AppError(message, 403, code || 'FORBIDDEN');
  }

  /**
   * Creates a 404 Not Found error.
   * @param message - Error message (defaults to 'Resource not found')
   * @param code - Optional error code
   */
  static notFound(message: string = 'Resource not found', code?: string): AppError {
    return new AppError(message, 404, code || 'NOT_FOUND');
  }

  /**
   * Creates a 409 Conflict error.
   * @param message - Error message describing the conflict
   * @param code - Optional error code
   */
  static conflict(message: string, code?: string): AppError {
    return new AppError(message, 409, code || 'CONFLICT');
  }

  /**
   * Creates a 422 Unprocessable Entity error.
   * @param message - Error message describing validation failure
   * @param code - Optional error code
   */
  static unprocessable(message: string, code?: string): AppError {
    return new AppError(message, 422, code || 'UNPROCESSABLE_ENTITY');
  }

  /**
   * Creates a 500 Internal Server Error.
   * @param message - Error message (defaults to 'Internal server error')
   * @param code - Optional error code
   */
  static internal(message: string = 'Internal server error', code?: string): AppError {
    return new AppError(message, 500, code || 'INTERNAL_ERROR');
  }

  /**
   * Creates a 503 Service Unavailable error.
   * @param message - Error message (defaults to 'Service unavailable')
   * @param code - Optional error code
   */
  static serviceUnavailable(message: string = 'Service unavailable', code?: string): AppError {
    return new AppError(message, 503, code || 'SERVICE_UNAVAILABLE');
  }
}
