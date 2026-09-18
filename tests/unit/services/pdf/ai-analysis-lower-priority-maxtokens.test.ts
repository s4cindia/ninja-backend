import { describe, it, expect, vi, afterEach } from 'vitest';
import { aiAnalysisService } from '../../../../src/services/pdf/ai-analysis.service';
import { geminiService } from '../../../../src/services/ai/gemini.service';
import type { PdfPage, PdfParseResult } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

/**
 * Unit coverage for the 7 lower-priority functions fixed after
 * analyzeTableHeaders/analyzeTableLayout (PR #565): analyzeList,
 * analyzeReadingOrder, analyzeHeading, analyzeLanguage, analyzeLinkText,
 * analyzeFormField, and analyzeBookmark's 2 call sites (generic-title rename
 * + missing-bookmarks-from-headings). All 8 used the same freeform-JSON
 * prompt + generateText + parseAiJson pattern already confirmed vulnerable
 * to Gemini's MAX_TOKENS silent-truncation trap 5 times this session (see
 * TABLE_HEADERS_SCHEMA's doc comment). Not individually live-measured --
 * most have zero or near-zero real issue volume in the reference document --
 * but fixed proactively via the same proven schema-constrained-decoding
 * pattern rather than left as known-remaining instances of a confirmed bug.
 *
 * Every field with its own app-level fallback (a `data.x || ...` in the
 * calling function) is deliberately optional on its Zod schema rather than
 * required -- required-but-has-a-fallback was a real Codex finding on the
 * table-headers/layout PR (requiring the field makes the fallback branch
 * unreachable, since a genuinely-omitted field fails validation before ever
 * reaching the fallback code). Each function below has at least one test
 * exercising the REAL schema (via geminiService.generateText, not a mocked
 * generateWithSchema) to prove an omitted fallback-eligible field is
 * accepted rather than trusting a mock alone.
 */

// All 7 functions are private; exercise via cast.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const svc = aiAnalysisService as any;

function buildPage(overrides: Partial<PdfPage> = {}): PdfPage {
  return {
    pageNumber: 3,
    width: 612,
    height: 792,
    rotation: 0,
    content: [
      { text: 'Chapter 3: Fractions', position: { x: 50, y: 100, width: 200, height: 20 } },
      { text: 'A fraction represents part of a whole.', position: { x: 50, y: 130, width: 300, height: 20 } },
    ],
    images: [],
    links: [],
    formFields: [],
    headings: [],
    tables: [],
    lists: [
      {
        id: 'list_p3_0',
        pageNumber: 3,
        type: 'unordered',
        itemCount: 2,
        items: [{ text: 'Numerator' }, { text: 'Denominator' }],
        position: { x: 50, y: 150 },
        isProperlyTagged: false,
      },
    ],
    ...overrides,
  } as PdfPage;
}

function buildParsed(overrides: Partial<PdfParseResult> = {}): PdfParseResult {
  return {
    metadata: {} as PdfParseResult['metadata'],
    pages: [buildPage()],
    isTagged: true,
    ...overrides,
  } as PdfParseResult;
}

