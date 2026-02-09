import { Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import Redis from 'ioredis';
import { getRedisClient, isRedisConfigured } from '../lib/redis';
import { logger } from '../lib/logger';

interface SSEClient {
  id: string;
  response: Response;
  tenantId: string;
  channels: Set<string>;
}

class SSEService {
  private clients: Map<string, SSEClient> = new Map();
  private redisSubscriber: Redis | null = null;
  private initialized = false;

  async initialize(): Promise<void> {
    if (this.initialized) return;

    if (isRedisConfigured()) {
      try {
        const redis = getRedisClient();
        this.redisSubscriber = redis.duplicate();

        this.redisSubscriber.on('message', (channel: string, message: string) => {
          this.handleRedisMessage(channel, message);
        });

        await this.redisSubscriber.subscribe('batch-progress');
        logger.info('SSE Service: Redis Pub/Sub initialized');
      } catch (err) {
        logger.error(`SSE Service: Failed to initialize Redis Pub/Sub: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    this.initialized = true;
  }

  addClient(response: Response, tenantId: string): string {
    const clientId = uuidv4();

    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const client: SSEClient = {
      id: clientId,
      response,
      tenantId,
      channels: new Set(),
    };

    this.clients.set(clientId, client);
    this.sendToClient(clientId, { type: 'connected', clientId });

    response.on('close', () => {
      this.removeClient(clientId);
    });

    return clientId;
  }

  subscribeToChannel(clientId: string, channel: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      client.channels.add(channel);
    }
  }

  sendToClient(clientId: string, data: unknown): void {
    const client = this.clients.get(clientId);
    if (client && !client.response.writableEnded) {
      const message = `data: ${JSON.stringify(data)}\n\n`;
      client.response.write(message);
      if (typeof (client.response as unknown as { flush?: () => void }).flush === 'function') {
        (client.response as unknown as { flush: () => void }).flush();
      }
    }
  }

  broadcastToChannel(channel: string, data: unknown, tenantId?: string): void {
    if (isRedisConfigured() && this.redisSubscriber) {
      getRedisClient().publish('batch-progress', JSON.stringify({
        channel,
        data,
        tenantId,
      }));
    } else {
      this.localBroadcast(channel, data, tenantId);
    }
  }

  private localBroadcast(channel: string, data: unknown, tenantId?: string): void {
    this.clients.forEach((client) => {
      if (client.channels.has(channel)) {
        if (!tenantId || client.tenantId === tenantId) {
          this.sendToClient(client.id, data);
        }
      }
    });
  }

  private handleRedisMessage(channel: string, message: string): void {
    try {
      const { channel: eventChannel, data, tenantId } = JSON.parse(message);
      this.localBroadcast(eventChannel, data, tenantId);
    } catch (err) {
      logger.error(`SSE: Failed to parse Redis message: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  removeClient(clientId: string): void {
    const client = this.clients.get(clientId);
    if (client) {
      if (!client.response.writableEnded) {
        client.response.end();
      }
      this.clients.delete(clientId);
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }
}

export const sseService = new SSEService();
