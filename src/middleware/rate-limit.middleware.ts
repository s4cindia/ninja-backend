/**
 * Rate Limiting Middleware
 *
 * Provides per-tenant rate limiting for expensive operations like AI validation.
 */

import { Response, NextFunction } from 'express';
import { logger } from '../lib/logger';
import type { AuthenticatedRequest } from '../types/authenticated-request';

interface RateLimitConfig {
  windowMs: number; // Time window in milliseconds
  maxRequests: number; // Max requests per window
  message?: string;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// In-memory store for rate limiting (use Redis for production scaling)
const rateLimitStore = new Map<string, RateLimitEntry>();

// Cleanup old entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateLimitStore.entries()) {
    if (entry.resetAt < now) {
      rateLimitStore.delete(key);
    }
  }
}, 60000); // Cleanup every minute

/**
 * Creates a rate limiting middleware for authenticated requests
 */
export function rateLimit(config: RateLimitConfig) {
  const { windowMs, maxRequests, message = 'Too many requests, please try again later' } = config;

  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    const tenantId = req.user?.tenantId;

    if (!tenantId) {
      // No tenant ID means not authenticated - let auth middleware handle it
      return next();
    }

    const key = `${tenantId}:${req.path}`;
    const now = Date.now();

    let entry = rateLimitStore.get(key);

    if (!entry || entry.resetAt < now) {
      // Create new window
      entry = {
        count: 1,
        resetAt: now + windowMs,
      };
      rateLimitStore.set(key, entry);
      return next();
    }

    entry.count++;

    if (entry.count > maxRequests) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);

      logger.warn(`[RateLimit] Tenant ${tenantId} exceeded rate limit on ${req.path}`);

      res.setHeader('Retry-After', retryAfter);
      res.setHeader('X-RateLimit-Limit', maxRequests);
      res.setHeader('X-RateLimit-Remaining', 0);
      res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000));

      return res.status(429).json({
        success: false,
        error: {
          code: 'RATE_LIMIT_EXCEEDED',
          message,
          retryAfter,
        },
      });
    }

    // Set rate limit headers
    res.setHeader('X-RateLimit-Limit', maxRequests);
    res.setHeader('X-RateLimit-Remaining', maxRequests - entry.count);
    res.setHeader('X-RateLimit-Reset', Math.ceil(entry.resetAt / 1000));

    return next();
  };
}

/**
 * Pre-configured rate limiters for common use cases
 */
export const rateLimiters = {
  // Style validation with AI: 10 requests per minute per tenant
  styleValidation: rateLimit({
    windowMs: 60 * 1000, // 1 minute
    maxRequests: 10,
    message: 'Style validation rate limit exceeded. Maximum 10 validations per minute.',
  }),

  // Style guide upload: 5 uploads per minute per tenant
  styleGuideUpload: rateLimit({
    windowMs: 60 * 1000,
    maxRequests: 5,
    message: 'Style guide upload rate limit exceeded. Maximum 5 uploads per minute.',
  }),

  // General API: 100 requests per minute per tenant
  general: rateLimit({
    windowMs: 60 * 1000,
    maxRequests: 100,
    message: 'API rate limit exceeded. Please slow down your requests.',
  }),
};
