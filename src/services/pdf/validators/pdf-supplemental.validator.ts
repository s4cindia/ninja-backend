/**
 * PDF Supplemental Validator
 *
 * Implements Matterhorn Protocol 1.1 machine-checkable conditions not covered
 * by other validators:
 *
 *   CP10-001  Form XObject on a page is not mapped to a structure element
 *   CP20-001  OCG dictionary is missing a /Name entry
 *   CP20-002  OCG /Intent entry is not /View, /Design, or an array of both
 *   CP21-001  Embedded file specification is missing both /F and /UF entries
 *   CP25-001  Non-interactive form field (Form structure element) has no accessible name
 *   CP30-001  /OpenAction uses a prohibited action type
 *
 * All conditions carry matterhornHow: 'M' (machine-checkable).
 */

import { PDFDict, PDFName, PDFArray, PDFString } from 'pdf-lib';
import { AuditIssue } from '../../audit/base-audit.service';
import { PdfParseResult, PdfStructureNode } from '../pdf-comprehensive-parser.service';
import { logger } from '../../../lib/logger';

// Action types prohibited by PDF/UA-1 when used as /OpenAction (Matterhorn 30-001)
const PROHIBITED_ACTION_TYPES = new Set(['Launch', 'JavaScript', 'SubmitForm', 'ResetForm', 'ImportData']);

// Valid values for an OCG /Intent entry (Matterhorn 20-002)
const VALID_INTENT_VALUES = new Set(['View', 'Design']);

class PdfSupplementalValidator {
  name = 'PdfSupplementalValidator';
  private issueCounter = 0;

  async validate(parsed: PdfParseResult): Promise<AuditIssue[]> {
    const pdfLibDoc = parsed.parsedPdf?.pdfLibDoc;
    if (!pdfLibDoc) {
      logger.warn('[PdfSupplementalValidator] pdfLibDoc not available — skipping');
      return [];
    }

    logger.info('[PdfSupplementalValidator] Starting supplemental validation...');
    this.issueCounter = 0;
    const issues: AuditIssue[] = [];

    // Resolve document catalog
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const catalog = this.resolveDict(pdfLibDoc.context.trailerInfo.Root as any, pdfLibDoc);
    if (!catalog) {
      logger.warn('[PdfSupplementalValidator] Could not resolve document catalog');
      return [];
    }

    issues.push(...this.checkOpenAction(catalog));
    issues.push(...this.checkOptionalContent(catalog, pdfLibDoc));
    issues.push(...this.checkEmbeddedFiles(catalog, pdfLibDoc));
    issues.push(...this.checkFormXObjects(parsed, pdfLibDoc));
    issues.push(...this.checkNonInteractiveForms(parsed));

    logger.info(`[PdfSupplementalValidator] Found ${issues.length} supplemental issue(s)`);
    return issues;
  }

  // ─── CP30: Actions ───────────────────────────────────────────────────────────

  private checkOpenAction(catalog: PDFDict): AuditIssue[] {
    const openAction = catalog.get(PDFName.of('OpenAction'));
    if (!openAction) return [];

    // OpenAction may be a destination array (page ref, /XYZ fit etc.) — skip those
    if (!(openAction instanceof PDFDict)) return [];

    const actionSubtype = openAction.get(PDFName.of('S'));
    if (!(actionSubtype instanceof PDFName)) return [];

    const actionType = actionSubtype.asString();
    if (!PROHIBITED_ACTION_TYPES.has(actionType)) return [];

    return [
      this.createIssue({
        code: 'MATTERHORN-30-001',
        matterhornCheckpoint: '30-001',
        severity: 'serious',
        message: `Document /OpenAction uses prohibited action type "${actionType}" (PDF/UA forbids Launch, JavaScript, SubmitForm, ResetForm, and ImportData)`,
        location: 'Document Catalog → /OpenAction',
        category: 'structure',
        suggestion:
          'Remove the /OpenAction or replace it with a GoTo action that navigates to a page destination.',
        context: `Prohibited action type: ${actionType}`,
      }),
    ];
  }

  // ─── CP20: Optional Content ──────────────────────────────────────────────────

