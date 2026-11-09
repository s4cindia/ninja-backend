/**
 * pdf-modifier.service.ts — Tier 1 manual-fix writers
 *
 * setLinkAltText / setFormFieldTooltip / renameBookmark let an operator's
 * edited (or AI-drafted) value actually get written into the PDF for three
 * suggestion types that were previously guidance-only with no apply path at
 * all. Each operates on a different, unrelated part of the PDF object graph
 * (Link annotations, AcroForm fields, the Outlines/bookmark tree) rather
 * than the structure tree fixHeadingHierarchy etc. mutate.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFString, PDFHexString, PDFDict, PDFRef } from 'pdf-lib';
import { pdfModifierService } from '../../../../src/services/pdf/pdf-modifier.service';
import type { AuditIssue } from '../../../../src/services/audit/base-audit.service';

function baseIssue(overrides: Partial<AuditIssue> = {}): AuditIssue {
  return {
    id: 'issue-1',
    source: 'test',
    severity: 'moderate',
    code: 'TEST-CODE',
    message: 'test',
    ...overrides,
  };
}

describe('setLinkAltText', () => {
  it("sets /Contents on the Link annotation whose Rect matches the issue's position", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    // boundingBox is top-left-origin: y=180,height=20 on a 600pt-tall page ->
    // PDF /Rect (bottom-left-origin) [x, 600-(180+20), x+width, 600-180] = [100,400,300,420]
    const linkRef = doc.context.register(
      doc.context.obj({
        Type: PDFName.of('Annot'),
        Subtype: PDFName.of('Link'),
        Rect: doc.context.obj([100, 400, 300, 420]),
      })
    );
    doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([linkRef]));

    const issue = baseIssue({
      code: 'LINK-GENERIC-TEXT',
      pageNumber: 1,
      boundingBox: { x: 100, y: 180, width: 200, height: 20, pageWidth: 400, pageHeight: 600 },
    });

    const result = await pdfModifierService.setLinkAltText(doc, issue, 'Download the 2024 annual report');

    expect(result.success).toBe(true);
    const linkDict = doc.context.lookup(linkRef) as PDFDict;
    const contents = linkDict.get(PDFName.of('Contents'));
    expect(contents).toBeInstanceOf(PDFHexString);
    expect((contents as PDFHexString).decodeText()).toBe('Download the 2024 annual report');
  });

  it('picks the closest Link annotation when several exist on the page', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const farRef = doc.context.register(
      doc.context.obj({ Subtype: PDFName.of('Link'), Rect: doc.context.obj([0, 0, 20, 20]) })
    );
    const nearRef = doc.context.register(
      doc.context.obj({ Subtype: PDFName.of('Link'), Rect: doc.context.obj([100, 400, 300, 420]) })
    );
    doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([farRef, nearRef]));

    const issue = baseIssue({
      pageNumber: 1,
      boundingBox: { x: 100, y: 180, width: 200, height: 20, pageWidth: 400, pageHeight: 600 },
    });

    const result = await pdfModifierService.setLinkAltText(doc, issue, 'Visit our accessibility guide');
    expect(result.success).toBe(true);

    const nearDict = doc.context.lookup(nearRef) as PDFDict;
    const farDict = doc.context.lookup(farRef) as PDFDict;
    expect((nearDict.get(PDFName.of('Contents')) as PDFHexString).decodeText()).toBe('Visit our accessibility guide');
    expect(farDict.get(PDFName.of('Contents'))).toBeUndefined();
  });

  it('fails when the closest Link annotation is too far from the flagged position (CodeRabbit/Codex finding)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    // 100pt away from the target center -- well past MAX_LINK_MATCH_DISTANCE_PT
    const farRef = doc.context.register(
      doc.context.obj({ Subtype: PDFName.of('Link'), Rect: doc.context.obj([0, 0, 20, 20]) })
    );
    doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([farRef]));

    const issue = baseIssue({
      pageNumber: 1,
      boundingBox: { x: 100, y: 180, width: 200, height: 20, pageWidth: 400, pageHeight: 600 },
    });

    const result = await pdfModifierService.setLinkAltText(doc, issue, 'text');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too far|not close enough|away \(max/i);
    expect((doc.context.lookup(farRef) as PDFDict).get(PDFName.of('Contents'))).toBeUndefined();
  });

  it('fails when two Link annotations are ambiguously close to the flagged position (CodeRabbit/Codex finding)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    // Both within a few points of the target center -- neither is clearly the right one.
    const aRef = doc.context.register(
      doc.context.obj({ Subtype: PDFName.of('Link'), Rect: doc.context.obj([100, 400, 300, 420]) })
    );
    const bRef = doc.context.register(
      doc.context.obj({ Subtype: PDFName.of('Link'), Rect: doc.context.obj([103, 400, 303, 420]) })
    );
    doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([aRef, bRef]));

    const issue = baseIssue({
      pageNumber: 1,
      boundingBox: { x: 100, y: 180, width: 200, height: 20, pageWidth: 400, pageHeight: 600 },
    });

    const result = await pdfModifierService.setLinkAltText(doc, issue, 'text');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/ambiguous|multiple/i);
    expect((doc.context.lookup(aRef) as PDFDict).get(PDFName.of('Contents'))).toBeUndefined();
    expect((doc.context.lookup(bRef) as PDFDict).get(PDFName.of('Contents'))).toBeUndefined();
  });

  it('fails gracefully when the issue has no pageNumber at all', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const result = await pdfModifierService.setLinkAltText(doc, baseIssue({}), 'text');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/pageNumber/);
  });

  it('falls back to the sole undescribed Link annotation when the issue has no boundingBox (pdfa11y-sourced issues carry no position data)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const linkRef = doc.context.register(
      doc.context.obj({ Subtype: PDFName.of('Link'), Rect: doc.context.obj([100, 400, 300, 420]) })
    );
    doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([linkRef]));

    const result = await pdfModifierService.setLinkAltText(doc, baseIssue({ pageNumber: 1 }), 'Enrollment form');

    expect(result.success).toBe(true);
    const linkDict = doc.context.lookup(linkRef) as PDFDict;
    expect((linkDict.get(PDFName.of('Contents')) as PDFHexString).decodeText()).toBe('Enrollment form');
  });

  it('fails when the issue has no boundingBox and no undescribed Link annotation is found (nothing to disambiguate)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const result = await pdfModifierService.setLinkAltText(doc, baseIssue({ pageNumber: 1 }), 'text');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/found 0/);
  });

  it('fails when the issue has no boundingBox and multiple undescribed Link annotations exist (ambiguous, nothing to disambiguate by)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const aRef = doc.context.register(doc.context.obj({ Subtype: PDFName.of('Link'), Rect: doc.context.obj([0, 0, 20, 20]) }));
    const bRef = doc.context.register(doc.context.obj({ Subtype: PDFName.of('Link'), Rect: doc.context.obj([100, 400, 300, 420]) }));
    doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([aRef, bRef]));

    const result = await pdfModifierService.setLinkAltText(doc, baseIssue({ pageNumber: 1 }), 'text');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/found 2/);
    expect((doc.context.lookup(aRef) as PDFDict).get(PDFName.of('Contents'))).toBeUndefined();
    expect((doc.context.lookup(bRef) as PDFDict).get(PDFName.of('Contents'))).toBeUndefined();
  });

  it('fails gracefully when the page has no Link annotations', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const issue = baseIssue({
      pageNumber: 1,
      boundingBox: { x: 100, y: 180, width: 200, height: 20, pageWidth: 400, pageHeight: 600 },
    });
    const result = await pdfModifierService.setLinkAltText(doc, issue, 'text');
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no \/Annots|No Link annotation/);
  });
});

describe('findLinksMissingContents', () => {
  it('returns only Link annotations whose /Contents is absent, ignoring other Subtypes and already-described links', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const undescribedRef = doc.context.register(doc.context.obj({ Subtype: PDFName.of('Link') }));
    const describedRef = doc.context.register(
      doc.context.obj({ Subtype: PDFName.of('Link'), Contents: PDFHexString.fromText('Already described') })
    );
    const widgetRef = doc.context.register(doc.context.obj({ Subtype: PDFName.of('Widget') }));
    doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([undescribedRef, describedRef, widgetRef]));

    const results = pdfModifierService.findLinksMissingContents(doc, 1);
    expect(results).toHaveLength(1);
    // pdf-lib's context.lookup returns the same canonical object instance
    // for the same ref -- identity comparison confirms it's the undescribed
    // one, not the already-described or Widget sibling.
    expect(results[0]).toBe(doc.context.lookup(undescribedRef));
  });

  it('returns an empty array for a page with no /Annots', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    expect(pdfModifierService.findLinksMissingContents(doc, 1)).toEqual([]);
  });

  it('returns an empty array for an out-of-range page number', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    expect(pdfModifierService.findLinksMissingContents(doc, 99)).toEqual([]);
  });
});

describe('getLinkUri', () => {
  it("extracts a Link annotation's /A /URI", async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const linkDict = doc.context.obj({
      Subtype: PDFName.of('Link'),
      A: doc.context.obj({ S: PDFName.of('URI'), URI: PDFString.of('https://example.com/enroll') }),
    }) as PDFDict;

    expect(pdfModifierService.getLinkUri(doc, linkDict)).toBe('https://example.com/enroll');
  });

  it('returns null when the Link has no /A action (e.g. a GoTo or no action at all)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);
    const linkDict = doc.context.obj({ Subtype: PDFName.of('Link') }) as PDFDict;

    expect(pdfModifierService.getLinkUri(doc, linkDict)).toBeNull();
  });
});

describe('setFormFieldTooltip', () => {
  it('sets /TU on the AcroForm field matching by name', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const fieldRef = doc.context.register(
      doc.context.obj({ FT: PDFName.of('Tx'), T: PDFString.of('email_address') })
    );
    const acroFormRef = doc.context.register(doc.context.obj({ Fields: doc.context.obj([fieldRef]) }));
    doc.catalog.set(PDFName.of('AcroForm'), acroFormRef);

    const issue = baseIssue({
      code: 'FORM-FIELD-NO-LABEL',
      context: 'Field name: "email_address", Type: text',
    });

    const result = await pdfModifierService.setFormFieldTooltip(doc, issue, 'Enter your email address');

    expect(result.success).toBe(true);
    const fieldDict = doc.context.lookup(fieldRef) as PDFDict;
    expect((fieldDict.get(PDFName.of('TU')) as PDFHexString).decodeText()).toBe('Enter your email address');
  });

  it('finds a hierarchical field by its fully qualified name (Codex finding)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    // Terminal "email" widget nested under a "person" parent field --
    // pdf-form.validator.ts (via pdf.js) reports this as "person.email".
    const emailRef = doc.context.register(doc.context.obj({ FT: PDFName.of('Tx'), T: PDFString.of('email') }));
    const personRef = doc.context.register(
      doc.context.obj({ T: PDFString.of('person'), Kids: doc.context.obj([emailRef]) })
    );
    const acroFormRef = doc.context.register(doc.context.obj({ Fields: doc.context.obj([personRef]) }));
    doc.catalog.set(PDFName.of('AcroForm'), acroFormRef);

    const issue = baseIssue({ context: 'Field name: "person.email", Type: text' });
    const result = await pdfModifierService.setFormFieldTooltip(doc, issue, 'Enter your email address');

    expect(result.success).toBe(true);
    const emailDict = doc.context.lookup(emailRef) as PDFDict;
    expect((emailDict.get(PDFName.of('TU')) as PDFHexString).decodeText()).toBe('Enter your email address');
    // The parent itself must stay untouched.
    expect((doc.context.lookup(personRef) as PDFDict).get(PDFName.of('TU'))).toBeUndefined();
  });

  it('fails cleanly for a field with no /T at all, rather than matching the wrong one (CodeRabbit/Codex finding)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const fieldRef = doc.context.register(doc.context.obj({ FT: PDFName.of('Tx') }));
    const acroFormRef = doc.context.register(doc.context.obj({ Fields: doc.context.obj([fieldRef]) }));
    doc.catalog.set(PDFName.of('AcroForm'), acroFormRef);

    const issue = baseIssue({ context: 'Field name: "(unnamed)", Type: text' });
    const result = await pdfModifierService.setFormFieldTooltip(doc, issue, 'text');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no \/T|cannot be located/i);
    expect((doc.context.lookup(fieldRef) as PDFDict).get(PDFName.of('TU'))).toBeUndefined();
  });

  it('fails gracefully when no field matches the name', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const acroFormRef = doc.context.register(doc.context.obj({ Fields: doc.context.obj([]) }));
    doc.catalog.set(PDFName.of('AcroForm'), acroFormRef);

    const issue = baseIssue({ context: 'Field name: "missing_field", Type: text' });
    const result = await pdfModifierService.setFormFieldTooltip(doc, issue, 'text');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No field named/);
  });

  it('fails gracefully when the document has no AcroForm', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const issue = baseIssue({ context: 'Field name: "x", Type: text' });
    const result = await pdfModifierService.setFormFieldTooltip(doc, issue, 'text');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/AcroForm/);
  });
});

describe('renameBookmark', () => {
  it('renames a top-level bookmark by matching its current title', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const itemRef = doc.context.register(doc.context.obj({ Title: PDFHexString.fromText('Chapter 1') }));
    const outlinesRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('Outlines'), First: itemRef, Last: itemRef, Count: 1 })
    );
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);

    const issue = baseIssue({ code: 'BOOKMARK-GENERIC-TEXT', context: 'Bookmark title: "Chapter 1"' });
    const result = await pdfModifierService.renameBookmark(doc, issue, 'Introduction to Market Structure');

    expect(result.success).toBe(true);
    const itemDict = doc.context.lookup(itemRef) as PDFDict;
    expect((itemDict.get(PDFName.of('Title')) as PDFHexString).decodeText()).toBe('Introduction to Market Structure');
  });

  it('finds and renames a nested (child) bookmark, not just top-level siblings', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const childRef = doc.context.register(doc.context.obj({ Title: PDFHexString.fromText('Section 1.1') }));
    const parentRef = doc.context.register(
      doc.context.obj({ Title: PDFHexString.fromText('Chapter 1'), First: childRef, Last: childRef, Count: 1 })
    );
    const outlinesRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('Outlines'), First: parentRef, Last: parentRef, Count: 1 })
    );
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);

    const issue = baseIssue({ context: 'Bookmark title: "Section 1.1"' });
    const result = await pdfModifierService.renameBookmark(doc, issue, 'Market Definitions');

    expect(result.success).toBe(true);
    const childDict = doc.context.lookup(childRef) as PDFDict;
    expect((childDict.get(PDFName.of('Title')) as PDFHexString).decodeText()).toBe('Market Definitions');
    // Sibling/parent untouched
    const parentDict = doc.context.lookup(parentRef) as PDFDict;
    expect((parentDict.get(PDFName.of('Title')) as PDFHexString).decodeText()).toBe('Chapter 1');
  });

  it('walks sibling chains via /Next to find a second top-level bookmark', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const secondRef: PDFRef = doc.context.register(doc.context.obj({ Title: PDFHexString.fromText('Chapter 2') }));
    const firstRef = doc.context.register(
      doc.context.obj({ Title: PDFHexString.fromText('Chapter 1'), Next: secondRef })
    );
    (doc.context.lookup(secondRef) as PDFDict).set(PDFName.of('Prev'), firstRef);
    const outlinesRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('Outlines'), First: firstRef, Last: secondRef, Count: 2 })
    );
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);

    const issue = baseIssue({ context: 'Bookmark title: "Chapter 2"' });
    const result = await pdfModifierService.renameBookmark(doc, issue, 'Market Overview');

    expect(result.success).toBe(true);
    const secondDict = doc.context.lookup(secondRef) as PDFDict;
    expect((secondDict.get(PDFName.of('Title')) as PDFHexString).decodeText()).toBe('Market Overview');
  });

  it('fails gracefully when no bookmark matches the title', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const itemRef = doc.context.register(doc.context.obj({ Title: PDFHexString.fromText('Chapter 1') }));
    const outlinesRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('Outlines'), First: itemRef, Last: itemRef, Count: 1 })
    );
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);

    const issue = baseIssue({ context: 'Bookmark title: "Does Not Exist"' });
    const result = await pdfModifierService.renameBookmark(doc, issue, 'New Title');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/No bookmark titled/);
  });

  it('fails gracefully when the document has no Outlines', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const issue = baseIssue({ context: 'Bookmark title: "Chapter 1"' });
    const result = await pdfModifierService.renameBookmark(doc, issue, 'New Title');

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Outlines/);
  });

  it('refuses to rename when multiple bookmarks share the flagged title, rather than guessing the first match (CodeRabbit/Codex finding)', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const firstRef: PDFRef = doc.context.register(doc.context.obj({ Title: PDFHexString.fromText('Section') }));
    const secondRef = doc.context.register(
      doc.context.obj({ Title: PDFHexString.fromText('Section'), Prev: firstRef })
    );
    (doc.context.lookup(firstRef) as PDFDict).set(PDFName.of('Next'), secondRef);
    const outlinesRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('Outlines'), First: firstRef, Last: secondRef, Count: 2 })
    );
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);

    const issue = baseIssue({ context: 'Bookmark title: "Section"' });
    const result = await pdfModifierService.renameBookmark(doc, issue, 'Market Definitions');

    expect(result.success).toBe(false);
    expect(result.description).toMatch(/ambiguous/i);
    expect((doc.context.lookup(firstRef) as PDFDict).get(PDFName.of('Title'))?.toString()).not.toContain(
      'Market Definitions'
    );
  });

  it('matches an empty-titled bookmark via the "(empty)" context placeholder pdf-bookmark.validator.ts writes', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([400, 600]);

    const itemRef = doc.context.register(doc.context.obj({ Title: PDFHexString.fromText('') }));
    const outlinesRef = doc.context.register(
      doc.context.obj({ Type: PDFName.of('Outlines'), First: itemRef, Last: itemRef, Count: 1 })
    );
    doc.catalog.set(PDFName.of('Outlines'), outlinesRef);

    const issue = baseIssue({ context: 'Bookmark title: "(empty)"' });
    const result = await pdfModifierService.renameBookmark(doc, issue, 'Chapter 3: Financial Risk Assessment');

    expect(result.success).toBe(true);
    const itemDict = doc.context.lookup(itemRef) as PDFDict;
    expect((itemDict.get(PDFName.of('Title')) as PDFHexString).decodeText()).toBe(
      'Chapter 3: Financial Risk Assessment'
    );
  });
});
