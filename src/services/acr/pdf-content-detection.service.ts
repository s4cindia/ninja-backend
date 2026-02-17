/**
 * PDF Content Detection Service
 *
 * Analyses a PDF file buffer to determine which WCAG criteria are
 * applicable vs. not applicable, mirroring the EPUB content detection
 * service but using PDF-specific signals (AcroForm, JavaScript, annotations).
 *
 * Implements Phase 5 B3 requirements.
 */

import { PDFArray, PDFDict, PDFDocument, PDFName } from 'pdf-lib';
import { logger } from '../../lib/logger';
import { pdfParserService } from '../pdf/pdf-parser.service';
import type { ApplicabilitySuggestion, DetectionCheck } from './content-detection.service';

interface PdfContentAnalysis {
  hasAcroForm: boolean;      // Interactive form fields (AcroForm in catalog)
  hasXFA: boolean;           // XFA forms (supersede AcroForm)
  hasJavaScript: boolean;    // PDF-level JavaScript actions
  hasAnnotations: boolean;   // Annotations on any page (links, comments, widgets)
  hasMultimedia: boolean;    // Rich media / embedded audio / video annotations
  hasSignatureFields: boolean; // Digital signature widgets
  pageCount: number;
  isTagged: boolean;
  documentType: 'static' | 'interactive' | 'multimedia';
}

class PdfContentDetectionService {

  /**
   * Analyse a PDF buffer and return applicability suggestions for WCAG criteria.
   *
   * @param buffer - PDF file buffer
   * @param fileName - Original filename (for logging)
   */
  async analyzePDFContent(buffer: Buffer, fileName = 'document.pdf'): Promise<ApplicabilitySuggestion[]> {
    logger.info(`[PDF Content Detection] Starting analysis: ${fileName}`);

    let parsedPdf;
    try {
      parsedPdf = await pdfParserService.parseBuffer(buffer, fileName);
    } catch (error) {
      logger.error('[PDF Content Detection] Failed to parse PDF, returning empty suggestions', error instanceof Error ? error : undefined);
      return [];
    }

    try {
      const { structure, pdfLibDoc } = parsedPdf;

      // Aggregate annotation count across pages
      const totalAnnotations = structure.pages.reduce((sum, p) => sum + (p.annotationCount ?? 0), 0);

      // Detect JavaScript actions via pdf-lib catalog inspection
      const hasJavaScript = this.detectJavaScript(pdfLibDoc);

      // Detect Rich Media / embedded multimedia annotations
      const hasMultimedia = this.detectMultimedia(pdfLibDoc);

      // Detect digital signature fields
      const hasSignatureFields = this.detectSignatureFields(pdfLibDoc);

      const analysis: PdfContentAnalysis = {
        hasAcroForm: structure.metadata.hasAcroForm,
        hasXFA: structure.metadata.hasXFA,
        hasJavaScript,
        hasAnnotations: totalAnnotations > 0,
        hasMultimedia,
        hasSignatureFields,
        pageCount: structure.pageCount,
        isTagged: structure.metadata.isTagged,
        documentType: this.classifyDocumentType(
          structure.metadata.hasAcroForm,
          hasJavaScript,
          hasMultimedia
        ),
      };

      logger.info('[PDF Content Detection] Analysis complete', {
        hasAcroForm: analysis.hasAcroForm,
        hasXFA: analysis.hasXFA,
        hasJavaScript: analysis.hasJavaScript,
        hasAnnotations: analysis.hasAnnotations,
        hasMultimedia: analysis.hasMultimedia,
        documentType: analysis.documentType,
        pageCount: analysis.pageCount,
      });

      return this.generateApplicabilitySuggestions(analysis);
    } finally {
      try {
        await pdfParserService.close(parsedPdf);
      } catch {
        // Ignore close errors — document may already be released
      }
    }
  }

  // ─── PDF-level signal detectors ───────────────────────────────────────────

