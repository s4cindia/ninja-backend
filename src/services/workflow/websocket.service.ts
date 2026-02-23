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
import prisma from '../../lib/prisma';

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

      socket.on('subscribe:workflow', async (workflowId: string) => {
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
        logger.info(`[WebSocket] Socket ${socket.id} subscribed to workflow:${workflowId} (${rooms.size}/${this.MAX_SUBSCRIPTIONS})`);

        // Send current HITL status immediately if workflow is waiting at a gate
        try {
          const workflow = await prisma.workflowInstance.findUnique({
            where: { id: workflowId },
            select: { currentState: true },
          });

          if (workflow) {
            const hitlStates: Record<string, string> = {
              'AWAITING_AI_REVIEW': 'ai-review',
              'AWAITING_REMEDIATION_REVIEW': 'remediation-review',
              'AWAITING_CONFORMANCE_REVIEW': 'conformance-review',
              'AWAITING_ACR_SIGNOFF': 'acr-signoff',
            };

            const gate = hitlStates[workflow.currentState];
            if (gate) {
              logger.info(`[WebSocket] Workflow ${workflowId} is at HITL gate ${gate}, emitting to new subscriber ${socket.id}`);

              // Emit HITL event directly to this socket
              socket.emit('workflow:hitl-required', {
                workflowId,
                gate,
                itemCount: 0,
                deepLink: `/workflow/${workflowId}/hitl/${gate}`,
              } as HITLRequiredEvent);
            }
          }
        } catch (error) {
          logger.error(`[WebSocket] Failed to check workflow HITL status for ${workflowId}:`, error);
          // Don't fail the subscription, just log the error
        }
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
        logger.info(`[WebSocket] Socket ${socket.id} subscribed to batch:${batchId} (${rooms.size}/${this.MAX_SUBSCRIPTIONS})`);
      });

      socket.on('disconnect', () => {
        logger.info(`[WebSocket] Client disconnected: ${socket.id}`);
        this.subscriptions.delete(socket.id);
      });
    });
  }

  emitStateChange(event: WorkflowStateChangeEvent): void {
    const room = `workflow:${event.workflowId}`;
    const subscriberCount = this.getSubscriberCount(room);
    logger.info(`[WebSocket] Emitting state-change: ${event.from} → ${event.to} (${subscriberCount} subscribers)`);
    this.io?.to(room).emit('workflow:state-change', event);
  }

  emitHITLRequired(event: HITLRequiredEvent): void {
    const room = `workflow:${event.workflowId}`;
    const subscriberCount = this.getSubscriberCount(room);
    logger.info(`[WebSocket] Emitting HITL required: ${event.gate} (${subscriberCount} subscribers)`);
    this.io?.to(room).emit('workflow:hitl-required', event);
  }

  emitRemediationProgress(event: RemediationProgressEvent): void {
    const room = `workflow:${event.workflowId}`;
    const subscriberCount = this.getSubscriberCount(room);
    logger.info(`[WebSocket] Emitting remediation progress: ${event.autoFixed}/${event.total} (${subscriberCount} subscribers)`);
    this.io?.to(room).emit('workflow:remediation-progress', event);
  }

  emitError(event: WorkflowErrorEvent): void {
    const room = `workflow:${event.workflowId}`;
    const subscriberCount = this.getSubscriberCount(room);
    logger.info(`[WebSocket] Emitting error: ${event.error} (${subscriberCount} subscribers)`);
    this.io?.to(room).emit('workflow:error', event);
  }

  emitBatchProgress(event: BatchProgressEvent): void {
    const room = `batch:${event.batchId}`;
    const subscriberCount = this.getSubscriberCount(room);
    logger.info(`[WebSocket] Emitting batch progress: ${event.completed}/${event.total} (${subscriberCount} subscribers)`);
    this.io?.to(room).emit('batch:progress', event);
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