function issue(overrides: Partial<AuditIssue> = {}): AuditIssue {
  return { id: 'i1', source: 'pdf', severity: 'serious', code: 'X', message: '', ...overrides };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockSchemaResult = (data: unknown, usage?: any) =>
  vi.spyOn(geminiService, 'generateWithSchema').mockResolvedValue({ data, usage, attempts: 1 } as never);

function expectSchemaConstrainedCall() {
  const callArgs = vi.mocked(geminiService.generateWithSchema).mock.calls[0];
  expect(callArgs[2]).toMatchObject({ maxOutputTokens: 2048, responseSchema: expect.any(Object) });
}

describe('analyzeList', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns null without calling Gemini when the page has no lists', async () => {
    const spy = vi.spyOn(geminiService, 'generateWithSchema');
    const res = await svc.analyzeList(issue(), buildPage({ lists: [] }), 'guidance-only');
    expect(res).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('auto-resolves a high-confidence decorative classification in auto-resolve-decorative mode', async () => {
    mockSchemaResult({ classification: 'decorative', confidence: 0.9, guidance: 'purely visual bullets' });

    const res = await svc.analyzeList(issue(), buildPage(), 'auto-resolve-decorative');

    expect(res.applyMode).toBe('auto-resolve');
    expect(res.value).toBe('decorative');
    expectSchemaConstrainedCall();
  });

  it('stays guidance-only for a low-confidence decorative classification even in auto-resolve-decorative mode', async () => {
    mockSchemaResult({ classification: 'decorative', confidence: 0.5, guidance: 'maybe decorative' });

    const res = await svc.analyzeList(issue(), buildPage(), 'auto-resolve-decorative');

    expect(res.applyMode).toBe('guidance-only');
  });

  it('falls back to a navigation-specific default guidance when the model omits guidance', async () => {
    mockSchemaResult({ classification: 'navigation', confidence: 0.7 });

    const res = await svc.analyzeList(issue(), buildPage(), 'guidance-only');

    expect(res.guidance).toContain('<TOC>');
  });

  it('accepts a real response that omits guidance via the real schema', async () => {
    vi.spyOn(geminiService, 'generateText').mockResolvedValue({
      text: JSON.stringify({ classification: 'semantic', confidence: 0.6 }),
    } as never);

    const res = await svc.analyzeList(issue(), buildPage(), 'guidance-only');

    expect(res).toBeTruthy();
    expect(res.guidance).toContain('<L>, <LI>');
  });

  // CodeRabbit review finding on this PR: an out-of-range confidence (e.g. 2)
  // would satisfy analyzeList's own `confidence >= 0.85` auto-resolve check
  // without ever being flagged as malformed. Every confidence field in this
  // file is now clamped to [0,1]; exercises the REAL schema to prove a
  // response with confidence: 2 is rejected rather than silently accepted.
  it('rejects an out-of-range confidence via the real schema, exhausting retries to null', async () => {
    vi.spyOn(geminiService, 'generateText').mockResolvedValue({
      text: JSON.stringify({ classification: 'decorative', confidence: 2, guidance: 'bogus' }),
    } as never);

    await expect(svc.analyzeList(issue(), buildPage(), 'auto-resolve-decorative')).resolves.toBeNull();
  });

  it('returns null (not a rejected promise) when the model exhausts retries', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockRejectedValue(new Error('Exhausted 3 attempt(s): MAX_TOKENS'));
    await expect(svc.analyzeList(issue(), buildPage(), 'guidance-only')).resolves.toBeNull();
  });
});

describe('analyzeReadingOrder', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drafts guidance via schema-constrained decoding', async () => {
    mockSchemaResult({ suggestedOrder: ['Chapter 3: Fractions', 'A fraction represents...'], confidence: 0.8, guidance: 'Reorder top-to-bottom.' });

    const res = await svc.analyzeReadingOrder(issue({ pageNumber: 3 }), buildPage());

    expect(res.suggestionType).toBe('reading-order');
    expect(res.guidance).toBe('Reorder top-to-bottom.');
    expect(res.applyMode).toBe('guidance-only');
    expectSchemaConstrainedCall();
  });

  it('falls back to a suggestedOrder-derived preview when the model omits guidance', async () => {
    mockSchemaResult({ suggestedOrder: ['A', 'B'], confidence: 0.6 });

    const res = await svc.analyzeReadingOrder(issue(), buildPage());

    expect(res.guidance).toBe('Suggested order: 1. A; 2. B');
  });

  // Codex review finding on this PR: an earlier draft accepted a response
  // that omits BOTH suggestedOrder and guidance, persisting the meaningless
  // "Suggested order: " as if it were real guidance. The real schema's
  // .refine() now rejects that combination, exhausting retries to null
  // instead. Exercises the REAL schema (not a mocked generateWithSchema).
  it('rejects a real response that omits both guidance and suggestedOrder via the real schema, exhausting retries to null', async () => {
    vi.spyOn(geminiService, 'generateText').mockResolvedValue({
      text: JSON.stringify({ confidence: 0.4 }),
    } as never);

    await expect(svc.analyzeReadingOrder(issue(), buildPage())).resolves.toBeNull();
  });

  it('accepts a real response that has guidance but omits suggestedOrder via the real schema', async () => {
    vi.spyOn(geminiService, 'generateText').mockResolvedValue({
      text: JSON.stringify({ confidence: 0.4, guidance: 'Reorder top-to-bottom.' }),
    } as never);

    const res = await svc.analyzeReadingOrder(issue(), buildPage());

    expect(res).toBeTruthy();
    expect(res.guidance).toBe('Reorder top-to-bottom.');
  });

  // CodeRabbit review finding on this PR: suggestedOrder: [''] (one blank
  // entry) satisfied the earlier .refine()'s "array is non-empty" check
  // even though the entry carries no real content. Each entry now requires
  // trimmed, non-empty text; exercises the REAL schema to prove a
  // blank-only array is rejected rather than treated as actionable.
  it('rejects a real response with only blank suggestedOrder entries via the real schema, exhausting retries to null', async () => {
    vi.spyOn(geminiService, 'generateText').mockResolvedValue({
      text: JSON.stringify({ suggestedOrder: ['', '  '], confidence: 0.4 }),
    } as never);

    await expect(svc.analyzeReadingOrder(issue(), buildPage())).resolves.toBeNull();
  });

  it('returns null (not a rejected promise) when the model exhausts retries', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockRejectedValue(new Error('Exhausted 3 attempt(s): MAX_TOKENS'));
    await expect(svc.analyzeReadingOrder(issue(), buildPage())).resolves.toBeNull();
  });
});

