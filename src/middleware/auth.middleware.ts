/**
 * @fileoverview Authentication and authorization middleware.
 * Handles JWT token validation and role-based access control.
 */

import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import prisma from '../lib/prisma';

/**
 * JWT token payload structure.
 * Contains user identity and authorization information.
 */
interface JwtPayload {
  /** Unique user identifier */
  userId: string;
  /** User's email address */
  email: string;
  /** Tenant/organization identifier for multi-tenancy */
  tenantId: string;
  /** User's role for authorization (e.g., 'ADMIN', 'USER') */
  role: string;
}

/**
 * Authentication middleware that validates JWT tokens.
 * Extracts user information from valid tokens and attaches to request.
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 * @returns 401 if token is missing, invalid, or expired
 */
export const authenticate = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        success: false,
        error: { message: 'No token provided' },
      });
      return;
    }

    const token = authHeader.split(' ')[1];
    
    const decoded = jwt.verify(token, config.jwtSecret) as JwtPayload;
    
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, tenantId: true, role: true, deletedAt: true },
    });

    if (!user || user.deletedAt) {
      res.status(401).json({
        success: false,
        error: { message: 'User not found or deactivated' },
      });
      return;
    }

    req.user = {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      role: user.role,
    };

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({
        success: false,
        error: { message: 'Token expired' },
      });
      return;
    }
    
    res.status(401).json({
      success: false,
      error: { message: 'Invalid token' },
    });
  }
};

/**
 * Authorization middleware factory that restricts access by user role.
 * Must be used after authenticate middleware.
 * @param roles - List of roles allowed to access the route
 * @returns Express middleware function
 * @example authorize('ADMIN', 'MANAGER') - Only admins and managers can access
 */
/**
 * Flexible authentication middleware for asset endpoints.
 * Supports both Bearer token header and query parameter token.
 * Used for serving images/assets to img tags in iframes that cannot set headers.
 * @param req - Express request object
 * @param res - Express response object
 * @param next - Express next function
 */
export const authenticateFlexible = async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  try {
    const headerToken = req.headers.authorization?.replace('Bearer ', '');
    const queryToken = req.query.token as string | undefined;
    
    const token = headerToken || queryToken;
    
    if (!token) {
      res.status(401).json({
        success: false,
        error: { message: 'Authentication required' },
      });
      return;
    }

    const decoded = jwt.verify(token, config.jwtSecret) as JwtPayload;
    
    const user = await prisma.user.findUnique({
      where: { id: decoded.userId },
      select: { id: true, email: true, tenantId: true, role: true, deletedAt: true },
    });

    if (!user || user.deletedAt) {
      res.status(401).json({
        success: false,
        error: { message: 'User not found or deactivated' },
      });
      return;
    }

    req.user = {
      id: user.id,
      email: user.email,
      tenantId: user.tenantId,
      role: user.role,
    };

    next();
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      res.status(401).json({
        success: false,
        error: { message: 'Token expired' },
      });
      return;
    }
    
    res.status(401).json({
      success: false,
      error: { message: 'Invalid token' },
    });
  }
};

export const authorize = (...roles: string[]) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        success: false,
        error: { message: 'Not authenticated' },
      });
      return;
    }

    if (!roles.includes(req.user.role)) {
      res.status(403).json({
        success: false,
        error: { message: 'Insufficient permissions' },
      });
      return;
    }

    next();
  };
};
