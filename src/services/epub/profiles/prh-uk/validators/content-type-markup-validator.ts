/**
 * PRH UK content-type markup validator (P6/PR5).
 *
 * Per Technical Guide §§ on sidebars / textboxes / floated elements /
 * poetry / speech bubbles / recipes. Each rule is content-type
 * specific — it only activates when the relevant construct is
 * present in the book, so a typical novel trips none of them.
 *
 * Six codes, all detect-only:
 *   - PRH-MARKUP-SIDEBAR-MAINCONTENT-MISSING — a .sidebar_wrapper
 *     without its paired .maincontent_wrapper.
 *   - PRH-MARKUP-TEXTBOX-USES-REAL-HEADER — the document's first
 *     real <h*> lives inside a .txt_box* (corrupts page-heading
 *     order; box headers should use <div class="boxhead">).
 *   - PRH-MARKUP-FLOATBOX-USES-REAL-HEADER — a real <h*> inside a
 *     .floatbox_left / .floatbox_right.
 *   - PRH-MARKUP-POETRY-WRONG-STRUCTURE — a .poetry_stanza using
 *     <p> for its lines instead of <div class="poetry_line">.
 *   - PRH-MARKUP-SPEECHBUBBLE-WRONG-CLASS — a speech-bubble <figure>
 *     with a non-canonical class.
 *   - PRH-MARKUP-METHOD-STEPS-NOT-OL — a numbered run of <p> that
 *     should be an <ol class="method_steps">. Heuristic; only fires
 *     when the book already uses .method_steps elsewhere so legal
 *     "1. The party agrees…" prose doesn't false-flag.
 *
 * Detect-only — the Style Guide explicitly forbids modifying poetry
 * markup without instruction, and sidebar / textbox refactors touch
 * surrounding DOM, so all six defer to operator review.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { PrhValidatorIssue, PrhPerXhtmlInput, PrhXhtmlFile } from './types';

/** Canonical speech-bubble classes (Technical Guide). */
const CANONICAL_SPEECHBUBBLE_CLASSES = new Set([
  'speechbubble',
  'speechbubble_r',
  'speechbubble_bl',
  'speechbubble_br',
]);

/** Minimum .method_steps elements that must exist book-wide before
 *  the numbered-<p> heuristic is allowed to run (cookbook signal). */
const METHOD_STEPS_COOKBOOK_THRESHOLD = 3;

/** Minimum consecutive numbered <p> siblings before the method-steps
 *  heuristic fires. Conservative — short numbered runs are common in
 *  ordinary prose. */
const METHOD_STEPS_MIN_RUN = 3;

