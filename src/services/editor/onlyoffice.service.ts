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
import { documentVersioningService } from '../document/document-versioning.service';
import { EditorSessionStatus } from '@prisma/client';

// Get API URL from environment
const API_URL = process.env.API_URL || 'http://localhost:3001';
const NODE_ENV = process.env.NODE_ENV || 'development';

// Insecure default secrets that must not be used in production
const INSECURE_SECRETS = ['your-onlyoffice-jwt-secret', 'dev-only-secret-not-for-production', ''];

// Validate required secrets in production
if (NODE_ENV === 'production') {
  const jwtSecret = process.env.ONLYOFFICE_JWT_SECRET;
  if (!jwtSecret || INSECURE_SECRETS.includes(jwtSecret)) {
    throw new Error(
      'ONLYOFFICE_JWT_SECRET environment variable must be set to a secure value in production. ' +
      'Set ONLYOFFICE_JWT_SECRET to a strong random string (32+ characters).'
    );
  }
}

// Fetch timeout for OnlyOffice document downloads (in milliseconds)
const FETCH_TIMEOUT_MS = 15000; // 15 seconds

// OnlyOffice configuration
const ONLYOFFICE_CONFIG = {
  documentServerUrl: process.env.ONLYOFFICE_URL || 'http://localhost:8080',
  jwtSecret: process.env.ONLYOFFICE_JWT_SECRET || (NODE_ENV === 'development' ? 'dev-only-secret-not-for-production' : ''),
  callbackUrl: process.env.ONLYOFFICE_CALLBACK_URL || `${API_URL}/api/v1/editor/callback`,
  documentUrl: process.env.ONLYOFFICE_DOCUMENT_URL || `${API_URL}/api/v1/editor/document`,
  // Skip JWT verification only in development with explicit flag
  skipJwtVerification: NODE_ENV === 'development' && process.env.ONLYOFFICE_SKIP_JWT === 'true',
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
  type?: string; // "desktop" | "mobile" | "embedded"
  width?: string;
  height?: string;
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
   * Check if JWT verification should be required
   * Only skip in development with explicit flag
   */
  isJwtVerificationRequired(): boolean {
    return !ONLYOFFICE_CONFIG.skipJwtVerification;
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
        status: EditorSessionStatus.ACTIVE,
        expiresAt,
        metadata: {
          documentName: document.originalName,
          storageType: document.storageType,
          userName,
          mode,
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
      type: 'desktop',
      width: '100%',
      height: '100%',
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

    // Rebuild the OnlyOffice config from stored metadata
    const metadata = session.metadata as { documentName?: string; storageType?: string; userName?: string; mode?: string } | null;

    const config: OnlyOfficeConfig = {
      document: {
        fileType: 'docx',
        key: session.sessionKey,
        title: metadata?.documentName || 'Document',
        url: `${ONLYOFFICE_CONFIG.documentUrl}/${session.id}`,
        permissions: {
          comment: true,
          download: true,
          edit: metadata?.mode !== 'view',
          print: true,
          review: true,
        },
      },
      documentType: 'word',
      type: 'desktop',
      width: '100%',
      height: '100%',
      editorConfig: {
        callbackUrl: `${ONLYOFFICE_CONFIG.callbackUrl}?sessionId=${session.id}`,
        lang: 'en',
        mode: metadata?.mode || 'edit',
        user: {
          id: session.userId,
          name: metadata?.userName || 'User',
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
    config.token = this.signConfig(config);

    return {
      id: session.id,
      documentId: session.documentId,
      userId: session.userId,
      sessionKey: session.sessionKey,
      status: session.status,
      expiresAt: session.expiresAt,
      config,
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
            status: EditorSessionStatus.EDITING,
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
              data: { status: EditorSessionStatus.SAVED },
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
          data: { status: EditorSessionStatus.ERROR },
        });
        break;
    }

    return { error: 0 };
  }

  /**
   * Validate that a URL is from the OnlyOffice document server
   * Prevents SSRF attacks by ensuring we only fetch from trusted sources
   */
  private isValidOnlyOfficeUrl(url: string): boolean {
    try {
      const parsedUrl = new URL(url);
      const serverUrl = new URL(ONLYOFFICE_CONFIG.documentServerUrl);

      // Only allow http and https schemes
      if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
        return false;
      }

      // In production, only allow OnlyOffice server and Docker network names
      // In development, also allow localhost for local testing
      const allowedHosts = NODE_ENV === 'production'
        ? [serverUrl.hostname, 'onlyoffice-documentserver', 'ninja-onlyoffice']
        : [serverUrl.hostname, 'localhost', '127.0.0.1', 'onlyoffice-documentserver', 'ninja-onlyoffice'];

      if (!allowedHosts.includes(parsedUrl.hostname)) {
        return false;
      }

      // Normalize ports for comparison (use default port when not specified)
      const getEffectivePort = (urlObj: URL): string => {
        if (urlObj.port) return urlObj.port;
        return urlObj.protocol === 'https:' ? '443' : '80';
      };

      const expectedPort = getEffectivePort(serverUrl);
      const actualPort = getEffectivePort(parsedUrl);

      if (actualPort !== expectedPort) {
        return false;
      }

      return true;
    } catch {
      return false;
    }
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

    // SSRF Protection: Validate the document URL is from OnlyOffice
    if (!this.isValidOnlyOfficeUrl(documentUrl)) {
      logger.error(`[OnlyOffice] SSRF attempt blocked - invalid documentUrl: ${documentUrl}`);
      throw new Error('Invalid document URL - must be from OnlyOffice server');
    }

    // Fetch the document from OnlyOffice with timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(documentUrl, { signal: controller.signal });
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Fetch timeout: OnlyOffice document download exceeded ${FETCH_TIMEOUT_MS}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }

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

    // KNOWN ISSUE: S3 Storage Leak (tracked for post-MVP cleanup)
    // ============================================================
    // The old S3 object at document.storagePath is NOT deleted when uploading
    // a new version. Each edit-save cycle creates a new S3 object, causing
    // unbounded storage growth for actively-edited documents.
    //
    // Production impact: Storage costs grow linearly with edit frequency.
    // Mitigation: Implement S3 lifecycle rules to expire old objects, or
    // add cleanup logic to delete previousStoragePath after successful upload.
    //
    // Fix approach: After successful upload (storageResult), call:
    //   await citationStorageService.deleteFile(previousStoragePath);
    // Handle errors gracefully - don't fail the save if cleanup fails.
    const previousStoragePath = document.storagePath;
    void previousStoragePath; // Retained for future cleanup implementation

    // Upload the new version
    const storageResult = await citationStorageService.uploadFile(
      document.tenantId,
      document.fileName,
      buffer,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );

    // Update document record and mark content as stale (needs re-extraction)
    // Set status to UPLOADED to indicate the document file has changed and
    // content extraction is needed for accurate text search/analysis
    await prisma.editorialDocument.update({
      where: { id: documentId },
      data: {
        storagePath: storageResult.storagePath,
        storageType: storageResult.storageType,
        fileSize: buffer.length,
        status: 'UPLOADED', // Mark for re-parsing
        updatedAt: new Date(),
      },
    });

    // Create a version snapshot
    // KNOWN LIMITATION: The content snapshot captures PRE-EDIT text content because:
    // 1. OnlyOffice saves the binary DOCX file directly to storage
    // 2. Text extraction from DOCX is a separate async process (not triggered here)
    // 3. EditorialDocumentContent still contains the OLD extracted text
    //
    // Impact: Version comparison will show pre-edit content until document is re-parsed.
    // The binary DOCX in S3 is correct; only the text snapshot is stale.
    //
    // Future improvement: Trigger content extraction here and wait for completion,
    // or create a background job to update the version snapshot after extraction.
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
      'OnlyOffice edit saved (text snapshot is pre-edit; binary is current)'
    );

    logger.info(`[OnlyOffice] Document ${documentId} saved successfully (content marked for re-extraction)`);
  }

  /**
   * Close an editor session
   */
  async closeSession(sessionId: string): Promise<void> {
    await prisma.editorSession.update({
      where: { id: sessionId },
      data: { status: EditorSessionStatus.CLOSED },
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
        status: { in: [EditorSessionStatus.ACTIVE, EditorSessionStatus.EDITING] },
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
        status: { not: EditorSessionStatus.CLOSED },
      },
      data: { status: EditorSessionStatus.EXPIRED },
    });

    if (result.count > 0) {
      logger.info(`[OnlyOffice] Cleaned up ${result.count} expired sessions`);
    }

    return result.count;
  }

  // Timer management for cleanup
  private cleanupIntervalId: ReturnType<typeof setInterval> | null = null;
  private cleanupTimeoutId: ReturnType<typeof setTimeout> | null = null;

  /**
   * Start the cleanup scheduler
   * Should be called during app bootstrap, not at module load
   */
  startCleanupScheduler(): void {
    if (this.cleanupIntervalId) {
      return; // Already running
    }

    const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

    // Schedule periodic cleanup
    this.cleanupIntervalId = setInterval(() => {
      this.cleanupExpiredSessions().catch((err) => {
        logger.error('[OnlyOffice] Failed to cleanup expired sessions:', err);
      });
    }, CLEANUP_INTERVAL_MS);

    // Run initial cleanup with a small delay
    this.cleanupTimeoutId = setTimeout(() => {
      this.cleanupExpiredSessions().catch((err) => {
        logger.error('[OnlyOffice] Failed initial session cleanup:', err);
      });
    }, 5000);

    logger.info('[OnlyOffice] Cleanup scheduler started');
  }

  /**
   * Stop the cleanup scheduler
   * Should be called during graceful shutdown or in tests
   */
  stopCleanupScheduler(): void {
    if (this.cleanupIntervalId) {
      clearInterval(this.cleanupIntervalId);
      this.cleanupIntervalId = null;
    }
    if (this.cleanupTimeoutId) {
      clearTimeout(this.cleanupTimeoutId);
      this.cleanupTimeoutId = null;
    }
    logger.info('[OnlyOffice] Cleanup scheduler stopped');
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
export const startCleanupScheduler = onlyOfficeService.startCleanupScheduler.bind(onlyOfficeService);
export const stopCleanupScheduler = onlyOfficeService.stopCleanupScheduler.bind(onlyOfficeService);

// Auto-start cleanup scheduler only in non-test environment
// In tests, use startCleanupScheduler/stopCleanupScheduler explicitly
if (process.env.NODE_ENV !== 'test') {
  onlyOfficeService.startCleanupScheduler();
}
