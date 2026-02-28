/**
 * Heading Hierarchy Check
 *
 * Validates heading structure (h1–h6) using HTML:
 * - No h1 → ERROR
 * - Multiple h1 → WARNING
 * - Level skip >1 (e.g. h1→h3) → ERROR
 * - Empty heading text → ERROR
 */

import { loadHtml } from '../rules/html-parser';
import type { CheckResult } from './figure-table-ref.check';

export function checkHeadingHierarchy(_text: string, html: string): CheckResult {
  const issues: CheckResult['issues'] = [];
  const $ = loadHtml(html);

  if (!$) {
    return {
      checkType: 'HEADING_HIERARCHY',
      issues: [],
      metadata: { headingsFound: 0, skipped: true, reason: 'No HTML content' },
    };
  }

  const headings: { level: number; text: string; index: number }[] = [];
  const levelDistribution: Record<string, number> = {};

  $('h1, h2, h3, h4, h5, h6').each((i, el) => {
    const tagName = $(el).prop('tagName')?.toLowerCase() || '';
    const level = parseInt(tagName.replace('h', ''), 10);
    const text = $(el).text().trim();

    headings.push({ level, text, index: i });
    const key = `h${level}`;
    levelDistribution[key] = (levelDistribution[key] || 0) + 1;
  });

  if (headings.length === 0) {
    return {
      checkType: 'HEADING_HIERARCHY',
      issues: [],
      metadata: { headingsFound: 0, levelDistribution, maxDepth: 0, hasH1: false },
    };
  }

  const h1Count = headings.filter((h) => h.level === 1).length;

  // No h1 at all
  if (h1Count === 0) {
    issues.push({
      checkType: 'HEADING_HIERARCHY',
      severity: 'ERROR',
      title: 'No H1 heading found',
      description: 'The document has no H1 heading. Every document should have at least one H1.',
      suggestedFix: 'Add an H1 heading as the main document title.',
    });
  }

  // Multiple h1 elements
  if (h1Count > 1) {
    issues.push({
      checkType: 'HEADING_HIERARCHY',
      severity: 'WARNING',
      title: 'Multiple H1 headings found',
      description: `The document has ${h1Count} H1 headings. Most documents should have only one H1.`,
      actualValue: String(h1Count),
      expectedValue: '1',
      suggestedFix: 'Use H1 for the main title only. Demote other H1s to H2 or lower.',
    });
  }

  let previousLevel = 0;
  for (const heading of headings) {
    // Empty heading text
    if (!heading.text) {
      issues.push({
        checkType: 'HEADING_HIERARCHY',
        severity: 'ERROR',
        title: 'Empty heading',
        description: `An H${heading.level} heading has no text content.`,
        actualValue: `h${heading.level} (empty)`,
        suggestedFix: 'Add text content to the heading or remove the empty heading element.',
      });
    }

    // Level skip > 1
    if (previousLevel > 0 && heading.level > previousLevel + 1) {
      issues.push({
        checkType: 'HEADING_HIERARCHY',
        severity: 'ERROR',
        title: 'Heading level skipped',
        description: `Heading jumps from H${previousLevel} to H${heading.level}, skipping H${previousLevel + 1}.`,
        originalText: heading.text || `(empty h${heading.level})`,
        actualValue: `h${heading.level}`,
        expectedValue: `h${previousLevel + 1}`,
        suggestedFix: `Change this to H${previousLevel + 1}, or add the missing intermediate heading level.`,
        context: heading.text ? heading.text.slice(0, 80) : undefined,
      });
    }

    previousLevel = heading.level;
  }

  const maxDepth = Math.max(...headings.map((h) => h.level));

  return {
    checkType: 'HEADING_HIERARCHY',
    issues,
    metadata: {
      headingsFound: headings.length,
      levelDistribution,
      maxDepth,
      hasH1: h1Count > 0,
    },
  };
}