  /**
   * Checks the PDF catalog for JavaScript actions in:
   *  - /Names → /JavaScript tree
   *  - /AA (additional actions) on the catalog
   *  - /OpenAction with type /JavaScript
   */
  private detectJavaScript(pdfLibDoc: PDFDocument): boolean {
    try {
      const catalog = pdfLibDoc.catalog;

      // Check /Names → /JavaScript
      if (catalog.has(PDFName.of('Names'))) {
        const names = catalog.get(PDFName.of('Names'));
        if (names instanceof PDFDict && names.has(PDFName.of('JavaScript'))) {
          return true;
        }
      }

      // Check /AA (Additional Actions) on catalog
      if (catalog.has(PDFName.of('AA'))) {
        return true;
      }

      // Check /OpenAction for JavaScript action type
      if (catalog.has(PDFName.of('OpenAction'))) {
        const openAction = catalog.get(PDFName.of('OpenAction'));
        if (openAction instanceof PDFDict) {
          const sType = openAction.get(PDFName.of('S'));
          if (sType instanceof PDFName && sType.asString() === 'JavaScript') {
            return true;
          }
        }
      }

      return false;
    } catch {
      logger.warn('[PDF Content Detection] JavaScript detection failed, assuming false');
      return false;
    }
  }

  /**
   * Checks for RichMedia or Screen annotations (embedded audio/video).
   * These appear as annotation subtypes in page /Annots arrays.
   */
  private detectMultimedia(pdfLibDoc: PDFDocument): boolean {
    try {
      const pages = pdfLibDoc.getPages();
      for (const page of pages) {
        const annots = page.node.get(PDFName.of('Annots'));
        if (!annots) continue;

        const annotArray = pdfLibDoc.context.lookupMaybe(annots, PDFArray);
        if (!annotArray) continue;

        for (let i = 0; i < annotArray.size(); i++) {
          const annotRef = annotArray.get(i);
          const annot = pdfLibDoc.context.lookupMaybe(annotRef, PDFDict);
          if (!annot) continue;

          const subtype = annot.get(PDFName.of('Subtype'));
          if (subtype instanceof PDFName) {
            const name = subtype.asString();
            if (name === 'RichMedia' || name === 'Screen' || name === 'Movie' || name === 'Sound') {
              return true;
            }
          }
        }
      }
      return false;
    } catch {
      logger.warn('[PDF Content Detection] Multimedia detection failed, assuming false');
      return false;
    }
  }

  /**
   * Checks for Sig (digital signature) widget annotations.
   */
  private detectSignatureFields(pdfLibDoc: PDFDocument): boolean {
    try {
      const catalog = pdfLibDoc.catalog;
      if (!catalog.has(PDFName.of('AcroForm'))) return false;

      const acroForm = catalog.get(PDFName.of('AcroForm'));
      if (!(acroForm instanceof PDFDict)) return false;

      const fields = acroForm.get(PDFName.of('Fields'));
      if (!fields) return false;

      const fieldArray = pdfLibDoc.context.lookupMaybe(fields, PDFArray);
      if (!fieldArray) return false;

      for (let i = 0; i < fieldArray.size(); i++) {
        const fieldRef = fieldArray.get(i);
        const field = pdfLibDoc.context.lookupMaybe(fieldRef, PDFDict);
        if (!field) continue;

        const ft = field.get(PDFName.of('FT'));
        if (ft instanceof PDFName && ft.asString() === 'Sig') {
          return true;
        }
      }
      return false;
    } catch {
      logger.warn('[PDF Content Detection] Signature detection failed, assuming false');
      return false;
    }
  }

  private classifyDocumentType(
    hasAcroForm: boolean,
    hasJavaScript: boolean,
    hasMultimedia: boolean
  ): 'static' | 'interactive' | 'multimedia' {
    if (hasMultimedia) return 'multimedia';
    if (hasAcroForm || hasJavaScript) return 'interactive';
    return 'static';
  }

  // ─── Suggestion generation ────────────────────────────────────────────────

  private generateApplicabilitySuggestions(analysis: PdfContentAnalysis): ApplicabilitySuggestion[] {
    const suggestions: ApplicabilitySuggestion[] = [];
    const isStatic = analysis.documentType === 'static';

    // Multimedia criteria (1.2.x)
    suggestions.push(this.suggestMultimedia(analysis));

    // Audio control (1.4.2)
    suggestions.push(this.suggestAudioControl(analysis));

    // Timing criteria — only applicable if JS or forms present
    if (isStatic) {
      suggestions.push(...this.suggestTimingCriteria(analysis));
    }

    // Keyboard / pointer / motion — only applicable if interactive
    if (isStatic) {
      suggestions.push(...this.suggestInteractionCriteria(analysis));
    }

    // Form / input criteria (3.3.x)
    suggestions.push(...this.suggestFormCriteria(analysis));

    // Focus/input change criteria (3.2.1, 3.2.2)
    suggestions.push(...this.suggestChangeCriteria(analysis));

    // Status messages (4.1.3) — N/A for static PDFs
    if (isStatic) {
      suggestions.push(this.suggestStatusMessages(analysis));
    }

    logger.info(`[PDF Content Detection] Generated ${suggestions.length} applicability suggestions for ${analysis.documentType} PDF`);
    return suggestions;
  }

