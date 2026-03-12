/**
 * Matterhorn Protocol 1.1 — Complete Condition Reference
 *
 * Source:  Matterhorn Protocol 1.1, PDF Association, 2021 (CC-BY-4.0)
 * Extracted from: docs/matterhorn-1.1-reference.md (2026-03-10)
 *
 * Total: 137 conditions (87 M + 47 H + 3 --)
 * Note: The spec intro states 136; the correct count is 137.
 * Condition 13-008 was added in v1.1 without updating the intro paragraph.
 */

export type MatterhornHow = 'M' | 'H' | '--';

export interface MatterhornCondition {
  /** Condition identifier, e.g. "13-004" */
  id: string;
  /** Checkpoint number as two-digit string, e.g. "13" */
  checkpoint: string;
  /** Checkpoint title */
  title: string;
  /** Exact failure condition text from the Matterhorn Protocol 1.1 spec */
  description: string;
  /** PDF/UA-1 clause reference */
  section: string;
  /** Scope: Doc | Page | Object | JS | All */
  type: string;
  /** Machine-checkable (M), Human-only (H), or no specific test (--) */
  how: MatterhornHow;
  /** Cross-reference to related conditions (empty if none) */
  see?: string;
}

/** All 137 Matterhorn Protocol 1.1 conditions, keyed by condition ID */
export const MATTERHORN_CONDITIONS: ReadonlyMap<string, MatterhornCondition> = new Map([
  // ── CP01: Real content tagged ─────────────────────────────────────────────
  ['01-001', { id: '01-001', checkpoint: '01', title: 'Real content tagged', description: 'Artifact is tagged as real content.', section: 'UA1:7.1-1', type: 'Object', how: 'H' }],
  ['01-002', { id: '01-002', checkpoint: '01', title: 'Real content tagged', description: 'Real content is marked as artifact.', section: 'UA1:7.1-1', type: 'Object', how: 'H' }],
  ['01-003', { id: '01-003', checkpoint: '01', title: 'Real content tagged', description: 'Content marked as Artifact is present inside tagged content.', section: 'UA1:7.1-1', type: 'Object', how: 'M' }],
  ['01-004', { id: '01-004', checkpoint: '01', title: 'Real content tagged', description: 'Tagged content is present inside content marked as Artifact.', section: 'UA1:7.1-1', type: 'Object', how: 'M' }],
  ['01-005', { id: '01-005', checkpoint: '01', title: 'Real content tagged', description: 'Content is neither marked as Artifact nor tagged as real content.', section: 'UA1:7.1-2', type: 'Object', how: 'M' }],
  ['01-006', { id: '01-006', checkpoint: '01', title: 'Real content tagged', description: 'The structure type and attributes of a structure element are not semantically appropriate for the structure element.', section: 'UA1:7.1-2', type: 'Object', how: 'H' }],
  ['01-007', { id: '01-007', checkpoint: '01', title: 'Real content tagged', description: 'Suspects entry has a value of true.', section: 'UA1:7.1-11', type: 'Doc', how: 'M' }],

  // ── CP02: Role Mapping ────────────────────────────────────────────────────
  ['02-001', { id: '02-001', checkpoint: '02', title: 'Role Mapping', description: "One or more non-standard tag's mapping does not terminate with a standard type.", section: 'UA1:7.1-3', type: 'Doc', how: 'M' }],
  ['02-002', { id: '02-002', checkpoint: '02', title: 'Role Mapping', description: 'The mapping of one or more non-standard types is semantically inappropriate.', section: 'UA1:7.1-3', type: 'Doc', how: 'H' }],
  ['02-003', { id: '02-003', checkpoint: '02', title: 'Role Mapping', description: 'A circular mapping exists.', section: 'UA1:7.1-3', type: 'Doc', how: 'M' }],
  ['02-004', { id: '02-004', checkpoint: '02', title: 'Role Mapping', description: 'One or more standard types are remapped.', section: 'UA1:7.1-4', type: 'Doc', how: 'M' }],

  // ── CP03: Flickering ──────────────────────────────────────────────────────
  ['03-001', { id: '03-001', checkpoint: '03', title: 'Flickering', description: 'One or more Actions lead to flickering.', section: 'UA1:7.1-5', type: 'Page', how: 'H' }],
  ['03-002', { id: '03-002', checkpoint: '03', title: 'Flickering', description: 'One or more multimedia objects contain flickering content.', section: 'UA1:7.1-5', type: 'Object', how: 'H' }],
  ['03-003', { id: '03-003', checkpoint: '03', title: 'Flickering', description: 'One or more JavaScript actions lead to flickering.', section: 'UA1:7.1-5', type: 'JS', how: 'H' }],

  // ── CP04: Color and Contrast ──────────────────────────────────────────────
  ['04-001', { id: '04-001', checkpoint: '04', title: 'Color and Contrast', description: 'Information is conveyed by contrast, color, format or layout, or some combination thereof but the content is not tagged to reflect all meaning conveyed by the use of contrast, color, format or layout, or some combination thereof.', section: 'UA1:7.1-6', type: 'Object', how: 'H' }],

  // ── CP05: Sound ───────────────────────────────────────────────────────────
  ['05-001', { id: '05-001', checkpoint: '05', title: 'Sound', description: 'Media annotation present, but audio content not available in another form.', section: 'UA1:7.1-7', type: 'Object', how: 'H' }],
  ['05-002', { id: '05-002', checkpoint: '05', title: 'Sound', description: 'Audio annotation present, but content not available in another form.', section: 'UA1:7.1-7', type: 'Object', how: 'H' }],
  ['05-003', { id: '05-003', checkpoint: '05', title: 'Sound', description: 'JavaScript uses beep function but does not provide another means of notification.', section: 'UA1:7.1-7', type: 'JS', how: 'H' }],

  // ── CP06: Metadata ────────────────────────────────────────────────────────
  ['06-001', { id: '06-001', checkpoint: '06', title: 'Metadata', description: 'Document does not contain an XMP metadata stream.', section: 'UA1:7.1-8', type: 'Doc', how: 'M' }],
  ['06-002', { id: '06-002', checkpoint: '06', title: 'Metadata', description: 'The XMP metadata stream in the Catalog dictionary does not include the PDF/UA identifier.', section: 'UA1:5', type: 'Doc', how: 'M' }],
  ['06-003', { id: '06-003', checkpoint: '06', title: 'Metadata', description: 'XMP metadata stream does not contain dc:title.', section: 'UA1:7.1-8', type: 'Doc', how: 'M' }],
  ['06-004', { id: '06-004', checkpoint: '06', title: 'Metadata', description: 'dc:title does not clearly identify the document.', section: 'UA1:7.1-8', type: 'Doc', how: 'H' }],

  // ── CP07: Dictionary ──────────────────────────────────────────────────────
  ['07-001', { id: '07-001', checkpoint: '07', title: 'Dictionary', description: 'ViewerPreferences dictionary of the Catalog dictionary does not contain a DisplayDocTitle entry.', section: 'UA1:7.1-9', type: 'Doc', how: 'M' }],
  ['07-002', { id: '07-002', checkpoint: '07', title: 'Dictionary', description: 'ViewerPreferences dictionary of the Catalog dictionary contains a DisplayDocTitle entry with a value of false.', section: 'UA1:7.1-9', type: 'Doc', how: 'M' }],

  // ── CP08: OCR Validation ──────────────────────────────────────────────────
  ['08-001', { id: '08-001', checkpoint: '08', title: 'OCR Validation', description: 'OCR-generated text contains significant errors.', section: 'UA1:7.1-10', type: 'Page', how: 'H' }],
  ['08-002', { id: '08-002', checkpoint: '08', title: 'OCR Validation', description: 'OCR-generated text is not tagged.', section: 'UA1:7.1-10', type: 'Page', how: 'H', see: '01-006' }],

  // ── CP09: Appropriate Tags ────────────────────────────────────────────────
  ['09-001', { id: '09-001', checkpoint: '09', title: 'Appropriate Tags', description: 'Tags are not in logical reading order.', section: 'UA1:7.2-1', type: 'Doc', how: 'H' }],
  ['09-002', { id: '09-002', checkpoint: '09', title: 'Appropriate Tags', description: 'Structure elements are nested in a semantically inappropriate manner (e.g., a table inside a heading).', section: 'UA1:7.2-1', type: 'Object', how: 'H' }],
  ['09-003', { id: '09-003', checkpoint: '09', title: 'Appropriate Tags', description: 'The structure type (after applying any role-mapping as necessary) of a structure element is not semantically appropriate.', section: 'UA1:7.2-1', type: 'Object', how: 'H', see: '01-006' }],
  ['09-004', { id: '09-004', checkpoint: '09', title: 'Appropriate Tags', description: 'A table-related structure element is used in a way that does not conform to the syntax defined in ISO 32000-1, Table 337.', section: 'UA1:7.2-1', type: 'Object', how: 'M' }],
  ['09-005', { id: '09-005', checkpoint: '09', title: 'Appropriate Tags', description: 'A list-related structure element is used in a way that does not conform to Table 336 in ISO 32000-1.', section: 'UA1:7.2-1', type: 'Object', how: 'M' }],
  ['09-006', { id: '09-006', checkpoint: '09', title: 'Appropriate Tags', description: 'A TOC-related structure element is used in a way that does not conform to Table 333 in ISO 32000-1.', section: 'UA1:7.2-1', type: 'Object', how: 'M' }],
  ['09-007', { id: '09-007', checkpoint: '09', title: 'Appropriate Tags', description: 'A Ruby-related structure element is used in a way that does not conform to Table 338 in ISO 32000-1.', section: 'UA1:7.2-1', type: 'Object', how: 'M' }],
  ['09-008', { id: '09-008', checkpoint: '09', title: 'Appropriate Tags', description: 'A Warichu-related structure element is used in a way that does not conform to Table 338 in ISO 32000-1.', section: 'UA1:7.2-1', type: 'Object', how: 'M' }],

  // ── CP10: Character Mappings ──────────────────────────────────────────────
  ['10-001', { id: '10-001', checkpoint: '10', title: 'Character Mappings', description: 'Character code cannot be mapped to Unicode.', section: 'UA1:7.2-2', type: 'Object', how: 'M' }],

  // ── CP11: Declared Natural Language ───────────────────────────────────────
  ['11-001', { id: '11-001', checkpoint: '11', title: 'Declared Natural Language', description: 'Natural language for text in page content cannot be determined.', section: 'UA1:7.2-3', type: 'Object', how: 'M' }],
  ['11-002', { id: '11-002', checkpoint: '11', title: 'Declared Natural Language', description: 'Natural language for text in Alt, ActualText and E attributes cannot be determined.', section: 'UA1:7.2-3', type: 'Object', how: 'M' }],
  ['11-003', { id: '11-003', checkpoint: '11', title: 'Declared Natural Language', description: 'Natural language in the Outline entries cannot be determined.', section: 'UA1:7.2-3', type: 'Object', how: 'M' }],
  ['11-004', { id: '11-004', checkpoint: '11', title: 'Declared Natural Language', description: 'Natural language in the Contents entry for annotations cannot be determined.', section: 'UA1:7.2-3', type: 'Object', how: 'M' }],
  ['11-005', { id: '11-005', checkpoint: '11', title: 'Declared Natural Language', description: 'Natural language in the TU entry for form fields cannot be determined.', section: 'UA1:7.2-3', type: 'Object', how: 'M' }],
  ['11-006', { id: '11-006', checkpoint: '11', title: 'Declared Natural Language', description: 'Natural language for document metadata cannot be determined.', section: 'UA1:7.2-3', type: 'Doc', how: 'M' }],
  ['11-007', { id: '11-007', checkpoint: '11', title: 'Declared Natural Language', description: 'Natural language is not appropriate.', section: 'UA1:7.2-3', type: 'All', how: 'H' }],

  // ── CP12: Stretchable Characters ──────────────────────────────────────────
  ['12-001', { id: '12-001', checkpoint: '12', title: 'Stretchable Characters', description: 'Stretched characters are not represented appropriately.', section: 'UA1:7.2-4', type: 'Object', how: 'H' }],

  // ── CP13: Graphics ────────────────────────────────────────────────────────
  ['13-001', { id: '13-001', checkpoint: '13', title: 'Graphics', description: 'Graphics objects other than text objects and artifacts are not tagged with a Figure tag.', section: 'UA1:7.3-1', type: 'Object', how: 'H' }],
  ['13-002', { id: '13-002', checkpoint: '13', title: 'Graphics', description: "A link with a meaningful background does not include alternative text describing both the link and the graphic's purpose.", section: 'UA1:7.3-1', type: 'Object', how: 'H' }],
  ['13-003', { id: '13-003', checkpoint: '13', title: 'Graphics', description: 'A caption is not tagged with a Caption tag.', section: 'UA1:7.3-2', type: 'Object', how: 'H' }],
  ['13-004', { id: '13-004', checkpoint: '13', title: 'Graphics', description: 'Figure tag alternative or replacement text missing.', section: 'UA1:7.3-3', type: 'Object', how: 'M' }],
  ['13-005', { id: '13-005', checkpoint: '13', title: 'Graphics', description: 'ActualText used for a Figure for which alternative text is more appropriate.', section: 'UA1:7.3-4', type: 'Object', how: 'H' }],
  ['13-006', { id: '13-006', checkpoint: '13', title: 'Graphics', description: 'Graphics objects that possess semantic value only within a group of graphics objects is tagged on its own.', section: 'UA1:7.3-5', type: 'Object', how: 'H' }],
  ['13-007', { id: '13-007', checkpoint: '13', title: 'Graphics', description: 'A more accessible representation is not used.', section: 'UA1:7.3-6', type: 'Object', how: 'H' }],
  ['13-008', { id: '13-008', checkpoint: '13', title: 'Graphics', description: 'ActualText not present when a Figure is intended to be consumed primarily as text.', section: 'UA1:7.3-4', type: 'Object', how: 'H' }],

  // ── CP14: Headings ────────────────────────────────────────────────────────
  ['14-001', { id: '14-001', checkpoint: '14', title: 'Headings', description: 'Headings are not tagged.', section: 'UA1:7.4-1', type: 'Doc', how: 'H', see: '01-006' }],
  ['14-002', { id: '14-002', checkpoint: '14', title: 'Headings', description: 'Does use numbered headings, but the first heading tag is not H1.', section: 'UA1:7.4.2-1', type: 'Doc', how: 'M' }],
  ['14-003', { id: '14-003', checkpoint: '14', title: 'Headings', description: 'Numbered heading levels in descending sequence are skipped (Example: H3 follows directly after H1).', section: 'UA1:7.4-1', type: 'Doc', how: 'M' }],
  ['14-004', { id: '14-004', checkpoint: '14', title: 'Headings', description: 'Numbered heading tags do not use Arabic numerals and are not role mapped to heading types that do use Arabic numerals.', section: 'UA1:7.4.3-1', type: 'Object', how: 'H', see: '01-006' }],
  ['14-005', { id: '14-005', checkpoint: '14', title: 'Headings', description: 'Content representing a 7th level (or higher) heading does not use an H7 (or higher) tag.', section: 'UA1:7.4.3-1', type: 'Object', how: 'H', see: '01-006' }],
  ['14-006', { id: '14-006', checkpoint: '14', title: 'Headings', description: 'A node contains more than one H tag.', section: 'UA1:7.4.4-1', type: 'Object', how: 'M' }],
  ['14-007', { id: '14-007', checkpoint: '14', title: 'Headings', description: 'Document uses both H and H# tags.', section: 'UA1:7.4.4-3', type: 'Doc', how: 'M' }],

  // ── CP15: Tables ──────────────────────────────────────────────────────────
  ['15-001', { id: '15-001', checkpoint: '15', title: 'Tables', description: 'A row has a header cell, but that header cell is not tagged as a header.', section: 'UA1:7.5-1', type: 'Object', how: 'H' }],
  ['15-002', { id: '15-002', checkpoint: '15', title: 'Tables', description: 'A column has a header cell, but that header cell is not tagged as a header.', section: 'UA1:7.5-1', type: 'Object', how: 'H' }],
  ['15-003', { id: '15-003', checkpoint: '15', title: 'Tables', description: 'In a table not organized with Headers attributes and IDs, a TH cell does not contain a Scope attribute.', section: 'UA1:7.5-2', type: 'Object', how: 'M' }],
  ['15-004', { id: '15-004', checkpoint: '15', title: 'Tables', description: 'Content is tagged as a table for information that is not organized in rows and columns.', section: 'UA1:7.5-3', type: 'Object', how: 'H' }],
  ['15-005', { id: '15-005', checkpoint: '15', title: 'Tables', description: "A given cell's header cannot be unambiguously determined.", section: 'UA1:7.5-2', type: 'Object', how: 'H', see: '01-006' }],

  // ── CP16: Lists ───────────────────────────────────────────────────────────
  ['16-001', { id: '16-001', checkpoint: '16', title: 'Lists', description: 'List is an ordered list, but no value for the ListNumbering attribute is present.', section: 'UA1:7.6-1', type: 'Object', how: 'H' }],
  ['16-002', { id: '16-002', checkpoint: '16', title: 'Lists', description: 'List is an ordered list, but the ListNumbering value is not one of the following: Decimal, UpperRoman, LowerRoman, UpperAlpha, LowerAlpha.', section: 'UA1:7.6-1', type: 'Object', how: 'H' }],
  ['16-003', { id: '16-003', checkpoint: '16', title: 'Lists', description: 'Content is a list but is not tagged as a list.', section: 'UA1:7.6-2', type: 'Object', how: 'H', see: '01-006' }],

  // ── CP17: Mathematical Expressions ───────────────────────────────────────
  ['17-001', { id: '17-001', checkpoint: '17', title: 'Mathematical Expressions', description: 'Content is a mathematical expression but is not tagged with a Formula tag.', section: 'UA1:7.7-1', type: 'Object', how: 'H', see: '01-006' }],
  ['17-002', { id: '17-002', checkpoint: '17', title: 'Mathematical Expressions', description: 'Formula tag is missing an Alt attribute.', section: 'UA1:7.7-1', type: 'Object', how: 'M' }],
  ['17-003', { id: '17-003', checkpoint: '17', title: 'Mathematical Expressions', description: 'Unicode mapping requirements are not met.', section: 'UA1:7.7-2', type: 'Object', how: 'M', see: '10-001' }],

  // ── CP18: Page Headers and Footers ────────────────────────────────────────
  ['18-001', { id: '18-001', checkpoint: '18', title: 'Page Headers and Footers', description: 'Headers and footers are not marked as pagination artifacts.', section: 'UA1:7.8-1', type: 'Object', how: 'H' }],
  ['18-002', { id: '18-002', checkpoint: '18', title: 'Page Headers and Footers', description: 'Header or footer artifacts are not classified as Header or Footer subtypes.', section: 'UA1:7.8-1', type: 'Object', how: 'H' }],

  // ── CP19: Notes and References ────────────────────────────────────────────
  ['19-001', { id: '19-001', checkpoint: '19', title: 'Notes and References', description: 'Footnotes or endnotes are not tagged as Note.', section: 'UA1:7.9-1', type: 'Object', how: 'H' }],
  ['19-002', { id: '19-002', checkpoint: '19', title: 'Notes and References', description: 'References are not tagged as Reference.', section: 'UA1:7.9-1', type: 'Object', how: 'H' }],
  ['19-003', { id: '19-003', checkpoint: '19', title: 'Notes and References', description: 'ID entry of the Note tag is not present.', section: 'UA1:7.9-2', type: 'Object', how: 'M' }],
  ['19-004', { id: '19-004', checkpoint: '19', title: 'Notes and References', description: 'ID entry of the Note tag is non-unique.', section: 'UA1:7.9-2', type: 'Object', how: 'M' }],

  // ── CP20: Optional Content ────────────────────────────────────────────────
  ['20-001', { id: '20-001', checkpoint: '20', title: 'Optional Content', description: 'Name entry is missing or has an empty string as its value in an Optional Content Configuration Dictionary in the Configs entry in the OCProperties entry in the Catalog dictionary.', section: 'UA1:7.10-1', type: 'Object', how: 'M' }],
  ['20-002', { id: '20-002', checkpoint: '20', title: 'Optional Content', description: 'Name entry is missing or has an empty string as its value in an Optional Content Configuration Dictionary that is the value of the D entry in the OCProperties entry in the Catalog dictionary.', section: 'UA1:7.10-1', type: 'Object', how: 'M' }],
  ['20-003', { id: '20-003', checkpoint: '20', title: 'Optional Content', description: 'An AS entry appears in an Optional Content Configuration Dictionary.', section: 'UA1:7.10-2', type: 'Object', how: 'M' }],

  // ── CP21: Embedded Files ──────────────────────────────────────────────────
  ['21-001', { id: '21-001', checkpoint: '21', title: 'Embedded Files', description: 'The file specification dictionary for an embedded file does not contain F and UF entries.', section: 'UA1:7.11-1', type: 'Object', how: 'M' }],

  // ── CP22: Article Threads ─────────────────────────────────────────────────
  ['22-001', { id: '22-001', checkpoint: '22', title: 'Article Threads', description: 'Article threads do not reflect logical reading order.', section: 'UA1:7.12-1', type: 'Object', how: 'H' }],

  // ── CP23: Digital Signatures ──────────────────────────────────────────────
  ['23-001', { id: '23-001', checkpoint: '23', title: 'Digital Signatures', description: 'No test specific to digital signatures is required, however other provisions apply (form fields).', section: 'UA1:7.13-1', type: '--', how: '--', see: '01-006' }],

  // ── CP24: Non-Interactive Forms ───────────────────────────────────────────
  ['24-001', { id: '24-001', checkpoint: '24', title: 'Non-Interactive Forms', description: 'Non-interactive forms are not tagged with the PrintFields attribute.', section: 'UA1:7.14-1', type: 'Object', how: 'H' }],

  // ── CP25: XFA ─────────────────────────────────────────────────────────────
  ['25-001', { id: '25-001', checkpoint: '25', title: 'XFA', description: 'File contains the dynamicRender element with value "required".', section: 'UA1:7.15-1', type: 'Object', how: 'M' }],

  // ── CP26: Security ────────────────────────────────────────────────────────
  ['26-001', { id: '26-001', checkpoint: '26', title: 'Security', description: 'The file is encrypted but does not contain a P entry in its encryption dictionary.', section: 'UA1:7.16-1', type: 'Object', how: 'M' }],
  ['26-002', { id: '26-002', checkpoint: '26', title: 'Security', description: 'The file is encrypted and does contain a P entry but the 10th bit position of the P entry is false.', section: 'UA1:7.16-1', type: 'Object', how: 'M' }],

  // ── CP27: Navigation ──────────────────────────────────────────────────────
  ['27-001', { id: '27-001', checkpoint: '27', title: 'Navigation', description: 'No tests specific to navigation are required; use appropriate semantics.', section: 'UA1:7.17-1', type: '--', how: '--', see: '01-006' }],

  // ── CP28: Annotations ────────────────────────────────────────────────────
  ['28-001', { id: '28-001', checkpoint: '28', title: 'Annotations', description: 'An annotation is not in correct reading order.', section: 'UA1:7.18.1-2', type: 'Object', how: 'H' }],
  ['28-002', { id: '28-002', checkpoint: '28', title: 'Annotations', description: 'An annotation, other than of subtype Widget, Link and PrinterMark, is not a direct child of an Annot structure element.', section: 'UA1:7.18.1-2', type: 'Object', how: 'M', see: '28-010, 28-011, 28-017, 28-018' }],
  ['28-003', { id: '28-003', checkpoint: '28', title: 'Annotations', description: 'An annotation is used for visual formatting but is not tagged according to its semantic function.', section: 'UA1:7.18.1-3', type: 'Object', how: 'H' }],
  ['28-004', { id: '28-004', checkpoint: '28', title: 'Annotations', description: 'An annotation, other than of subtype Widget, does not have a Contents entry and does not have an alternative description (in the form of an Alt entry in the enclosing structure element).', section: 'UA1:7.18.1-4', type: 'Object', how: 'M' }],
  ['28-005', { id: '28-005', checkpoint: '28', title: 'Annotations', description: 'A form field does not have a TU entry and does not have an alternative description (in the form of an Alt entry in the enclosing structure element).', section: 'UA1:7.18.1-4', type: 'Object', how: 'M' }],
  ['28-006', { id: '28-006', checkpoint: '28', title: 'Annotations', description: 'An annotation with subtype undefined in ISO 32000 does not meet 7.18.1.', section: 'UA1:7.18.2-1', type: 'Object', how: 'M', see: '28-001, 28-002, 28-003, 28-004' }],
  ['28-007', { id: '28-007', checkpoint: '28', title: 'Annotations', description: 'An annotation of subtype TrapNet exists.', section: 'UA1:7.18.2-2', type: 'Object', how: 'M' }],
  ['28-008', { id: '28-008', checkpoint: '28', title: 'Annotations', description: 'A page containing an annotation does not contain a Tabs entry.', section: 'UA1:7.18.3-1', type: 'Object', how: 'M' }],
  ['28-009', { id: '28-009', checkpoint: '28', title: 'Annotations', description: 'A page containing an annotation has a Tabs entry with a value other than S.', section: 'UA1:7.18.3-1', type: 'Object', how: 'M' }],
  ['28-010', { id: '28-010', checkpoint: '28', title: 'Annotations', description: 'A widget annotation is not nested within a Form tag.', section: 'UA1:7.18.4-1', type: 'Object', how: 'M' }],
  ['28-011', { id: '28-011', checkpoint: '28', title: 'Annotations', description: 'A link annotation is not nested within a Link tag.', section: 'UA1:7.18.5-1', type: 'Object', how: 'M' }],
  ['28-012', { id: '28-012', checkpoint: '28', title: 'Annotations', description: 'A link annotation does not include an alternate description in its Contents entry.', section: 'UA1:7.18.5-2', type: 'Object', how: 'M' }],
  ['28-013', { id: '28-013', checkpoint: '28', title: 'Annotations', description: 'An IsMap entry is present with a value of true but the functionality is not provided in some other way.', section: 'UA1:7.18.5-3', type: 'Object', how: 'H' }],
  ['28-014', { id: '28-014', checkpoint: '28', title: 'Annotations', description: 'CT entry is missing from the media clip data dictionary.', section: 'UA1:7.18.6.2-1', type: 'Object', how: 'M' }],
  ['28-015', { id: '28-015', checkpoint: '28', title: 'Annotations', description: 'Alt entry is missing from the media clip data dictionary.', section: 'UA1:7.18.6.2-1', type: 'Object', how: 'M' }],
  ['28-016', { id: '28-016', checkpoint: '28', title: 'Annotations', description: 'File attachment annotations do not conform to 7.11.', section: 'UA1:7.18.7-1', type: 'Object', how: 'M', see: '20-001' }],
  ['28-017', { id: '28-017', checkpoint: '28', title: 'Annotations', description: 'A PrinterMark annotation is included in the logical structure.', section: 'UA1:7.18.8-1', type: 'Object', how: 'M' }],
  ['28-018', { id: '28-018', checkpoint: '28', title: 'Annotations', description: 'The appearance stream of a PrinterMark annotation is not marked as Artifact.', section: 'UA1:7.18.8-2', type: 'Object', how: 'M', see: '01-002, 01-005' }],

  // ── CP29: Actions ────────────────────────────────────────────────────────
  ['29-001', { id: '29-001', checkpoint: '29', title: 'Actions', description: 'A script requires specific timing for individual keystrokes.', section: 'UA1:7.19-1', type: 'Object', how: 'H' }],

  // ── CP30: XObjects ────────────────────────────────────────────────────────
  ['30-001', { id: '30-001', checkpoint: '30', title: 'XObjects', description: 'A reference XObject is present.', section: 'UA1:7.20-1', type: 'Object', how: 'M' }],
  ['30-002', { id: '30-002', checkpoint: '30', title: 'XObjects', description: 'Form XObject contains MCIDs and is referenced more than once.', section: 'UA1:7.20-2', type: 'Object', how: 'M' }],

  // ── CP31: Fonts ───────────────────────────────────────────────────────────
  ['31-001', { id: '31-001', checkpoint: '31', title: 'Fonts', description: 'A Type 0 font dictionary with encoding other than Identity-H and Identity-V has values for Registry in both CIDSystemInfo dictionaries that are not identical.', section: 'UA1:7.21.3-1', type: 'Object', how: 'M' }],
  ['31-002', { id: '31-002', checkpoint: '31', title: 'Fonts', description: 'A Type 0 font dictionary with encoding other than Identity-H and Identity-V has values for Ordering in both CIDSystemInfo dictionaries that are not identical.', section: 'UA1:7.21.3.1-1', type: 'Object', how: 'M' }],
  ['31-003', { id: '31-003', checkpoint: '31', title: 'Fonts', description: 'A Type 0 font dictionary with encoding other than Identity-H and Identity-V has a value for Supplement in the CIDSystemInfo dictionary of the CID font that is less than the value for Supplement in the CIDSystemInfo dictionary of the CMap.', section: 'UA1:7.21.3.1-1', type: 'Object', how: 'M' }],
  ['31-004', { id: '31-004', checkpoint: '31', title: 'Fonts', description: 'A Type 2 CID font contains neither a stream nor the name Identity as the value of the CIDToGIDMap entry.', section: 'UA1:7.21.3.2-1', type: 'Object', how: 'M' }],
  ['31-005', { id: '31-005', checkpoint: '31', title: 'Fonts', description: 'A Type 2 CID font does not contain a CIDToGIDMap entry.', section: 'UA1:7.21.3.2-1', type: 'Object', how: 'M' }],
  ['31-006', { id: '31-006', checkpoint: '31', title: 'Fonts', description: 'A CMap is neither listed as described in ISO 32000-1:2008, 9.7.5.2, Table 118 nor is it embedded.', section: 'UA1:7.21.3.3-1', type: 'Object', how: 'M' }],
  ['31-007', { id: '31-007', checkpoint: '31', title: 'Fonts', description: 'The WMode entry in a CMap dictionary is not identical to the WMode value in the CMap stream.', section: 'UA1:7.21.3.3-1', type: 'Object', how: 'M' }],
  ['31-008', { id: '31-008', checkpoint: '31', title: 'Fonts', description: 'A CMap references another CMap which is not listed in ISO 32000-1:2008, 9.7.5.2, Table 118.', section: 'UA1:7.21.3.3-2', type: 'Object', how: 'M' }],
  ['31-009', { id: '31-009', checkpoint: '31', title: 'Fonts', description: 'For a font used by text intended to be rendered the font program is not embedded.', section: 'UA1:7.21.4.1-1', type: 'Object', how: 'M' }],
  ['31-010', { id: '31-010', checkpoint: '31', title: 'Fonts', description: 'A font program is embedded that is not legally embeddable for unlimited, universal rendering.', section: 'UA1:7.21.4.1-2', type: 'Object', how: 'H' }],
  ['31-011', { id: '31-011', checkpoint: '31', title: 'Fonts', description: 'For a font used by text the font program is embedded but it does not contain glyphs for all of the glyphs referenced by the text used for rendering.', section: 'UA1:7.21.4.1-3', type: 'Object', how: 'M' }],
  ['31-012', { id: '31-012', checkpoint: '31', title: 'Fonts', description: 'The FontDescriptor dictionary of an embedded Type 1 font contains a CharSet string, but at least one of the glyphs present in the font program is not listed in the CharSet string.', section: 'UA1:7.21.4.2-1', type: 'Object', how: 'M' }],
  ['31-013', { id: '31-013', checkpoint: '31', title: 'Fonts', description: 'The FontDescriptor dictionary of an embedded Type 1 font contains a CharSet string, but at least one of the glyphs listed in the CharSet string is not present in the font program.', section: 'UA1:7.21.4.2-2', type: 'Object', how: 'M' }],
  ['31-014', { id: '31-014', checkpoint: '31', title: 'Fonts', description: 'The FontDescriptor dictionary of an embedded CID font contains a CIDSet string, but at least one of the glyphs present in the font program is not listed in the CIDSet string.', section: 'UA1:7.21.4.2-3', type: 'Object', how: 'M' }],
  ['31-015', { id: '31-015', checkpoint: '31', title: 'Fonts', description: 'The FontDescriptor dictionary of an embedded CID font contains a CIDSet string, but at least one of the glyphs listed in the CIDSet string is not present in the font program.', section: 'UA1:7.21.4.2-4', type: 'Object', how: 'M' }],
  ['31-016', { id: '31-016', checkpoint: '31', title: 'Fonts', description: 'For one or more glyphs, the glyph width information in the font dictionary and in the embedded font program differ by more than 1/1000 unit.', section: 'UA1:7.21.5-1', type: 'Object', how: 'M' }],
  ['31-017', { id: '31-017', checkpoint: '31', title: 'Fonts', description: 'A non-symbolic TrueType font is used for rendering, but none of the cmap entries in the embedded font program is a non-symbolic cmap.', section: 'UA1:7.21.6-1', type: 'Object', how: 'M' }],
  ['31-018', { id: '31-018', checkpoint: '31', title: 'Fonts', description: 'A non-symbolic TrueType font is used for rendering, but for at least one glyph to be rendered the glyph cannot be looked up by any of the non-symbolic cmap entries in the embedded font program.', section: 'UA1:7.21.6-2', type: 'Object', how: 'M' }],
  ['31-019', { id: '31-019', checkpoint: '31', title: 'Fonts', description: 'The font dictionary for a non-symbolic TrueType font does not contain an Encoding entry.', section: 'UA1:7.21.6-3', type: 'Object', how: 'M' }],
  ['31-020', { id: '31-020', checkpoint: '31', title: 'Fonts', description: 'The font dictionary for a non-symbolic TrueType font contains an Encoding dictionary which does not contain a BaseEncoding entry.', section: 'UA1:7.21.6-4', type: 'Object', how: 'M' }],
  ['31-021', { id: '31-021', checkpoint: '31', title: 'Fonts', description: 'The value for either the Encoding entry or the BaseEncoding entry in the Encoding dictionary in a non-symbolic TrueType font dictionary is neither MacRomanEncoding nor WinAnsiEncoding.', section: 'UA1:7.21.6-5', type: 'Object', how: 'M' }],
  ['31-022', { id: '31-022', checkpoint: '31', title: 'Fonts', description: 'The Differences array in the Encoding entry in a non-symbolic TrueType font dictionary contains one or more glyph names which are not listed in the Adobe Glyph List.', section: 'UA1:7.21.6-6', type: 'Object', how: 'M' }],
  ['31-023', { id: '31-023', checkpoint: '31', title: 'Fonts', description: 'The Differences array is present in the Encoding entry in a non-symbolic TrueType font dictionary but the embedded font program does not contain a (3,1) Microsoft Unicode cmap.', section: 'UA1:7.21.6-7', type: 'Object', how: 'M' }],
  ['31-024', { id: '31-024', checkpoint: '31', title: 'Fonts', description: 'The Encoding entry is present in the font dictionary for a symbolic TrueType font.', section: 'UA1:7.21.6-8', type: 'Object', how: 'M' }],
  ['31-025', { id: '31-025', checkpoint: '31', title: 'Fonts', description: 'The embedded font program for a symbolic TrueType font contains no cmap.', section: 'UA1:7.21.6-9', type: 'Object', how: 'M' }],
  ['31-026', { id: '31-026', checkpoint: '31', title: 'Fonts', description: 'The embedded font program for a symbolic TrueType font contains more than one cmap, but none of the cmap entries is a (3,0) Microsoft Symbol cmap.', section: 'UA1:7.21.6-10', type: 'Object', how: 'M' }],
  ['31-027', { id: '31-027', checkpoint: '31', title: 'Fonts', description: 'A font dictionary does not contain the ToUnicode entry and none of the following is true: the font uses MacRomanEncoding, MacExpertEncoding or WinAnsiEncoding; the font is a Type 1 or Type 3 font and the glyph names of the glyphs referenced are all contained in the Adobe Glyph List or the set of named characters in the Symbol font; the font is a Type 0 font, and its descendant CIDFont uses Adobe-GB1, Adobe-CNS1, Adobe-Japan1 or Adobe-Korea1 character collections; the font is a non-symbolic TrueType font.', section: 'UA1:7.21.7-1', type: 'Object', how: 'M' }],
  ['31-028', { id: '31-028', checkpoint: '31', title: 'Fonts', description: 'One or more Unicode values specified in the ToUnicode CMap are zero (0).', section: 'UA1:7.21.7-2', type: 'Object', how: 'M' }],
  ['31-029', { id: '31-029', checkpoint: '31', title: 'Fonts', description: 'One or more Unicode values specified in the ToUnicode CMap are equal to either U+FEFF or U+FFFE.', section: 'UA1:7.21.7-3', type: 'Object', how: 'M' }],
  ['31-030', { id: '31-030', checkpoint: '31', title: 'Fonts', description: 'One or more characters used in text showing operators reference the .notdef glyph.', section: 'UA1:7.21.8-1', type: 'Object', how: 'M' }],
]);

