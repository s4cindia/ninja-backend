/**
 * PRH UK audio/video markup validator (P6/PR4).
 *
 * Covers the THREE pure-XHTML-markup rules for embedded media. The
 * codec / bitrate / dimensions rules (H.264-baseline, video
 * dimensions, MP3-256k) are deliberately NOT here — they need
 * ffprobe-grade container parsing, deferred to a follow-up pending a
 * media-inspection dependency decision when audio/video EPUB demand
 * materialises.
 *
 * Three codes, all detect-only:
 *   - PRH-MEDIA-WRAPPER-MISSING — a <video>/<audio> not inside a
 *     <figure class="media_wrapper">.
 *   - PRH-MEDIA-FALLBACK-TEXT-MISSING — a <video>/<audio> with no
 *     fallback text for reading systems that can't play the media
 *     (text content, ignoring <source>/<track> children).
 *   - PRH-MEDIA-INLINE-WIDTH — a <video>/<audio> setting width via a
 *     `width` attribute or inline `style`; PRH wants width in CSS.
 *
 * Each rule only matters when the book actually embeds media, so a
 * typical text-only EPUB trips none of them. One issue per (file,
 * code) with an occurrence count, matching the other PRH validators.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { PrhValidatorIssue, PrhPerXhtmlInput } from './types';

const MEDIA_TAGS = ['video', 'audio'] as const;

/** Child tags that are NOT fallback text — sources / tracks / captions. */
const NON_FALLBACK_CHILD_TAGS = new Set(['source', 'track']);

interface MediaElement {
  tag: 'video' | 'audio';
  /** Raw attribute chunk of the open tag (everything between the tag name and `>`). */
  attrs: string;
  /** Inner HTML between the open and close tag; '' for self-closing. */
  inner: string;
  /** Offset of the `<` of the open tag. */
  start: number;
}

export function validatePrhMediaMarkup(input: PrhPerXhtmlInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  for (const file of input.xhtmlFiles) {
    const body = stripHead(file.content);
    const mediaElements = findMediaElements(body);
    if (mediaElements.length === 0) continue;

    const wrapperSpans = findMediaWrapperSpans(body);

    let wrapperMissing = 0;
    let fallbackMissing = 0;
    let inlineWidth = 0;

    for (const el of mediaElements) {
      if (!isInsideAnySpan(el.start, wrapperSpans)) {
        wrapperMissing++;
      }
      if (!hasFallbackText(el.inner)) {
        fallbackMissing++;
      }
      if (hasInlineWidth(el.attrs)) {
        inlineWidth++;
      }
    }

    if (wrapperMissing > 0) {
      issues.push(buildIssue('PRH-MEDIA-WRAPPER-MISSING', file.path, ` (${wrapperMissing} element(s))`));
    }
    if (fallbackMissing > 0) {
      issues.push(buildIssue('PRH-MEDIA-FALLBACK-TEXT-MISSING', file.path, ` (${fallbackMissing} element(s))`));
    }
    if (inlineWidth > 0) {
      issues.push(buildIssue('PRH-MEDIA-INLINE-WIDTH', file.path, ` (${inlineWidth} element(s))`));
    }
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

function stripHead(html: string): string {
  return html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, '');
}

/**
 * Find every `<video>` / `<audio>` element. Handles both the normal
 * `<video …>…</video>` form (depth-counted balanced close so a nested
 * same-tag element — rare but legal — doesn't truncate early) and the
 * self-closing `<video … />` form (inner = '').
 */
function findMediaElements(body: string): MediaElement[] {
  const out: MediaElement[] = [];
  for (const tag of MEDIA_TAGS) {
    const openRe = new RegExp(`<${tag}\\b([^>]*)>`, 'gi');
    let m: RegExpExecArray | null;
    while ((m = openRe.exec(body)) !== null) {
      const attrs = m[1];
      const start = m.index;
      const openTagEnd = openRe.lastIndex;
      if (attrs.trimEnd().endsWith('/')) {
        // Self-closing: no inner content.
        out.push({ tag, attrs, inner: '', start });
        continue;
      }
      const close = findBalancedClose(body, tag, openTagEnd);
      const inner = close ? body.slice(openTagEnd, close.innerEnd) : '';
      out.push({ tag, attrs, inner, start });
    }
  }
  return out;
}

/**
 * Find the spans of every `<figure>` element carrying the
 * `media_wrapper` class token. Returns `{start, end}` offsets so a
 * media element's position can be tested for containment.
 */
function findMediaWrapperSpans(body: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const openRe = /<figure\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(body)) !== null) {
    const attrs = m[1];
    if (attrs.trimEnd().endsWith('/')) continue; // self-closing figure can't wrap anything
    const classMatch = attrs.match(/(?:^|\s)class\s*=\s*["']([^"']*)["']/i);
    if (!classMatch) continue;
    const tokens = classMatch[1].split(/\s+/).filter(Boolean);
    if (!tokens.includes('media_wrapper')) continue;
    const close = findBalancedClose(body, 'figure', openRe.lastIndex);
    if (close) {
      spans.push({ start: m.index, end: close.outerEnd });
    }
  }
  return spans;
}

