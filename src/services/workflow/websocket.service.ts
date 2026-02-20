import { Server } from 'socket.io';
import {
  WorkflowStateChangeEvent,
  HITLRequiredEvent,
  RemediationProgressEvent,
  WorkflowErrorEvent,
  BatchProgressEvent,
} from '../../types/workflow-contracts';
import { logger } from '../../lib/logger';

class WebSocketService {
  private io: Server | null = null;

  initialize(httpServer: any): void {
    this.io = new Server(httpServer, { cors: { origin: '*' } });

    this.io.on('connection', socket => {
      logger.info(`[WebSocket] Client connected: ${socket.id}`);

      socket.on('subscribe:workflow', (workflowId: string) => {
        socket.join(`workflow:${workflowId}`);
      });

      socket.on('subscribe:batch', (batchId: string) => {
        socket.join(`batch:${batchId}`);
      });

      socket.on('disconnect', () => {
        logger.info(`[WebSocket] Client disconnected: ${socket.id}`);
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
}

export const websocketService = new WebSocketService();
