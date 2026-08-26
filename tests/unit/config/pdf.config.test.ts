/**
 * pdfConfig.maxAuditPages
 *
 * Used to default to 50 pages with no env var set, silently truncating
 * every audit of a longer document to its first 50 pages — found live via
 * a Comparison Study trial where a 414-page book was audited (and its
 * pageCount reported) as if it were 50 pages. Now defaults to 0
 * (uncapped); MAX_AUDIT_PAGES must be explicitly set to opt into a cap.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const ORIGINAL_ENV = process.env.MAX_AUDIT_PAGES;

async function loadConfig(): Promise<typeof import('../../../src/config/pdf.config').pdfConfig> {
  vi.resetModules();
  const mod = await import('../../../src/config/pdf.config');
  return mod.pdfConfig;
}

describe('pdfConfig.maxAuditPages', () => {
  beforeEach(() => {
    delete process.env.MAX_AUDIT_PAGES;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.MAX_AUDIT_PAGES;
    else process.env.MAX_AUDIT_PAGES = ORIGINAL_ENV;
  });

  it('defaults to 0 (uncapped) when MAX_AUDIT_PAGES is not set', async () => {
    const pdfConfig = await loadConfig();
    expect(pdfConfig.maxAuditPages).toBe(0);
  });

  it('respects an explicit MAX_AUDIT_PAGES override', async () => {
    process.env.MAX_AUDIT_PAGES = '75';
    const pdfConfig = await loadConfig();
    expect(pdfConfig.maxAuditPages).toBe(75);
  });

  it('an explicit 0 also means uncapped (not "0 pages")', async () => {
    process.env.MAX_AUDIT_PAGES = '0';
    const pdfConfig = await loadConfig();
    expect(pdfConfig.maxAuditPages).toBe(0);
  });
});
