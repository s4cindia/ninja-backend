/**
 * Editor Controller
 * Handles OnlyOffice document editing integration
 *
 * Endpoints:
 * - POST /editor/session - Create editing session
 * - GET /editor/session/:sessionId - Get session info
 * - POST /editor/callback - OnlyOffice callback handler
 * - GET /editor/document/:sessionId - Serve document to OnlyOffice
 * - GET /editor/status - Check OnlyOffice availability
 * - DELETE /editor/session/:sessionId - Close session
 */

import { Request, Response, NextFunction } from 'express';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { EditorSessionStatus } from '@prisma/client';
import {
  onlyOfficeService,
  CallbackData,
} from '../../services/editor/onlyoffice.service';

export class EditorController {
  /**
   * POST /api/v1/editor/session
   * Create a new editing session
   */
  async createSession(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { documentId, mode = 'edit' } = req.body;
      const { tenantId, id: userId } = req.user!;

      logger.info(`[Editor] Creating session for document ${documentId}`);

      // Get user info for display name
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { firstName: true, lastName: true, email: true },
      });

      // Verify document exists and belongs to tenant
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        select: { id: true, originalName: true },
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      const userName = user
        ? `${user.firstName} ${user.lastName}`.trim() || user.email
        : 'User';

      const session = await onlyOfficeService.createSession(
        documentId,
        userId,
        userName,
        mode
      );

      res.status(201).json({
        success: true,
        data: {
          sessionId: session.id,
          documentId: session.documentId,
          expiresAt: session.expiresAt,
          documentServerUrl: onlyOfficeService.getDocumentServerUrl(),
          config: session.config,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/editor/session/:sessionId
   * Get session information
   */
  async getSession(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { sessionId } = req.params;
      const { tenantId } = req.user!;

      const session = await onlyOfficeService.getSession(sessionId);

      if (!session) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Session not found or expired' },
        });
        return;
      }

      // Verify tenant access
      const document = await prisma.editorialDocument.findFirst({
        where: { id: session.documentId, tenantId },
        select: { id: true },
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      res.json({
        success: true,
        data: {
          sessionId: session.id,
          documentId: session.documentId,
          status: session.status,
          expiresAt: session.expiresAt,
          documentServerUrl: onlyOfficeService.getDocumentServerUrl(),
          config: session.config,
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * POST /api/v1/editor/callback
   * Handle callbacks from OnlyOffice Document Server
   * This endpoint is called by OnlyOffice, not by users
   */
  async handleCallback(
    req: Request,
    res: Response,
    _next: NextFunction
  ): Promise<void> {
    try {
      const { sessionId } = req.query;
      const data = req.body as CallbackData;

      logger.info(`[Editor] Callback received for session ${sessionId}`);

      if (!sessionId || typeof sessionId !== 'string') {
        res.status(400).json({ error: 1 });
        return;
      }

      // JWT verification is REQUIRED unless explicitly disabled in development
      if (onlyOfficeService.isJwtVerificationRequired()) {
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.replace(/^bearer\s+/i, '');
        if (!token) {
          logger.warn(`[Editor] Missing JWT token for session ${sessionId}`);
          res.status(401).json({ error: 1 });
          return;
        }

        const verified = onlyOfficeService.verifyToken(token);
        if (!verified) {
          logger.warn(`[Editor] Invalid token for session ${sessionId}`);
          res.status(401).json({ error: 1 });
          return;
        }
      }

      const result = await onlyOfficeService.handleCallback(sessionId, data);
      res.json(result);
    } catch (error) {
      logger.error(`[Editor] Callback error: ${error}`);
      res.json({ error: 1 });
    }
  }

  /**
   * GET /api/v1/editor/document/:sessionId
   * Serve document content to OnlyOffice
   * This endpoint is called by OnlyOffice, not by users
   *
   * Security Model:
   * - Access is controlled by OnlyOffice-embedded signed JWT configuration
   * - Session IDs are cryptographically random UUIDs with 1-hour expiry
   * - Session state (ACTIVE/EDITING) and expiry are validated before serving
   * - OnlyOffice callbacks use JWT verification when enabled
   * - This endpoint does not require user authentication as OnlyOffice
   *   server requests cannot carry user auth tokens
   */
  async serveDocument(
    req: Request,
    res: Response,
    _next: NextFunction
  ): Promise<void> {
    try {
      const { sessionId } = req.params;

      logger.info(`[Editor] Serving document for session ${sessionId}`);

      // Validate session exists and is in valid state
      const session = await prisma.editorSession.findUnique({
        where: { id: sessionId },
        select: { id: true, status: true, expiresAt: true },
      });

      if (!session) {
        logger.warn(`[Editor] Session not found: ${sessionId}`);
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Session not found' },
        });
        return;
      }

      // Check session is not expired
      if (session.expiresAt < new Date()) {
        logger.warn(`[Editor] Session expired: ${sessionId}`);
        res.status(410).json({
          success: false,
          error: { code: 'SESSION_EXPIRED', message: 'Session has expired' },
        });
        return;
      }

      // Check session is in valid state (active or editing)
      const validStates: EditorSessionStatus[] = [EditorSessionStatus.ACTIVE, EditorSessionStatus.EDITING];
      if (!validStates.includes(session.status as EditorSessionStatus)) {
        logger.warn(`[Editor] Session in invalid state: ${sessionId} (${session.status})`);
        res.status(403).json({
          success: false,
          error: { code: 'INVALID_SESSION_STATE', message: 'Session is not active' },
        });
        return;
      }

      const buffer = await onlyOfficeService.getDocumentContent(sessionId);

      if (!buffer) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      res.setHeader(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      );
      res.setHeader('Content-Length', buffer.length);
      res.send(buffer);
    } catch (error) {
      _next(error);
    }
  }

  /**
   * GET /api/v1/editor/status
   * Check OnlyOffice Document Server availability
   */
  async getStatus(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const available = await onlyOfficeService.isAvailable();

      res.json({
        success: true,
        data: {
          available,
          documentServerUrl: onlyOfficeService.getDocumentServerUrl(),
        },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * DELETE /api/v1/editor/session/:sessionId
   * Close an editing session
   */
  async closeSession(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { sessionId } = req.params;
      const { tenantId, id: userId } = req.user!;

      const session = await onlyOfficeService.getSession(sessionId);

      if (!session) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Session not found' },
        });
        return;
      }

      // Verify ownership
      if (session.userId !== userId) {
        res.status(403).json({
          success: false,
          error: { code: 'FORBIDDEN', message: 'Cannot close another user\'s session' },
        });
        return;
      }

      // Verify tenant access
      const document = await prisma.editorialDocument.findFirst({
        where: { id: session.documentId, tenantId },
        select: { id: true },
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      await onlyOfficeService.closeSession(sessionId);

      res.json({
        success: true,
        data: { message: 'Session closed' },
      });
    } catch (error) {
      next(error);
    }
  }

  /**
   * GET /api/v1/editor/document/:documentId/sessions
   * Get active sessions for a document
   */
  async getDocumentSessions(
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> {
    try {
      const { documentId } = req.params;
      const { tenantId } = req.user!;

      // Verify document exists and belongs to tenant
      const document = await prisma.editorialDocument.findFirst({
        where: { id: documentId, tenantId },
        select: { id: true },
      });

      if (!document) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Document not found' },
        });
        return;
      }

      // Single query to get sessions - derive count from array length for consistency
      const sessions = await prisma.editorSession.findMany({
        where: {
          documentId,
          status: { in: [EditorSessionStatus.ACTIVE, EditorSessionStatus.EDITING] },
          expiresAt: { gt: new Date() },
        },
        select: {
          id: true,
          userId: true,
          status: true,
          lastActivity: true,
          expiresAt: true,
        },
      });

      res.json({
        success: true,
        data: {
          documentId,
          activeCount: sessions.length,
          sessions,
        },
      });
    } catch (error) {
      next(error);
    }
  }
}

export const editorController = new EditorController();
