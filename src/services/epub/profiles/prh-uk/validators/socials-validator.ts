/**
 * PRH UK socials-page validator (P2/PR3).
 *
 * Validates the imprint's "Follow us" / socials page — the backmatter
 * section that lists the imprint's social handles. Per Branding Guide §6:
 *
 *   - Penguin → 7 channels in a fixed order, plus a closing strapline.
 *     Files: `follow_penguin.xhtml` (full) / `follow_penguin_ya.xhtml` (YA).
 *   - Vintage → 4 channels (Twitter / Instagram / TikTok / Facebook)
 *     under `@vintagebooks` (TikTok is `@vintageukbooks`).
 *     File: `vintage/vin_endpage_socials.xhtml`.
 *   - Cornerstone Saga → Facebook + Penny Street newsletter URL.
 *     File: `Cornerstone-saga/saga_socials.xhtml`.
 *   - Puffin / Pelican / Ladybird / #Merky → no socials page. The
 *     imprint registry sets `socials: null` and the orchestrator
 *     short-circuits the validator entirely.
 *
 * Issue codes emitted:
 *   - PRH-SOCIALS-PAGE-MISSING          — no socials page found
 *   - PRH-SOCIALS-CHANNEL-MISSING       — declared channel handle not in page
 *   - PRH-SOCIALS-CHANNEL-ORDER-WRONG   — channels present but out of order
 *   - PRH-SOCIALS-HANDLE-WRONG          — channel referenced with wrong handle
 *   - PRH-SOCIALS-STRAPLINE-MISSING     — declared strapline absent
 *
 * Detection strategy: locate the socials XHTML, then walk the imprint's
 * channel list checking (1) presence of the canonical handle substring,
 * (2) order of the FIRST occurrence of each channel's URL prefix
 * (twitter.com / facebook.com / etc.) against the declared order, and
 * (3) wrong-handle — when the channel's URL prefix appears but with a
 * different account name than the imprint specifies (only flagged when
 * MISSING didn't already fire for the same channel).
 *
 * Channels NOT in the imprint registry are intentionally ignored — a
 * PRH EPUB that adds a Threads handle to the bottom of the Penguin
 * socials page doesn't get flagged. Detection-only means we don't drive
 * removal here.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { ImprintRules, SocialChannel } from '../imprints/_types';
import type { PrhValidatorIssue, PrhPerXhtmlInput } from './types';

interface SocialsInput extends PrhPerXhtmlInput {
  imprintRules: ImprintRules;
}

/** URL prefix used to detect a channel's mention regardless of the
 *  actual handle (used for ordering + wrong-handle diagnostics). */
const CHANNEL_URL_PREFIX: Record<SocialChannel['id'], string> = {
  twitter: 'twitter.com/',
  facebook: 'facebook.com/',
  instagram: 'instagram.com/',
  youtube: 'youtube.com/',
  pinterest: 'pinterest.com/',
  linkedin: 'linkedin.com/',
  tiktok: 'tiktok.com/',
  // Newsletter is the odd-one-out — no canonical url-prefix; the handle
  // IS the substring. Detection falls back to the handle field.
  newsletter: '',
};

