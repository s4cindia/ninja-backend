import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import prisma from '../lib/prisma';

interface JwtPayload {
  userId: string;
  email: string;
  tenantId: string;
  role: string;
}

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
