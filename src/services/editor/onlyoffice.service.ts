/**
 * OnlyOffice Document Server Integration Service
 *
 * Handles integration with OnlyOffice Document Server for Word document editing.
 * OnlyOffice provides:
 * - Full DOCX compatibility with track changes
 * - Real-time collaborative editing
 * - Document conversion
 *
 * Flow:
 * 1. Client requests document edit session
 * 2. We generate a signed JWT config
 * 3. OnlyOffice fetches document via our callback URL
 * 4. User edits in OnlyOffice iframe
 * 5. OnlyOffice calls our callback on save
 * 6. We fetch the updated document and store it
 */

import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import prisma from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { citationStorageService } from '../citation/citation-storage.service';

// Get API URL from environment
const API_URL = process.env.API_URL || 'http://localhost:3001';

// OnlyOffice configuration
const ONLYOFFICE_CONFIG = {
  documentServerUrl: process.env.ONLYOFFICE_URL || 'http://localhost:8080',
  jwtSecret: process.env.ONLYOFFICE_JWT_SECRET || 'your-onlyoffice-jwt-secret',
  callbackUrl: process.env.ONLYOFFICE_CALLBACK_URL || `${API_URL}/api/v1/editor/callback`,
  documentUrl: process.env.ONLYOFFICE_DOCUMENT_URL || `${API_URL}/api/v1/editor/document`,
};

export interface OnlyOfficeConfig {
  document: {
    fileType: string;
    key: string;
    title: string;
    url: string;
    permissions: {
      comment: boolean;
      download: boolean;
      edit: boolean;
      print: boolean;
      review: boolean;
    };
  };
  documentType: string;
  editorConfig: {
    callbackUrl: string;
    lang: string;
    mode: string;
    user: {
      id: string;
      name: string;
    };
    customization?: {
      autosave: boolean;
      chat: boolean;
      comments: boolean;
      compactHeader: boolean;
      compactToolbar: boolean;
      feedback: boolean;
      forcesave: boolean;
      help: boolean;
      hideRightMenu: boolean;
      showReviewChanges: boolean;
      trackChanges: boolean;
    };
  };
  token?: string;
}

export interface EditorSession {
  id: string;
  documentId: string;
  userId: string;
  sessionKey: string;
  status: string;
  expiresAt: Date;
  config: OnlyOfficeConfig;
}

export interface CallbackData {
  key: string;
  status: number;
  url?: string;
  changesurl?: string;
  history?: {
    serverVersion: string;
    changes: Array<{
      created: string;
      user: { id: string; name: string };
    }>;
  };
  users?: string[];
  actions?: Array<{
    type: number;
    userid: string;
  }>;
  lastsave?: string;
  notmodified?: boolean;
}

// OnlyOffice callback status codes
export enum CallbackStatus {
  EDITING = 1, // Document being edited
  SAVE_READY = 2, // Document ready for saving
  SAVE_ERROR = 3, // Saving error occurred
  CLOSE_NO_CHANGES = 4, // Document closed without changes
  SAVE_IN_PROGRESS = 6, // Document saving in progress
  FORCE_SAVE_ERROR = 7, // Force save error
}

class OnlyOfficeService {
  /**
   * Generate a unique document key for OnlyOffice
   * The key must be unique and change when the document is modified
   */
  private generateDocumentKey(documentId: string): string {
    const timestamp = Date.now();
    const random = crypto.randomBytes(8).toString('hex');
    return `${documentId}-${timestamp}-${random}`;
  }

  /**
   * Sign a configuration object with JWT
   */
  private signConfig(config: OnlyOfficeConfig): string {
    return jwt.sign(config, ONLYOFFICE_CONFIG.jwtSecret, {
      expiresIn: '1h',
    });
  }

  /**
   * Verify a JWT token from OnlyOffice callback
   */
  verifyToken(token: string): CallbackData | null {
    try {
      return jwt.verify(token, ONLYOFFICE_CONFIG.jwtSecret) as CallbackData;
    } catch {
      return null;
    }
  }

  /**
   * Create an editor session for a document
   */
  async createSession(
    documentId: string,
    userId: string,
    userName: string,
    mode: 'edit' | 'view' = 'edit'
  ): Promise<EditorSession> {
    logger.info(`[OnlyOffice] Creating session for document ${documentId}`);

    // Get document info
    const document = await prisma.editorialDocument.findUnique({
      where: { id: documentId },
      select: {
        id: true,
        fileName: true,
        originalName: true,
        storagePath: true,
        storageType: true,
      },
    });

    if (!document) {
      throw new Error('Document not found');
    }

    // Generate session key
    const sessionKey = this.generateDocumentKey(documentId);

    // Calculate expiry (1 hour)
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);