export function validatePrhSocials(input: SocialsInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  // Imprint has no canonical socials page (Puffin / Pelican / Ladybird / Merky).
  if (!input.imprintRules.socials) return issues;

  const socialsFile = findSocialsXhtml(input.xhtmlFiles, input.imprintRules.imprint);
  // Pick the YA ruleset when the YA-variant filename matches AND the
  // imprint declares one (Penguin only). Otherwise use the full rules.
  // The YA variant ships a smaller channel set per Branding Guide §6 —
  // validating it against the full ruleset would emit a flurry of
  // CHANNEL-MISSING issues for conformant YA builds.
  const rules = socialsFile && isPenguinYaFile(socialsFile.path) && input.imprintRules.socialsYa
    ? input.imprintRules.socialsYa
    : input.imprintRules.socials;

  if (!socialsFile) {
    issues.push(buildIssue(
      'PRH-SOCIALS-PAGE-MISSING',
      `Socials page not found. Expected a <body epub:type="backmatter"> file referencing the ${input.imprintRules.displayName} social handles.`,
      `Add the ${input.imprintRules.displayName} socials page per Branding Guide §6 — backmatter file listing ${rules.channels.map((c) => c.id).join(', ')}.`,
      'EPUB',
    ));
    return issues;
  }

  const normalised = normaliseSocialsText(socialsFile.content);

  // Track which channels are present (handle matches) — order check
  // only considers channels that are actually present, so a missing
  // channel doesn't double-fire as out-of-order too. Each entry
  // records the channel and its match index in the normalised text
  // (so the order check uses the actual detector position rather than
  // recomputing it later).
  const channelsPresent: Array<{ channel: SocialChannel; index: number }> = [];
  for (const channel of rules.channels) {
    const presentAt = findChannelIndex(channel, normalised);
    const prefix = CHANNEL_URL_PREFIX[channel.id].toLowerCase();
    const prefixPresent = prefix.length > 0 && normalised.includes(prefix);

    if (presentAt >= 0) {
      channelsPresent.push({ channel, index: presentAt });
      continue;
    }

    if (prefixPresent) {
      // Channel referenced but with the wrong handle (e.g.
      // twitter.com/penguinbooks instead of twitter.com/penguinukbooks).
      // Fire HANDLE-WRONG once per channel — the operator can correct
      // it without separately being told the canonical handle was
      // "missing" too.
      issues.push(buildIssue(
        'PRH-SOCIALS-HANDLE-WRONG',
        `${channel.id} channel is referenced on the socials page but with an unexpected handle. ${input.imprintRules.displayName} expects "${channel.handle}".`,
        `Update the ${channel.id} link/handle to "${channel.handle}".`,
        socialsFile.path,
      ));
      continue;
    }

    // Channel entirely absent.
    issues.push(buildIssue(
      'PRH-SOCIALS-CHANNEL-MISSING',
      `${channel.id} channel is missing from the socials page. ${input.imprintRules.displayName} expects "${channel.handle}".`,
      `Add the ${channel.id} entry "${channel.handle}" to the socials page in the canonical order.`,
      socialsFile.path,
    ));
  }

  // Order check — the indices were captured per-channel above using
  // the channel-specific detector (regex or handle substring), so the
  // check is just "do these indices increase monotonically?". This
  // gives correct behaviour for Vintage where three channels share
  // the same plain handle but each has its own context-aware detector.
  if (channelsPresent.length >= 2 && !isOrderMonotonic(channelsPresent.map((c) => c.index))) {
    issues.push(buildIssue(
      'PRH-SOCIALS-CHANNEL-ORDER-WRONG',
      `Socials channels appear in a different order than ${input.imprintRules.displayName} specifies (expected: ${rules.channels.map((c) => c.id).join(' → ')}).`,
      `Reorder the channels on the socials page to: ${rules.channels.map((c) => c.id).join(' → ')}.`,
      socialsFile.path,
    ));
  }

  if (rules.strapline) {
    const straplineNorm = rules.strapline.toLowerCase().replace(/\s+/g, ' ').trim();
    if (!normalised.includes(straplineNorm)) {
      issues.push(buildIssue(
        'PRH-SOCIALS-STRAPLINE-MISSING',
        `Socials page is missing the ${input.imprintRules.displayName} strapline: "${rules.strapline}".`,
        `Add the strapline near the foot of the socials page: "${rules.strapline}".`,
        socialsFile.path,
      ));
    }
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

interface XhtmlFile {
  path: string;
  content: string;
}

/**
 * Locate the socials XHTML. Preference order:
 *   1. <body epub:type="backmatter"> with a known socials filename hint
 *      (follow_penguin, vin_endpage_socials, saga_socials, etc.).
 *   2. <body epub:type="backmatter"> that contains at least one of the
 *      canonical channel URL prefixes (twitter.com / facebook.com /
 *      instagram.com etc.) — fingerprint match.
 *   3. Filename heuristic alone (`*socials*.xhtml`, `follow_*.xhtml`).
 *
 * Imprint-specific filename hints help disambiguate when multiple
 * backmatter files contain channel URLs (e.g. an author bio that links
 * to twitter shouldn't count as the "socials page").
 */
function findSocialsXhtml(
  files: PrhPerXhtmlInput['xhtmlFiles'],
  imprintId: string,
): XhtmlFile | null {
  const filenameHint = SOCIALS_FILENAME_HINT[imprintId];

  if (filenameHint) {
    for (const f of files) {
      if (filenameHint.test(f.path) && isBackmatter(f.content)) {
        return f;
      }
    }
  }

  // Fingerprint match: backmatter file with channel URL prefixes.
  for (const f of files) {
    if (!isBackmatter(f.content)) continue;
    const text = f.content.toLowerCase();
    let matched = 0;
    for (const prefix of Object.values(CHANNEL_URL_PREFIX)) {
      if (prefix.length > 0 && text.includes(prefix)) matched += 1;
    }
    // Two or more channel-URL prefixes makes this likely a socials
    // page rather than e.g. an author bio with a single twitter link.
    if (matched >= 2) return f;
  }

  // Filename fallback: anything that looks like a socials page.
  for (const f of files) {
    if (/(?:^|\/)(?:follow[_-][\w-]+|[\w-]*socials[\w-]*)\.x?html?$/i.test(f.path)) {
      return f;
    }
  }

  return null;
}

/** Per-imprint filename hint for the socials page. */
const SOCIALS_FILENAME_HINT: Record<string, RegExp> = {
  penguin: /(?:^|\/)follow_penguin(?:_ya)?\.x?html?$/i,
  vintage: /(?:^|\/)(?:vin_endpage_socials|vintage[_-]?socials)\.x?html?$/i,
  'cornerstone-saga': /(?:^|\/)(?:saga[_-]?socials|pennystreet[_-]?socials)\.x?html?$/i,
};

function isBackmatter(html: string): boolean {
  return /<body\b[^>]*\bepub:type\s*=\s*["'][^"']*\bbackmatter\b/i.test(html);
}

/**
 * Lowercase + whitespace-collapse normalised view of the socials page.
 * Differs from the copyright-page normaliser in one critical way: we
 * pull `href` URL values out of `<a>` tags BEFORE stripping the tags.
 * Without that step, a markup-correct socials page like
 *   <a href="https://twitter.com/penguinukbooks">Twitter @penguinukbooks</a>
 * would lose the URL during tag-strip and silently fail the
 * channel-handle check (the visible text typically reads "Twitter"
 * rather than the full URL).
 *
 * Strategy: collect every `href="…"` value, append them to the visible
 * text with separating whitespace, then run the standard
 * tag-strip / whitespace-collapse / lowercase pipeline.
 */
function normaliseSocialsText(html: string): string {
  // Inline-substitute each <a href="X">Y</a> into ` X Y ` so the URL
  // appears in document order (right where the link sat). Appending
  // hrefs at the end of the string would break the channel-order
  // check, because a URL that originally sat at position N would end
  // up at position end-of-document.
  const hrefInlined = html.replace(
    /<a\b[^>]*\bhref\s*=\s*["']([^"']*)["'][^>]*>/gi,
    ' $1 ',
  );
  return hrefInlined
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&#x?[0-9a-f]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Locate a channel's first match position in the normalised text.
 * Preference order:
 *   1. Channel-specific `detector` regex (used by Vintage to
 *      disambiguate three @vintagebooks channels).
 *   2. URL prefix (`twitter.com/` etc.) — used when the channel's
 *      canonical handle is a URL.
 *   3. Bare handle substring — used for newsletter or @-only handles
 *      with no URL prefix.
 *
 * Returns -1 when none of these are present in the text.
 *
 * IMPORTANT: this function decides BOTH "is the channel present?" AND
 * "where in the page is it?" — so a channel with a `detector` is
 * considered missing whenever the detector regex fails, even if the
 * bare handle string happens to appear elsewhere in the page (e.g. a
 * stray @vintagebooks mention in body copy). That stricter rule is
 * intentional: detectors exist precisely to disambiguate ambiguous
 * handles.
 */
function findChannelIndex(channel: SocialChannel, normalised: string): number {
  if (channel.detector) {
    const m = channel.detector.exec(normalised);
    return m ? m.index : -1;
  }
  const prefix = CHANNEL_URL_PREFIX[channel.id].toLowerCase();
  if (prefix.length > 0) {
    // For URL-shaped handles, look for the canonical handle first
    // (so HANDLE-WRONG can still distinguish present-with-wrong-handle
    // from genuinely-missing). The handle match takes precedence; the
    // prefix-only check is the fallback decided by the caller.
    const handleIdx = normalised.indexOf(channel.handle.toLowerCase());
    if (handleIdx >= 0) return handleIdx;
    return -1;
  }
  // Newsletter (no URL prefix) — handle IS the substring.
  const idx = normalised.indexOf(channel.handle.toLowerCase());
  return idx;
}

/** True when the indices are strictly increasing. Used for the channel-order check. */
function isOrderMonotonic(indices: number[]): boolean {
  for (let i = 1; i < indices.length; i += 1) {
    if (indices[i] <= indices[i - 1]) return false;
  }
  return true;
}

/**
 * Detects the Penguin YA-variant filename.
 * `follow_penguin_ya.xhtml` is documented in Branding Guide §6 as the
 * cut-down socials page with 3 channels instead of 7.
 */
function isPenguinYaFile(path: string): boolean {
  return /(?:^|\/)follow_penguin_ya\.x?html?$/i.test(path);
}

function buildIssue(
  code: keyof typeof PRH_ISSUE_CODES,
  message: string,
  suggestion: string,
  location: string,
): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES[code];
  return {
    code,
    severity: def.severity,
    wcag: def.wcag,
    message: `${def.summary}: ${message}`,
    suggestion,
    location,
  };
}