  private checkOptionalContent(
    catalog: PDFDict,
    pdfLibDoc: import('pdf-lib').PDFDocument
  ): AuditIssue[] {
    const ocPropertiesRaw = catalog.get(PDFName.of('OCProperties'));
    if (!ocPropertiesRaw) return []; // No optional content — skip CP20

    const ocProperties = this.resolveDict(ocPropertiesRaw, pdfLibDoc);
    if (!ocProperties) return [];

    const ocgsEntry = ocProperties.get(PDFName.of('OCGs'));
    if (!(ocgsEntry instanceof PDFArray)) return [];

    const issues: AuditIssue[] = [];
    let ocgIndex = 0;

    for (const ocgRaw of ocgsEntry.asArray()) {
      ocgIndex++;
      const ocg = this.resolveDict(ocgRaw, pdfLibDoc);
      if (!ocg) continue;

      // 20-001: /Name must exist and be a text string
      const nameEntry = ocg.get(PDFName.of('Name'));
      if (!nameEntry || !(nameEntry instanceof PDFString)) {
        issues.push(
          this.createIssue({
            code: 'MATTERHORN-20-001',
            matterhornCheckpoint: '20-001',
            severity: 'moderate',
            message: `Optional content group #${ocgIndex} is missing a /Name entry or has a non-text /Name value`,
            location: 'Document Catalog → /OCProperties → /OCGs',
            category: 'structure',
            suggestion:
              'Add a descriptive text string as the /Name entry for each optional content group.',
            context: `OCG index: ${ocgIndex}`,
          })
        );
      }

      // 20-002: /Intent must be absent, /View, /Design, or an array of both
      const intentEntry = ocg.get(PDFName.of('Intent'));
      if (intentEntry && this.isIntentInvalid(intentEntry)) {
        issues.push(
          this.createIssue({
            code: 'MATTERHORN-20-002',
            matterhornCheckpoint: '20-002',
            severity: 'moderate',
            message: `Optional content group #${ocgIndex} has an invalid /Intent value`,
            location: 'Document Catalog → /OCProperties → /OCGs',
            category: 'structure',
            suggestion:
              'Set the /Intent entry to /View, /Design, or an array containing both.',
            context: `OCG index: ${ocgIndex}`,
          })
        );
      }
    }

    return issues;
  }

  /** Returns true if the intent entry violates CP20-002 */
  private isIntentInvalid(intentEntry: unknown): boolean {
    if (intentEntry instanceof PDFName) {
      return !VALID_INTENT_VALUES.has(intentEntry.asString());
    }
    if (intentEntry instanceof PDFArray) {
      return intentEntry.asArray().some(
        item => !(item instanceof PDFName) || !VALID_INTENT_VALUES.has(item.asString())
      );
    }
    return true; // Unknown type
  }

  // ─── CP21: Embedded Files ────────────────────────────────────────────────────

  private checkEmbeddedFiles(
    catalog: PDFDict,
    pdfLibDoc: import('pdf-lib').PDFDocument
  ): AuditIssue[] {
    const namesRaw = catalog.get(PDFName.of('Names'));
    if (!namesRaw) return [];

    const namesDict = this.resolveDict(namesRaw, pdfLibDoc);
    if (!namesDict) return [];

    const embeddedFilesRaw = namesDict.get(PDFName.of('EmbeddedFiles'));
    if (!embeddedFilesRaw) return [];

    const embeddedFilesTree = this.resolveDict(embeddedFilesRaw, pdfLibDoc);
    if (!embeddedFilesTree) return [];

    // Name tree leaf nodes store entries as [nameString, fileSpecRef, ...]
    const namesArray = embeddedFilesTree.get(PDFName.of('Names'));
    if (!(namesArray instanceof PDFArray)) return [];

    const issues: AuditIssue[] = [];
    const arr = namesArray.asArray();

    for (let i = 1; i < arr.length; i += 2) {
      const fileSpec = this.resolveDict(arr[i], pdfLibDoc);
      if (!fileSpec) continue;

      const hasF = fileSpec.get(PDFName.of('F'));
      const hasUF = fileSpec.get(PDFName.of('UF'));

      if (!hasF && !hasUF) {
        const fileIndex = Math.floor(i / 2) + 1;
        issues.push(
          this.createIssue({
            code: 'MATTERHORN-21-001',
            matterhornCheckpoint: '21-001',
            severity: 'moderate',
            message: `Embedded file specification #${fileIndex} is missing both /F and /UF entries`,
            location: 'Document Catalog → /Names → /EmbeddedFiles',
            category: 'structure',
            suggestion:
              'Add a /UF (Unicode filename) entry to each embedded file specification so assistive technology can identify the file.',
            context: `File spec index: ${fileIndex}`,
          })
        );
      }
    }

    return issues;
  }

  // ─── CP10: Form XObjects ─────────────────────────────────────────────────────

