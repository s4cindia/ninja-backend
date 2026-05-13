import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  photoAltGenerator,
  buildPrhCoverAlt,
} from '../../../../src/services/alt-text/photo-alt-generator.service';

describe('buildPrhCoverAlt', () => {
  it('returns "Cover for [Title]." when title is present', () => {
    expect(buildPrhCoverAlt('The Book')).toBe('Cover for The Book.');
  });

  it('trims whitespace from the title before formatting', () => {
    expect(buildPrhCoverAlt('   The Book   ')).toBe('Cover for The Book.');
  });

  it('falls back to "Cover image." when title is null', () => {
    expect(buildPrhCoverAlt(null)).toBe('Cover image.');
  });

  it('falls back to "Cover image." when title is undefined', () => {
    expect(buildPrhCoverAlt(undefined)).toBe('Cover image.');
  });

  it('falls back to "Cover image." when title is empty string', () => {
    expect(buildPrhCoverAlt('')).toBe('Cover image.');
  });

  it('falls back to "Cover image." when title is whitespace-only', () => {
    expect(buildPrhCoverAlt('   ')).toBe('Cover image.');
  });

  it('always ends with a full stop (PRH Style Guide Appendix 7)', () => {
    // Whatever the input, the output must end in `.` — PRH requires
    // every description to end with a full stop.
    expect(buildPrhCoverAlt('Book')).toMatch(/\.$/);
    expect(buildPrhCoverAlt(null)).toMatch(/\.$/);
  });
});

describe('generateAltText — PRH cover short-circuit', () => {
  // These tests exercise the path that bypasses Gemini entirely. The
  // generator returns the documented template without an API call, so
  // we don't need to mock GEMINI_API_KEY or the model.
  const dummyBuffer = Buffer.from('dummy');

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the PRH template without invoking Gemini when isCover + prh-uk profile', async () => {
    const result = await photoAltGenerator.generateAltText(
      dummyBuffer,
      'image/jpeg',
      { profile: 'prh-uk', isCover: true, bookTitle: 'Test Book' },
    );
    expect(result.shortAlt).toBe('Cover for Test Book.');
    expect(result.extendedAlt).toBe('Cover for Test Book.');
    expect(result.confidence).toBe(100);
    expect(result.flags).toEqual(['COVER_TEMPLATE']);
    expect(result.aiModel).toBe('prh-cover-template');
  });

  it('falls back to "Cover image." when bookTitle is missing', async () => {
    const result = await photoAltGenerator.generateAltText(
      dummyBuffer,
      'image/jpeg',
      { profile: 'prh-uk', isCover: true },
    );
    expect(result.shortAlt).toBe('Cover image.');
  });

  it('does NOT short-circuit when isCover is true but profile is default', async () => {
    // Stub the lazy Gemini initializer to throw a known marker error.
    // If the test enters the model path (i.e. short-circuit DIDN'T
    // fire), the stub trips and we catch a marker error. If the
    // short-circuit DID fire, the stub is never invoked.
    const initSpy = vi
      .spyOn(photoAltGenerator as unknown as { ensureInitialized: () => void }, 'ensureInitialized')
      .mockImplementation(() => {
        throw new Error('STUB_ENSURED_INIT_CALLED');
      });

    await expect(
      photoAltGenerator.generateAltText(
        dummyBuffer,
        'image/jpeg',
        { isCover: true }, // no profile → defaults to 'default'
      ),
    ).rejects.toThrow('STUB_ENSURED_INIT_CALLED');

    expect(initSpy).toHaveBeenCalled();
  });

  it('does NOT short-circuit when profile is prh-uk but isCover is false', async () => {
    const initSpy = vi
      .spyOn(photoAltGenerator as unknown as { ensureInitialized: () => void }, 'ensureInitialized')
      .mockImplementation(() => {
        throw new Error('STUB_ENSURED_INIT_CALLED');
      });

    await expect(
      photoAltGenerator.generateAltText(
        dummyBuffer,
        'image/jpeg',
        { profile: 'prh-uk' }, // no isCover
      ),
    ).rejects.toThrow('STUB_ENSURED_INIT_CALLED');

    expect(initSpy).toHaveBeenCalled();
  });

  it('short-circuit does NOT invoke ensureInitialized (no Gemini call)', async () => {
    const initSpy = vi.spyOn(
      photoAltGenerator as unknown as { ensureInitialized: () => void },
      'ensureInitialized',
    );

    await photoAltGenerator.generateAltText(
      dummyBuffer,
      'image/jpeg',
      { profile: 'prh-uk', isCover: true, bookTitle: 'Test' },
    );

    expect(initSpy).not.toHaveBeenCalled();
  });
});
