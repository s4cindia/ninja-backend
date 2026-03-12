/**
 * PDF Link Text Validator
 *
 * Validates that hyperlinks have descriptive text rather than generic
 * phrases or raw URLs.
 *
 * WCAG 2.4.4 (Link Purpose - In Context) - Level AA
 * WCAG 2.4.9 (Link Purpose - Link Only) - Level AAA
 */

import { AuditIssue } from '../../audit/base-audit.service';
import { PdfParseResult, PdfLink } from '../pdf-comprehensive-parser.service';
import { logger } from '../../../lib/logger';

// Exact-match generic phrases (lower-cased for comparison)
const GENERIC_PHRASES = new Set([
  'click here', 'here', 'read more', 'more', 'this', 'visit',
  'link', 'go', 'see', 'download', 'click', 'open', 'view',
  'access', 'learn more', 'find out more', 'more info', 'more information',
]);

const URL_AS_TEXT_RE = /^https?:\/\/|^www\./i;

class PdfLinkValidator {
  name = 'PdfLinkValidator';
  private issueCounter = 0;

  async validate(parsed: PdfParseResult): Promise<AuditIssue[]> {
    logger.info('[PdfLinkValidator] Starting link text validation...');
    this.issueCounter = 0;
    const issues: AuditIssue[] = [];

    for (const page of parsed.pages) {
      for (const link of page.links) {
        const issue = this.checkLink(link, page.pageNumber, page.width, page.height);
        if (issue) issues.push(issue);
      }
    }

    logger.info(`[PdfLinkValidator] Found ${issues.length} link text issues`);
    return issues;
  }

  private checkLink(link: PdfLink, pageNumber: number, pageWidth: number, pageHeight: number): AuditIssue | null {
    const text = link.text?.trim() ?? '';

    if (URL_AS_TEXT_RE.test(text)) {
      return this.createIssue(
        pageNumber,
        link,
        'LINK-URL-AS-TEXT',
        `Link text is a raw URL: "${text.substring(0, 80)}"`,
        'Replace the URL with descriptive text that conveys the destination or purpose of the link (e.g., "Visit our accessibility guide" instead of "https://example.com/a11y").',
        'serious',
        pageWidth,
        pageHeight
      );
    }

    if (GENERIC_PHRASES.has(text.toLowerCase())) {
      return this.createIssue(
        pageNumber,
        link,
        'LINK-GENERIC-TEXT',
        `Link text "${text}" is non-descriptive`,
        'Use link text that makes sense out of context. Describe the destination or action (e.g., "Download 2024 Annual Report (PDF)" instead of "click here").',
        'moderate',
        pageWidth,
        pageHeight
      );
    }

    if (link.hasDescriptiveText === false && text.length > 0) {
      return this.createIssue(
        pageNumber,
        link,
        'LINK-NOT-DESCRIPTIVE',
        `Link text "${text.substring(0, 80)}" may not be sufficiently descriptive`,
        'Ensure link text clearly describes the destination or purpose without needing surrounding context.',
        'minor',
        pageWidth,
        pageHeight
      );
    }

    return null;
  }

  private createIssue(
    pageNumber: number,
    link: PdfLink,
    code: string,
    message: string,
    suggestion: string,
    severity: AuditIssue['severity'],
    pageWidth: number = 0,
    pageHeight: number = 0
  ): AuditIssue {
    return {
      id: `link-${++this.issueCounter}`,
      source: 'link-validator',
      severity,
      code,
      message,
      wcagCriteria: ['2.4.4'],
      location: `Page ${pageNumber} at (${Math.round(link.position.x)}, ${Math.round(link.position.y)})`,
      category: 'links',
      suggestion,
      context: link.url ? `Link text: "${link.text}" → ${link.url.substring(0, 120)}` : `Link text: "${link.text}"`,
      pageNumber,
      boundingBox: {
        x: link.position.x,
        y: link.position.y,
        width: link.position.width,
        height: link.position.height,
        pageWidth,
        pageHeight,
      },
    };
  }
}

export const pdfLinkValidator = new PdfLinkValidator();
