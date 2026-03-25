import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mapDoclingLabel } from '../../../../src/services/zone-extractor/zone-type-mapper';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('mapDoclingLabel', () => {
  it.each([
    // Docling v1 PascalCase labels
    ['Text', 'paragraph'],
    ['Section-Header', 'section-header'],
    ['Table', 'table'],
    ['Picture', 'figure'],
    ['Caption', 'caption'],
    ['Footnote', 'footnote'],
    ['Page-Header', 'header'],
    ['Page-Footer', 'footer'],
    // Docling v2 lowercase labels
    ['text', 'paragraph'],
    ['section_header', 'section-header'],
    ['table', 'table'],
    ['picture', 'figure'],
    ['caption', 'caption'],
    ['footnote', 'footnote'],
    ['page_header', 'header'],
    ['page_footer', 'footer'],
    ['list_item', 'paragraph'],
  ] as const)('maps "%s" → "%s"', (label, expected) => {
    expect(mapDoclingLabel(label)).toBe(expected);
  });

  it('returns "paragraph" for truly unknown labels', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mapDoclingLabel('SomethingNew')).toBe('paragraph');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('SomethingNew'),
    );
    warnSpy.mockRestore();
  });
});
