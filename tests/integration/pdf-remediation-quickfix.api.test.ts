import { describe, it, expect } from 'vitest';

const API_BASE_URL = process.env.API_BASE_URL || 'http://localhost:5000';
const REQUIRE_API = !!process.env.API_BASE_URL;

// Use conditional test runner: skip tests when API is not required
const testRunner = REQUIRE_API ? describe : describe.skip;

/**
 * PDF Remediation Quick-Fix API Integration Tests
 *
 * These tests verify the quick-fix endpoints for PDF remediation.
 * Tests are skipped unless API_BASE_URL environment variable is set.
 *
 * Note: These tests assume:
 * - A valid authentication token is available
 * - A test job with PDF audit results exists
 * - The API server is running at API_BASE_URL
 */
testRunner('PDF Remediation Quick-Fix API', () => {
  // TODO: Replace with actual test job ID and auth token when running integration tests
  const testJobId = 'test-job-id';
  const authToken = process.env.TEST_AUTH_TOKEN || '';

  describe('GET /api/v1/pdf/:jobId/remediation/preview/:issueId', () => {
    it('should preview language fix', async () => {
      const url = new URL(`/api/v1/pdf/${testJobId}/remediation/preview/issue-1`, API_BASE_URL);
      url.searchParams.set('field', 'language');
      url.searchParams.set('value', 'en-US');

      const response = await fetch(url.toString(), {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('currentValue');
      expect(data.data).toHaveProperty('proposedValue');
    });
  });

  describe('POST /api/v1/pdf/:jobId/remediation/quick-fix/:issueId', () => {
    it('should apply title fix', async () => {
      const response = await fetch(
        `${API_BASE_URL}/api/v1/pdf/${testJobId}/remediation/quick-fix/issue-2`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${authToken}`,
          },
          body: JSON.stringify({
            field: 'title',
            value: 'Accessible Document',
          }),
        }
      );

      expect(response.status).toBe(200);
      const data = await response.json();
      expect(data.success).toBe(true);
      expect(data.data).toHaveProperty('remediatedFileUrl');
      expect(data.data.modification.success).toBe(true);
    });

    it('should require authentication', async () => {
      const response = await fetch(
        `${API_BASE_URL}/api/v1/pdf/${testJobId}/remediation/quick-fix/issue-1`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            field: 'language',
            value: 'en-US',
          }),
        }
      );

      expect(response.status).toBe(401);
    });
  });
});