  // ── Per-criterion helpers ──────────────────────────────────────────────────

  private suggestMultimedia(analysis: PdfContentAnalysis): ApplicabilitySuggestion {
    const checks: DetectionCheck[] = [
      {
        check: 'RichMedia / Screen / Movie annotations',
        result: analysis.hasMultimedia ? 'fail' : 'pass',
        details: analysis.hasMultimedia
          ? 'Embedded multimedia annotations detected'
          : 'No RichMedia, Screen, Movie, or Sound annotations found',
      },
    ];

    if (analysis.hasMultimedia) {
      return {
        criterionId: '1.2.x',
        suggestedStatus: 'applicable',
        confidence: 90,
        detectionChecks: checks,
        rationale: 'Embedded multimedia detected. Criteria 1.2.1–1.2.5 are likely applicable.',
        edgeCases: ['Verify whether audio/video is prerecorded or live'],
      };
    }

    return {
      criterionId: '1.2.x',
      suggestedStatus: 'not_applicable',
      confidence: 90,
      detectionChecks: checks,
      rationale: 'No embedded multimedia annotations detected. Criteria 1.2.1–1.2.5 are not applicable to this static PDF.',
      edgeCases: ['Externally linked media is not detected by static analysis'],
    };
  }

  private suggestAudioControl(analysis: PdfContentAnalysis): ApplicabilitySuggestion {
    const checks: DetectionCheck[] = [
      {
        check: 'Sound / autoplay audio annotations',
        result: analysis.hasMultimedia ? 'warning' : 'pass',
        details: analysis.hasMultimedia
          ? 'Multimedia annotations present — verify for autoplaying audio'
          : 'No Sound annotations found',
      },
    ];

    if (!analysis.hasMultimedia) {
      return {
        criterionId: '1.4.2',
        suggestedStatus: 'not_applicable',
        confidence: 92,
        detectionChecks: checks,
        rationale: 'No audio content detected. Criterion 1.4.2 (Audio Control) is not applicable.',
        edgeCases: [],
      };
    }

    return {
      criterionId: '1.4.2',
      suggestedStatus: 'uncertain',
      confidence: 50,
      detectionChecks: checks,
      rationale: 'Multimedia annotations present. Manual verification needed to determine if audio autoplays for more than 3 seconds.',
      edgeCases: ['Cannot determine autoplay behaviour from static analysis'],
    };
  }

  private suggestTimingCriteria(analysis: PdfContentAnalysis): ApplicabilitySuggestion[] {
    const checks: DetectionCheck[] = [
      {
        check: 'JavaScript actions (timing may be controlled by script)',
        result: analysis.hasJavaScript ? 'fail' : 'pass',
        details: analysis.hasJavaScript
          ? 'JavaScript detected — timed content is possible'
          : 'No JavaScript found; no timed interactions expected',
      },
      {
        check: 'Interactive forms (session timeouts possible)',
        result: analysis.hasAcroForm ? 'warning' : 'pass',
        details: analysis.hasAcroForm
          ? 'Forms present — check for session/time limits'
          : 'No form fields found',
      },
    ];

    const rationale = 'No JavaScript or interactive forms detected in this static PDF. Time-limit criteria are not applicable.';

    return ['2.2.1', '2.2.2'].map(criterionId => ({
      criterionId,
      suggestedStatus: 'not_applicable' as const,
      confidence: 88,
      detectionChecks: [...checks],
      rationale,
      edgeCases: [],
    }));
  }