function isInsideAnySpan(
  pos: number,
  spans: Array<{ start: number; end: number }>,
): boolean {
  return spans.some((s) => pos >= s.start && pos < s.end);
}

/**
 * Fallback text = any non-whitespace text content of the media
 * element once `<source>` / `<track>` children and ALL other tags are
 * stripped. `<source>`/`<track>` declare the media itself, not a
 * human-readable fallback, so they don't count.
 */
function hasFallbackText(inner: string): boolean {
  if (inner.trim() === '') return false;
  // Drop <source>/<track> elements (both void — no closing tag).
  let stripped = inner;
  for (const childTag of NON_FALLBACK_CHILD_TAGS) {
    stripped = stripped.replace(new RegExp(`<${childTag}\\b[^>]*/?>`, 'gi'), '');
  }
  // Drop every remaining tag, leaving only text.
  stripped = stripped.replace(/<[^>]+>/g, '');
  return stripped.trim().length > 0;
}

/**
 * True when the open-tag attributes set width via a `width` attribute
 * or an inline `style` containing a `width` declaration. The attribute
 * names are anchored on `(?:^|\s)` so `data-width` / `max-width` inside
 * a different attribute don't false-match.
 */
function hasInlineWidth(attrs: string): boolean {
  if (/(?:^|\s)width\s*=/i.test(attrs)) return true;
  const styleMatch = attrs.match(/(?:^|\s)style\s*=\s*["']([^"']*)["']/i);
  if (styleMatch && /(?:^|;)\s*width\s*:/i.test(styleMatch[1])) return true;
  return false;
}

/**
 * Given the index just past an opening `<tag …>`, walk forward
 * counting same-tag opens / closes and return the inner-end (just
 * before the matching `</tag>`) and outer-end (just past it). Returns
 * null for unbalanced markup — callers skip such elements.
 */
function findBalancedClose(
  html: string,
  tag: string,
  fromIndex: number,
): { innerEnd: number; outerEnd: number } | null {
  const tokenRe = new RegExp(`<(/?)${tag}\\b[^>]*>`, 'gi');
  tokenRe.lastIndex = fromIndex;
  let depth = 1;
  let m: RegExpExecArray | null;
  while ((m = tokenRe.exec(html)) !== null) {
    const isClose = m[1] === '/';
    const isSelfClosing = !isClose && m[0].trimEnd().endsWith('/>');
    if (isSelfClosing) continue;
    if (isClose) {
      depth--;
      if (depth === 0) {
        return { innerEnd: m.index, outerEnd: tokenRe.lastIndex };
      }
    } else {
      depth++;
    }
  }
  return null;
}

function buildIssue(
  code:
    | 'PRH-MEDIA-WRAPPER-MISSING'
    | 'PRH-MEDIA-FALLBACK-TEXT-MISSING'
    | 'PRH-MEDIA-INLINE-WIDTH',
  location: string,
  detail = '',
): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES[code];
  return {
    code,
    severity: def.severity,
    wcag: def.wcag,
    message: `${def.summary}: ${location}${detail}`,
    suggestion: suggestionFor(code),
    location,
  };
}

function suggestionFor(code: string): string {
  switch (code) {
    case 'PRH-MEDIA-WRAPPER-MISSING':
      return 'Wrap each <video>/<audio> in <figure class="media_wrapper"> so media has a consistent structural container.';
    case 'PRH-MEDIA-FALLBACK-TEXT-MISSING':
      return 'Add fallback text inside the <video>/<audio> element describing the media — reading systems that cannot play it show this content instead.';
    case 'PRH-MEDIA-INLINE-WIDTH':
      return 'Remove the width attribute / inline style and set media width via a CSS class in your stylesheet.';
    default:
      return '';
  }
}
