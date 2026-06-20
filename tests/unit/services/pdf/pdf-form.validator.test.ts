/**
 * Tests for PDF Form Field Validator
 *
 * Focuses on accessible-label detection and on the boundingBox geometry that
 * drives issue highlighting in the frontend PDF preview.
 */

import { describe, it, expect } from 'vitest';
import { pdfFormValidator } from '../../../../src/services/pdf/validators/pdf-form.validator';
import { PdfParseResult, PdfFormField } from '../../../../src/services/pdf/pdf-comprehensive-parser.service';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

function makeParsed(formFields: PdfFormField[]): PdfParseResult {
  return {
    metadata: {
      pdfVersion: '1.7',
      isEncrypted: false,
      isLinearized: false,
      isTagged: true,
      hasOutline: false,
      hasAcroForm: true,
      hasXFA: false,
      pageCount: 1,
      hasStructureTree: true,
    },
    pages: [
      {
        pageNumber: 1,
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        rotation: 0,
        content: [],
        images: [],
        links: [],
        formFields,
        headings: [],
        tables: [],
        lists: [],
      },
    ],
    isTagged: true,
  } as unknown as PdfParseResult;
}

function makeField(overrides: Partial<PdfFormField> = {}): PdfFormField {
  return {
    name: 'field1', // generic name → triggers FORM-FIELD-NO-LABEL when unlabeled
    type: 'text',
    label: '',
    value: '',
    required: false,
    // pdfjs rect convention: bottom-left origin, position.y is the BOTTOM edge
    position: { x: 100, y: 700, width: 200, height: 20 },
    ...overrides,
  };
}

describe('PdfFormValidator', () => {
  it('flags an unlabeled, generically-named field', async () => {
    const issues = await pdfFormValidator.validate(makeParsed([makeField()]));
    expect(issues).toHaveLength(1);
    expect(issues[0].code).toBe('FORM-FIELD-NO-LABEL');
  });

  it('attaches a top-left-origin boundingBox derived from field.position', async () => {
    const issues = await pdfFormValidator.validate(makeParsed([makeField()]));
    const box = issues[0].boundingBox;

    expect(box).toBeDefined();
    // y is flipped from the bottom-left rect: pageHeight - (y + height) = 792 - 720 = 72
    expect(box).toEqual({
      x: 100,
      y: 72,
      width: 200,
      height: 20,
      pageWidth: PAGE_WIDTH,
      pageHeight: PAGE_HEIGHT,
    });
  });

  it('omits boundingBox when the field has a zero-area rect', async () => {
    const issues = await pdfFormValidator.validate(
      makeParsed([makeField({ position: { x: 0, y: 0, width: 0, height: 0 } })])
    );
    expect(issues).toHaveLength(1);
    expect(issues[0].boundingBox).toBeUndefined();
  });
});