  private suggestInteractionCriteria(analysis: PdfContentAnalysis): ApplicabilitySuggestion[] {
    const checks: DetectionCheck[] = [
      {
        check: 'AcroForm (interactive form fields)',
        result: analysis.hasAcroForm ? 'fail' : 'pass',
        details: analysis.hasAcroForm ? 'Form fields detected' : 'No AcroForm found',
      },
      {
        check: 'JavaScript actions',
        result: analysis.hasJavaScript ? 'fail' : 'pass',
        details: analysis.hasJavaScript ? 'JavaScript found in catalog' : 'No JavaScript actions',
      },
    ];

    // Criteria that are N/A for static PDFs (no keyboard trap, no pointer/motion gestures)
    const staticOnlyCriteria = ['2.1.2', '2.5.1', '2.5.2', '2.5.4'];
    const rationale = 'No interactive elements (forms, JavaScript) detected. This static PDF does not have keyboard traps or pointer/motion interactions.';

    return staticOnlyCriteria.map(criterionId => ({
      criterionId,
      suggestedStatus: 'not_applicable' as const,
      confidence: 85,
      detectionChecks: [...checks],
      rationale,
      edgeCases: ['PDF viewer itself may introduce keyboard behaviour outside document scope'],
    }));
  }

  private suggestFormCriteria(analysis: PdfContentAnalysis): ApplicabilitySuggestion[] {
    const checks: DetectionCheck[] = [
      {
        check: 'AcroForm fields',
        result: analysis.hasAcroForm ? 'fail' : 'pass',
        details: analysis.hasAcroForm ? 'AcroForm detected' : 'No form fields',
      },
      {
        check: 'XFA forms',
        result: analysis.hasXFA ? 'fail' : 'pass',
        details: analysis.hasXFA ? 'XFA form detected' : 'No XFA form',
      },
    ];

    const isApplicable = analysis.hasAcroForm || analysis.hasXFA;

    const suggestion = isApplicable
      ? {
          suggestedStatus: 'applicable' as const,
          confidence: 92,
          rationale: 'Interactive form fields detected. Input assistance criteria (3.3.x) are applicable.',
          edgeCases: [],
        }
      : {
          suggestedStatus: 'not_applicable' as const,
          confidence: 92,
          rationale: 'No form fields detected. Input assistance criteria (3.3.x) are not applicable to this static PDF.',
          edgeCases: [],
        };

    return ['3.3.1', '3.3.2', '3.3.3', '3.3.4'].map(criterionId => ({
      criterionId,
      detectionChecks: [...checks],
      ...suggestion,
    }));
  }

  private suggestChangeCriteria(analysis: PdfContentAnalysis): ApplicabilitySuggestion[] {
    const checks: DetectionCheck[] = [
      {
        check: 'Interactive elements (forms / JavaScript)',
        result: (analysis.hasAcroForm || analysis.hasJavaScript) ? 'fail' : 'pass',
        details: (analysis.hasAcroForm || analysis.hasJavaScript)
          ? 'Interactive content detected — focus/input change events possible'
          : 'No interactive content; no focus or input events expected',
      },
    ];

    const isStatic = !analysis.hasAcroForm && !analysis.hasJavaScript;
    const suggestion = isStatic
      ? {
          suggestedStatus: 'not_applicable' as const,
          confidence: 90,
          rationale: 'No forms or JavaScript detected. On Focus (3.2.1) and On Input (3.2.2) are not applicable to this static PDF.',
          edgeCases: [],
        }
      : {
          suggestedStatus: 'applicable' as const,
          confidence: 85,
          rationale: 'Interactive content detected. On Focus (3.2.1) and On Input (3.2.2) may be applicable.',
          edgeCases: ['Verify focus and input behaviour in PDF forms'],
        };

    return ['3.2.1', '3.2.2'].map(criterionId => ({
      criterionId,
      detectionChecks: [...checks],
      ...suggestion,
    }));
  }

  private suggestStatusMessages(analysis: PdfContentAnalysis): ApplicabilitySuggestion {
    return {
      criterionId: '4.1.3',
      suggestedStatus: 'not_applicable',
      confidence: 90,
      detectionChecks: [
        {
          check: 'Dynamic status messages (require JavaScript or live regions)',
          result: analysis.hasJavaScript ? 'warning' : 'pass',
          details: analysis.hasJavaScript
            ? 'JavaScript present — status messages may be generated dynamically'
            : 'No JavaScript detected; no dynamic status messages expected',
        },
      ],
      rationale: 'Static PDFs do not generate status messages. Criterion 4.1.3 is not applicable.',
      edgeCases: [],
    };
  }
}

export const pdfContentDetectionService = new PdfContentDetectionService();