export function validatePrhContentTypeMarkup(input: PrhPerXhtmlInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];

  // The method-steps heuristic is gated on a book-wide cookbook
  // signal: it only runs when the EPUB already uses
  // `class="method_steps"` in at least a few places. A book that
  // never uses the canonical markup is assumed NOT to be a recipe
  // book — running the numbered-<p> heuristic there would false-flag
  // ordinary numbered prose (contracts, instructions, lists).
  const methodStepsCount = countMethodStepsElements(input.xhtmlFiles);
  const cookbookSignal = methodStepsCount >= METHOD_STEPS_COOKBOOK_THRESHOLD;

  for (const file of input.xhtmlFiles) {
    // Strip <head> and HTML comments before any regex scan — commented
    // -out markup (`<!-- <h1>… -->`, `<!-- class="method_steps" -->`)
    // is still text to a regex and would otherwise raise false findings
    // or even flip the cookbook heuristic on.
    const body = stripComments(stripHead(file.content));

    // 1. Sidebar / maincontent pairing.
    if (hasSidebarWithoutMaincontentSibling(body)) {
      issues.push(buildIssue('PRH-MARKUP-SIDEBAR-MAINCONTENT-MISSING', file.path));
    }

    // 2. Textbox holding the document's first real heading.
    if (firstRealHeaderIsInsideTextbox(body)) {
      issues.push(buildIssue('PRH-MARKUP-TEXTBOX-USES-REAL-HEADER', file.path));
    }

    // 3. Floatbox containing a real header.
    const floatboxes = findClassedElements(body, (tokens) =>
      tokens.includes('floatbox_left') || tokens.includes('floatbox_right'),
    );
    if (floatboxes.some((el) => REAL_HEADER_REGEX.test(el.inner))) {
      issues.push(buildIssue('PRH-MARKUP-FLOATBOX-USES-REAL-HEADER', file.path));
    }

    // 4. Poetry stanza using <p> for its lines.
    const stanzas = findClassedElements(body, (tokens) => tokens.includes('poetry_stanza'));
    if (stanzas.some((el) => /<p\b/i.test(el.inner))) {
      issues.push(buildIssue('PRH-MARKUP-POETRY-WRONG-STRUCTURE', file.path));
    }

    // 5. Speech-bubble figures with a non-canonical class.
    const badSpeechbubble = findNonCanonicalSpeechbubbleClasses(body);
    if (badSpeechbubble.length > 0) {
      issues.push(
        buildIssue(
          'PRH-MARKUP-SPEECHBUBBLE-WRONG-CLASS',
          file.path,
          ` (non-canonical class(es): ${badSpeechbubble.join(', ')})`,
        ),
      );
    }

    // 6. Numbered <p> run that should be an <ol class="method_steps">.
    //    Gated on the book-wide cookbook signal.
    if (cookbookSignal && hasNumberedParagraphRun(body)) {
      issues.push(buildIssue('PRH-MARKUP-METHOD-STEPS-NOT-OL', file.path));
    }
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Real heading tags h1-h6. Used both as a test and to locate the
 *  first heading in a document. */
const REAL_HEADER_REGEX = /<h[1-6]\b/i;

function stripHead(html: string): string {
  return html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/i, '');
}

function stripComments(html: string): string {
  return html.replace(/<!--[\s\S]*?-->/g, '');
}

/**
 * Count occurrences of a specific class TOKEN across the HTML. We
 * match `class="…"` attributes and split into whitespace-separated
 * tokens so `class="foo sidebar_wrapper bar"` counts once, and
 * `data-sidebar_wrapper` / partial substrings never match.
 */
function countClassTokenOccurrences(html: string, token: string): number {
  let count = 0;
  for (const m of html.matchAll(/(?:^|\s)class\s*=\s*["']([^"']*)["']/gi)) {
    const tokens = m[1].split(/\s+/).filter(Boolean);
    if (tokens.includes(token)) count++;
  }
  return count;
}

/**
 * Structural sidebar-pairing check. PRH requires the
 * `.maincontent_wrapper` to be the IMMEDIATE sibling of each
 * `.sidebar_wrapper` — a count comparison isn't enough, because a
 * file can have equal totals while individual sidebars are still
 * unpaired (the main-content wrapper sits in an unrelated section).
 *
 * For each `.sidebar_wrapper` element we look at what immediately
 * follows its closing tag, skipping whitespace and comments, and
 * confirm the next element carries `maincontent_wrapper`. Any
 * sidebar that fails — including one with nothing after it —
 * triggers the finding.
 */
function hasSidebarWithoutMaincontentSibling(body: string): boolean {
  const sidebars = findClassedElements(body, (tokens) => tokens.includes('sidebar_wrapper'));
  for (const sidebar of sidebars) {
    const tail = body.slice(sidebar.end);
    const nextElement = tail.match(/^\s*(?:<!--[\s\S]*?-->\s*)*<([a-z][a-z0-9]*)\b([^>]*)>/i);
    if (!nextElement) return true;
    const classMatch = nextElement[2].match(/(?:^|\s)class\s*=\s*["']([^"']*)["']/i);
    const tokens = classMatch ? classMatch[1].split(/\s+/).filter(Boolean) : [];
    if (!tokens.includes('maincontent_wrapper')) return true;
  }
  return false;
}

