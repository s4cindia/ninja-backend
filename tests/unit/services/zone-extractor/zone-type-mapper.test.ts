import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mapDoclingLabel } from '../../../../src/services/zone-extractor/zone-type-mapper';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('mapDoclingLabel', () => {
  it.each([
    ['Text', 'paragraph'],
    ['Section-Header', 'section-header'],
    ['Table', 'table'],
    ['Picture', 'figure'],
    ['Caption', 'caption'],
    ['Footnote', 'footnote'],
    ['Page-Header', 'header'],
    ['Page-Footer', 'footer'],
  ] as const)('maps "%s" → "%s"', (label, expected) => {
    expect(mapDoclingLabel(label)).toBe(expected);
  });

  it('returns "paragraph" for unknown label "Formula"', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mapDoclingLabel('Formula')).toBe('paragraph');
    warnSpy.mockRestore();
  });

  it('logs a warning for unknown label', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mapDoclingLabel('Formula');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Formula'),
    );
    warnSpy.mockRestore();
  });

  it('is case-sensitive: "text" falls through to default', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mapDoclingLabel('text')).toBe('paragraph');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
