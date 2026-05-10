/**
 * PRH UK per-XHTML validator.
 *
 * Two checks per XHTML file:
 *
 *   PRH-XHTML-XML-LANG               — every <html> must carry BOTH `lang`
 *                                       AND `xml:lang` attributes (existing
 *                                       EPUB-SEM-001 only requires `lang`).
 *   PRH-XHTML-TITLE-EMPTY-OR-GENERIC — <head><title> must be present,
 *                                       non-empty, and not just the book
 *                                       title (per the Technical Guide
 *                                       guidance: "Chapter 7, 1Q84
 *                                       Volume 3" rather than just "1Q84").
 *
 * Both checks emit one issue per offending file so the operator can locate
 * the broken XHTML quickly. The summaryBySource counter rolls up totals.
 */

import { PRH_ISSUE_CODES } from '../../../../../constants/prh-issue-codes';
import type { PrhPerXhtmlInput, PrhValidatorIssue } from './types';

export function validatePrhPerXhtml(input: PrhPerXhtmlInput): PrhValidatorIssue[] {
  const issues: PrhValidatorIssue[] = [];
  const bookTitle = input.bookTitle?.trim().toLowerCase() ?? null;

  for (const file of input.xhtmlFiles) {
    // ── 1. <html> must carry both lang AND xml:lang ─────────────────────
    const htmlOpenMatch = file.content.match(/<html\b([^>]*)>/i);
    if (htmlOpenMatch) {
      const attrs = htmlOpenMatch[1];
      // Require start-of-attrs or whitespace before `lang` so the bare
      // `lang` inside `xml:lang` doesn't trip the check (the colon counts
      // as a word boundary, so a naive `\blang` matches both attribute
      // names — a real bug surfaced by tests).
      const hasLang = /(?:^|\s)lang\s*=\s*["'][^"']+["']/i.test(attrs);
      const hasXmlLang = /\bxml:lang\s*=\s*["'][^"']+["']/i.test(attrs);
      if (!hasLang || !hasXmlLang) {
        const reasons: string[] = [];
        if (!hasLang) reasons.push('lang');
        if (!hasXmlLang) reasons.push('xml:lang');
        issues.push(
          buildIssue('PRH-XHTML-XML-LANG', file.path, {
            message: `<html> is missing required attribute(s): ${reasons.join(', ')}`,
            suggestion: `Add to the <html> element: ${reasons.map((r) => `${r}="en"`).join(' ')} (use the appropriate ISO 639-1 code for this book's language)`,
          }),
        );
      }
    }

    // ── 2. <head><title> must be specific, not the book title alone ────
    const titleValue = extractHeadTitle(file.content);
    if (titleValue == null) {
      issues.push(
        buildIssue('PRH-XHTML-TITLE-EMPTY-OR-GENERIC', file.path, {
          message: '<head><title> is missing or empty',
          suggestion: 'Set <title> to a chapter or section identifier (e.g. "Chapter 7, [Book Title]")',
        }),
      );
    } else if (bookTitle && titleValue.trim().toLowerCase() === bookTitle) {
      issues.push(
        buildIssue('PRH-XHTML-TITLE-EMPTY-OR-GENERIC', file.path, {
          message: `<title> is just the book title ("${titleValue.trim()}"); PRH expects a chapter/section identifier`,
          suggestion: `Update <title> to include a chapter or section identifier (e.g. "Chapter 7, ${titleValue.trim()}")`,
        }),
      );
    }
  }

  return issues;
}

// ── helpers ──────────────────────────────────────────────────────────────

/** Pull the inner text of the first `<title>` element inside `<head>`. */
function extractHeadTitle(content: string): string | null {
  const headMatch = content.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i);
  if (!headMatch) return null;
  const titleMatch = headMatch[1].match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!titleMatch) return null;
  const inner = titleMatch[1].trim();
  return inner.length === 0 ? null : inner;
}

function buildIssue(
  code: keyof typeof PRH_ISSUE_CODES,
  location: string,
  parts: { message: string; suggestion: string },
): PrhValidatorIssue {
  const def = PRH_ISSUE_CODES[code];
  return {
    code,
    severity: def.severity,
    wcag: def.wcag,
    message: parts.message,
    suggestion: parts.suggestion,
    location,
  };
}