/**
 * Locate the document's first real <h*> heading and report whether
 * it sits inside a `.txt_box*` element. The "first heading" framing
 * matches the Technical Guide rule — a real header inside a textbox
 * is only a problem when it would be the first heading the reading
 * system encounters and thus corrupt page-heading order. A real
 * header inside a textbox LATER in the doc (after a legitimate
 * chapter heading) is permitted for very long boxes.
 */
function firstRealHeaderIsInsideTextbox(body: string): boolean {
  const headerMatch = body.match(REAL_HEADER_REGEX);
  if (!headerMatch || headerMatch.index === undefined) return false;
  const headerIndex = headerMatch.index;

  const textboxes = findClassedElements(body, (tokens) =>
    tokens.some((t) => t.startsWith('txt_box')),
  );
  return textboxes.some((el) => headerIndex >= el.start && headerIndex < el.end);
}

/**
 * Find `<figure>` elements carrying a class token that looks like a
 * speech bubble (`speech-bubble`, `speech_bubble`, `speechbubble`,
 * `speechbubble_left`, …) but is NOT one of the four canonical
 * classes. Returns the offending tokens, deduped.
 *
 * Scoped to `<figure>` deliberately — PRH speech bubbles are always
 * `<figure>` elements, so a CSS-helper class on a `<div>`/`<p>` (or
 * a wrapper named `speechbubble_styles`) must not false-flag.
 */
function findNonCanonicalSpeechbubbleClasses(html: string): string[] {
  const bad = new Set<string>();
  for (const m of html.matchAll(/<figure\b([^>]*)>/gi)) {
    const classMatch = m[1].match(/(?:^|\s)class\s*=\s*["']([^"']*)["']/i);
    if (!classMatch) continue;
    const tokens = classMatch[1].split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      if (!/speech[-_]?bubble/i.test(token)) continue;
      if (!CANONICAL_SPEECHBUBBLE_CLASSES.has(token)) {
        bad.add(token);
      }
    }
  }
  return [...bad].sort();
}

/** Count elements anywhere in the book carrying `class="…method_steps…"`.
 *  Comments + <head> stripped first so a commented-out method_steps
 *  reference can't flip the cookbook heuristic on. */
function countMethodStepsElements(files: PrhXhtmlFile[]): number {
  let total = 0;
  for (const file of files) {
    total += countClassTokenOccurrences(
      stripComments(stripHead(file.content)),
      'method_steps',
    );
  }
  return total;
}

/**
 * Detect a run of >= METHOD_STEPS_MIN_RUN consecutive `<p>` siblings
 * whose trimmed text begins with a `N.` number marker. We walk the
 * `<p>…</p>` elements in document order and track the longest run of
 * consecutively-numbered ones; a non-numbered <p> resets the run.
 *
 * The run only counts paragraphs that are genuine ADJACENT siblings —
 * if any non-whitespace markup sits between two numbered `<p>` tags
 * (e.g. `</div><div>` wrappers, an image, a heading), the run resets.
 * Numbered paragraphs scattered across unrelated sections shouldn't
 * be mistaken for a method-steps list.
 *
 * Conservative by design — short numbered runs (2 items) are common
 * in ordinary prose, and this only runs at all when the book-wide
 * cookbook signal is set.
 */
function hasNumberedParagraphRun(body: string): boolean {
  let run = 0;
  let previousParagraphEnd: number | null = null;
  for (const m of body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)) {
    if (previousParagraphEnd !== null) {
      const between = body.slice(previousParagraphEnd, m.index).trim();
      if (between !== '') run = 0;
    }
    const text = stripTags(m[1]).trim();
    if (/^\d+\./.test(text)) {
      run++;
      if (run >= METHOD_STEPS_MIN_RUN) return true;
    } else {
      run = 0;
    }
    previousParagraphEnd = m.index + m[0].length;
  }
  return false;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '');
}

