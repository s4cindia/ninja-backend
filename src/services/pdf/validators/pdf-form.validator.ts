/**
 * PDF Form Field Validator
 *
 * Validates that interactive form fields have accessible labels/tooltips
 * so screen reader users can understand what to enter in each field.
 *
 * WCAG 1.3.1 (Info and Relationships) - Level A
 * WCAG 4.1.2 (Name, Role, Value) - Level A
 * PDF/UA: Form fields must have a tooltip (TU entry)
 */

import { AuditIssue } from '../../audit/base-audit.service';
import { PdfParseResult, PdfFormField } from '../pdf-comprehensive-parser.service';
import { logger } from '../../../lib/logger';

// Generic/auto-generated field name patterns
const GENERIC_NAME_RE = /^(field|text|input|form|widget|textbox|checkbox|radio|button)[\s_-]?\d*$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NUMERIC_ONLY_RE = /^\d+$/;

class PdfFormValidator {
  name = 'PdfFormValidator';
  private issueCounter = 0;

  async validate(parsed: PdfParseResult): Promise<AuditIssue[]> {
    logger.info('[PdfFormValidator] Starting form field validation...');
    this.issueCounter = 0;
    const issues: AuditIssue[] = [];

    let totalFields = 0;
    for (const page of parsed.pages) {
      totalFields += page.formFields.length;
      for (const field of page.formFields) {
        const issue = this.checkField(field, page.pageNumber);
        if (issue) issues.push(issue);
      }
    }

    if (totalFields === 0) {
      logger.info('[PdfFormValidator] No form fields found — skipping');
      return [];
    }

    logger.info(`[PdfFormValidator] Checked ${totalFields} form fields, found ${issues.length} issue(s)`);
    return issues;
  }

  private checkField(field: PdfFormField, pageNumber: number): AuditIssue | null {
    const label = (field.label ?? '').trim();
    const name = (field.name ?? '').trim();

    const hasNoLabel = !label;
    const hasGenericLabel = label
      ? (GENERIC_NAME_RE.test(label) || UUID_RE.test(label) || NUMERIC_ONLY_RE.test(label))
      : false;
    const hasGenericName = name
      ? (GENERIC_NAME_RE.test(name) || UUID_RE.test(name) || NUMERIC_ONLY_RE.test(name))
      : true;

    if (hasNoLabel && hasGenericName) {
      // Worst case: no tooltip and the field name itself is also non-descriptive
      return {
        id: `form-${++this.issueCounter}`,
        source: 'form-validator',
        severity: 'serious',
        code: 'FORM-FIELD-NO-LABEL',
        message: `Form field "${name || '(unnamed)'}" (${field.type}) has no accessible label`,
        wcagCriteria: ['1.3.1', '4.1.2'],
        location: `Page ${pageNumber} at (${Math.round(field.position.x)}, ${Math.round(field.position.y)})`,
        category: 'forms',
        suggestion:
          'Add a tooltip (TU entry) to this form field in Acrobat Pro (Form Edit mode → field properties → Tooltip tab) ' +
          'or set a descriptive field name in the authoring tool.',
        context: `Field name: "${name || '(unnamed)'}", Type: ${field.type}`,
        pageNumber,
      };
    }

    if (hasNoLabel && !hasGenericName) {
      // Has a descriptive field name but no tooltip — still an issue because tooltip is preferred
      return {
        id: `form-${++this.issueCounter}`,
        source: 'form-validator',
        severity: 'moderate',
        code: 'FORM-FIELD-MISSING-TOOLTIP',
        message: `Form field "${name}" (${field.type}) has no tooltip — screen readers may only announce the field name`,
        wcagCriteria: ['4.1.2'],
        location: `Page ${pageNumber} at (${Math.round(field.position.x)}, ${Math.round(field.position.y)})`,
        category: 'forms',
        suggestion:
          'Add a descriptive tooltip to this field in Acrobat Pro (Form Edit mode → field properties → Tooltip tab). ' +
          'The tooltip provides the accessible name read by screen readers.',
        context: `Field name: "${name}", Type: ${field.type}`,
        pageNumber,
      };
    }

    if (hasGenericLabel) {
      // Has a tooltip but it's a generic/auto-generated value
      return {
        id: `form-${++this.issueCounter}`,
        source: 'form-validator',
        severity: 'moderate',
        code: 'FORM-FIELD-MISSING-TOOLTIP',
        message: `Form field "${name}" (${field.type}) has a generic tooltip: "${label}"`,
        wcagCriteria: ['4.1.2'],
        location: `Page ${pageNumber} at (${Math.round(field.position.x)}, ${Math.round(field.position.y)})`,
        category: 'forms',
        suggestion:
          `Replace the generic tooltip "${label}" with a descriptive label that explains what the user should enter ` +
          '(e.g., "Enter your full legal name" instead of "Field1").',
        context: `Field name: "${name}", Tooltip: "${label}", Type: ${field.type}`,
        pageNumber,
      };
    }

    return null;
  }
}

export const pdfFormValidator = new PdfFormValidator();