describe('analyzeHeading', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drafts guidance via schema-constrained decoding', async () => {
    mockSchemaResult({
      correctedHeadings: [{ text: 'Fractions', currentLevel: 3, suggestedLevel: 2 }],
      guidance: 'Promote to H2.',
      confidence: 0.75,
      rationale: 'skips a level',
    });

    const res = await svc.analyzeHeading(issue({ message: 'heading level skip' }), buildParsed());

    expect(res.suggestionType).toBe('heading');
    expect(res.guidance).toBe('Promote to H2.');
    expect(res.rationale).toBe('skips a level');
    expectSchemaConstrainedCall();
  });

  it('falls back to a correctedHeadings-derived string when the model omits guidance', async () => {
    mockSchemaResult({
      correctedHeadings: [{ text: 'Fractions', currentLevel: 3, suggestedLevel: 2 }],
      confidence: 0.75,
      rationale: 'r',
    });

    const res = await svc.analyzeHeading(issue(), buildParsed());

    expect(res.guidance).toContain('H3→H2');
  });

  // Codex review finding on this PR: an earlier draft accepted a response
  // that omits BOTH correctedHeadings and guidance, persisting an empty
  // guidance string. The real schema's .refine() now rejects that
  // combination, exhausting retries to null instead.
  it('rejects a real response that omits both guidance and correctedHeadings via the real schema, exhausting retries to null', async () => {
    vi.spyOn(geminiService, 'generateText').mockResolvedValue({
      text: JSON.stringify({ confidence: 0.5, rationale: 'no clear fix' }),
    } as never);

    await expect(svc.analyzeHeading(issue(), buildParsed())).resolves.toBeNull();
  });

  // Same CodeRabbit finding as ReadingOrderResult's equivalent test -- a
  // correctedHeadings entry with blank text must not satisfy the
  // "array is non-empty" refine check.
  it('rejects a real response with a blank-text correctedHeadings entry via the real schema, exhausting retries to null', async () => {
    vi.spyOn(geminiService, 'generateText').mockResolvedValue({
      text: JSON.stringify({
        correctedHeadings: [{ text: '  ', currentLevel: 3, suggestedLevel: 2 }],
        confidence: 0.5,
        rationale: 'r',
      }),
    } as never);

    await expect(svc.analyzeHeading(issue(), buildParsed())).resolves.toBeNull();
  });

  it('accepts a real response that has guidance but omits correctedHeadings via the real schema', async () => {
    vi.spyOn(geminiService, 'generateText').mockResolvedValue({
      text: JSON.stringify({ confidence: 0.5, rationale: 'r', guidance: 'No clear fix available.' }),
    } as never);

    const res = await svc.analyzeHeading(issue(), buildParsed());

    expect(res).toBeTruthy();
    expect(res.guidance).toBe('No clear fix available.');
  });

  it('returns null (not a rejected promise) when the model exhausts retries', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockRejectedValue(new Error('Exhausted 3 attempt(s): MAX_TOKENS'));
    await expect(svc.analyzeHeading(issue(), buildParsed())).resolves.toBeNull();
  });
});

