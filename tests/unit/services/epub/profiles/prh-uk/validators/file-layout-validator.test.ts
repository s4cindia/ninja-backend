import { describe, it, expect } from 'vitest';
import { validatePrhFileLayout } from '../../../../../../../src/services/epub/profiles/prh-uk/validators/file-layout-validator';
import type {
  PrhFileLayoutInput,
  PrhManifestEntry,
} from '../../../../../../../src/services/epub/profiles/prh-uk/validators/types';

function manifestEntry(
  path: string,
  mediaType: string,
  opts: { sizeBytes?: number | null; properties?: string[] } = {},
): PrhManifestEntry {
  return {
    path,
    mediaType,
    properties: opts.properties ?? [],
    sizeBytes: opts.sizeBytes ?? 1000,
  };
}

function input(opts: Partial<PrhFileLayoutInput> = {}): PrhFileLayoutInput {
  return {
    opfContent: opts.opfContent ?? '<?xml version="1.0"?><package/>',
    opfPath: opts.opfPath ?? 'EPUB/package.opf',
    manifestEntries: opts.manifestEntries ?? [],
    zipPaths: opts.zipPaths ?? [],
    requiresNcx: opts.requiresNcx ?? false,
  };
}

/** A minimal conformant baseline: package.opf at canonical path, nav.xhtml,
 *  cover image, and an XHTML chapter — no violations. */
function conformantBaseline(): Partial<PrhFileLayoutInput> {
  return {
    opfPath: 'EPUB/package.opf',
    manifestEntries: [
      manifestEntry('EPUB/xhtml/nav.xhtml', 'application/xhtml+xml', {
        properties: ['nav'],
        sizeBytes: 5000,
      }),
      manifestEntry('EPUB/xhtml/chapter_001.xhtml', 'application/xhtml+xml', {
        sizeBytes: 200 * 1024,
      }),
      manifestEntry('EPUB/images/cover.jpg', 'image/jpeg', {
        properties: ['cover-image'],
        sizeBytes: 500_000,
      }),
    ],
    zipPaths: [
      'mimetype',
      'META-INF/container.xml',
      'EPUB/package.opf',
      'EPUB/xhtml/nav.xhtml',
      'EPUB/xhtml/chapter_001.xhtml',
      'EPUB/images/cover.jpg',
    ],
    requiresNcx: false,
  };
}

describe('validatePrhFileLayout — PRH-FILE-XHTML-OVERSIZE', () => {
  it('emits when a non-plate XHTML exceeds 600KB', () => {
    const base = conformantBaseline();
    const entries = [
      ...(base.manifestEntries ?? []),
      manifestEntry('EPUB/xhtml/chapter_002.xhtml', 'application/xhtml+xml', {
        sizeBytes: 700 * 1024,
      }),
    ];
    const issues = validatePrhFileLayout(input({ ...base, manifestEntries: entries }));
    expect(issues.some((i) => i.code === 'PRH-FILE-XHTML-OVERSIZE')).toBe(true);
  });

  it('does NOT emit for XHTML at or below 600KB', () => {
    const base = conformantBaseline();
    const entries = [
      ...(base.manifestEntries ?? []),
      manifestEntry('EPUB/xhtml/chapter_002.xhtml', 'application/xhtml+xml', {
        sizeBytes: 600 * 1024,
      }),
    ];
    const issues = validatePrhFileLayout(input({ ...base, manifestEntries: entries }));
    expect(issues.some((i) => i.code === 'PRH-FILE-XHTML-OVERSIZE')).toBe(false);
  });

  it('treats plate XHTML as a separate category (no 600KB-rule emission)', () => {
    const base = conformantBaseline();
    const entries = [
      ...(base.manifestEntries ?? []),
      manifestEntry('EPUB/xhtml/plate_001.xhtml', 'application/xhtml+xml', {
        sizeBytes: 5 * 1024 * 1024, // 5MB plate, under the 11MB cap
      }),
    ];
    const issues = validatePrhFileLayout(input({ ...base, manifestEntries: entries }));
    expect(issues.some((i) => i.code === 'PRH-FILE-XHTML-OVERSIZE')).toBe(false);
  });

  it('does not emit when sizeBytes is null (manifested but absent from zip)', () => {
    const base = conformantBaseline();
    const entries = [
      ...(base.manifestEntries ?? []),
      manifestEntry('EPUB/xhtml/chapter_002.xhtml', 'application/xhtml+xml', {
        sizeBytes: null,
      }),
    ];
    const issues = validatePrhFileLayout(input({ ...base, manifestEntries: entries }));
    expect(issues.some((i) => i.code === 'PRH-FILE-XHTML-OVERSIZE')).toBe(false);
  });
});