  /**
   * Check that Form XObjects on each page are mapped to the structure tree.
   *
   * Form XObjects live in each page's /Resources/XObject dict — not the catalog.
   * A tagged Form XObject carries a /StructParents entry (integer key into the
   * parent tree). Content-carrying Form XObjects that lack /StructParents are
   * flagged as CP10-001.
   *
   * Only runs on tagged documents; skips XObjects with /OC (optional content
   * layers) and XObjects without /Resources (appearance streams / artifacts).
   */
  private checkFormXObjects(
    parsed: PdfParseResult,
    pdfLibDoc: import('pdf-lib').PDFDocument
  ): AuditIssue[] {
    if (!parsed.isTagged) return []; // Untagged is already flagged by structure validator

    const issues: AuditIssue[] = [];
    const pages = pdfLibDoc.getPages();

    for (let pageIdx = 0; pageIdx < pages.length; pageIdx++) {
      const page = pages[pageIdx];
      const pageNum = pageIdx + 1;

      let resources: PDFDict | undefined;
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const pageDict = (page as any).node as PDFDict;
        resources = this.resolveDict(pageDict.get(PDFName.of('Resources')), pdfLibDoc);
      } catch {
        continue;
      }
      if (!resources) continue;

      const xObjectDict = this.resolveDict(resources.get(PDFName.of('XObject')), pdfLibDoc);
      if (!xObjectDict) continue;

      for (const [keyRaw, xObjRaw] of xObjectDict.entries()) {
        const xObj = this.resolveDict(xObjRaw, pdfLibDoc);
        if (!xObj) continue;

        // Only interested in Form subtype
        const subtype = xObj.get(PDFName.of('Subtype'));
        if (!(subtype instanceof PDFName) || subtype.asString() !== 'Form') continue;

        // Skip optional-content controlled XObjects (hidden layers)
        if (xObj.get(PDFName.of('OC'))) continue;

        // Only flag content-carrying Form XObjects (those with /Resources)
        // to avoid flagging widget appearances and watermarks
        if (!xObj.get(PDFName.of('Resources'))) continue;

        // A tagged Form XObject has /StructParents pointing into the parent tree
        if (xObj.get(PDFName.of('StructParents'))) continue;

        const xObjName = keyRaw instanceof PDFName ? keyRaw.asString() : String(keyRaw);
        issues.push(
          this.createIssue({
            code: 'MATTERHORN-10-001',
            matterhornCheckpoint: '10-001',
            severity: 'moderate',
            message: `Form XObject "${xObjName}" on page ${pageNum} is not mapped to a structure element`,
            location: `Page ${pageNum} → /Resources/XObject/${xObjName}`,
            category: 'structure',
            suggestion:
              'Ensure every content-carrying Form XObject is referenced from the structure tree via an /Obj entry or carries a /StructParents key.',
            context: `Page: ${pageNum}, XObject: ${xObjName}`,
            pageNumber: pageNum,
          })
        );
      }
    }

    return issues;
  }

  // ─── CP25: Non-interactive Forms ─────────────────────────────────────────────

  /**
   * Walk the structure tree looking for <Form> elements that lack an accessible
   * name (no /T title entry). These are non-interactive form fields per CP25-001.
   */
  private checkNonInteractiveForms(parsed: PdfParseResult): AuditIssue[] {
    if (!parsed.structureTree?.length) return [];

    const issues: AuditIssue[] = [];
    this.walkStructureForForms(parsed.structureTree, issues);
    return issues;
  }

  private walkStructureForForms(nodes: PdfStructureNode[], issues: AuditIssue[]): void {
    for (const node of nodes) {
      if (node.type === 'Form') {
        if (!node.title?.trim() && !node.alt?.trim()) {
          issues.push(
            this.createIssue({
              code: 'MATTERHORN-25-001',
              matterhornCheckpoint: '25-001',
              severity: 'moderate',
              message:
                'Non-interactive form field (Form structure element) is missing an accessible name (/T title or /Alt entry)',
              location: 'Structure tree → Form element',
              category: 'forms',
              suggestion:
                'Add a descriptive title or alternate text to the Form structure element so assistive technology can identify the field purpose.',
              pageNumber: node.pageNumber,
            })
          );
        }
      }
      if (node.children?.length) {
        this.walkStructureForForms(node.children, issues);
      }
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

  /**
   * Resolve a direct PDFDict or indirect reference to a PDFDict.
   * Returns undefined if the entry is not resolvable as a dict.
   */
  private resolveDict(
    entry: unknown,
    pdfLibDoc: import('pdf-lib').PDFDocument
  ): PDFDict | undefined {
    if (entry instanceof PDFDict) return entry;
    if (!entry) return undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const resolved = pdfLibDoc.context.lookup(entry as any);
      if (resolved instanceof PDFDict) return resolved;
    } catch {
      // Not a valid reference
    }
    return undefined;
  }

  private createIssue(opts: {
    code: string;
    matterhornCheckpoint: string;
    severity: AuditIssue['severity'];
    message: string;
    location: string;
    category: string;
    suggestion: string;
    context?: string;
    pageNumber?: number;
    wcagCriteria?: string[];
  }): AuditIssue {
    return {
      id: `supplemental-${++this.issueCounter}`,
      source: 'supplemental-validator',
      severity: opts.severity,
      code: opts.code,
      matterhornCheckpoint: opts.matterhornCheckpoint,
      matterhornHow: 'M',
      message: opts.message,
      wcagCriteria: opts.wcagCriteria ?? [],
      location: opts.location,
      category: opts.category,
      suggestion: opts.suggestion,
      context: opts.context,
      pageNumber: opts.pageNumber,
    };
  }
}

export const pdfSupplementalValidator = new PdfSupplementalValidator();