describe('analyzeLanguage', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns null without calling Gemini when there is no sample text', async () => {
    const spy = vi.spyOn(geminiService, 'generateWithSchema');
    const res = await svc.analyzeLanguage(issue(), buildParsed({ pages: [buildPage({ content: [] })] }), 'apply-to-pdf');
    expect(res).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('drafts a language code via schema-constrained decoding', async () => {
    mockSchemaResult({ languageCode: 'en-US', confidence: 0.95, rationale: 'English prose' });

    const res = await svc.analyzeLanguage(issue(), buildParsed(), 'apply-to-pdf');

    expect(res.value).toBe('en-US');
    expect(res.guidance).toBeUndefined();
    expect(res.applyMode).toBe('apply-to-pdf');
    expectSchemaConstrainedCall();
  });

  it('sets guidance text only in guidance-only mode', async () => {
    mockSchemaResult({ languageCode: 'fr-FR', confidence: 0.9, rationale: 'r' });

    const res = await svc.analyzeLanguage(issue(), buildParsed(), 'guidance-only');

    expect(res.guidance).toContain('fr-FR');
  });

  it('returns null (not a rejected promise) when the model exhausts retries', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockRejectedValue(new Error('Exhausted 3 attempt(s): MAX_TOKENS'));
    await expect(svc.analyzeLanguage(issue(), buildParsed(), 'apply-to-pdf')).resolves.toBeNull();
  });
});

describe('analyzeLinkText', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drafts link text via schema-constrained decoding', async () => {
    mockSchemaResult({ suggestedText: 'Download the syllabus PDF', confidence: 0.85, rationale: 'r' });

    const res = await svc.analyzeLinkText(
      issue({ context: 'Link text: "click here"\nURL: "https://example.com/syllabus.pdf"' }),
      buildPage(),
      'apply-to-pdf'
    );

    expect(res.value).toBe('Download the syllabus PDF');
    expect(res.guidance).toContain("link's accessible description");
    expectSchemaConstrainedCall();
  });

  it('rejects link text longer than 60 characters via the real schema, exhausting retries to null', async () => {
    const overLong = 'A'.repeat(61);
    vi.spyOn(geminiService, 'generateText').mockResolvedValue({
      text: JSON.stringify({ suggestedText: overLong, confidence: 0.8, rationale: 'r' }),
    } as never);

    await expect(svc.analyzeLinkText(issue(), buildPage(), 'apply-to-pdf')).resolves.toBeNull();
  });

  it('returns null (not a rejected promise) when the model exhausts retries', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockRejectedValue(new Error('Exhausted 3 attempt(s): MAX_TOKENS'));
    await expect(svc.analyzeLinkText(issue(), buildPage(), 'apply-to-pdf')).resolves.toBeNull();
  });
});

describe('analyzeFormField', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drafts a form field label via schema-constrained decoding', async () => {
    mockSchemaResult({ suggestedLabel: 'Enter student name', confidence: 0.8, rationale: 'r' });

    const res = await svc.analyzeFormField(
      issue({ context: 'Field name: "field1"\nType: "text"' }),
      buildPage(),
      'guidance-only'
    );

    expect(res.value).toBe('Enter student name');
    expectSchemaConstrainedCall();
  });

  it('rejects a label longer than 50 characters via the real schema, exhausting retries to null', async () => {
    const overLong = 'A'.repeat(51);
    vi.spyOn(geminiService, 'generateText').mockResolvedValue({
      text: JSON.stringify({ suggestedLabel: overLong, confidence: 0.8, rationale: 'r' }),
    } as never);

    await expect(svc.analyzeFormField(issue(), buildPage(), 'guidance-only')).resolves.toBeNull();
  });

  it('returns null (not a rejected promise) when the model exhausts retries', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockRejectedValue(new Error('Exhausted 3 attempt(s): MAX_TOKENS'));
    await expect(svc.analyzeFormField(issue(), buildPage(), 'guidance-only')).resolves.toBeNull();
  });
});

