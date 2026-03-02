/**
 * Explanation Catalog Service
 *
 * Provides human-readable explanations for why each EPUB/PDF issue code is
 * classified as auto-fix, quick-fix, or manual, and what the platform did
 * (or what the user must do) to address it.
 *
 * Resolution order:
 *  1. Exact issue code match in EXPLANATION_CATALOG
 *  2. Category-level fallback via categorizeIssue()
 *  3. AI-generated via Gemini (when source === 'gemini' or 'hybrid')
 */

import { categorizeIssue, IssueCategory } from '../workflow/issue-categorizer.service';
import { getFixType, normalizeIssueCode } from '../../constants/fix-classification';
import { classifyIssueType } from '../../constants/pdf-fix-classification';
import { logger } from '../../lib/logger';

export type ExplanationSource = 'hardcoded' | 'gemini' | 'hybrid';

export interface IssueExplanation {
  fixType: 'auto' | 'quickfix' | 'manual';
  reason: string;
  whatPlatformDid: string | null;
  whatUserMustDo: string | null;
  wcagGuidance: string;
  estimatedTime: string | null;
}

// ---------------------------------------------------------------------------
// Explanation catalog — keyed by normalized issue code
// ---------------------------------------------------------------------------

const EXPLANATION_CATALOG: Record<string, Omit<IssueExplanation, 'fixType'>> = {

  // ─── EPUB Auto-Fixable ────────────────────────────────────────────────────

  'EPUB-META-001': {
    reason: 'This metadata field follows a strict, machine-readable format. The platform knows exactly what value to insert based on the EPUB specification — no human judgment is needed.',
    whatPlatformDid: 'Inserted or corrected the epub:type accessibility metadata in the OPF package document.',
    whatUserMustDo: null,
    wcagGuidance: 'EPUB Accessibility 1.1 — Metadata requirements',
    estimatedTime: null,
  },
  'EPUB-META-002': {
    reason: 'Accessibility features and hazards are declarative metadata flags. The platform can detect the content type and apply the correct flags automatically.',
    whatPlatformDid: 'Added the missing accessibilityFeature and/or accessibilityHazard metadata fields to the OPF package document.',
    whatUserMustDo: null,
    wcagGuidance: 'EPUB Accessibility 1.1 — Metadata: accessibilityFeature, accessibilityHazard',
    estimatedTime: null,
  },
  'EPUB-META-003': {
    reason: 'Accessibility summary is a structured metadata field that can be generated from the document\'s audit results. The platform assembles this automatically.',
    whatPlatformDid: 'Generated and inserted a schema:accessibilitySummary metadata value describing the document\'s accessibility state.',
    whatUserMustDo: null,
    wcagGuidance: 'EPUB Accessibility 1.1 — Metadata: accessibilitySummary',
    estimatedTime: null,
  },
  'EPUB-META-004': {
    reason: 'Access modes (textual, visual, auditory) are deterministic properties of the content. The platform identifies them from the document structure without human input.',
    whatPlatformDid: 'Inserted schema:accessMode and/or schema:accessModeSufficient metadata reflecting the detected content types.',
    whatUserMustDo: null,
    wcagGuidance: 'EPUB Accessibility 1.1 — Metadata: accessMode, accessModeSufficient',
    estimatedTime: null,
  },
  'EPUB-NAV-001': {
    reason: 'Navigation document structure follows precise EPUB specification rules. Structural corrections are fully automated.',
    whatPlatformDid: 'Corrected the EPUB navigation document (nav.xhtml) to meet epub:type="toc" requirements.',
    whatUserMustDo: null,
    wcagGuidance: 'EPUB 3 Specification — Navigation Document',
    estimatedTime: null,
  },
  'EPUB-SEM-001': {
    reason: 'This semantic markup issue can be resolved by inserting the required epub:type attribute using the detected content structure.',
    whatPlatformDid: 'Added or corrected epub:type semantic attributes to the relevant elements.',
    whatUserMustDo: null,
    wcagGuidance: 'EPUB Accessibility 1.1 — Semantic Inflection',
    estimatedTime: null,
  },
  'EPUB-SEM-002': {
    reason: 'Missing or incorrect ARIA landmark roles can be derived from the document\'s existing structure and epub:type declarations.',
    whatPlatformDid: 'Applied the correct ARIA landmark role to the element based on its epub:type or structural context.',
    whatUserMustDo: null,
    wcagGuidance: 'WCAG 2.1 SC 1.3.1 — Info and Relationships',
    estimatedTime: null,
  },
  'EPUB-STRUCT-003': {
    reason: 'This structural element requires a specific wrapping container element per the EPUB specification. The fix is deterministic.',
    whatPlatformDid: 'Wrapped the content in the required container element to conform to EPUB structural requirements.',
    whatUserMustDo: null,
    wcagGuidance: 'EPUB 3 Specification — Content Documents',
    estimatedTime: null,
  },
  'EPUB-STRUCT-004': {
    reason: 'The document was missing a required structural element that the platform can insert without affecting the content or meaning.',
    whatPlatformDid: 'Inserted the required structural element at the correct position in the document.',
    whatUserMustDo: null,
    wcagGuidance: 'EPUB 3 Specification — Content Documents',
    estimatedTime: null,
  },
  'EPUB-FIG-001': {
    reason: 'Figure wrapper elements (`<figure>`) and their ARIA roles can be programmatically added around image elements without changing content meaning.',
    whatPlatformDid: 'Wrapped the image and its caption in a <figure> element and applied the correct role attribute.',
    whatUserMustDo: null,
    wcagGuidance: 'WCAG 2.1 SC 1.1.1 — Non-text Content',
    estimatedTime: null,
  },
  'METADATA-ACCESSMODE': {
    reason: 'Access mode metadata is a programmatic declaration of content types (text, visual). The platform detects these automatically from the document.',
    whatPlatformDid: 'Inserted the schema:accessMode metadata into the OPF package document.',
    whatUserMustDo: null,
    wcagGuidance: 'EPUB Accessibility 1.1 — Metadata: accessMode',
    estimatedTime: null,
  },
  'METADATA-ACCESSMODESUFFICIENT': {
    reason: 'Access mode sufficiency describes how the content can be consumed with a single modality. This can be derived programmatically from the document structure.',
    whatPlatformDid: 'Inserted the schema:accessModeSufficient metadata reflecting the detected modalities.',
    whatUserMustDo: null,
    wcagGuidance: 'EPUB Accessibility 1.1 — Metadata: accessModeSufficient',
    estimatedTime: null,
  },
  'METADATA-ACCESSIBILITYFEATURE': {
    reason: 'Accessibility feature flags (e.g., structuralNavigation, alternativeText) are deterministic based on what the platform finds in the document.',
    whatPlatformDid: 'Added schema:accessibilityFeature metadata values for all detected accessibility features.',
    whatUserMustDo: null,
    wcagGuidance: 'EPUB Accessibility 1.1 — Metadata: accessibilityFeature',
    estimatedTime: null,
  },
  'METADATA-ACCESSIBILITYHAZARD': {
    reason: 'Hazard declarations (flashing, motion simulation, sound) follow a structured vocabulary. The platform sets "none" when no hazards are detected.',
    whatPlatformDid: 'Added schema:accessibilityHazard metadata. Set to "none" if no hazards were detected.',
    whatUserMustDo: null,
    wcagGuidance: 'EPUB Accessibility 1.1 — Metadata: accessibilityHazard',
    estimatedTime: null,
  },
  'METADATA-ACCESSIBILITYSUMMARY': {
    reason: 'An accessibility summary can be auto-generated from the audit results, describing the document\'s conformance state and any remaining issues.',
    whatPlatformDid: 'Generated a schema:accessibilitySummary based on the audit findings.',
    whatUserMustDo: null,
    wcagGuidance: 'EPUB Accessibility 1.1 — Metadata: accessibilitySummary',
    estimatedTime: null,
  },

  // ─── EPUB Quick-Fixable ───────────────────────────────────────────────────

  'EPUB-IMG-001': {
    reason: 'Alt text must accurately and meaningfully describe the image\'s content and purpose. Only a human who understands the content\'s context can determine whether alt text is appropriate.',
    whatPlatformDid: null,
    whatUserMustDo: 'Review each flagged image and provide a short, descriptive alt text that conveys the image\'s purpose to screen reader users. Decorative images should receive empty alt text (alt="").',
    wcagGuidance: 'WCAG 2.1 SC 1.1.1 — Non-text Content',
    estimatedTime: '2–5 minutes per image',
  },
  'IMG-001': {
    reason: 'Alt text must accurately and meaningfully describe the image\'s content and purpose. Only a human who understands the content\'s context can determine whether alt text is appropriate.',
    whatPlatformDid: null,
    whatUserMustDo: 'Review each flagged image and provide a short, descriptive alt text that conveys the image\'s purpose to screen reader users. Decorative images should receive empty alt text (alt="").',
    wcagGuidance: 'WCAG 2.1 SC 1.1.1 — Non-text Content',
    estimatedTime: '2–5 minutes per image',
  },
  'ACE-IMG-001': {
    reason: 'Alt text quality cannot be assessed without understanding the document\'s subject matter and the image\'s communicative intent.',
    whatPlatformDid: null,
    whatUserMustDo: 'Open the quick-fix panel to review each image and enter appropriate alt text. Check that the description conveys the same information a sighted reader would obtain.',
    wcagGuidance: 'WCAG 2.1 SC 1.1.1 — Non-text Content',
    estimatedTime: '2–5 minutes per image',
  },
  'EPUB-STRUCT-002': {
    reason: 'Table header relationships depend on the table\'s logical structure. The platform detected the missing headers but needs you to confirm which cells should serve as headers before applying the fix.',
    whatPlatformDid: null,
    whatUserMustDo: 'Open the flagged table and add <th> elements (with scope="col" or scope="row") to identify header cells. Apply the change in the quick-fix panel or edit the source file directly.',
    wcagGuidance: 'WCAG 2.1 SC 1.3.1 — Info and Relationships',
    estimatedTime: '2–5 minutes per table',
  },
  'EPUB-SEM-003': {
    reason: 'Semantic role assignment depends on editorial intent that automation cannot infer from structure alone.',
    whatPlatformDid: null,
    whatUserMustDo: 'Use the quick-fix panel to select the correct epub:type semantic role for the flagged element.',
    wcagGuidance: 'WCAG 2.1 SC 1.3.1 — Info and Relationships',
    estimatedTime: '1–2 minutes per element',
  },
  'LANDMARK-UNIQUE': {
    reason: 'Duplicate landmarks (e.g., two `<nav>` elements without distinct labels) cannot be disambiguated without knowing the author\'s intent for each region.',
    whatPlatformDid: null,
    whatUserMustDo: 'Add an aria-label to each duplicate landmark to distinguish them (e.g., aria-label="Table of Contents" and aria-label="Chapter Navigation").',
    wcagGuidance: 'WCAG 2.1 SC 1.3.1 — Info and Relationships',
    estimatedTime: '1–2 minutes',
  },
  'EPUB-TYPE-HAS-MATCHING-ROLE': {
    reason: 'The epub:type and ARIA role on this element are mismatched. Resolving this requires understanding which role accurately reflects the element\'s function in the document.',
    whatPlatformDid: null,
    whatUserMustDo: 'Use the quick-fix panel to align the epub:type and ARIA role. Choose the role that best describes the element\'s purpose for assistive technology users.',
    wcagGuidance: 'EPUB Accessibility 1.1 — ARIA Authoring Guide',
    estimatedTime: '1–2 minutes per element',
  },
  'COLOR-CONTRAST': {
    reason: 'Color contrast failures require choosing new colors that meet the WCAG 4.5:1 ratio (AA) or 7:1 (AAA). The correct color choice depends on the document\'s visual design decisions.',
    whatPlatformDid: null,
    whatUserMustDo: 'Use the quick-fix panel to select a color combination that passes the contrast ratio. A contrast checker is provided to help you find compliant colors.',
    wcagGuidance: 'WCAG 2.1 SC 1.4.3 — Contrast (Minimum)',
    estimatedTime: '2–5 minutes per instance',
  },
  'EPUB-CONTRAST-001': {
    reason: 'Color contrast failures require editorial decisions about which colors to use. The platform cannot select replacement colors that match your design intent.',
    whatPlatformDid: null,
    whatUserMustDo: 'Review the flagged elements and update the color values to achieve a minimum contrast ratio of 4.5:1 against the background.',
    wcagGuidance: 'WCAG 2.1 SC 1.4.3 — Contrast (Minimum)',
    estimatedTime: '2–5 minutes per instance',
  },

  // ─── PDF Auto-Fixable ─────────────────────────────────────────────────────

  'MATTERHORN-01-001': {
    reason: 'The PDF "Marked" flag is a single bit in the document\'s MarkInfo dictionary. Setting it to true is a fully automated, non-destructive operation.',
    whatPlatformDid: 'Set the Marked flag to true in the PDF\'s MarkInfo dictionary, indicating the document contains tagged content.',
    whatUserMustDo: null,
    wcagGuidance: 'PDF/UA-1 (ISO 14289-1) — Clause 7.1',
    estimatedTime: null,
  },
  'MATTERHORN-01-002': {
    reason: 'The DisplayDocTitle flag controls whether the viewer\'s title bar shows the document title. Enabling it is a single, automated operation.',
    whatPlatformDid: 'Set DisplayDocTitle to true in the PDF\'s ViewerPreferences dictionary.',
    whatUserMustDo: null,
    wcagGuidance: 'PDF/UA-1 (ISO 14289-1) — Clause 7.1; WCAG 2.1 SC 2.4.2',
    estimatedTime: null,
  },
  'MATTERHORN-01-005': {
    reason: 'The Suspects flag indicates whether the tag structure was automatically inferred. Clearing it is a deterministic metadata operation.',
    whatPlatformDid: 'Cleared the Suspects flag in the PDF\'s MarkInfo dictionary.',
    whatUserMustDo: null,
    wcagGuidance: 'PDF/UA-1 (ISO 14289-1) — Clause 7.1',
    estimatedTime: null,
  },

  // ─── PDF Quick-Fixable ────────────────────────────────────────────────────

  'MATTERHORN-11-001': {
    reason: 'The document language must be specified in the PDF metadata, but the correct value depends on the document\'s actual language — a content decision the platform cannot make automatically.',
    whatPlatformDid: null,
    whatUserMustDo: 'Enter the document\'s language in the quick-fix panel (e.g., "en-US", "fr-FR"). This will be written to the PDF\'s document catalog.',
    wcagGuidance: 'WCAG 2.1 SC 3.1.1 — Language of Page; PDF/UA-1 Clause 7.2',
    estimatedTime: '1 minute',
  },
  'PDF-NO-LANGUAGE': {
    reason: 'The document language is missing from the PDF metadata. Only you know the correct language for this document.',
    whatPlatformDid: null,
    whatUserMustDo: 'Specify the document language in the quick-fix panel (BCP 47 language tag, e.g., "en", "en-GB").',
    wcagGuidance: 'WCAG 2.1 SC 3.1.1 — Language of Page',
    estimatedTime: '1 minute',
  },
  'MATTERHORN-01-003': {
    reason: 'The document title must appear in the PDF metadata. The correct title is a content decision only the author can make.',
    whatPlatformDid: null,
    whatUserMustDo: 'Enter the document title in the quick-fix panel. This will be written to the PDF\'s document info dictionary and XMP metadata.',
    wcagGuidance: 'WCAG 2.1 SC 2.4.2 — Page Titled; PDF/UA-1 Clause 7.1',
    estimatedTime: '1 minute',
  },
  'WCAG-2.4.2': {
    reason: 'A descriptive document title is required but depends on the document\'s content and purpose — only the author can provide an accurate title.',
    whatPlatformDid: null,
    whatUserMustDo: 'Enter a descriptive title for the document in the quick-fix panel.',
    wcagGuidance: 'WCAG 2.1 SC 2.4.2 — Page Titled',
    estimatedTime: '1 minute',
  },
  'PDF-NO-TITLE': {
    reason: 'The document title is missing. Providing the correct title requires knowing the document\'s intended title — automation cannot determine this.',
    whatPlatformDid: null,
    whatUserMustDo: 'Enter the document title in the quick-fix panel.',
    wcagGuidance: 'WCAG 2.1 SC 2.4.2 — Page Titled',
    estimatedTime: '1 minute',
  },
  'PDF-NO-CREATOR': {
    reason: 'Creator metadata is informational and depends on the document\'s provenance. Only the author can provide the correct value.',
    whatPlatformDid: null,
    whatUserMustDo: 'Enter the document creator/author in the quick-fix panel.',
    wcagGuidance: 'PDF/UA-1 — Document metadata best practices',
    estimatedTime: '1 minute',
  },
};

