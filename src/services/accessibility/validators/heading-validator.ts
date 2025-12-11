import { randomUUID } from 'crypto';
import {
  AccessibilityIssue,
  HeadingInfo,
  HeadingValidationResult,
  ValidatorContext,
} from '../types';

const ISO_639_1_CODES = new Set([
  'aa', 'ab', 'ae', 'af', 'ak', 'am', 'an', 'ar', 'as', 'av', 'ay', 'az',
  'ba', 'be', 'bg', 'bh', 'bi', 'bm', 'bn', 'bo', 'br', 'bs', 'ca', 'ce',
  'ch', 'co', 'cr', 'cs', 'cu', 'cv', 'cy', 'da', 'de', 'dv', 'dz', 'ee',
  'el', 'en', 'eo', 'es', 'et', 'eu', 'fa', 'ff', 'fi', 'fj', 'fo', 'fr',
  'fy', 'ga', 'gd', 'gl', 'gn', 'gu', 'gv', 'ha', 'he', 'hi', 'ho', 'hr',
  'ht', 'hu', 'hy', 'hz', 'ia', 'id', 'ie', 'ig', 'ii', 'ik', 'io', 'is',
  'it', 'iu', 'ja', 'jv', 'ka', 'kg', 'ki', 'kj', 'kk', 'kl', 'km', 'kn',
  'ko', 'kr', 'ks', 'ku', 'kv', 'kw', 'ky', 'la', 'lb', 'lg', 'li', 'ln',
  'lo', 'lt', 'lu', 'lv', 'mg', 'mh', 'mi', 'mk', 'ml', 'mn', 'mr', 'ms',
  'mt', 'my', 'na', 'nb', 'nd', 'ne', 'ng', 'nl', 'nn', 'no', 'nr', 'nv',
  'ny', 'oc', 'oj', 'om', 'or', 'os', 'pa', 'pi', 'pl', 'ps', 'pt', 'qu',
  'rm', 'rn', 'ro', 'ru', 'rw', 'sa', 'sc', 'sd', 'se', 'sg', 'si', 'sk',
  'sl', 'sm', 'sn', 'so', 'sq', 'sr', 'ss', 'st', 'su', 'sv', 'sw', 'ta',
  'te', 'tg', 'th', 'ti', 'tk', 'tl', 'tn', 'to', 'tr', 'ts', 'tt', 'tw',
  'ty', 'ug', 'uk', 'ur', 'uz', 've', 'vi', 'vo', 'wa', 'wo', 'xh', 'yi',
  'yo', 'za', 'zh', 'zu'
]);

export function isValidISO639Code(code: string): boolean {
  if (!code) return false;
  const normalized = code.toLowerCase().split('-')[0].split('_')[0];
  return ISO_639_1_CODES.has(normalized);
}

export function validateHeadingHierarchy(
  headings: HeadingInfo[],
  context: ValidatorContext
): HeadingValidationResult {
  const issues: AccessibilityIssue[] = [];
  let hasH1 = false;
  let hasSkippedLevels = false;
  let hasEmptyHeadings = false;
  let h1Count = 0;

  if (headings.length === 0) {
    issues.push({
      id: randomUUID(),
      wcagCriterion: '1.3.1',
      wcagLevel: 'A',
      severity: 'moderate',
      title: 'No headings found',
      description: 'The document does not contain any headings. Headings help users understand the document structure and navigate content.',
      location: { page: 1 },
      remediation: 'Add heading tags (H1-H6) to structure your document. Start with an H1 for the main title.',
    });
    return { issues, headingOutline: [], hasH1: false, hasSkippedLevels: false, hasEmptyHeadings: false };
  }

  let previousLevel = 0;

  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i];

    if (heading.level === 1) {
      hasH1 = true;
      h1Count++;
    }

    if (heading.isEmpty) {
      hasEmptyHeadings = true;
      issues.push({
        id: randomUUID(),
        wcagCriterion: '1.3.1',
        wcagLevel: 'A',
        severity: 'serious',
        title: 'Empty heading',
        description: `Heading level ${heading.level} on page ${heading.page} is empty or contains only whitespace.`,
        location: {
          page: heading.page,
          element: `H${heading.level}`,
        },
        remediation: 'Add meaningful text content to the heading or remove the empty heading tag.',
      });
    }

    if (previousLevel > 0 && heading.level > previousLevel + 1) {
      hasSkippedLevels = true;
      issues.push({
        id: randomUUID(),
        wcagCriterion: '1.3.1',
        wcagLevel: 'A',
        severity: 'serious',
        title: 'Skipped heading level',
        description: `Heading level jumps from H${previousLevel} to H${heading.level} on page ${heading.page}. Heading text: "${heading.text.substring(0, 50)}${heading.text.length > 50 ? '...' : ''}"`,
        location: {
          page: heading.page,
          element: `H${heading.level}`,
        },
        remediation: `Change this heading to H${previousLevel + 1} or add the missing intermediate heading level(s).`,
      });
    }

    previousLevel = heading.level;
  }

  if (!hasH1) {
    issues.push({
      id: randomUUID(),
      wcagCriterion: '1.3.1',
      wcagLevel: 'A',
      severity: 'serious',
      title: 'Missing H1 heading',
      description: 'The document does not have an H1 heading. Every document should have at least one H1 to identify its main topic.',
      location: { page: 1 },
      remediation: 'Add an H1 heading at the beginning of the document to identify the main topic or title.',
    });
  }

  if (h1Count > 1) {
    issues.push({
      id: randomUUID(),
      wcagCriterion: '1.3.1',
      wcagLevel: 'A',
      severity: 'moderate',
      title: 'Multiple H1 headings',
      description: `The document contains ${h1Count} H1 headings. While not strictly prohibited, a single H1 is generally recommended for the main document title.`,
      location: { page: 1 },
      remediation: 'Consider using a single H1 for the main title and H2 for major sections.',
    });
  }

  const firstHeading = headings[0];
  if (firstHeading && firstHeading.level !== 1) {
    issues.push({
      id: randomUUID(),
      wcagCriterion: '1.3.1',
      wcagLevel: 'A',
      severity: 'moderate',
      title: 'Document does not start with H1',
      description: `The first heading in the document is H${firstHeading.level} instead of H1.`,
      location: {
        page: firstHeading.page,
        element: `H${firstHeading.level}`,
      },
      remediation: 'Start the document with an H1 heading that identifies the main topic.',
    });
  }

  return {
    issues,
    headingOutline: headings,
    hasH1,
    hasSkippedLevels,
    hasEmptyHeadings,
  };
}