describe('analyzeBookmark (generic title)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('drafts a bookmark title via schema-constrained decoding', async () => {
    mockSchemaResult({ suggestedTitle: 'Chapter 3: Fractions', confidence: 0.85, rationale: 'r' });

    const res = await svc.analyzeBookmark(
      issue({ code: 'BOOKMARK-GENERIC-TEXT', context: 'Bookmark title: "Page 3"', pageNumber: 3 }),
      buildParsed(),
      'apply-to-pdf'
    );

    expect(res.value).toBe('Chapter 3: Fractions');
    expect(res.guidance).toContain('Renames bookmark');
    expectSchemaConstrainedCall();
  });

  it('rejects a title longer than 60 characters via the real schema, exhausting retries to null', async () => {
    const overLong = 'A'.repeat(61);
    vi.spyOn(geminiService, 'generateText').mockResolvedValue({
      text: JSON.stringify({ suggestedTitle: overLong, confidence: 0.8, rationale: 'r' }),
    } as never);

    await expect(
      svc.analyzeBookmark(issue({ code: 'BOOKMARK-GENERIC-TEXT' }), buildParsed(), 'apply-to-pdf')
    ).resolves.toBeNull();
  });

  it('returns null (not a rejected promise) when the model exhausts retries', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockRejectedValue(new Error('Exhausted 3 attempt(s): MAX_TOKENS'));
    await expect(
      svc.analyzeBookmark(issue({ code: 'BOOKMARK-GENERIC-TEXT' }), buildParsed(), 'apply-to-pdf')
    ).resolves.toBeNull();
  });
});

