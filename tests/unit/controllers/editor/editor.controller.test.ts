/**
 * Editor Controller Unit Tests
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Request, Response, NextFunction } from 'express';
import { EditorSessionStatus } from '@prisma/client';

// Mock dependencies
vi.mock('../../../../src/lib/prisma', () => ({
  default: {
    user: {
      findUnique: vi.fn(),
    },
    editorialDocument: {
      findFirst: vi.fn(),
    },
    editorSession: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  },
}));

vi.mock('../../../../src/lib/logger', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../../../../src/services/editor/onlyoffice.service', () => ({
  onlyOfficeService: {
    createSession: vi.fn(),
    getSession: vi.fn(),
    closeSession: vi.fn(),
    handleCallback: vi.fn(),
    getDocumentContent: vi.fn(),
    getDocumentServerUrl: vi.fn().mockReturnValue('http://localhost:8080'),
    isAvailable: vi.fn(),
    isJwtVerificationRequired: vi.fn().mockReturnValue(false),
    verifyToken: vi.fn(),
  },
}));

import prisma from '../../../../src/lib/prisma';
import { editorController } from '../../../../src/controllers/editor/editor.controller';
import { onlyOfficeService } from '../../../../src/services/editor/onlyoffice.service';

describe('EditorController', () => {
  let mockReq: Partial<Request>;
  let mockRes: Partial<Response>;
  let mockNext: NextFunction;

  beforeEach(() => {
    vi.clearAllMocks();

    mockRes = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      setHeader: vi.fn().mockReturnThis(),
      send: vi.fn().mockReturnThis(),
    };
    mockNext = vi.fn();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('getDocumentSessions', () => {
    it('should return paginated sessions', async () => {
      const mockSessions = [
        { id: 'session-1', userId: 'user-1', status: EditorSessionStatus.ACTIVE, lastActivity: new Date(), expiresAt: new Date(Date.now() + 3600000) },
        { id: 'session-2', userId: 'user-2', status: EditorSessionStatus.EDITING, lastActivity: new Date(), expiresAt: new Date(Date.now() + 3600000) },
      ];

      mockReq = {
        params: { documentId: 'doc-1' },
        query: { limit: '10', offset: '0' },
        user: { tenantId: 'tenant-1', id: 'user-1' },
      };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({ id: 'doc-1' } as any);
      vi.mocked(prisma.editorSession.count).mockResolvedValue(2);
      vi.mocked(prisma.editorSession.findMany).mockResolvedValue(mockSessions as any);

      await editorController.getDocumentSessions(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data: {
          documentId: 'doc-1',
          sessions: mockSessions,
          pagination: {
            total: 2,
            limit: 10,
            offset: 0,
            hasMore: false,
          },
        },
      });
    });

    it('should use default pagination when not provided', async () => {
      mockReq = {
        params: { documentId: 'doc-1' },
        query: {},
        user: { tenantId: 'tenant-1', id: 'user-1' },
      };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({ id: 'doc-1' } as any);
      vi.mocked(prisma.editorSession.count).mockResolvedValue(0);
      vi.mocked(prisma.editorSession.findMany).mockResolvedValue([]);

      await editorController.getDocumentSessions(mockReq as Request, mockRes as Response, mockNext);

      expect(prisma.editorSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 50, // default limit
          skip: 0,  // default offset
        })
      );
    });

    it('should enforce max limit of 100', async () => {
      mockReq = {
        params: { documentId: 'doc-1' },
        query: { limit: '500' }, // exceeds max
        user: { tenantId: 'tenant-1', id: 'user-1' },
      };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({ id: 'doc-1' } as any);
      vi.mocked(prisma.editorSession.count).mockResolvedValue(0);
      vi.mocked(prisma.editorSession.findMany).mockResolvedValue([]);

      await editorController.getDocumentSessions(mockReq as Request, mockRes as Response, mockNext);

      expect(prisma.editorSession.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          take: 100, // capped at max
        })
      );
    });

    it('should return 404 when document not found', async () => {
      mockReq = {
        params: { documentId: 'nonexistent' },
        query: {},
        user: { tenantId: 'tenant-1', id: 'user-1' },
      };

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

      await editorController.getDocumentSessions(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(404);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Document not found' },
      });
    });
  });

  describe('handleCallback', () => {
    it('should handle callback successfully', async () => {
      mockReq = {
        query: { sessionId: 'session-1' },
        body: { status: 2, url: 'http://example.com/doc.docx' },
        headers: {},
      };

      vi.mocked(onlyOfficeService.handleCallback).mockResolvedValue({ error: 0 });

      await editorController.handleCallback(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith({ error: 0 });
    });

    it('should return error 1 when callback throws', async () => {
      mockReq = {
        query: { sessionId: 'session-1' },
        body: { status: 2 },
        headers: {},
      };

      vi.mocked(onlyOfficeService.handleCallback).mockRejectedValue(new Error('S3 upload failed'));

      await editorController.handleCallback(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith({ error: 1 });
    });

    it('should return error when sessionId is missing', async () => {
      mockReq = {
        query: {},
        body: { status: 2 },
        headers: {},
      };

      await editorController.handleCallback(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(400);
      expect(mockRes.json).toHaveBeenCalledWith({ error: 1 });
    });
  });

  describe('createSession', () => {
    it('should create a new editing session', async () => {
      mockReq = {
        body: { documentId: 'doc-1', mode: 'edit' },
        user: { tenantId: 'tenant-1', id: 'user-1' },
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
      } as any);

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({
        id: 'doc-1',
        originalName: 'test.docx',
      } as any);

      vi.mocked(onlyOfficeService.createSession).mockResolvedValue({
        id: 'session-1',
        documentId: 'doc-1',
        expiresAt: new Date(Date.now() + 3600000),
        config: {},
      } as any);

      await editorController.createSession(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(201);
      expect(mockRes.json).toHaveBeenCalledWith(
        expect.objectContaining({
          success: true,
          data: expect.objectContaining({
            sessionId: 'session-1',
            documentId: 'doc-1',
          }),
        })
      );
    });

    it('should return 404 when document not found', async () => {
      mockReq = {
        body: { documentId: 'nonexistent' },
        user: { tenantId: 'tenant-1', id: 'user-1' },
      };

      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        firstName: 'John',
        lastName: 'Doe',
        email: 'john@example.com',
      } as any);

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue(null);

      await editorController.createSession(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(404);
    });
  });

  describe('closeSession', () => {
    it('should close a session owned by the user', async () => {
      mockReq = {
        params: { sessionId: 'session-1' },
        user: { tenantId: 'tenant-1', id: 'user-1' },
      };

      vi.mocked(onlyOfficeService.getSession).mockResolvedValue({
        id: 'session-1',
        userId: 'user-1',
        documentId: 'doc-1',
      } as any);

      vi.mocked(prisma.editorialDocument.findFirst).mockResolvedValue({ id: 'doc-1' } as any);
      vi.mocked(onlyOfficeService.closeSession).mockResolvedValue(undefined);

      await editorController.closeSession(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.json).toHaveBeenCalledWith({
        success: true,
        data: { message: 'Session closed' },
      });
    });

    it('should return 403 when trying to close another user\'s session', async () => {
      mockReq = {
        params: { sessionId: 'session-1' },
        user: { tenantId: 'tenant-1', id: 'user-2' },
      };

      vi.mocked(onlyOfficeService.getSession).mockResolvedValue({
        id: 'session-1',
        userId: 'user-1', // Different user
        documentId: 'doc-1',
      } as any);

      await editorController.closeSession(mockReq as Request, mockRes as Response, mockNext);

      expect(mockRes.status).toHaveBeenCalledWith(403);
      expect(mockRes.json).toHaveBeenCalledWith({
        success: false,
        error: { code: 'FORBIDDEN', message: "Cannot close another user's session" },
      });
    });
  });
});