// ---------------------------------------------------------------------------
// Category-level fallback explanations
// ---------------------------------------------------------------------------

const CATEGORY_FALLBACK: Record<IssueCategory, Omit<IssueExplanation, 'fixType'>> = {
  'alt-text': {
    reason: 'Alt text must accurately describe the image\'s content and purpose in context. Only a human who understands the subject matter can judge whether the description is accurate and meaningful.',
    whatPlatformDid: null,
    whatUserMustDo: 'Review each flagged image and provide descriptive alt text. Decorative images should have empty alt text (alt="").',
    wcagGuidance: 'WCAG 2.1 SC 1.1.1 — Non-text Content',
    estimatedTime: '2–5 minutes per image',
  },
  'color-contrast': {
    reason: 'Color contrast failures require selecting new foreground/background color combinations that meet WCAG ratio requirements. The correct choice depends on the document\'s visual design.',
    whatPlatformDid: null,
    whatUserMustDo: 'Update the flagged text or background colors to achieve a minimum 4.5:1 contrast ratio (or 3:1 for large text). Use the contrast checker in the quick-fix panel.',
    wcagGuidance: 'WCAG 2.1 SC 1.4.3 — Contrast (Minimum)',
    estimatedTime: '2–5 minutes per instance',
  },
  'heading-hierarchy': {
    reason: 'Heading structure reflects the document\'s information architecture. Determining the correct heading level requires understanding the content\'s logical outline.',
    whatPlatformDid: null,
    whatUserMustDo: 'Review the document\'s heading structure. Ensure headings follow a logical hierarchy (H1 → H2 → H3) without skipping levels.',
    wcagGuidance: 'WCAG 2.1 SC 1.3.1 — Info and Relationships; SC 2.4.6 — Headings and Labels',
    estimatedTime: '5–15 minutes',
  },
  'link-text': {
    reason: 'Descriptive link text depends on what the link destination contains and the surrounding context. Automation cannot determine what a meaningful description should be.',
    whatPlatformDid: null,
    whatUserMustDo: 'Replace vague link text ("click here", "read more") with text that describes the link\'s destination or purpose.',
    wcagGuidance: 'WCAG 2.1 SC 2.4.4 — Link Purpose (In Context)',
    estimatedTime: '1–3 minutes per link',
  },
  'table-headers': {
    reason: 'Table header relationships depend on the table\'s logical structure and the author\'s intent for how rows/columns relate. Automation cannot reliably infer complex table semantics.',
    whatPlatformDid: null,
    whatUserMustDo: 'Add <th> elements with appropriate scope attributes ("col" or "row") to define header cells. Add id/headers attributes for complex tables.',
    wcagGuidance: 'WCAG 2.1 SC 1.3.1 — Info and Relationships',
    estimatedTime: '5–20 minutes per table',
  },
  'language': {
    reason: 'Language declarations require knowing the actual language of each content section. The platform cannot determine what language the text is written in without content analysis.',
    whatPlatformDid: null,
    whatUserMustDo: 'Add lang attributes to elements where the language differs from the document\'s primary language (e.g., lang="fr" for French passages).',
    wcagGuidance: 'WCAG 2.1 SC 3.1.1 — Language of Page; SC 3.1.2 — Language of Parts',
    estimatedTime: '1–2 minutes per instance',
  },
  'aria': {
    reason: 'ARIA role and attribute corrections require understanding the element\'s interactive behavior and how it should be announced to assistive technology users.',
    whatPlatformDid: null,
    whatUserMustDo: 'Review the flagged ARIA usage and correct roles or attributes to match the element\'s actual behavior and purpose.',
    wcagGuidance: 'WCAG 2.1 SC 4.1.2 — Name, Role, Value',
    estimatedTime: '2–5 minutes per element',
  },
  'reading-order': {
    reason: 'Logical reading order reflects the intended flow of the document. Only the author can determine the correct sequence for complex layouts.',
    whatPlatformDid: null,
    whatUserMustDo: 'Review the document\'s source order and adjust it to match the intended reading sequence. Use CSS for visual positioning without changing source order.',
    wcagGuidance: 'WCAG 2.1 SC 1.3.2 — Meaningful Sequence',
    estimatedTime: '10–30 minutes',
  },
  'metadata': {
    reason: 'This metadata field requires a value that reflects the document\'s actual properties — something only the author or publisher can provide.',
    whatPlatformDid: null,
    whatUserMustDo: 'Open the EPUB package document (content.opf) and supply the correct value for the flagged metadata field. Refer to the EPUB Accessibility specification for the expected format.',
    wcagGuidance: 'EPUB Accessibility 1.1 — Metadata requirements',
    estimatedTime: '1–5 minutes',
  },
  'duplicate-id': {
    reason: 'Duplicate IDs cause assistive technology to behave unpredictably. While auto-detection is straightforward, determining which ID should be retained or renamed requires knowledge of how these IDs are used in links and references.',
    whatPlatformDid: null,
    whatUserMustDo: 'Review the flagged duplicate IDs and rename or remove the duplicates. Ensure any links or references pointing to these IDs are updated accordingly.',
    wcagGuidance: 'WCAG 2.1 SC 4.1.1 — Parsing',
    estimatedTime: '2–5 minutes per duplicate',
  },
  'page-list': {
    reason: 'Page list navigation depends on the document\'s intended pagination structure, which the author must define.',
    whatPlatformDid: null,
    whatUserMustDo: 'Review and correct the page list structure in the navigation document.',
    wcagGuidance: 'EPUB Accessibility 1.1 — Navigation',
    estimatedTime: '5–15 minutes',
  },
  'timing': {
    reason: 'Time-based media (audio, video, animations) require captions, transcripts, or audio descriptions that accurately reflect the media content. Only a human can create these.',
    whatPlatformDid: null,
    whatUserMustDo: 'Provide captions or a transcript for the flagged time-based media. Ensure all spoken content and important sounds are described.',
    wcagGuidance: 'WCAG 2.1 SC 1.2.1 — Audio-only and Video-only; SC 1.2.2 — Captions (Prerecorded)',
    estimatedTime: '15–60 minutes per media item',
  },
  'keyboard': {
    reason: 'Keyboard accessibility depends on the interactive behavior of components. Only a human testing with a keyboard can verify all functionality is reachable and operable.',
    whatPlatformDid: null,
    whatUserMustDo: 'Test all interactive elements using only a keyboard (Tab, Enter, Space, arrow keys). Ensure all functionality is accessible without a mouse.',
    wcagGuidance: 'WCAG 2.1 SC 2.1.1 — Keyboard',
    estimatedTime: '15–30 minutes',
  },
  'focus': {
    reason: 'Focus order and visibility depend on the document\'s interaction design. Manual testing with a keyboard is required to verify that focus moves logically.',
    whatPlatformDid: null,
    whatUserMustDo: 'Tab through the document and verify that focus moves in a logical order. Ensure all focusable elements have a visible focus indicator.',
    wcagGuidance: 'WCAG 2.1 SC 2.4.3 — Focus Order; SC 2.4.7 — Focus Visible',
    estimatedTime: '10–20 minutes',
  },
  'form-labels': {
    reason: 'Form labels must describe the input\'s purpose in a way that is meaningful to users. While missing labels can be detected, the correct label text depends on the form\'s context.',
    whatPlatformDid: null,
    whatUserMustDo: 'Associate a descriptive <label> element with each form control, or provide an aria-label/aria-labelledby attribute.',
    wcagGuidance: 'WCAG 2.1 SC 1.3.5 — Identify Input Purpose; SC 3.3.2 — Labels or Instructions',
    estimatedTime: '1–3 minutes per form control',
  },
  'other': {
    reason: 'This issue requires human review to assess the correct fix approach in the context of the document.',
    whatPlatformDid: null,
    whatUserMustDo: 'Review the flagged issue and apply the recommended fix based on the WCAG success criteria guidance.',
    wcagGuidance: 'WCAG 2.1 — Refer to the specific criterion listed in the issue details',
    estimatedTime: '5–15 minutes',
  },
};

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

