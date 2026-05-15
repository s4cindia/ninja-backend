/**
 * PRH UK long-description-inline validator (P6/PR6).
 *
 * Per the Technical Guide, LONG descriptions of complex images
 * (charts, schematics, infographics that need a paragraph or more
 * to describe) should live in a NON-LINEAR XHTML appendix — a
 * `<basename>_longdesc<N>.xhtml` file marked `linear="no"` in the
 * spine, linked from the figure via `aria-describedby`. Short
 * captions and brief context belong inline in `<figcaption>`; long
 * descriptions inline clutter the reading flow and add scroll
 * weight, especially on Kindle ET.
 *
 * One detect-only rule:
 *   - PRH-FIGURE-LONG-DESC-INLINE — a `<figcaption>` whose text
 *     content reaches the long-description threshold. Operators
 *     review and decide; the actual non-linear-XHTML refactor is
 *     deferred until tenant demand surfaces.
 *
 * Aggregated per file (one issue per file with an occurrence count)
 * to match the other PRH markup validators.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { PrhValidatorIssue, PrhPerXhtmlInput } from './types';

/**
 * Character threshold above which a figcaption is considered a "long
 * description" candidate. Aligned with the P6 implementation plan's
 * 250-char target — short enough to catch genuine multi-sentence
 * descriptions while leaving normal captions ("Fig. 3. The Eiffel
 * Tower, 1889.") untouched.
 */
const LONG_DESC_CHAR_THRESHOLD = 250;

export function validatePrhLongDescriptionInline(input: PrhPerXhtmlInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  for (const file of input.xhtmlFiles) {
    const body = stripComments(stripHead(file.content));
    const captions = extractFigcaptionTexts(body);
    if (captions.length === 0) continue;

    const longCount = captions.filter((text) => text.length >= LONG_DESC_CHAR_THRESHOLD).length;
    if (longCount > 0) {
      issues.push(
        buildIssue(
          'PRH-FIGURE-LONG-DESC-INLINE',
          file.path,
          ` (${longCount} figcaption(s) at or above the ${LONG_DESC_CHAR_THRESHOLD}-char threshold)`,
        ),
      );
    }
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

function stripHead(html: string): string {
  return html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, '');
}

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Extract the plain-text content of every `<figcaption>` element.
 * Depth-counted balanced matching on `<figcaption>` so nested same-tag
 * children (rare but possible) don't truncate early; text length is
 * measured after stripping ALL child tags so a description wrapped in
 * `<p>` and `<span>` is still counted by its visible text length.
 */
function extractFigcaptionTexts(body: string): string[] {
  const out: string[] = [];
  const openRe = /<figcaption\b[^>]*>/gi;
  let m: RegExpExecArray | null;
  while ((m = openRe.exec(body)) !== null) {
    // Self-closing <figcaption/> has no text and is malformed XHTML;
    // skip it rather than count zero text.
    if (m[0].trimEnd().endsWith('/>')) continue;
    const close = findBalancedClose(body, 'figcaption', openRe.lastIndex);
    if (!close) continue;
    const inner = body.slice(openRe.lastIndex, close.innerEnd);
    const text = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    out.push(text);
  }
  return out;
}

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
  code: 'PRH-FIGURE-LONG-DESC-INLINE',
  location: string,
  detail = '',
): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES[code];
  return {
    code,
    severity: def.severity,
    wcag: def.wcag,
    message: `${def.summary}: ${location}${detail}`,
    suggestion:
      'Move the long description into a separate non-linear XHTML file (e.g. <basename>_longdesc1.xhtml, declared with linear="no" in the spine) and link from the figure via aria-describedby. Keep the inline <figcaption> short (caption only).',
    location,
  };
}