    // Create session in database
    const session = await prisma.editorSession.create({
      data: {
        documentId,
        userId,
        sessionKey,
        status: 'active',
        expiresAt,
        metadata: {
          documentName: document.originalName,
          storageType: document.storageType,
        },
      },
    });

    // Build OnlyOffice configuration
    const onlyOfficeConfig: OnlyOfficeConfig = {
      document: {
        fileType: 'docx',
        key: sessionKey,
        title: document.originalName || document.fileName,
        url: `${ONLYOFFICE_CONFIG.documentUrl}/${session.id}`,
        permissions: {
          comment: true,
          download: true,
          edit: mode === 'edit',
          print: true,
          review: true,
        },
      },
      documentType: 'word',
      editorConfig: {
        callbackUrl: `${ONLYOFFICE_CONFIG.callbackUrl}?sessionId=${session.id}`,
        lang: 'en',
        mode: mode,
        user: {
          id: userId,
          name: userName,
        },
        customization: {
          autosave: true,
          chat: false,
          comments: true,
          compactHeader: false,
          compactToolbar: false,
          feedback: false,
          forcesave: true,
          help: true,
          hideRightMenu: false,
          showReviewChanges: false,
          trackChanges: false,
        },
      },
    };

    // Sign the config
    onlyOfficeConfig.token = this.signConfig(onlyOfficeConfig);

    logger.info(`[OnlyOffice] Created session ${session.id} for document ${documentId}`);

