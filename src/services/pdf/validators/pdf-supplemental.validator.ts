/**
 * PDF Supplemental Validator
 *
 * Implements Matterhorn Protocol 1.1 machine-checkable conditions not covered
 * by other validators.  Condition IDs and titles are taken verbatim from the
 * reference file at docs/matterhorn-1.1-reference.md.
 *
 * Implemented conditions:
 *   CP19-003  Note tag is missing its ID entry
 *   CP19-004  Note tag ID entry is non-unique within the document
 *   CP20-001  OC Config Dict in /Configs array is missing /Name (or empty)
 *   CP20-002  OC Config Dict in /D entry is missing /Name (or empty)
 *   CP20-003  OC Config Dict (D or Configs) contains an /AS entry
 *   CP21-001  Embedded file specification is missing both /F and /UF entries
 *   CP25-001  File contains the dynamicRender element with value "required"
 *   CP26-001  File is encrypted but has no /P entry in the encryption dictionary
 *   CP26-002  File is encrypted, /P entry present, but bit 10 (accessibility) is false
 *   CP30-001  A reference XObject is present
 *
 * Intentionally deferred to veraPDF (Step 4):
 *   CP10-001  Character code cannot be mapped to Unicode (font encoding analysis)
 *   CP30-002  Form XObject with MCIDs referenced more than once
 */