/** Total condition count — 137 (spec intro incorrectly states 136; 13-008 added in v1.1) */
export const MATTERHORN_CONDITION_COUNT = 137;

/** Count of machine-checkable (M) conditions */
export const MATTERHORN_M_COUNT = 87;

/** Count of human-only (H) conditions */
export const MATTERHORN_H_COUNT = 47;

/** Count of no-specific-test (--) conditions */
export const MATTERHORN_DASH_COUNT = 3;

/**
 * Get a condition by its ID (e.g. "13-004").
 * Returns undefined for unknown IDs.
 */
export function getMatterhornCondition(id: string): MatterhornCondition | undefined {
  return MATTERHORN_CONDITIONS.get(id);
}

/**
 * Get all conditions for a given checkpoint number (e.g. "13").
 */
export function getMatterhornCheckpointConditions(checkpoint: string): MatterhornCondition[] {
  const results: MatterhornCondition[] = [];
  for (const condition of MATTERHORN_CONDITIONS.values()) {
    if (condition.checkpoint === checkpoint) {
      results.push(condition);
    }
  }
  return results.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Get all machine-checkable (M) conditions.
 */
export function getMachineCheckableConditions(): MatterhornCondition[] {
  return [...MATTERHORN_CONDITIONS.values()].filter(c => c.how === 'M');
}