    return {
      id: session.id,
      documentId,
      userId,
      sessionKey,
      status: session.status,
      expiresAt,
      config: onlyOfficeConfig,
    };
  }

  /**
   * Get an existing session
   */
  async getSession(sessionId: string): Promise<EditorSession | null> {
    const session = await prisma.editorSession.findUnique({
      where: { id: sessionId },
    });

    if (!session) return null;

    // Check if session is expired
    if (session.expiresAt < new Date()) {
      await this.closeSession(sessionId);
      return null;
    }

    return {
      id: session.id,
      documentId: session.documentId,
      userId: session.userId,
      sessionKey: session.sessionKey,
      status: session.status,
      expiresAt: session.expiresAt,
      config: session.metadata as unknown as OnlyOfficeConfig,
    };
  }

  /**
   * Get document content for OnlyOffice to fetch
   */
  async getDocumentContent(sessionId: string): Promise<Buffer | null> {
    const session = await prisma.editorSession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      logger.warn(`[OnlyOffice] Session not found: ${sessionId}`);
      return null;
    }

    const document = await prisma.editorialDocument.findUnique({
      where: { id: session.documentId },
      select: {
        storagePath: true,
        storageType: true,
      },
    });

    if (!document) {
      logger.warn(`[OnlyOffice] Document not found for session: ${sessionId}`);
      return null;
    }

    try {
      const buffer = await citationStorageService.getFileBuffer(
        document.storagePath,
        document.storageType
      );
      return buffer;
    } catch (error) {
      logger.error(`[OnlyOffice] Error fetching document: ${error}`);
      return null;
    }
  }

  /**
   * Handle callback from OnlyOffice
   */
  async handleCallback(
    sessionId: string,
    data: CallbackData
  ): Promise<{ error: number }> {
    logger.info(
      `[OnlyOffice] Callback received for session ${sessionId}, status: ${data.status}`
    );

    const session = await prisma.editorSession.findUnique({
      where: { id: sessionId },
    });

    if (!session) {
      logger.warn(`[OnlyOffice] Session not found: ${sessionId}`);
      return { error: 0 }; // Return success to avoid OnlyOffice retries
    }

    switch (data.status) {
      case CallbackStatus.EDITING:
        // Document is being edited
        await prisma.editorSession.update({
          where: { id: sessionId },
          data: {
            status: 'editing',
            lastActivity: new Date(),
          },
        });
        break;

      case CallbackStatus.SAVE_READY:
        // Document ready for saving - fetch and store
        if (data.url) {
          try {
            await this.saveDocument(session.documentId, data.url, session.userId);
            await prisma.editorSession.update({
              where: { id: sessionId },
              data: { status: 'saved' },
            });
          } catch (error) {
            logger.error(`[OnlyOffice] Error saving document: ${error}`);
            return { error: 1 };
          }
        }
        break;

      case CallbackStatus.CLOSE_NO_CHANGES:
        // Document closed without changes
        await this.closeSession(sessionId);
        break;

      case CallbackStatus.SAVE_ERROR:
      case CallbackStatus.FORCE_SAVE_ERROR:
        // Save error
        logger.error(`[OnlyOffice] Save error for session ${sessionId}`);
        await prisma.editorSession.update({
          where: { id: sessionId },
          data: { status: 'error' },
        });
        break;
    }

    return { error: 0 };
  }

  /**
   * Save the edited document from OnlyOffice
   */
  private async saveDocument(
    documentId: string,
    documentUrl: string,
    userId: string
  ): Promise<void> {
    logger.info(`[OnlyOffice] Saving document ${documentId} from ${documentUrl}`);

    // Fetch the document from OnlyOffice
    const response = await fetch(documentUrl);
    if (!response.ok) {
      throw new Error(`Failed to fetch document: ${response.statusText}`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    // Get current document info
    const document = await prisma.editorialDocument.findUnique({
      where: { id: documentId },
      select: {
        tenantId: true,
        fileName: true,
        storagePath: true,
        storageType: true,
      },
    });

    if (!document) {
      throw new Error('Document not found');
    }

    // Upload the new version
    const storageResult = await citationStorageService.uploadFile(
      document.tenantId,
      document.fileName,
      buffer,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    // Update document record
    await prisma.editorialDocument.update({
      where: { id: documentId },
      data: {
        storagePath: storageResult.storagePath,
        storageType: storageResult.storageType,
        fileSize: buffer.length,
        updatedAt: new Date(),
      },
    });

    // Create a version snapshot (imports from document versioning)
    const { documentVersioningService } = await import('../document/document-versioning.service');

    const documentContent = await prisma.editorialDocumentContent.findUnique({
      where: { documentId },
    });

    await documentVersioningService.createVersion(
      documentId,
      {
        documentId,
        content: documentContent?.fullText || '',
        metadata: {
          wordCount: documentContent?.wordCount || 0,
        },
      },
      userId,
      'OnlyOffice edit saved'
    );

    logger.info(`[OnlyOffice] Document ${documentId} saved successfully`);
  }

  /**
   * Close an editor session
   */
  async closeSession(sessionId: string): Promise<void> {
    await prisma.editorSession.update({
      where: { id: sessionId },
      data: { status: 'closed' },
    });
    logger.info(`[OnlyOffice] Session ${sessionId} closed`);
  }

  /**
   * Get the OnlyOffice Document Server URL
   */
  getDocumentServerUrl(): string {
    return ONLYOFFICE_CONFIG.documentServerUrl;
  }

  /**
   * Check if OnlyOffice is configured and available
   */
  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(
        `${ONLYOFFICE_CONFIG.documentServerUrl}/healthcheck`,
        { method: 'GET', signal: AbortSignal.timeout(5000) }
      );
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get active sessions for a document
   */
  async getActiveSessionsForDocument(documentId: string): Promise<number> {
    return prisma.editorSession.count({
      where: {
        documentId,
        status: { in: ['active', 'editing'] },
        expiresAt: { gt: new Date() },
      },
    });
  }

  /**
   * Cleanup expired sessions
   */
  async cleanupExpiredSessions(): Promise<number> {
    const result = await prisma.editorSession.updateMany({
      where: {
        expiresAt: { lt: new Date() },
        status: { not: 'closed' },
      },
      data: { status: 'expired' },
    });

    if (result.count > 0) {
      logger.info(`[OnlyOffice] Cleaned up ${result.count} expired sessions`);
    }

    return result.count;
  }
}

export const onlyOfficeService = new OnlyOfficeService();

// Export bound methods
export const createSession = onlyOfficeService.createSession.bind(onlyOfficeService);
export const getSession = onlyOfficeService.getSession.bind(onlyOfficeService);
export const handleCallback = onlyOfficeService.handleCallback.bind(onlyOfficeService);
export const getDocumentContent = onlyOfficeService.getDocumentContent.bind(onlyOfficeService);
export const closeSession = onlyOfficeService.closeSession.bind(onlyOfficeService);
export const isAvailable = onlyOfficeService.isAvailable.bind(onlyOfficeService);
