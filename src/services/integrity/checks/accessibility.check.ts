/**
 * Accessibility Check (Alt Text + Table Structure)
 *
 * ALT_TEXT:
 * - img with no alt attribute → ERROR
 * - alt matches a filename pattern → ERROR
 * - alt starts with "image of"/"photo of" → WARNING
 * - alt too short (<5 chars, non-empty) → WARNING
 * - figure with img but no figcaption → SUGGESTION
 *
 * TABLE_STRUCTURE:
 * - No <th> in a data table → ERROR
 * - <th> without scope → WARNING
 * - Complex table without <caption> → SUGGESTION
 * - Empty <th> text → ERROR
 */

import { loadHtml } from '../rules/html-parser';
import type { CheckResult } from './figure-table-ref.check';

const FILENAME_PATTERN = /\.(jpe?g|png|gif|svg|bmp|webp|tiff?|ico)$/i;
const REDUNDANT_ALT_PREFIX = /^(image of|photo of|picture of|graphic of|icon of)\b/i;

export function checkAccessibility(_text: string, html: string): CheckResult {
  const issues: CheckResult['issues'] = [];
  const $ = loadHtml(html);

  if (!$) {
    return {
      checkType: 'ACCESSIBILITY',
      issues: [],
      metadata: { totalImages: 0, imagesMissingAlt: 0, totalTables: 0, tablesMissingHeaders: 0, skipped: true },
    };
  }

  // ── Alt Text Checks ──────────────────────────────────────────

  let totalImages = 0;
  let imagesMissingAlt = 0;

  $('img').each((_i, el) => {
    totalImages++;
    const alt = $(el).attr('alt');

    if (alt === undefined || alt === null) {
      imagesMissingAlt++;
      issues.push({
        checkType: 'ALT_TEXT',
        severity: 'ERROR',
        title: 'Image missing alt attribute',
        description: 'An image element has no alt attribute. All images must have alt text for accessibility.',
        originalText: $(el).attr('src') || '<img>',
        suggestedFix: 'Add a descriptive alt attribute to the image.',
      });
      return;
    }

    const trimmedAlt = alt.trim();

    if (FILENAME_PATTERN.test(trimmedAlt)) {
      issues.push({
        checkType: 'ALT_TEXT',
        severity: 'ERROR',
        title: 'Alt text appears to be a filename',
        description: `Alt text "${trimmedAlt}" looks like a filename, not a description.`,
        originalText: trimmedAlt,
        suggestedFix: 'Replace the filename with a meaningful description of the image content.',
      });
      return;
    }

    if (REDUNDANT_ALT_PREFIX.test(trimmedAlt)) {
      issues.push({
        checkType: 'ALT_TEXT',
        severity: 'WARNING',
        title: 'Alt text has redundant prefix',
        description: `Alt text starts with a redundant phrase: "${trimmedAlt.slice(0, 30)}..."`,
        originalText: trimmedAlt,
        suggestedFix: 'Remove "image of"/"photo of" prefix — screen readers already announce it as an image.',
      });
    }

    if (trimmedAlt.length > 0 && trimmedAlt.length < 5) {
      issues.push({
        checkType: 'ALT_TEXT',
        severity: 'WARNING',
        title: 'Alt text is very short',
        description: `Alt text "${trimmedAlt}" is only ${trimmedAlt.length} characters. Consider providing more detail.`,
        originalText: trimmedAlt,
        suggestedFix: 'Provide a more descriptive alt text (at least 5 characters).',
      });
    }
  });

  // Figures with images but no figcaption
  $('figure').each((_i, el) => {
    const hasImg = $(el).find('img').length > 0;
    const hasFigcaption = $(el).find('figcaption').length > 0;
    if (hasImg && !hasFigcaption) {
      issues.push({
        checkType: 'ALT_TEXT',
        severity: 'SUGGESTION',
        title: 'Figure without figcaption',
        description: 'A <figure> element contains an image but has no <figcaption>.',
        suggestedFix: 'Add a <figcaption> element to provide a visible caption for the figure.',
      });
    }
  });

  // ── Table Structure Checks ───────────────────────────────────

  let totalTables = 0;
  let tablesMissingHeaders = 0;

  $('table').each((_i, el) => {
    const rows = $(el).find('tr');
    const cols = $(el).find('tr:first-child td, tr:first-child th').length;

    // Skip layout tables: single row or single column heuristic
    if (rows.length <= 1 || cols <= 1) return;

    totalTables++;
    const thElements = $(el).find('th');

    if (thElements.length === 0) {
      tablesMissingHeaders++;
      issues.push({
        checkType: 'TABLE_STRUCTURE',
        severity: 'ERROR',
        title: 'Data table missing header cells',
        description: 'A data table has no <th> elements. Tables must use <th> for header cells.',
        suggestedFix: 'Mark the first row or column cells as <th> instead of <td>.',
      });
      return;
    }

    // Check for empty th
    thElements.each((_j, th) => {
      const thText = $(th).text().trim();
      if (!thText) {
        issues.push({
          checkType: 'TABLE_STRUCTURE',
          severity: 'ERROR',
          title: 'Empty table header cell',
          description: 'A <th> element has no text content.',
          suggestedFix: 'Add descriptive text to the header cell.',
        });
      }
    });

    // Check th without scope
    thElements.each((_j, th) => {
      if (!$(th).attr('scope')) {
        issues.push({
          checkType: 'TABLE_STRUCTURE',
          severity: 'WARNING',
          title: 'Table header missing scope attribute',
          description: 'A <th> element does not have a scope attribute (row/col).',
          suggestedFix: 'Add scope="col" or scope="row" to each <th> element.',
        });
      }
    });

    // Complex table without caption
    const isComplex = cols > 4 || rows.length > 5;
    const hasCaption = $(el).find('caption').length > 0;
    if (isComplex && !hasCaption) {
      issues.push({
        checkType: 'TABLE_STRUCTURE',
        severity: 'SUGGESTION',
        title: 'Complex table without caption',
        description: `A table with ${rows.length} rows and ${cols} columns has no <caption> element.`,
        suggestedFix: 'Add a <caption> element to describe the table content.',
      });
    }
  });

  return {
    checkType: 'ACCESSIBILITY',
    issues,
    metadata: {
      totalImages,
      imagesMissingAlt,
      totalTables,
      tablesMissingHeaders,
    },
  };
}
