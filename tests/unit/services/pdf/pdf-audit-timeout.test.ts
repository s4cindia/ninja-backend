/**
 * PdfAuditService.withAuditTimeout
 *
 * Real incident: a PDF batch item hung inside PdfComprehensiveParser.parse
 * (logged its start, then nothing, ever) and sat there for ~24h -- no
 * timeout existed anywhere in runAuditFromBuffer, so it permanently wedged
 * a worker's concurrency slot (and a tenant's weighted budget unit).
 * withAuditTimeout bounds that call so a hang fails fast instead.
 *
 * Scoped narrowly to the new timeout wrapper rather than the rest of
 * runAuditFromBuffer's huge, pre-existing, untested call chain (parseBuffer/
 * validate/generateReport + their own veraPDF/pdfa11y/validator
 * dependencies) -- this change doesn't alter that chain's behavior at all
 * in the non-timeout case, only wraps it.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../../src/config/pdf.config', () => ({
  pdfConfig: { auditTimeoutMs: 50 },
}));

import { pdfAuditService } from '../../../../src/services/pdf/pdf-audit.service';

type WithAuditTimeout = <T>(fileName: string, work: () => Promise<T>) => Promise<T>;

function withAuditTimeout<T>(work: () => Promise<T>): Promise<T> {
  const instance = pdfAuditService as unknown as { withAuditTimeout: WithAuditTimeout };
  return instance.withAuditTimeout('test.pdf', work);
}

describe('PdfAuditService.withAuditTimeout', () => {
  it('resolves with the work result when it finishes before the timeout', async () => {
    const result = await withAuditTimeout(async () => 'done');
    expect(result).toBe('done');
  });

  it('rejects with a timeout error when work never resolves within auditTimeoutMs', async () => {
    const hungWork = () => new Promise<string>(() => {
      /* never resolves -- simulates the real hang */
    });

    await expect(withAuditTimeout(hungWork)).rejects.toThrow(/timed out after 50ms for test\.pdf/);
  });

  it('propagates a real rejection from work rather than waiting for the timeout', async () => {
    const failingWork = async (): Promise<string> => {
      throw new Error('parse exploded');
    };

    await expect(withAuditTimeout(failingWork)).rejects.toThrow('parse exploded');
  });
});
