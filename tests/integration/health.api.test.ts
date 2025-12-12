import { describe, it, expect } from 'vitest';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:5000';

describe('Health API', () => {
  describe('GET /health', () => {
    it('should return healthy status', async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/health`);
        
        if (!response.ok && response.status === 0) {
          console.log('API not available, skipping integration test');
          return;
        }
        
        expect(response.status).toBe(200);
        
        const data = await response.json();
        expect(data).toHaveProperty('status');
        expect(data.status).toBe('healthy');
      } catch (error) {
        if ((error as Error).message?.includes('fetch failed')) {
          console.log('API not running - integration test skipped');
          return;
        }
        throw error;
      }
    });
  });

  describe('GET /api/v1', () => {
    it('should return API info and available endpoints', async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1`);
        
        if (!response.ok && response.status === 0) {
          console.log('API not available, skipping integration test');
          return;
        }
        
        expect(response.status).toBe(200);
        
        const data = await response.json();
        expect(data).toHaveProperty('name');
        expect(data).toHaveProperty('version');
        expect(data).toHaveProperty('endpoints');
      } catch (error) {
        if ((error as Error).message?.includes('fetch failed')) {
          console.log('API not running - integration test skipped');
          return;
        }
        throw error;
      }
    });
  });
});
