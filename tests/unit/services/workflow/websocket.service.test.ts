import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServer, Server as HTTPServer } from 'http';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { AddressInfo } from 'net';
import type { WorkflowState, HITLGate } from '@/types/workflow-contracts';

// Mock prisma before service import — vi.mock calls are hoisted by Vitest
vi.mock('@/lib/prisma', () => ({
  default: {
    workflowInstance: {
      findUnique: vi.fn().mockResolvedValue(null),
    },
  },
}));

import { websocketService } from '@/services/workflow/websocket.service';

describe('WebSocketService', () => {
  let httpServer: HTTPServer;
  let port: number;
  let clientSocket: ClientSocket;

  beforeEach(() => new Promise<void>((resolve) => {
    httpServer = createServer();
    httpServer.listen(() => {
      port = (httpServer.address() as AddressInfo).port;
      websocketService.initialize(httpServer);
      resolve();
    });
  }));

  afterEach(() => new Promise<void>((resolve) => {
    if (clientSocket?.connected) {
      clientSocket.disconnect();
    }
    // Close the socket.io server before the http server
    (websocketService as unknown as { io: { close: (cb: () => void) => void } | null }).io?.close(() => {
      httpServer.close(() => resolve());
    });
    // If io is null, just close the http server
    if (!(websocketService as unknown as { io: unknown }).io) {
      httpServer.close(() => resolve());
    }
  }));

  describe('initialization', () => {
    it('should initialize with HTTP server', () => new Promise<void>((resolve) => {
      clientSocket = ioClient(`http://localhost:${port}`);

      clientSocket.on('connect', () => {
        expect(clientSocket.connected).toBe(true);
        resolve();
      });
    }));

    it('should accept WebSocket and polling transports', () => new Promise<void>((resolve) => {
      clientSocket = ioClient(`http://localhost:${port}`, {
        transports: ['websocket', 'polling'],
      });

      clientSocket.on('connect', () => {
        expect(clientSocket.connected).toBe(true);
        resolve();
      });
    }));
  });

  describe('subscription handling', () => {
    it('should allow subscription to workflow room with valid UUID', () => new Promise<void>((resolve) => {
      clientSocket = ioClient(`http://localhost:${port}`);

      const workflowId = '12345678-1234-1234-1234-123456789012';

      clientSocket.on('connect', () => {
        clientSocket.emit('subscribe:workflow', workflowId);

        // Wait a bit for subscription to process
        setTimeout(() => {
          // If no error emitted, subscription succeeded
          resolve();
        }, 100);
      });
    }));

    it('should allow subscription to batch room with valid UUID', () => new Promise<void>((resolve) => {
      clientSocket = ioClient(`http://localhost:${port}`);

      const batchId = '87654321-4321-4321-4321-210987654321';

      clientSocket.on('connect', () => {
        clientSocket.emit('subscribe:batch', batchId);

        setTimeout(() => {
          resolve();
        }, 100);
      });
    }));

    it('should reject subscription with invalid workflow UUID', () => new Promise<void>((resolve) => {
      clientSocket = ioClient(`http://localhost:${port}`);

      clientSocket.on('connect', () => {
        clientSocket.on('error', (error: Record<string, unknown>) => {
          expect((error as { message: string }).message).toBe('Invalid workflow ID format');
          resolve();
        });

        clientSocket.emit('subscribe:workflow', 'invalid-uuid');
      });
    }));

    it('should reject subscription with invalid batch UUID', () => new Promise<void>((resolve) => {
      clientSocket = ioClient(`http://localhost:${port}`);

      clientSocket.on('connect', () => {
        clientSocket.on('error', (error: Record<string, unknown>) => {
          expect((error as { message: string }).message).toBe('Invalid batch ID format');
          resolve();
        });

        clientSocket.emit('subscribe:batch', 'not-a-uuid');
      });
    }));

    it('should enforce max 10 subscriptions per socket', () => new Promise<void>((resolve) => {
      clientSocket = ioClient(`http://localhost:${port}`);

      clientSocket.on('connect', () => {
        // Subscribe to 10 workflows (should succeed)
        for (let i = 0; i < 10; i++) {
          const uuid = `12345678-1234-1234-1234-12345678901${i}`;
          clientSocket.emit('subscribe:workflow', uuid);
        }

        // 11th subscription should fail
        clientSocket.on('error', (error: Record<string, unknown>) => {
          expect((error as { message: string }).message).toContain('Too many subscriptions');
          resolve();
        });

        setTimeout(() => {
          const uuid = '12345678-1234-1234-1234-123456789999';
          clientSocket.emit('subscribe:workflow', uuid);
        }, 200);
      });
    }));
  });

  describe('event emission', () => {
    it('should emit state change event to subscribed workflow room', () => new Promise<void>((resolve) => {
      clientSocket = ioClient(`http://localhost:${port}`);
      const workflowId = '12345678-1234-1234-1234-123456789012';

      clientSocket.on('connect', () => {
        clientSocket.emit('subscribe:workflow', workflowId);

        clientSocket.on('workflow:state-change', (event: Record<string, unknown>) => {
          expect(event.workflowId).toBe(workflowId);
          expect(event.from).toBe('PREPROCESSING');
          expect(event.to).toBe('RUNNING_EPUBCHECK');
          expect(event.phase).toBe('audit');
          resolve();
        });

        // Emit event after subscription
        setTimeout(() => {
          websocketService.emitStateChange({
            workflowId,
            from: 'PREPROCESSING' as WorkflowState,
            to: 'RUNNING_EPUBCHECK' as WorkflowState,
            timestamp: new Date().toISOString(),
            phase: 'audit',
          });
        }, 100);
      });
    }));

    it('should emit HITL required event to subscribed workflow room', () => new Promise<void>((resolve) => {
      clientSocket = ioClient(`http://localhost:${port}`);
      const workflowId = '12345678-1234-1234-1234-123456789012';

      clientSocket.on('connect', () => {
        clientSocket.emit('subscribe:workflow', workflowId);

        clientSocket.on('workflow:hitl-required', (event: Record<string, unknown>) => {
          expect(event.workflowId).toBe(workflowId);
          expect(event.gate).toBe('AI_REVIEW');
          expect(event.itemCount).toBe(5);
          resolve();
        });

        setTimeout(() => {
          websocketService.emitHITLRequired({
            workflowId,
            gate: 'AI_REVIEW' as HITLGate,
            itemCount: 5,
            deepLink: '/workflow/123/hitl/ai-review',
          });
        }, 100);
      });
    }));

    it('should emit remediation progress event', () => new Promise<void>((resolve) => {
      clientSocket = ioClient(`http://localhost:${port}`);
      const workflowId = '12345678-1234-1234-1234-123456789012';

      clientSocket.on('connect', () => {
        clientSocket.emit('subscribe:workflow', workflowId);

        clientSocket.on('workflow:remediation-progress', (event: Record<string, unknown>) => {
          expect(event.workflowId).toBe(workflowId);
          expect(event.autoFixed).toBe(10);
          expect(event.manualPending).toBe(3);
          expect(event.total).toBe(13);
          resolve();
        });

        setTimeout(() => {
          websocketService.emitRemediationProgress({
            workflowId,
            autoFixed: 10,
            manualPending: 3,
            manualComplete: 0,
            total: 13,
          });
        }, 100);
      });
    }));

    it('should emit error event', () => new Promise<void>((resolve) => {
      clientSocket = ioClient(`http://localhost:${port}`);
      const workflowId = '12345678-1234-1234-1234-123456789012';

      clientSocket.on('connect', () => {
        clientSocket.emit('subscribe:workflow', workflowId);

        clientSocket.on('workflow:error', (event: Record<string, unknown>) => {
          expect(event.workflowId).toBe(workflowId);
          expect(event.error).toBe('EPUBCheck validation failed');
          expect(event.state).toBe('FAILED');
          expect(event.retryable).toBe(true);
          resolve();
        });

        setTimeout(() => {
          websocketService.emitError({
            workflowId,
            error: 'EPUBCheck validation failed',
            state: 'FAILED' as WorkflowState,
            retryable: true,
            retryCount: 1,
          });
        }, 100);
      });
    }));

    it('should emit batch progress event', () => new Promise<void>((resolve) => {
      clientSocket = ioClient(`http://localhost:${port}`);
      const batchId = '12345678-1234-1234-1234-123456789012';

      clientSocket.on('connect', () => {
        clientSocket.emit('subscribe:batch', batchId);

        clientSocket.on('batch:progress', (event: Record<string, unknown>) => {
          expect(event.batchId).toBe(batchId);
          expect(event.completed).toBe(5);
          expect(event.total).toBe(10);
          expect(event.failedCount).toBe(1);
          resolve();
        });

        setTimeout(() => {
          websocketService.emitBatchProgress({
            batchId,
            completed: 5,
            total: 10,
            currentStages: { RUNNING_ACE: 3, AUTO_REMEDIATION: 1 },
            failedCount: 1,
          });
        }, 100);
      });
    }));

    it('should NOT emit to unsubscribed clients', () => new Promise<void>((resolve) => {
      const client1 = ioClient(`http://localhost:${port}`);
      const client2 = ioClient(`http://localhost:${port}`);

      const workflowId1 = '12345678-1234-1234-1234-123456789001';
      const workflowId2 = '12345678-1234-1234-1234-123456789002';

      let client1Received = false;
      let client2Received = false;

      client1.on('connect', () => {
        client1.emit('subscribe:workflow', workflowId1);

        client1.on('workflow:state-change', () => {
          client1Received = true;
        });
      });

      client2.on('connect', () => {
        client2.emit('subscribe:workflow', workflowId2);

        client2.on('workflow:state-change', () => {
          client2Received = true;
        });
      });

      setTimeout(() => {
        websocketService.emitStateChange({
          workflowId: workflowId1,
          from: 'PREPROCESSING' as WorkflowState,
          to: 'RUNNING_EPUBCHECK' as WorkflowState,
          timestamp: new Date().toISOString(),
          phase: 'audit',
        });

        setTimeout(() => {
          expect(client1Received).toBe(true);
          expect(client2Received).toBe(false);
          client1.disconnect();
          client2.disconnect();
          resolve();
        }, 100);
      }, 200);
    }));
  });

  describe('metrics', () => {
    it('should return connection count', () => {
      const count = websocketService.getConnectionCount();
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('should return room count', () => {
      const count = websocketService.getRoomCount();
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });

    it('should return subscriber count for room', () => {
      const count = websocketService.getSubscriberCount('workflow:123');
      expect(typeof count).toBe('number');
      expect(count).toBeGreaterThanOrEqual(0);
    });
  });
});
