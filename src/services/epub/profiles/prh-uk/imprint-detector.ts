/**
 * PRH UK imprint detector.
 *
 * Decides whether an EPUB looks like a PRH-UK deliverable, and if so which
 * imprint (Penguin / Puffin / Vintage / Pelican / Ladybird / #Merky /
 * Cornerstone Saga). The detection is signal-aggregating: each match adds to
 * the result, and the caller (profile-detector) translates the strongest set
 * of signals into a `PublisherProfile` with `confidence`.
 *
 * Inputs are deliberately decoupled from the EPUB pipeline: the function
 * accepts the parsed OPF text, the list of file paths in the zip, and an
 * optional sample of XHTML content. This keeps the detector unit-testable
 * without spinning up JSZip.
 */

import type { PrhImprint, ProfileSignal } from '../types';

export interface ImprintDetectionInput {
  /** Raw OPF (`package.opf`) content, as string. May be empty if absent. */
  opfContent: string;
  /** Every file path inside the EPUB zip (e.g. `EPUB/xhtml/cover.xhtml`). */
  filePaths: string[];
  /**
   * Optional small sample of XHTML body content concatenated together. Used
   * to look for imprint URLs (`penguin.co.uk`, etc.). The detector itself is
   * cheap; the caller decides how much content to provide.
   */
  contentSample?: string;
}

export interface ImprintDetectionResult {
  /** True if any PRH-UK signal matched at all. */
  isPrhUk: boolean;
  /** Best-guess imprint, or 'unknown' if PRH-UK matched but no imprint did. */
  imprint: PrhImprint | null;
  /** Every signal that contributed, in detection order. */
  signals: ProfileSignal[];
}

const PUBLISHER_PATTERNS = {
  /** dc:publisher or dc:creator strings indicating PRH-UK ownership. */
  publisherText: [
    /penguin random house/i,
    /penguin books/i,
    /penguin random house uk/i,
  ],
};