class ExplanationCatalogService {
  /**
   * Get an explanation for an issue code.
   *
   * @param issueCode - The issue code (EPUB or PDF)
   * @param source - Where to source the explanation from
   * @param isPdf - Whether this is a PDF issue (affects fix type lookup)
   * @param geminiGenerateFn - Optional async function for Gemini generation
   */
  async getExplanation(
    issueCode: string,
    source: ExplanationSource,
    isPdf = false,
    geminiGenerateFn?: (code: string, fixType: 'auto' | 'quickfix' | 'manual') => Promise<Partial<IssueExplanation>>
  ): Promise<IssueExplanation> {
    const fixType = this.resolveFixType(issueCode, isPdf);
    const catalogEntry = this.lookupCatalog(issueCode);

    if (catalogEntry) {
      const explanation: IssueExplanation = { fixType, ...catalogEntry };

      // For hybrid: enrich with AI if this is a quick/manual issue and Gemini is available
      if (source === 'hybrid' && fixType !== 'auto' && geminiGenerateFn) {
        try {
          const aiEnrichment = await geminiGenerateFn(issueCode, fixType);
          return { ...explanation, ...aiEnrichment };
        } catch {
          logger.warn(`[ExplanationCatalog] Gemini enrichment failed for ${issueCode}, using catalog fallback`);
          return explanation;
        }
      }

      return explanation;
    }

    // No catalog entry — use Gemini if configured
    if ((source === 'gemini' || source === 'hybrid') && geminiGenerateFn) {
      try {
        const aiExplanation = await geminiGenerateFn(issueCode, fixType);
        return {
          fixType,
          reason: aiExplanation.reason ?? 'This issue requires human review.',
          whatPlatformDid: aiExplanation.whatPlatformDid ?? null,
          whatUserMustDo: aiExplanation.whatUserMustDo ?? null,
          wcagGuidance: aiExplanation.wcagGuidance ?? 'Refer to WCAG 2.1',
          estimatedTime: aiExplanation.estimatedTime ?? null,
        };
      } catch {
        logger.warn(`[ExplanationCatalog] Gemini generation failed for ${issueCode}, using category fallback`);
      }
    }

    // Final fallback: category-level explanation
    return this.getCategoryFallback(issueCode, fixType);
  }

  private resolveFixType(issueCode: string, isPdf: boolean): 'auto' | 'quickfix' | 'manual' {
    if (isPdf) {
      const pdfType = classifyIssueType(issueCode);
      if (pdfType === 'AUTO_FIXABLE') return 'auto';
      if (pdfType === 'QUICK_FIX') return 'quickfix';
      return 'manual';
    }
    return getFixType(issueCode);
  }

  private lookupCatalog(issueCode: string): Omit<IssueExplanation, 'fixType'> | null {
    const normalized = normalizeIssueCode(issueCode);
    return EXPLANATION_CATALOG[normalized] ?? EXPLANATION_CATALOG[issueCode] ?? null;
  }

  private getCategoryFallback(issueCode: string, fixType: 'auto' | 'quickfix' | 'manual'): IssueExplanation {
    const category = categorizeIssue(issueCode);
    const fallback = CATEGORY_FALLBACK[category] ?? CATEGORY_FALLBACK['other'];
    return { fixType, ...fallback };
  }
}

export const explanationCatalogService = new ExplanationCatalogService();