describe('analyzeBookmark (missing bookmarks from headings)', () => {
  afterEach(() => vi.restoreAllMocks());

  function parsedWithHeadings() {
    return buildParsed({
      pages: [
        buildPage({
          headings: [
            { id: 'h1', level: 1, text: 'Chapter 3: Fractions', pageNumber: 3, position: { x: 0, y: 0 }, isFromTags: true, isProperlyNested: true },
          ],
        }),
      ],
    });
  }

  it('returns a no-headings guidance result without calling Gemini when there are no headings', async () => {
    const spy = vi.spyOn(geminiService, 'generateWithSchema');
    const res = await svc.analyzeBookmark(issue({ code: 'BOOKMARK-MISSING' }), buildParsed({ pages: [buildPage({ headings: [] })] }), 'guidance-only');

    expect(res.applyMode).toBe('guidance-only');
    expect(res.guidance).toContain('No headings detected');
    expect(spy).not.toHaveBeenCalled();
  });

  it('drafts bookmark suggestions via schema-constrained decoding', async () => {
    mockSchemaResult({
      suggestedBookmarks: [{ pageNumber: 3, title: 'Chapter 3: Fractions', level: 1 }],
      guidance: 'Add a top-level bookmark for Chapter 3.',
      confidence: 0.8,
      rationale: 'r',
    });

    const res = await svc.analyzeBookmark(issue({ code: 'BOOKMARK-MISSING' }), parsedWithHeadings(), 'guidance-only');

    expect(res.suggestionType).toBe('bookmark-missing');
    expect(res.guidance).toBe('Add a top-level bookmark for Chapter 3.');
    expectSchemaConstrainedCall();
  });

  it('falls back to a suggestedBookmarks-derived preview when the model omits guidance', async () => {
    mockSchemaResult({
      suggestedBookmarks: [{ pageNumber: 3, title: 'Chapter 3: Fractions', level: 1 }],
      confidence: 0.7,
      rationale: 'r',
    });

    const res = await svc.analyzeBookmark(issue({ code: 'BOOKMARK-MISSING' }), parsedWithHeadings(), 'guidance-only');

    expect(res.guidance).toContain('Add bookmarks: "Chapter 3: Fractions" (p.3)');
  });

  // Codex review finding on this PR: an earlier draft accepted a response
  // that omits BOTH suggestedBookmarks and guidance, persisting "Add
  // bookmarks: " as if it were real guidance. The real schema's .refine()
  // now rejects that combination, exhausting retries to null instead.
  it('rejects a real response that omits both guidance and suggestedBookmarks via the real schema, exhausting retries to null', async () => {
    vi.spyOn(geminiService, 'generateText').mockResolvedValue({
      text: JSON.stringify({ confidence: 0.5, rationale: 'r' }),
    } as never);

    await expect(
      svc.analyzeBookmark(issue({ code: 'BOOKMARK-MISSING' }), parsedWithHeadings(), 'guidance-only')
    ).resolves.toBeNull();
  });

  // Same CodeRabbit finding as ReadingOrderResult/HeadingCorrectionResult's
  // equivalent tests -- a suggestedBookmarks entry with a blank title must
  // not satisfy the "array is non-empty" refine check.
  it('rejects a real response with a blank-title suggestedBookmarks entry via the real schema, exhausting retries to null', async () => {
    vi.spyOn(geminiService, 'generateText').mockResolvedValue({
      text: JSON.stringify({
        suggestedBookmarks: [{ pageNumber: 3, title: '   ', level: 1 }],
        confidence: 0.5,
        rationale: 'r',
      }),
    } as never);

    await expect(
      svc.analyzeBookmark(issue({ code: 'BOOKMARK-MISSING' }), parsedWithHeadings(), 'guidance-only')
    ).resolves.toBeNull();
  });

  it('accepts a real response that has guidance but omits suggestedBookmarks via the real schema', async () => {
    vi.spyOn(geminiService, 'generateText').mockResolvedValue({
      text: JSON.stringify({ confidence: 0.5, rationale: 'r', guidance: 'No clear bookmarks to suggest.' }),
    } as never);

    const res = await svc.analyzeBookmark(issue({ code: 'BOOKMARK-MISSING' }), parsedWithHeadings(), 'guidance-only');

    expect(res).toBeTruthy();
    expect(res.guidance).toBe('No clear bookmarks to suggest.');
  });

  it('returns null (not a rejected promise) when the model exhausts retries', async () => {
    vi.spyOn(geminiService, 'generateWithSchema').mockRejectedValue(new Error('Exhausted 3 attempt(s): MAX_TOKENS'));
    await expect(
      svc.analyzeBookmark(issue({ code: 'BOOKMARK-MISSING' }), parsedWithHeadings(), 'guidance-only')
    ).resolves.toBeNull();
  });

  // Real Math_Weir_PDF.pdf incident: pdf-structure-writer.service.ts's own
  // generateBookmarksFromHeadings (a deterministic, no-AI-call writer) was
  // already wired on the APPLY side (STRUCTURE_WRITER_TYPES /
  // 'bookmark-generate' in applyApprovedSuggestions) but nothing ever
  // PRODUCED that suggestion type -- unreachable dead code. Mirrors
  // analyzeColorContrast's own apply-to-pdf gating: never overrides an
  // explicit config choice, and only engages when real TAGGED headings
  // exist (isFromTags), since the deterministic writer walks the real
  // structure tree and can't see font-size-heuristic headings at all.
  describe('deterministic apply-to-pdf path (real tagged headings + mode opted in)', () => {
    it('returns bookmark-generate/apply-to-pdf without calling Gemini when mode is apply-to-pdf and headings are tagged', async () => {
      const spy = vi.spyOn(geminiService, 'generateWithSchema');
      const res = await svc.analyzeBookmark(issue({ code: 'BOOKMARK-MISSING' }), parsedWithHeadings(), 'apply-to-pdf');

      expect(res.suggestionType).toBe('bookmark-generate');
      expect(res.applyMode).toBe('apply-to-pdf');
      expect(spy).not.toHaveBeenCalled();
    });

    it('falls back to the AI guidance-only path when mode is apply-to-pdf but headings are only from the font-size heuristic (not tagged)', async () => {
      const heuristicOnly = buildParsed({
        pages: [
          buildPage({
            headings: [
              { id: 'h1', level: 1, text: 'Chapter 3: Fractions', pageNumber: 3, position: { x: 0, y: 0 }, isFromTags: false, isProperlyNested: true },
            ],
          }),
        ],
      });
      mockSchemaResult({
        suggestedBookmarks: [{ pageNumber: 3, title: 'Chapter 3: Fractions', level: 1 }],
        guidance: 'Add a top-level bookmark for Chapter 3.',
        confidence: 0.8,
        rationale: 'r',
      });

      const res = await svc.analyzeBookmark(issue({ code: 'BOOKMARK-MISSING' }), heuristicOnly, 'apply-to-pdf');

      expect(res.suggestionType).toBe('bookmark-missing');
      expect(res.applyMode).toBe('guidance-only');
    });

    it('still uses the AI guidance-only path when mode is guidance-only, even with real tagged headings (never overrides the config)', async () => {
      mockSchemaResult({
        suggestedBookmarks: [{ pageNumber: 3, title: 'Chapter 3: Fractions', level: 1 }],
        guidance: 'Add a top-level bookmark for Chapter 3.',
        confidence: 0.8,
        rationale: 'r',
      });

      const res = await svc.analyzeBookmark(issue({ code: 'BOOKMARK-MISSING' }), parsedWithHeadings(), 'guidance-only');

      expect(res.suggestionType).toBe('bookmark-missing');
      expect(res.applyMode).toBe('guidance-only');
    });
  });
});
