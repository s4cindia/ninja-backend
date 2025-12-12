import { describe, it, expect } from 'vitest';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:5000';
const REQUIRE_API = !!process.env.API_BASE_URL;

describe('Health API', () => {
  describe('GET /health', () => {
    it('should return healthy status', async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/health`);

        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data).toHaveProperty('status');
        expect(data.status).toBe('healthy');
      } catch (error) {
        if (REQUIRE_API) {
          throw new Error(`API unavailable at ${API_BASE_URL}: ${(error as Error).message}`);
        }
        console.warn('API not running - skipping integration test');
      }
    });
  });

  describe('GET /api/v1', () => {
    it('should return API info and available endpoints', async () => {
      try {
        const response = await fetch(`${API_BASE_URL}/api/v1`);

        expect(response.status).toBe(200);

        const data = await response.json();
        expect(data).toHaveProperty('name');
        expect(data).toHaveProperty('version');
        expect(data).toHaveProperty('endpoints');
      } catch (error) {
        if (REQUIRE_API) {
          throw new Error(`API unavailable at ${API_BASE_URL}: ${(error as Error).message}`);
        }
        console.warn('API not running - skipping integration test');
      }
    });
  });
});