describe('validatePrhFileLayout — PRH-FILE-PLATE-OVERSIZE', () => {
  it('emits when a plate XHTML exceeds 11MB', () => {
    const base = conformantBaseline();
    const entries = [
      ...(base.manifestEntries ?? []),
      manifestEntry('EPUB/xhtml/plate_001.xhtml', 'application/xhtml+xml', {
        sizeBytes: 12 * 1024 * 1024,
      }),
    ];
    const issues = validatePrhFileLayout(input({ ...base, manifestEntries: entries }));
    expect(issues.some((i) => i.code === 'PRH-FILE-PLATE-OVERSIZE')).toBe(true);
  });

  it('does NOT emit for plate XHTML at or below 11MB', () => {
    const base = conformantBaseline();
    const entries = [
      ...(base.manifestEntries ?? []),
      manifestEntry('EPUB/xhtml/plate_001.xhtml', 'application/xhtml+xml', {
        sizeBytes: 11 * 1024 * 1024,
      }),
    ];
    const issues = validatePrhFileLayout(input({ ...base, manifestEntries: entries }));
    expect(issues.some((i) => i.code === 'PRH-FILE-PLATE-OVERSIZE')).toBe(false);
  });

  it('detects plates by /plates/ directory segment too', () => {
    const base = conformantBaseline();
    const entries = [
      ...(base.manifestEntries ?? []),
      manifestEntry('EPUB/plates/plate_001.xhtml', 'application/xhtml+xml', {
        sizeBytes: 12 * 1024 * 1024,
      }),
    ];
    const issues = validatePrhFileLayout(input({ ...base, manifestEntries: entries }));
    expect(issues.some((i) => i.code === 'PRH-FILE-PLATE-OVERSIZE')).toBe(true);
  });
});

describe('validatePrhFileLayout — PRH-DIR-LAYOUT-NONSTANDARD', () => {
  it('emits when images live outside /images/', () => {
    const base = conformantBaseline();
    const entries = [
      ...(base.manifestEntries ?? []),
      manifestEntry('EPUB/figures/diagram_01.png', 'image/png'),
    ];
    const issues = validatePrhFileLayout(input({ ...base, manifestEntries: entries }));
    const dirIssue = issues.find((i) => i.code === 'PRH-DIR-LAYOUT-NONSTANDARD');
    expect(dirIssue).toBeDefined();
    expect(dirIssue?.message).toMatch(/images/);
  });

  it('emits when stylesheets live outside /styles/', () => {
    const base = conformantBaseline();
    const entries = [
      ...(base.manifestEntries ?? []),
      manifestEntry('EPUB/css/basestyles.css', 'text/css'),
    ];
    const issues = validatePrhFileLayout(input({ ...base, manifestEntries: entries }));
    expect(issues.some((i) => i.code === 'PRH-DIR-LAYOUT-NONSTANDARD')).toBe(true);
  });

  it('does NOT emit when each content type is under its canonical dir', () => {
    const base = conformantBaseline();
    const entries = [
      ...(base.manifestEntries ?? []),
      manifestEntry('EPUB/images/diagram_01.png', 'image/png'),
      manifestEntry('EPUB/styles/basestyles.css', 'text/css'),
      manifestEntry('EPUB/fonts/garamond.otf', 'font/otf'),
    ];
    const issues = validatePrhFileLayout(input({ ...base, manifestEntries: entries }));
    expect(issues.some((i) => i.code === 'PRH-DIR-LAYOUT-NONSTANDARD')).toBe(false);
  });

  it('emits ONE issue per content type even with many violators', () => {
    const base = conformantBaseline();
    const entries = [
      ...(base.manifestEntries ?? []),
      manifestEntry('EPUB/figures/diagram_01.png', 'image/png'),
      manifestEntry('EPUB/figures/diagram_02.png', 'image/png'),
      manifestEntry('EPUB/figures/diagram_03.png', 'image/png'),
      manifestEntry('EPUB/figures/diagram_04.png', 'image/png'),
    ];
    const issues = validatePrhFileLayout(input({ ...base, manifestEntries: entries }));
    const dirIssues = issues.filter((i) => i.code === 'PRH-DIR-LAYOUT-NONSTANDARD');
    expect(dirIssues).toHaveLength(1);
    expect(dirIssues[0].message).toMatch(/4 file/);
  });
});

