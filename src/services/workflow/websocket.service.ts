import { Server } from 'socket.io';
import type { Server as HTTPServer } from 'http';
import {
  WorkflowStateChangeEvent,
  HITLRequiredEvent,
  RemediationProgressEvent,
  WorkflowErrorEvent,
  BatchProgressEvent,
} from '../../types/workflow-contracts';
import { logger } from '../../lib/logger';
import { config } from '../../config';

class WebSocketService {
  private io: Server | null = null;
  private subscriptions = new Map<string, Set<string>>(); // socketId → Set<roomId>
  private readonly MAX_SUBSCRIPTIONS = 10;
  private readonly UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  initialize(httpServer: HTTPServer): void {
    this.io = new Server(httpServer, {
      cors: {
        origin: config.corsOrigins,
        credentials: true,
      },
      transports: ['websocket', 'polling'],
    });

    this.io.on('connection', socket => {
      logger.info(`[WebSocket] Client connected: ${socket.id}`);

      socket.on('subscribe:workflow', (workflowId: string) => {
        // Validate UUID format
        if (!this.UUID_REGEX.test(workflowId)) {
          socket.emit('error', { message: 'Invalid workflow ID format' });
          logger.warn(`[WebSocket] Invalid workflow ID format from ${socket.id}: ${workflowId}`);
          return;
        }

        // Rate limiting: check subscription count
        const rooms = this.subscriptions.get(socket.id) || new Set();
        if (rooms.size >= this.MAX_SUBSCRIPTIONS) {
          socket.emit('error', { message: 'Too many subscriptions (max 10)' });
          logger.warn(`[WebSocket] Socket ${socket.id} exceeded subscription limit`);
          return;
        }

        socket.join(`workflow:${workflowId}`);
        rooms.add(`workflow:${workflowId}`);
        this.subscriptions.set(socket.id, rooms);
        logger.debug(`[WebSocket] Socket ${socket.id} subscribed to workflow:${workflowId} (${rooms.size}/${this.MAX_SUBSCRIPTIONS})`);
      });

      socket.on('subscribe:batch', (batchId: string) => {
        // Validate UUID format
        if (!this.UUID_REGEX.test(batchId)) {
          socket.emit('error', { message: 'Invalid batch ID format' });
          logger.warn(`[WebSocket] Invalid batch ID format from ${socket.id}: ${batchId}`);
          return;
        }

        // Rate limiting: check subscription count
        const rooms = this.subscriptions.get(socket.id) || new Set();
        if (rooms.size >= this.MAX_SUBSCRIPTIONS) {
          socket.emit('error', { message: 'Too many subscriptions (max 10)' });
          logger.warn(`[WebSocket] Socket ${socket.id} exceeded subscription limit`);
          return;
        }

        socket.join(`batch:${batchId}`);
        rooms.add(`batch:${batchId}`);
        this.subscriptions.set(socket.id, rooms);
        logger.debug(`[WebSocket] Socket ${socket.id} subscribed to batch:${batchId} (${rooms.size}/${this.MAX_SUBSCRIPTIONS})`);
      });

      socket.on('disconnect', () => {
        logger.info(`[WebSocket] Client disconnected: ${socket.id}`);
        this.subscriptions.delete(socket.id);
      });
    });
  }

  emitStateChange(event: WorkflowStateChangeEvent): void {
    this.io?.to(`workflow:${event.workflowId}`).emit('workflow:state-change', event);
  }

  emitHITLRequired(event: HITLRequiredEvent): void {
    this.io?.to(`workflow:${event.workflowId}`).emit('workflow:hitl-required', event);
  }

  emitRemediationProgress(event: RemediationProgressEvent): void {
    this.io?.to(`workflow:${event.workflowId}`).emit('workflow:remediation-progress', event);
  }

  emitError(event: WorkflowErrorEvent): void {
    this.io?.to(`workflow:${event.workflowId}`).emit('workflow:error', event);
  }

  emitBatchProgress(event: BatchProgressEvent): void {
    this.io?.to(`batch:${event.batchId}`).emit('batch:progress', event);
  }

  /**
   * Get total number of connected sockets.
   * Used for health endpoint metrics.
   */
  getConnectionCount(): number {
    return this.io?.sockets.sockets.size || 0;
  }

  /**
   * Get total number of subscribed rooms.
   * Used for health endpoint metrics.
   */
  getRoomCount(): number {
    return this.io?.sockets.adapter.rooms.size || 0;
  }

  /**
   * Get count of subscribers for a specific workflow or batch room.
   * Useful for debugging and monitoring.
   */
  getSubscriberCount(roomName: string): number {
    return this.io?.sockets.adapter.rooms.get(roomName)?.size || 0;
  }
}

export const websocketService = new WebSocketService();
