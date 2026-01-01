import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import prisma from '../lib/prisma';
import { config } from '../config';
import { AppError } from '../utils/app-error';
import { ErrorCodes } from '../utils/error-codes';

interface RegisterInput {
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  tenantId?: string;
}

interface LoginInput {
  email: string;
  password: string;
}

interface TokenPayload {
  userId: string;
  email: string;
  tenantId: string;
  role: string;
}

export class AuthService {
  private generateTokens(payload: TokenPayload) {
    const accessToken = jwt.sign(payload, config.jwtSecret, {
      expiresIn: '15m',
    });
    
    const refreshToken = jwt.sign(payload, config.jwtRefreshSecret, {
      expiresIn: '7d',
    });

    return { accessToken, refreshToken };
  }

  async register(input: RegisterInput) {
    const existingUser = await prisma.user.findUnique({
      where: { email: input.email },
    });

    if (existingUser) {
      throw AppError.conflict('Email already registered', ErrorCodes.USER_EMAIL_EXISTS);
    }

    // Auto-assign default tenant if not provided
    let tenantId = input.tenantId;
    if (!tenantId) {
      const defaultTenant = await prisma.tenant.findFirst();
      if (!defaultTenant) {
        throw AppError.badRequest('No tenant available. Please contact administrator.');
      }
      tenantId = defaultTenant.id;
    }

    const hashedPassword = await bcrypt.hash(input.password, 12);

    const user = await prisma.user.create({
      data: {
        email: input.email,
        password: hashedPassword,
        firstName: input.firstName,
        lastName: input.lastName,
        tenantId: tenantId,
        role: 'USER',
      },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        tenantId: true,
        createdAt: true,
      },
    });

    const tokens = this.generateTokens({
      userId: user.id,
      email: user.email,
      tenantId: user.tenantId,
      role: user.role,
    });

    return { user, ...tokens };
  }

  async login(input: LoginInput) {
    const user = await prisma.user.findUnique({
      where: { email: input.email },
    });

    if (!user || user.deletedAt) {
      throw AppError.unauthorized('Invalid credentials', ErrorCodes.AUTH_INVALID_CREDENTIALS);
    }

    const isValidPassword = await bcrypt.compare(input.password, user.password);

    if (!isValidPassword) {
      throw AppError.unauthorized('Invalid credentials', ErrorCodes.AUTH_INVALID_CREDENTIALS);
    }

    const tokens = this.generateTokens({
      userId: user.id,
      email: user.email,
      tenantId: user.tenantId,
      role: user.role,
    });

    return {
      user: {
        id: user.id,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: user.role,
        tenantId: user.tenantId,
      },
      ...tokens,
    };
  }

  async refreshToken(token: string) {
    try {
      const decoded = jwt.verify(token, config.jwtRefreshSecret) as TokenPayload;
      
      const user = await prisma.user.findUnique({
        where: { id: decoded.userId },
      });

      if (!user || user.deletedAt) {
        throw AppError.notFound('User not found', ErrorCodes.USER_NOT_FOUND);
      }

      return this.generateTokens({
        userId: user.id,
        email: user.email,
        tenantId: user.tenantId,
        role: user.role,
      });
    } catch (error) {
      if (error instanceof AppError) {
        throw error;
      }
      throw AppError.unauthorized('Invalid refresh token', ErrorCodes.AUTH_TOKEN_INVALID);
    }
  }

  async getCurrentUser(userId: string) {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: {
        id: true,
        email: true,
        firstName: true,
        lastName: true,
        role: true,
        tenantId: true,
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
          },
        },
        createdAt: true,
        updatedAt: true,
      },
    });

    if (!user) {
      throw AppError.notFound('User not found', ErrorCodes.USER_NOT_FOUND);
    }

    return user;
  }
}

export const authService = new AuthService();