/**
 * Find every element whose `class` attribute satisfies `classTest`,
 * returning the element's inner HTML plus the start/end offsets of
 * the full outer element. Balanced matching is done on the element's
 * OWN tag name with a depth counter, so a nested same-tag child
 * doesn't truncate the region early.
 *
 * Self-closing tags and void elements are skipped — they can't
 * contain content, so they're irrelevant to every caller here.
 */
function findClassedElements(
  html: string,
  classTest: (tokens: string[]) => boolean,
): Array<{ tag: string; inner: string; start: number; end: number }> {
  const results: Array<{ tag: string; inner: string; start: number; end: number }> = [];
  const openTagRe = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = openTagRe.exec(html)) !== null) {
    const tag = m[1].toLowerCase();
    const attrs = m[2];
    if (attrs.trimEnd().endsWith('/')) continue; // self-closing
    const classMatch = attrs.match(/(?:^|\s)class\s*=\s*["']([^"']*)["']/i);
    if (!classMatch) continue;
    const tokens = classMatch[1].split(/\s+/).filter(Boolean);
    if (!classTest(tokens)) continue;

    const openTagEnd = openTagRe.lastIndex;
    const close = findBalancedClose(html, tag, openTagEnd);
    if (close === null) continue;
    results.push({
      tag,
      inner: html.slice(openTagEnd, close.innerEnd),
      start: m.index,
      end: close.outerEnd,
    });
  }
  return results;
}

/**
 * Given the index just past an opening `<tag …>`, walk forward
 * counting same-tag opens / closes and return the inner-end (just
 * before the matching `</tag>`) and outer-end (just past it). Returns
 * null when the element is unbalanced (malformed HTML) — callers
 * simply skip such elements rather than guessing.
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
    | 'PRH-MARKUP-SIDEBAR-MAINCONTENT-MISSING'
    | 'PRH-MARKUP-TEXTBOX-USES-REAL-HEADER'
    | 'PRH-MARKUP-FLOATBOX-USES-REAL-HEADER'
    | 'PRH-MARKUP-POETRY-WRONG-STRUCTURE'
    | 'PRH-MARKUP-SPEECHBUBBLE-WRONG-CLASS'
    | 'PRH-MARKUP-METHOD-STEPS-NOT-OL',
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
    case 'PRH-MARKUP-SIDEBAR-MAINCONTENT-MISSING':
      return 'Wrap the main content in <div class="maincontent_wrapper"> as the immediate sibling of each <div class="sidebar_wrapper">. Multiple pairs each go inside their own <section>.';
    case 'PRH-MARKUP-TEXTBOX-USES-REAL-HEADER':
      return 'Replace the real <h*> at the start of the textbox with <div class="boxhead"> so the page-level heading order is preserved.';
    case 'PRH-MARKUP-FLOATBOX-USES-REAL-HEADER':
      return 'Replace real <h*> headings inside floatboxes with <div class="boxhead"> — real headers inside floated elements corrupt heading-navigation.';
    case 'PRH-MARKUP-POETRY-WRONG-STRUCTURE':
      return 'Mark each poem line as <div class="poetry_line"> (or .poetry_line_indented) inside the .poetry_stanza. Do not change poetry markup without publisher instruction — flag for review.';
    case 'PRH-MARKUP-SPEECHBUBBLE-WRONG-CLASS':
      return 'Use exactly one of the canonical speech-bubble classes: speechbubble, speechbubble_r, speechbubble_bl, speechbubble_br.';
    case 'PRH-MARKUP-METHOD-STEPS-NOT-OL':
      return 'Convert the numbered paragraph run into <ol class="method_steps"> with one <li> per step so the numbering is semantic and survives reflow.';
    default:
      return '';
  }
}