const IMPRINT_PATTERNS: Record<PrhImprint, {
  /** File-name fragments that identify the imprint (e.g. cover assets). */
  filePathFragments: string[];
  /** Body / OPF text fragments that identify the imprint. */
  textFragments: RegExp[];
  /** URL fragments unique to this imprint. */
  urlFragments: string[];
}> = {
  penguin: {
    filePathFragments: ['penguin-cover', 'penguin/title', 'penguin/brand'],
    // Match the actual imprint name "Penguin Books" (used as the [DIVISION]
    // value in PRH adult copyright pages) and the imprint-specific CSS font
    // family. Bare "penguin" is too noisy — it appears inside both
    // "Penguin Random House" (the publisher, on every PRH EPUB) and the
    // shared `penguin.co.uk` URL (used in the standard accessibility-summary
    // metadata across all imprints).
    textFragments: [/\bpenguin\s+books\b/i, /font-penguin/i],
    // Bare `penguin.co.uk` is shared across PRH-UK (every PRH book's standard
    // accessibility-summary points to penguin.co.uk/accessibility) — it is
    // NOT a Penguin-imprint-only signal. The unique social handle is what
    // distinguishes Penguin from sibling imprints.
    urlFragments: ['penguinukbooks'],
  },
  puffin: {
    filePathFragments: ['puffin-cover', 'puffin/', 'puffin_logo'],
    textFragments: [/\bpuffin\b/i, /font-puffin/i, /puffinBeaky/i],
    urlFragments: ['puffin.co.uk', 'puffinbooks'],
  },
  vintage: {
    filePathFragments: ['vintage-cover', 'vintage/', 'font-vintage'],
    textFragments: [/\bvintage books\b/i, /font-vintage/i],
    urlFragments: ['vintage-books.co.uk', 'penguin.co.uk/vintage', 'vintagebooks'],
  },
  pelican: {
    filePathFragments: ['pelican-cover', 'pelican/', 'font-pelican'],
    textFragments: [/\bpelican books\b/i, /pelican_chapterheader/i],
    urlFragments: [],
  },
  ladybird: {
    filePathFragments: ['ladybird-cover', 'ladybird/', 'ladybird563'],
    textFragments: [/\bladybird books\b/i, /ladybird563/i],
    urlFragments: ['ladybird.co.uk'],
  },
  merky: {
    filePathFragments: ['merkybooks/', 'merky_'],
    textFragments: [/#merky books/i, /merky books/i],
    urlFragments: [],
  },
  'cornerstone-saga': {
    filePathFragments: ['cornerstone-saga/', 'penny_street', 'pennylogo'],
    textFragments: [/penny street/i, /welcome to penny street/i],
    urlFragments: ['penguin.co.uk/pennystreet', 'welcometopennystreet'],
  },
  unknown: { filePathFragments: [], textFragments: [], urlFragments: [] },
};

/** PRH-shared assets — finding `prh_core_assets/` is a strong PRH signal. */
const PRH_CORE_ASSETS_PATH_FRAGMENT = 'prh_core_assets';
const PRH_UK_LOGO_PATH_FRAGMENT = 'prh_uk_logo';

/**
 * Minimum imprint score required to actually pin an imprint. A single weak
 * signal (e.g. one CSS reference to a font filename also present in shared
 * brand assets) shouldn't override the safer 'unknown' default. Real PRH
 * books with imprint-specific cover/title paths score >= 4 from path
 * matches alone; multi-imprint demo docs score 0–1.
 */
const IMPRINT_SCORE_THRESHOLD = 2;

/**
 * Detect whether an EPUB carries PRH-UK profile signals. Pure function over
 * the inputs — no I/O.
 */
export function detectPrhImprint(
  input: ImprintDetectionInput,
): ImprintDetectionResult {
  const signals: ProfileSignal[] = [];
  const opf = input.opfContent ?? '';
  const sample = input.contentSample ?? '';
  const paths = input.filePaths ?? [];

  // ── Publisher-level signals ──────────────────────────────────────────
  for (const re of PUBLISHER_PATTERNS.publisherText) {
    if (re.test(opf)) {
      signals.push({
        id: 'publisher-text-opf',
        description: `OPF contains publisher text matching ${re}`,
        strength: 'strong',
      });
      break;
    }
  }

  // prh_core_assets directory anywhere in the zip — a near-certain PRH signal.
  if (paths.some((p) => p.toLowerCase().includes(PRH_CORE_ASSETS_PATH_FRAGMENT))) {
    signals.push({
      id: 'prh-core-assets-path',
      description: `Zip contains ${PRH_CORE_ASSETS_PATH_FRAGMENT}/ directory`,
      strength: 'strong',
    });
  }

  // PRH UK logo asset.
  if (paths.some((p) => p.toLowerCase().includes(PRH_UK_LOGO_PATH_FRAGMENT))) {
    signals.push({
      id: 'prh-uk-logo-asset',
      description: 'Zip contains a prh_uk_logo asset',
      strength: 'moderate',
    });
  }

  // ── Imprint-level signals ────────────────────────────────────────────
  // Score each imprint independently so the caller can pick the strongest.
  // Paths under prh_core_assets/ are excluded from imprint scoring because
  // that subtree is shared brand infrastructure (fonts, the PRH UK logo)
  // rather than imprint-specific content. The Technical Guide ships every
  // imprint's brand fonts in prh_core_assets/fonts/ as a markup-demo doc;
  // a real PRH book ships only its own imprint's fonts in EPUB/fonts/.
  const imprintPaths = paths.filter(
    (p) => !p.toLowerCase().includes(PRH_CORE_ASSETS_PATH_FRAGMENT),
  );
  const imprintScores = new Map<PrhImprint, number>();

  for (const [imprintRaw, patterns] of Object.entries(IMPRINT_PATTERNS)) {
    const imprint = imprintRaw as PrhImprint;
    if (imprint === 'unknown') continue;

    let score = 0;

    for (const fragment of patterns.filePathFragments) {
      if (imprintPaths.some((p) => p.toLowerCase().includes(fragment.toLowerCase()))) {
        score += 2;
        signals.push({
          id: `imprint-path-${imprint}`,
          description: `File path contains "${fragment}" (${imprint})`,
          strength: 'strong',
        });
      }
    }

    for (const re of patterns.textFragments) {
      if (re.test(opf) || re.test(sample)) {
        score += 1;
        signals.push({
          id: `imprint-text-${imprint}-${re.source.slice(0, 12)}`,
          description: `Content matches "${re}" (${imprint})`,
          strength: 'moderate',
        });
      }
    }

    for (const url of patterns.urlFragments) {
      if (opf.toLowerCase().includes(url) || sample.toLowerCase().includes(url)) {
        score += 1;
        signals.push({
          id: `imprint-url-${imprint}-${url.replace(/[^a-z0-9]/gi, '-')}`,
          description: `Content references ${url} (${imprint})`,
          strength: 'weak',
        });
      }
    }

    if (score > 0) imprintScores.set(imprint, score);
  }

  // Pick the imprint with the highest score; ties resolve by first-seen
  // (Object.entries preserves insertion order in modern engines). A score
  // below IMPRINT_SCORE_THRESHOLD is treated as 'unknown' rather than the
  // top imprint — a single weak text/CSS reference shouldn't pin a doc.
  let topImprint: PrhImprint | null = null;
  let topScore = 0;
  for (const [imprint, score] of imprintScores) {
    if (score > topScore) {
      topScore = score;
      topImprint = imprint;
    }
  }
  const selectedImprint: PrhImprint | null =
    topScore >= IMPRINT_SCORE_THRESHOLD ? topImprint : null;

  const isPrhUk = signals.length > 0;

  // If we have publisher-level evidence but no imprint matched cleanly, mark
  // the imprint as 'unknown' so callers know we recognised PRH but couldn't
  // pin down the line.
  const imprint: PrhImprint | null = isPrhUk
    ? selectedImprint ?? 'unknown'
    : null;

  return { isPrhUk, imprint, signals };
}
