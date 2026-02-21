import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from 'vitest';
import { Server as HTTPServer } from 'http';
import { io as ioClient, Socket as ClientSocket } from 'socket.io-client';
import { AddressInfo } from 'net';
import prisma from '../../src/lib/prisma';

/**
 * Integration tests for WebSocket workflow emissions.
 * Tests the full flow from workflow state changes to WebSocket events.
 */
describe('Workflow WebSocket Integration', () => {
  let httpServer: HTTPServer;
  let port: number;
  let clientSocket: ClientSocket;
  let testWorkflowId: string;
  let testFileId: string;
  let testUserId: string;
  let testBatchId: string;

  beforeAll(async () => {
    // Create test data
    const user = await prisma.user.findFirst();
    if (!user) {
      throw new Error('No test user found');
    }
    testUserId = user.id;

    const file = await prisma.file.create({
      data: {
        filename: 'test-websocket.epub',
        originalFilename: 'test-websocket.epub',
        mimeType: 'application/epub+zip',
        size: 1024,
        path: '/tmp/test-websocket.epub',
        tenantId: user.tenantId,
        uploadedBy: testUserId,
      },
    });
    testFileId = file.id;
  });

  afterAll(async () => {
    // Cleanup test data
    if (testWorkflowId) {
      await prisma.workflowEvent.deleteMany({ where: { workflowId: testWorkflowId } });
      await prisma.workflowInstance.deleteMany({ where: { id: testWorkflowId } });
    }
    if (testFileId) {
      await prisma.file.deleteMany({ where: { id: testFileId } });
    }
  });

  beforeEach((done) => {
    // Create HTTP server for WebSocket
    httpServer = require('http').createServer();
    httpServer.listen(() => {
      port = (httpServer.address() as AddressInfo).port;

      // Initialize WebSocket service
      const { websocketService } = require('../../src/services/workflow/websocket.service');
      websocketService.initialize(httpServer);

      done();
    });
  });

  afterEach(() => {
    if (clientSocket) {
      clientSocket.disconnect();
    }
    if (httpServer) {
      httpServer.close();
    }
  });

  describe('State Transition Emissions', () => {
    it('should emit state change event when workflow transitions', async () => {
      const { workflowService } = await import('../../src/services/workflow/workflow.service');

      // Create workflow
      const workflow = await workflowService.createWorkflow(testFileId, testUserId);
      testWorkflowId = workflow.id;

      return new Promise<void>((resolve, reject) => {
        clientSocket = ioClient(`http://localhost:${port}`);

        clientSocket.on('connect', () => {
          clientSocket.emit('subscribe:workflow', testWorkflowId);

          clientSocket.on('workflow:state-change', (event: any) => {
            try {
              expect(event.workflowId).toBe(testWorkflowId);
              expect(event.from).toBe('UPLOAD_RECEIVED');
              expect(event.to).toBe('PREPROCESSING');
              expect(event.phase).toBeDefined();
              expect(event.timestamp).toBeDefined();
              resolve();
            } catch (error) {
              reject(error);
            }
          });

          // Trigger state transition
          setTimeout(async () => {
            try {
              await workflowService.transition(testWorkflowId, 'PREPROCESS');
            } catch (error) {
              reject(error);
            }
          }, 100);
        });

        setTimeout(() => reject(new Error('Timeout waiting for state change event')), 5000);
      });
    });

    it('should emit multiple state changes in sequence', async () => {
      const { workflowService } = await import('../../src/services/workflow/workflow.service');

      const workflow = await workflowService.createWorkflow(testFileId, testUserId);
      testWorkflowId = workflow.id;

      return new Promise<void>((resolve, reject) => {
        clientSocket = ioClient(`http://localhost:${port}`);
        const events: any[] = [];

        clientSocket.on('connect', () => {
          clientSocket.emit('subscribe:workflow', testWorkflowId);

          clientSocket.on('workflow:state-change', (event: any) => {
            events.push(event);

            if (events.length === 2) {
              try {
                expect(events[0].to).toBe('PREPROCESSING');
                expect(events[1].to).toBe('RUNNING_EPUBCHECK');
                resolve();
              } catch (error) {
                reject(error);
              }
            }
          });

          setTimeout(async () => {
            try {
              await workflowService.transition(testWorkflowId, 'PREPROCESS');
              await workflowService.transition(testWorkflowId, 'START_AUDIT');
            } catch (error) {
              reject(error);
            }
          }, 100);
        });

        setTimeout(() => reject(new Error('Timeout waiting for state changes')), 5000);
      });
    });
  });

  describe('HITL Gate Emissions', () => {
    it('should emit HITL required when workflow reaches gate', async () => {
      // This test would require creating a workflow that reaches a HITL gate
      // For now, we'll test the direct emission
      const workflowId = '12345678-1234-1234-1234-123456789012';

      return new Promise<void>((resolve, reject) => {
        clientSocket = ioClient(`http://localhost:${port}`);

        clientSocket.on('connect', () => {
          clientSocket.emit('subscribe:workflow', workflowId);

          clientSocket.on('workflow:hitl-required', (event: any) => {
            try {
              expect(event.workflowId).toBe(workflowId);
              expect(event.gate).toBe('AI_REVIEW');
              expect(event.itemCount).toBeGreaterThan(0);
              expect(event.deepLink).toContain('/workflow/');
              resolve();
            } catch (error) {
              reject(error);
            }
          });

          setTimeout(() => {
            const { websocketService } = require('../../src/services/workflow/websocket.service');
            websocketService.emitHITLRequired({
              workflowId,
              gate: 'AI_REVIEW' as any,
              itemCount: 5,
              deepLink: `/workflow/${workflowId}/hitl/ai-review`,
            });
          }, 100);
        });

        setTimeout(() => reject(new Error('Timeout waiting for HITL event')), 5000);
      });
    });
  });

  describe('Error Emissions', () => {
    it('should emit error event when workflow fails', async () => {
      const workflowId = '12345678-1234-1234-1234-123456789012';

      return new Promise<void>((resolve, reject) => {
        clientSocket = ioClient(`http://localhost:${port}`);

        clientSocket.on('connect', () => {
          clientSocket.emit('subscribe:workflow', workflowId);

          clientSocket.on('workflow:error', (event: any) => {
            try {
              expect(event.workflowId).toBe(workflowId);
              expect(event.error).toBeDefined();
              expect(event.state).toBe('FAILED');
              expect(typeof event.retryable).toBe('boolean');
              resolve();
            } catch (error) {
              reject(error);
            }
          });

          setTimeout(() => {
            const { websocketService } = require('../../src/services/workflow/websocket.service');
            websocketService.emitError({
              workflowId,
              error: 'Test error',
              state: 'FAILED' as any,
              retryable: true,
              retryCount: 1,
            });
          }, 100);
        });

        setTimeout(() => reject(new Error('Timeout waiting for error event')), 5000);
      });
    });
  });

  describe('Remediation Progress Emissions', () => {
    it('should emit remediation progress updates', async () => {
      const workflowId = '12345678-1234-1234-1234-123456789012';

      return new Promise<void>((resolve, reject) => {
        clientSocket = ioClient(`http://localhost:${port}`);

        clientSocket.on('connect', () => {
          clientSocket.emit('subscribe:workflow', workflowId);

          clientSocket.on('workflow:remediation-progress', (event: any) => {
            try {
              expect(event.workflowId).toBe(workflowId);
              expect(typeof event.autoFixed).toBe('number');
              expect(typeof event.manualPending).toBe('number');
              expect(typeof event.total).toBe('number');
              expect(event.total).toBe(event.autoFixed + event.manualPending);
              resolve();
            } catch (error) {
              reject(error);
            }
          });

          setTimeout(() => {
            const { websocketService } = require('../../src/services/workflow/websocket.service');
            websocketService.emitRemediationProgress({
              workflowId,
              autoFixed: 10,
              manualPending: 5,
              manualComplete: 0,
              total: 15,
            });
          }, 100);
        });

        setTimeout(() => reject(new Error('Timeout waiting for remediation progress')), 5000);
      });
    });
  });

  describe('Batch Progress Emissions', () => {
    it('should emit batch progress when workflows in batch complete', async () => {
      const batchId = '12345678-1234-1234-1234-123456789012';

      return new Promise<void>((resolve, reject) => {
        clientSocket = ioClient(`http://localhost:${port}`);

        clientSocket.on('connect', () => {
          clientSocket.emit('subscribe:batch', batchId);

          clientSocket.on('batch:progress', (event: any) => {
            try {
              expect(event.batchId).toBe(batchId);
              expect(typeof event.completed).toBe('number');
              expect(typeof event.total).toBe('number');
              expect(typeof event.failedCount).toBe('number');
              expect(event.currentStages).toBeDefined();
              resolve();
            } catch (error) {
              reject(error);
            }
          });

          setTimeout(() => {
            const { websocketService } = require('../../src/services/workflow/websocket.service');
            websocketService.emitBatchProgress({
              batchId,
              completed: 5,
              total: 10,
              currentStages: { RUNNING_ACE: 3, AUTO_REMEDIATION: 2 },
              failedCount: 0,
            });
          }, 100);
        });

        setTimeout(() => reject(new Error('Timeout waiting for batch progress')), 5000);
      });
    });
  });

  describe('Multiple Clients', () => {
    it('should send events to all subscribed clients', async () => {
      const workflowId = '12345678-1234-1234-1234-123456789012';

      return new Promise<void>((resolve, reject) => {
        const client1 = ioClient(`http://localhost:${port}`);
        const client2 = ioClient(`http://localhost:${port}`);

        let client1Received = false;
        let client2Received = false;

        const checkBothReceived = () => {
          if (client1Received && client2Received) {
            client1.disconnect();
            client2.disconnect();
            resolve();
          }
        };

        client1.on('connect', () => {
          client1.emit('subscribe:workflow', workflowId);
          client1.on('workflow:state-change', () => {
            client1Received = true;
            checkBothReceived();
          });
        });

        client2.on('connect', () => {
          client2.emit('subscribe:workflow', workflowId);
          client2.on('workflow:state-change', () => {
            client2Received = true;
            checkBothReceived();
          });
        });

        setTimeout(() => {
          const { websocketService } = require('../../src/services/workflow/websocket.service');
          websocketService.emitStateChange({
            workflowId,
            from: 'PREPROCESSING' as any,
            to: 'RUNNING_EPUBCHECK' as any,
            timestamp: new Date().toISOString(),
            phase: 'audit',
          });
        }, 200);

        setTimeout(() => {
          client1.disconnect();
          client2.disconnect();
          reject(new Error('Timeout waiting for clients to receive events'));
        }, 5000);
      });
    });
  });
});
