import { describe, it, expect } from 'vitest';
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
    // The cover template is PRH-specific. Default-profile cover
    // images go through the normal Gemini path. We don't run that
    // path here (would need API mocking) — assert via behaviour: the
    // short-circuit returns confidence 100 + aiModel 'prh-cover-template',
    // so if those aren't present we know we'd have entered the
    // Gemini path. We use a try/catch to handle the inevitable
    // ensureInitialized() failure on missing GEMINI_API_KEY.
    try {
      const result = await photoAltGenerator.generateAltText(
        dummyBuffer,
        'image/jpeg',
        { isCover: true }, // no profile → defaults to 'default'
      );
      expect(result.aiModel).not.toBe('prh-cover-template');
    } catch (err) {
      // Expected when GEMINI_API_KEY is absent — proves we entered
      // the model path, not the short-circuit.
      expect((err as Error).message).toMatch(/GEMINI_API_KEY/);
    }
  });

  it('does NOT short-circuit when profile is prh-uk but isCover is false', async () => {
    try {
      const result = await photoAltGenerator.generateAltText(
        dummyBuffer,
        'image/jpeg',
        { profile: 'prh-uk' }, // no isCover
      );
      expect(result.aiModel).not.toBe('prh-cover-template');
    } catch (err) {
      expect((err as Error).message).toMatch(/GEMINI_API_KEY/);
    }
  });
});
