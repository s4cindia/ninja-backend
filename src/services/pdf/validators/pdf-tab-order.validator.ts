/**
 * PDF Tab Order Validator
 *
 * Matterhorn 28-008 ("A page containing an annotation does not contain a
 * Tabs entry", UA1:7.18.3-1) / PDF32000-1:2008 §12.5, §14.8.4.2. Confirmed
 * real via a live PAC 2026 report on Karsaklian_189165_9781606497623.pdf
 * (2026-11-09): of 190 pages, exactly 8 have any /Annots at all (links/form
 * fields), and all 8 are missing /Tabs entirely -- never /R or /C, just
 * absent. A page with annotations but no /Tabs=/S leaves keyboard/screen-
 * reader tab order undefined or viewer-dependent instead of following the
 * page's own structure-tree reading order, the PDF/UA-required behavior.
 *
 * This checkpoint was previously catalog data only (src/data/
 * matterhorn-1.1.data.ts) -- never validated anywhere in this codebase.
 * struct-tree-builder.ts (Seam C) already sets /Tabs = /S unconditionally
 * on every page, but only as part of its own from-scratch structure-tree
 * rebuild for untagged PDFs -- never reached for an already-tagged document
 * like this one.
 */

import { PDFName, PDFArray, PDFRef } from 'pdf-lib';
import { AuditIssue } from '../../audit/base-audit.service';
import { ParsedPDF } from '../pdf-parser.service';
import { logger } from '../../../lib/logger';

export interface TabOrderValidationResult {
  issues: AuditIssue[];
  metadata: {
    pagesWithAnnotations: number;
    pagesMissingTabOrder: number;
  };
}

class PdfTabOrderValidator {
  private issueCounter = 0;

  async validate(parsedPdf: ParsedPDF): Promise<TabOrderValidationResult> {
    this.issueCounter = 0;
    const doc = parsedPdf.pdfLibDoc;
    const issues: AuditIssue[] = [];
    let pagesWithAnnotations = 0;

    const pages = doc.getPages();
    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      const pageNumber = i + 1;

      const annotsRaw = page.node.get(PDFName.of('Annots'));
      const annots = annotsRaw instanceof PDFRef ? doc.context.lookup(annotsRaw) : annotsRaw;
      if (!(annots instanceof PDFArray) || annots.size() === 0) continue;
      pagesWithAnnotations++;

      const tabsRaw = page.node.get(PDFName.of('Tabs'));
      const tabsName = tabsRaw?.toString();
      if (tabsName === '/S') continue; // already correct

      issues.push({
        id: `tab-order-${++this.issueCounter}`,
        source: 'pdf-tab-order',
        severity: 'moderate',
        code: 'TAB-ORDER-NOT-STRUCTURE',
        message: `Page ${pageNumber} has ${annots.size()} annotation(s) but its own /Tabs entry is ` +
          `${tabsRaw === undefined ? 'missing' : `set to ${tabsName}`}, not /S (structure) -- tab order is ` +
          'undefined or viewer-dependent instead of following reading order',
        wcagCriteria: ['2.4.3'],
        location: `Page ${pageNumber}`,
        suggestion: "Set the page's own /Tabs entry to /S so keyboard/screen-reader tab order follows the structure tree's reading order.",
        category: 'structure',
        pageNumber,
        // 28-008 ("does not contain a Tabs entry") vs 28-009 ("has a Tabs
        // entry with a value other than S") -- distinct Matterhorn
        // checkpoints for the two distinct shapes, even though this
        // document's own 8 real cases are all the missing-entirely (28-008)
        // shape.
        matterhornCheckpoint: tabsRaw === undefined ? '28-008' : '28-009',
        matterhornHow: 'M',
      });
    }

    logger.info(
      `[PdfTabOrderValidator] ${pagesWithAnnotations} page(s) with annotations, ${issues.length} missing /Tabs=/S`
    );

    return {
      issues,
      metadata: { pagesWithAnnotations, pagesMissingTabOrder: issues.length },
    };
  }
}

export const pdfTabOrderValidator = new PdfTabOrderValidator();