import { PDFDict, PDFName, PDFArray, PDFString, PDFNumber } from 'pdf-lib';
import { AuditIssue } from '../../audit/base-audit.service';
import { PdfParseResult, PdfStructureNode } from '../pdf-comprehensive-parser.service';
import { logger } from '../../../lib/logger';

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const catalog = this.resolveDict(pdfLibDoc.context.trailerInfo.Root as any, pdfLibDoc);
    if (!catalog) {
      logger.warn('[PdfSupplementalValidator] Could not resolve document catalog');
      return [];
    }

    issues.push(...this.checkNoteIds(parsed));
    issues.push(...this.checkOptionalContent(catalog, pdfLibDoc));
    issues.push(...this.checkEmbeddedFiles(catalog, pdfLibDoc));
    issues.push(...this.checkXfa(catalog, pdfLibDoc));
    issues.push(...this.checkEncryption(pdfLibDoc));
    issues.push(...this.checkReferenceXObjects(pdfLibDoc));

    logger.info(`[PdfSupplementalValidator] Found ${issues.length} supplemental issue(s)`);
    return issues;
  }

  // ─── CP19: Notes and References ──────────────────────────────────────────────

  /**
   * CP19-003: Note tag missing its ID entry.
   * CP19-004: Note tag ID entry is non-unique.
   *
   * Walks the structure tree looking for elements with type "Note".
   * Each Note element must have a non-empty, document-unique /ID attribute.
   */
  private checkNoteIds(parsed: PdfParseResult): AuditIssue[] {
    if (!parsed.structureTree?.length) return [];

    const issues: AuditIssue[] = [];
    const seenIds = new Map<string, number>(); // id → first occurrence index

    // First pass: collect all Note IDs
    this.collectNoteIds(parsed.structureTree, seenIds, issues);

    // Second pass: flag duplicates (seenIds values > 1)
    for (const [noteId, count] of seenIds) {
      if (count > 1) {
        issues.push(
          this.createIssue({
            code: 'MATTERHORN-19-004',
            matterhornCheckpoint: '19-004',
            severity: 'moderate',
            message: `Note structure element has a non-unique ID "${noteId}" (appears ${count} times)`,
            location: 'Structure tree → Note element',
            category: 'structure',
            suggestion:
              'Ensure every Note element has a unique /ID attribute within the document.',
            context: `Duplicate ID: "${noteId}", count: ${count}`,
          })
        );
      }
    }

    return issues;
  }

  private collectNoteIds(
    nodes: PdfStructureNode[],
    seenIds: Map<string, number>,
    issues: AuditIssue[]
  ): void {
    for (const node of nodes) {
      if (node.type === 'Note') {
        if (!node.id || node.id.trim() === '') {
          issues.push(
            this.createIssue({
              code: 'MATTERHORN-19-003',
              matterhornCheckpoint: '19-003',
              severity: 'moderate',
              message: 'Note structure element is missing its ID entry',
              location: 'Structure tree → Note element',
              category: 'structure',
              suggestion:
                'Add a unique /ID attribute to every Note structure element so footnote/endnote references can be resolved.',
              pageNumber: node.pageNumber,
            })
          );
        } else {
          seenIds.set(node.id, (seenIds.get(node.id) ?? 0) + 1);
        }
      }
      if (node.children?.length) {
        this.collectNoteIds(node.children, seenIds, issues);
      }
    }
  }

  // ─── CP20: Optional Content ──────────────────────────────────────────────────

  /**
   * CP20-001: OC Config Dict in the /Configs array is missing /Name or has empty string.
   * CP20-002: OC Config Dict in the /D entry is missing /Name or has empty string.
   * CP20-003: An OC Config Dict (either /D or any entry in /Configs) contains an /AS entry.
   *
   * Note: these conditions apply to Optional Content *Configuration* Dicts
   * (the /D and /Configs entries inside /OCProperties), NOT to OCG dicts (/OCGs).
   */
  private checkOptionalContent(
    catalog: PDFDict,
    pdfLibDoc: import('pdf-lib').PDFDocument
  ): AuditIssue[] {
    const ocPropertiesRaw = catalog.get(PDFName.of('OCProperties'));
    if (!ocPropertiesRaw) return []; // No optional content — skip CP20

    const ocProperties = this.resolveDict(ocPropertiesRaw, pdfLibDoc);
    if (!ocProperties) return [];

    const issues: AuditIssue[] = [];

    // Check the /D (default) OC Config Dict — CP20-002 and CP20-003
    const dRaw = ocProperties.get(PDFName.of('D'));
    if (dRaw) {
      const dDict = this.resolveDict(dRaw, pdfLibDoc);
      if (dDict) {
        issues.push(...this.checkOcConfigDict(dDict, '/D', '20-002', 'MATTERHORN-20-002'));
      }
    }

    // Check each dict in the /Configs array — CP20-001 and CP20-003
    const configsRaw = ocProperties.get(PDFName.of('Configs'));
    if (configsRaw instanceof PDFArray) {
      let configIdx = 0;
      for (const configRaw of configsRaw.asArray()) {
        configIdx++;
        const configDict = this.resolveDict(configRaw, pdfLibDoc);
        if (!configDict) continue;
        issues.push(
          ...this.checkOcConfigDict(
            configDict,
            `/Configs[${configIdx}]`,
            '20-001',
            'MATTERHORN-20-001'
          )
        );
      }
    }

    return issues;
  }

  /**
   * Check a single OC Config Dict for missing/empty /Name (CP20-001 or 20-002)
   * and for presence of /AS (CP20-003, which applies to both D and Configs entries).
   */
  private checkOcConfigDict(
    dict: PDFDict,
    location: string,
    missingNameCondition: '20-001' | '20-002',
    missingNameCode: string
  ): AuditIssue[] {
    const issues: AuditIssue[] = [];

    // CP20-001 / CP20-002: /Name must be present and non-empty
    const nameEntry = dict.get(PDFName.of('Name'));
    const nameIsEmpty =
      !nameEntry ||
      (nameEntry instanceof PDFString && nameEntry.decodeText().trim() === '');
    if (nameIsEmpty) {
      issues.push(
        this.createIssue({
          code: missingNameCode,
          matterhornCheckpoint: missingNameCondition,
          severity: 'moderate',
          message: `Optional content configuration dictionary at ${location} is missing a /Name entry or has an empty /Name value`,
          location: `Document Catalog → /OCProperties → ${location}`,
          category: 'structure',
          suggestion:
            'Add a descriptive text string as the /Name entry for each optional content configuration dictionary.',
          context: `OC Config Dict location: ${location}`,
        })
      );
    }

    // CP20-003: /AS entry must not be present
    if (dict.get(PDFName.of('AS'))) {
      issues.push(
        this.createIssue({
          code: 'MATTERHORN-20-003',
          matterhornCheckpoint: '20-003',
          severity: 'moderate',
          message: `Optional content configuration dictionary at ${location} contains an /AS entry, which is not permitted in PDF/UA`,
          location: `Document Catalog → /OCProperties → ${location}`,
          category: 'structure',
          suggestion:
            'Remove the /AS (AutoState) entry from all optional content configuration dictionaries.',
          context: `OC Config Dict location: ${location}`,
        })
      );
    }

    return issues;
  }

  // ─── CP21: Embedded Files ────────────────────────────────────────────────────

  /**
   * CP21-001: Embedded file specification is missing both /F and /UF entries.
   *
   * Walks the /Names → /EmbeddedFiles name tree in the document catalog.
   */
  private checkEmbeddedFiles(
    catalog: PDFDict,
    pdfLibDoc: import('pdf-lib').PDFDocument
  ): AuditIssue[] {
    const namesDict = this.resolveDict(catalog.get(PDFName.of('Names')), pdfLibDoc);
    if (!namesDict) return [];

    const embeddedFilesTree = this.resolveDict(
      namesDict.get(PDFName.of('EmbeddedFiles')),
      pdfLibDoc
    );
    if (!embeddedFilesTree) return [];

    // Name tree leaf: /Names array containing [nameString, fileSpecRef, ...]
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
              'Add a /UF (Unicode filename) entry to each embedded file specification.',
            context: `File spec index: ${fileIndex}`,
          })
        );
      }
    }

    return issues;
  }

  // ─── CP25: XFA ───────────────────────────────────────────────────────────────

  /**
   * CP25-001: File contains the dynamicRender element with value "required".
   *
   * Checks the AcroForm XFA stream(s) for a <dynamicRender>required</dynamicRender>
   * element, which forces dynamic XFA rendering and is prohibited by PDF/UA.
   *
   * XFA is stored in /AcroForm → /XFA, either as a single stream or as an array
   * of [name, stream, name, stream, ...] pairs. We look specifically in the
   * "config" named packet where dynamicRender lives.
   */
  private checkXfa(
    catalog: PDFDict,
    pdfLibDoc: import('pdf-lib').PDFDocument
  ): AuditIssue[] {
    const acroFormRaw = catalog.get(PDFName.of('AcroForm'));
    if (!acroFormRaw) return []; // No AcroForm → no XFA

    const acroForm = this.resolveDict(acroFormRaw, pdfLibDoc);
    if (!acroForm) return [];

    const xfaRaw = acroForm.get(PDFName.of('XFA'));
    if (!xfaRaw) return []; // No XFA

    // Try to find and decode the "config" packet within the XFA data
    const configText = this.extractXfaConfig(xfaRaw, pdfLibDoc);
    if (!configText) return [];

    // Search for dynamicRender element with value "required"
    // Handles both <dynamicRender>required</dynamicRender> and attribute forms
    const hasDynamicRenderRequired = /dynamicRender[^<]*>[\s]*required[\s]*</i.test(configText);
    if (!hasDynamicRenderRequired) return [];

    return [
      this.createIssue({
        code: 'MATTERHORN-25-001',
        matterhornCheckpoint: '25-001',
        severity: 'critical',
        message:
          'Document contains an XFA dynamicRender element with value "required", which forces dynamic XFA rendering and is prohibited by PDF/UA-1',
        location: 'Document Catalog → /AcroForm → /XFA → config',
        category: 'structure',
        suggestion:
          'Remove the dynamicRender element or set its value to something other than "required". Consider converting the document to a static PDF.',
        wcagCriteria: ['4.1.2'],
      }),
    ];
  }

  /**
   * Extract the raw text content of the "config" packet from the XFA stream.
   * Returns null if XFA is absent, inaccessible, or unreadable.
   */
  private extractXfaConfig(
    xfaRaw: unknown,
    pdfLibDoc: import('pdf-lib').PDFDocument
  ): string | null {
    try {
      // XFA as a single stream (uncommon but valid)
      if (this.isRawStream(xfaRaw)) {
        return this.streamToText(xfaRaw);
      }

      // XFA as an array of [name, stream, name, stream, ...] pairs
      if (xfaRaw instanceof PDFArray) {
        const arr = xfaRaw.asArray();
        for (let i = 0; i < arr.length - 1; i += 2) {
          const nameEntry = arr[i];
          const nameStr =
            nameEntry instanceof PDFString
              ? nameEntry.decodeText()
              : nameEntry instanceof PDFName
              ? nameEntry.asString()
              : null;

          if (nameStr === 'config') {
            const streamRef = arr[i + 1];
            const resolved = streamRef
              ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
                pdfLibDoc.context.lookup(streamRef as any)
              : null;
            if (resolved && this.isRawStream(resolved)) {
              return this.streamToText(resolved);
            }
          }
        }
      }
    } catch {
      // Non-fatal — XFA may be encrypted or in an unsupported format
    }
    return null;
  }

  private isRawStream(obj: unknown): boolean {
    if (!obj || typeof obj !== 'object') return false;
    // pdf-lib raw streams have a `contents` Uint8Array property
    return 'contents' in (obj as object) && 'dict' in (obj as object);
  }

  private streamToText(streamObj: unknown): string {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const contents = (streamObj as any).contents as Uint8Array | undefined;
    if (!contents) return '';
    return new TextDecoder('utf-8', { fatal: false }).decode(contents);
  }

  // ─── CP26: Security ──────────────────────────────────────────────────────────

  /**
   * CP26-001: File is encrypted but the encryption dictionary has no /P entry.
   * CP26-002: File is encrypted, /P entry present, but bit 10 (accessibility text
   *           extraction) is not set.
   *
   * Bit 10 (1-indexed, per PDF spec Table 22) = enable text/graphics extraction
   * for accessibility purposes.  In a 32-bit integer: 1 << 9 (0-indexed) = 512.
   */
  private checkEncryption(pdfLibDoc: import('pdf-lib').PDFDocument): AuditIssue[] {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const encryptRef = (pdfLibDoc.context.trailerInfo as any).Encrypt;
    if (!encryptRef) return []; // Not encrypted — skip CP26

    const encryptDict = this.resolveDict(encryptRef, pdfLibDoc);
    if (!encryptDict) return [];

    const pEntry = encryptDict.get(PDFName.of('P'));

    // CP26-001: /P entry missing entirely
    if (!pEntry) {
      return [
        this.createIssue({
          code: 'MATTERHORN-26-001',
          matterhornCheckpoint: '26-001',
          severity: 'serious',
          message:
            'Encrypted document is missing the /P (permissions) entry in the encryption dictionary',
          location: 'Document Trailer → /Encrypt',
          category: 'structure',
          suggestion:
            'Add a /P entry to the encryption dictionary with the accessibility bit (bit 10) enabled.',
        }),
      ];
    }

    // CP26-002: /P entry present but accessibility bit (bit 10) is 0
    if (pEntry instanceof PDFNumber) {
      const pValue = pEntry.asNumber();
      const accessibilityBitSet = (pValue & 512) !== 0; // bit 10 (1-indexed) = 1 << 9
      if (!accessibilityBitSet) {
        return [
          this.createIssue({
            code: 'MATTERHORN-26-002',
            matterhornCheckpoint: '26-002',
            severity: 'serious',
            message:
              'Encrypted document has the accessibility text-extraction permission bit (bit 10) set to false',
            location: 'Document Trailer → /Encrypt → /P',
            category: 'structure',
            suggestion:
              'Set bit 10 of the /P permissions flag to enable text extraction for assistive technology.',
            context: `P value: ${pValue} (0x${(pValue >>> 0).toString(16)})`,
          }),
        ];
      }
    }

    return [];
  }

  // ─── CP30: XObjects ──────────────────────────────────────────────────────────

  /**
   * CP30-001: A reference XObject is present.
   *
   * Checks each page's /Resources/XObject dict for any XObject whose /Subtype
   * is /Reference.  Reference XObjects are prohibited by PDF/UA.
   */
  private checkReferenceXObjects(pdfLibDoc: import('pdf-lib').PDFDocument): AuditIssue[] {
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

        const subtype = xObj.get(PDFName.of('Subtype'));
        if (!(subtype instanceof PDFName) || subtype.asString() !== '/Reference') continue;

        const xObjName = keyRaw instanceof PDFName ? keyRaw.asString() : String(keyRaw);
        issues.push(
          this.createIssue({
            code: 'MATTERHORN-30-001',
            matterhornCheckpoint: '30-001',
            severity: 'moderate',
            message: `Reference XObject "${xObjName}" found on page ${pageNum} — reference XObjects are prohibited by PDF/UA`,
            location: `Page ${pageNum} → /Resources/XObject/${xObjName}`,
            category: 'structure',
            suggestion:
              'Replace the reference XObject with directly embedded content.',
            context: `Page: ${pageNum}, XObject: ${xObjName}`,
            pageNumber: pageNum,
          })
        );
      }
    }

    return issues;
  }

  // ─── Helpers ─────────────────────────────────────────────────────────────────

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
