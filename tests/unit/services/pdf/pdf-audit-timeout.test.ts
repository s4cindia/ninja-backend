/**
 * PdfAuditService.withAuditTimeout
 *
 * Real incident #1: a PDF batch item hung inside PdfComprehensiveParser.parse
 * (logged its start, then nothing, ever) and sat there for ~24h -- no
 * timeout existed anywhere in runAuditFromBuffer, so it permanently wedged
 * a worker's concurrency slot (and a tenant's weighted budget unit).
 * withAuditTimeout bounds that call so a hang fails fast instead.
 *
 * Real incident #2 (2026-10-19): the original fixed-duration version of this
 * timeout then killed a LEGITIMATELY working audit -- FMHE_PDF.pdf's
 * 5934-image Alt Text pass needs ~53 minutes of real Gemini latency with
 * nothing broken, but the whole audit (parse + all validators) raced
 * against one 15-minute timer that never reset. withAuditTimeout now takes
 * a `resetTimeout` callback the caller invokes from its own progress
 * callbacks (see pdf-audit.service.ts's wrapping of onProgress/
 * onValidatorComplete/onAltTextImageProgress in runAuditFromBuffer) --
 * this is a MAX GAP between progress events now, not a fixed total
 * duration.
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

type WithAuditTimeout = <T>(fileName: string, work: (resetTimeout: () => void) => Promise<T>) => Promise<T>;

function withAuditTimeout<T>(work: (resetTimeout: () => void) => Promise<T>): Promise<T> {
  const instance = pdfAuditService as unknown as { withAuditTimeout: WithAuditTimeout };
  return instance.withAuditTimeout('test.pdf', work);
}

describe('PdfAuditService.withAuditTimeout', () => {
  it('resolves with the work result when it finishes before the timeout', async () => {
    const result = await withAuditTimeout(async () => 'done');
    expect(result).toBe('done');
  });

  it('rejects with a "no progress" error when work never resolves and never calls resetTimeout', async () => {
    const hungWork = () => new Promise<string>(() => {
      /* never resolves, never calls resetTimeout -- simulates a genuine hang */
    });

    await expect(withAuditTimeout(hungWork)).rejects.toThrow(/Audit for test\.pdf had no progress for 50ms/);
  });

  it('propagates a real rejection from work rather than waiting for the timeout', async () => {
    const failingWork = async (): Promise<string> => {
      throw new Error('parse exploded');
    };

    await expect(withAuditTimeout(failingWork)).rejects.toThrow('parse exploded');
  });

  it('survives past the configured gap as long as resetTimeout keeps getting called -- the actual FMHE_PDF.pdf fix', async () => {
    // Simulates a slow-but-working audit: 5 "progress events" spaced 30ms
    // apart (each comfortably under the 50ms gap, but the total -- 150ms --
    // is 3x the old fixed-duration timeout, which would have killed this).
    const slowButWorkingWork = async (resetTimeout: () => void): Promise<string> => {
      for (let i = 0; i < 5; i++) {
        await new Promise((resolve) => setTimeout(resolve, 30));
        resetTimeout();
      }
      return 'done';
    };

    const result = await withAuditTimeout(slowButWorkingWork);
    expect(result).toBe('done');
  });

  it('still times out if progress events stop coming, even after resetTimeout fired earlier', async () => {
    // Resets once (proving the mechanism works at all), then goes silent
    // for longer than the gap -- must still be caught as a real stall, not
    // treated as "it called resetTimeout once, so it's fine forever."
    const stallsAfterOneReset = (resetTimeout: () => void) => {
      resetTimeout();
      return new Promise<string>(() => {
        /* never resolves again after the one reset */
      });
    };

    await expect(withAuditTimeout(stallsAfterOneReset)).rejects.toThrow(/Audit for test\.pdf had no progress for 50ms/);
  });
});
