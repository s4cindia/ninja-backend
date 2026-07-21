import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mapYoloLabel } from '../../../../src/services/zone-extractor/yolo-label-mapper';

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('mapYoloLabel', () => {
  it.each([
    'paragraph', 'section-header', 'table', 'figure', 'caption',
    'footnote', 'header', 'footer', 'list-item', 'toci', 'formula',
  ] as const)('passes canonical label "%s" through unchanged', (label) => {
    expect(mapYoloLabel(label)).toBe(label);
  });

  it('is case- and whitespace-tolerant', () => {
    expect(mapYoloLabel('Formula')).toBe('formula');
    expect(mapYoloLabel('  LIST-ITEM  ')).toBe('list-item');
    expect(mapYoloLabel('TOCI')).toBe('toci');
  });

  it('defaults an unknown label to paragraph and warns once', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(mapYoloLabel('doodad')).toBe('paragraph');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('doodad'));
    warn.mockRestore();
  });
});