describe('validatePrhFileLayout — PRH-FILE-NAMING-NONSTANDARD', () => {
  it('emits for uppercase characters in the basename', () => {
    const base = conformantBaseline();
    const issues = validatePrhFileLayout(
      input({
        ...base,
        zipPaths: [...(base.zipPaths ?? []), 'EPUB/xhtml/Chapter_002.xhtml'],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-FILE-NAMING-NONSTANDARD')).toBe(true);
  });

  it('emits for multiple dots in the basename', () => {
    const base = conformantBaseline();
    const issues = validatePrhFileLayout(
      input({
        ...base,
        zipPaths: [...(base.zipPaths ?? []), 'EPUB/xhtml/chapter.001.xhtml'],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-FILE-NAMING-NONSTANDARD')).toBe(true);
  });

  it('emits for disallowed characters (spaces, parens)', () => {
    const base = conformantBaseline();
    const issues = validatePrhFileLayout(
      input({
        ...base,
        zipPaths: [...(base.zipPaths ?? []), 'EPUB/xhtml/chapter (1).xhtml'],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-FILE-NAMING-NONSTANDARD')).toBe(true);
  });

  it('exempts mimetype + META-INF boilerplate from the naming rule', () => {
    const issues = validatePrhFileLayout(
      input({
        ...conformantBaseline(),
        zipPaths: ['mimetype', 'META-INF/container.xml', 'EPUB/package.opf'],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-FILE-NAMING-NONSTANDARD')).toBe(false);
  });

  it('does NOT emit for conformant filenames (lowercase, underscores, hyphens)', () => {
    const issues = validatePrhFileLayout(
      input({
        ...conformantBaseline(),
        zipPaths: [
          'EPUB/xhtml/chapter_001.xhtml',
          'EPUB/xhtml/chapter-introduction.xhtml',
          'EPUB/images/diagram-01.png',
        ],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-FILE-NAMING-NONSTANDARD')).toBe(false);
  });

  it('skips directory entries (trailing slash)', () => {
    const issues = validatePrhFileLayout(
      input({
        ...conformantBaseline(),
        zipPaths: ['EPUB/', 'EPUB/xhtml/', 'EPUB/package.opf'],
      }),
    );
    expect(issues.some((i) => i.code === 'PRH-FILE-NAMING-NONSTANDARD')).toBe(false);
  });
});

describe('validatePrhFileLayout — PRH-FILE-FIXED-NAME-MISSING', () => {
  it('emits when package.opf is named otherwise', () => {
    const issues = validatePrhFileLayout(
      input({
        ...conformantBaseline(),
        opfPath: 'EPUB/content.opf',
      }),
    );
    expect(
      issues.some(
        (i) => i.code === 'PRH-FILE-FIXED-NAME-MISSING' && /package\.opf/i.test(i.message),
      ),
    ).toBe(true);
  });

  it('emits when no manifest item has properties="nav"', () => {
    const base = conformantBaseline();
    const issues = validatePrhFileLayout(
      input({
        ...base,
        manifestEntries: (base.manifestEntries ?? []).filter(
          (e) => !e.properties.includes('nav'),
        ),
      }),
    );
    expect(
      issues.some(
        (i) => i.code === 'PRH-FILE-FIXED-NAME-MISSING' && /nav\.xhtml/i.test(i.message),
      ),
    ).toBe(true);
  });

  it('emits when the nav item is named other than nav.xhtml', () => {
    const issues = validatePrhFileLayout(
      input({
        ...conformantBaseline(),
        manifestEntries: [
          manifestEntry('EPUB/xhtml/toc.xhtml', 'application/xhtml+xml', {
            properties: ['nav'],
          }),
          manifestEntry('EPUB/images/cover.jpg', 'image/jpeg', {
            properties: ['cover-image'],
          }),
        ],
      }),
    );
    expect(
      issues.some(
        (i) => i.code === 'PRH-FILE-FIXED-NAME-MISSING' && /toc\.xhtml/.test(i.message),
      ),
    ).toBe(true);
  });

  it('emits when requiresNcx is true but no NCX item is present', () => {
    const issues = validatePrhFileLayout(
      input({
        ...conformantBaseline(),
        requiresNcx: true,
      }),
    );
    expect(
      issues.some(
        (i) => i.code === 'PRH-FILE-FIXED-NAME-MISSING' && /toc\.ncx/.test(i.message),
      ),
    ).toBe(true);
  });

  it('does NOT emit for a missing toc.ncx when requiresNcx is false', () => {
    const issues = validatePrhFileLayout(input({ ...conformantBaseline(), requiresNcx: false }));
    expect(
      issues.some(
        (i) => i.code === 'PRH-FILE-FIXED-NAME-MISSING' && /toc\.ncx/.test(i.message),
      ),
    ).toBe(false);
  });

  it('emits when no manifest item has properties="cover-image"', () => {
    const base = conformantBaseline();
    const issues = validatePrhFileLayout(
      input({
        ...base,
        manifestEntries: (base.manifestEntries ?? []).filter(
          (e) => !e.properties.includes('cover-image'),
        ),
      }),
    );
    expect(
      issues.some(
        (i) => i.code === 'PRH-FILE-FIXED-NAME-MISSING' && /cover/i.test(i.message),
      ),
    ).toBe(true);
  });

  it('emits when the cover-image item is not named cover.<ext>', () => {
    const issues = validatePrhFileLayout(
      input({
        ...conformantBaseline(),
        manifestEntries: [
          manifestEntry('EPUB/xhtml/nav.xhtml', 'application/xhtml+xml', {
            properties: ['nav'],
          }),
          manifestEntry('EPUB/images/front_cover.jpg', 'image/jpeg', {
            properties: ['cover-image'],
          }),
        ],
      }),
    );
    expect(
      issues.some(
        (i) =>
          i.code === 'PRH-FILE-FIXED-NAME-MISSING' && /front_cover\.jpg/.test(i.message),
      ),
    ).toBe(true);
  });
});

describe('validatePrhFileLayout — overall', () => {
  it('emits zero issues for a conformant EPUB', () => {
    const issues = validatePrhFileLayout(input(conformantBaseline()));
    expect(issues).toEqual([]);
  });
});
