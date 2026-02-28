/**
 * Shared regex patterns for integrity checks
 */

// Figure references: "Figure 1", "Fig. 2", "figure 3.1"
export const FIGURE_REF = /\b(?:Figure|Fig\.?)\s+(\d+(?:\.\d+)?[a-z]?)/gi;
// Figure captions: "Figure 1." or "Figure 1:" at start of line or after newline
export const FIGURE_CAPTION = /(?:^|\n)\s*(?:Figure|Fig\.?)\s+(\d+(?:\.\d+)?[a-z]?)\s*[.:]/gi;

// Table references: "Table 1", "table 3.2"
export const TABLE_REF = /\bTable\s+(\d+(?:\.\d+)?[a-z]?)/gi;
export const TABLE_CAPTION = /(?:^|\n)\s*Table\s+(\d+(?:\.\d+)?[a-z]?)\s*[.:]/gi;

// Equation references: "Equation 1", "Eq. (2)", "equation (3.1)"
export const EQUATION_REF = /\b(?:Equation|Eq\.?)\s*\(?(\d+(?:\.\d+)?)\)?/gi;

// Box references: "Box 1", "box 2"
export const BOX_REF = /\bBox\s+(\d+(?:\.\d+)?)/gi;

// Section references: "Section 1.2", "section 3", "Sec. 4"
export const SECTION_REF = /\b(?:Section|Sec\.?)\s+(\d+(?:\.\d+)*)/gi;
// Section headings: numbered headings like "1.2 Title" or "3.1.1 Subsection"
// Only match numbers up to 99 (bare numbers >=100 are almost certainly data, not sections)
// Must be followed by at least 2 word characters to avoid matching table data
export const SECTION_HEADING = /(?:^|\n)\s*(\d{1,2}(?:\.\d+)*)\s+[A-Z][a-zA-Z]/gm;

// Citation references: "(Author, Year)", "[1]", "[Author et al., 2020]"
export const CITATION_BRACKET = /\[(\d+(?:\s*[-–,]\s*\d+)*)\]/g;
export const CITATION_AUTHOR_YEAR = /\(([A-Z][a-z]+(?:\s+(?:et\s+al\.?|&|and)\s+[A-Z][a-z]+)?,?\s+\d{4}[a-z]?)\)/g;

// Abbreviation pattern: "full form (ABBR)" or "(ABBR)"
export const ABBREVIATION_DEFINITION = /([A-Z][a-z]+(?:\s+[A-Za-z]+){1,6})\s+\(([A-Z]{2,8})\)/g;
export const ABBREVIATION_USE = /\b([A-Z]{2,8})\b/g;

// Equation captions: "Equation 1." or "Equation 1:" at start of line
export const EQUATION_CAPTION = /(?:^|\n)\s*Equation\s+(\d+(?:\.\d+)?)\s*[.:]/gi;

// Box captions: "Box 1:" or "Box 2.1." at start of line
export const BOX_CAPTION = /(?:^|\n)\s*Box\s+(\d+(?:\.\d+)?)\s*[.:]/gi;

// Footnote patterns (text fallback when HTML not available)
export const FOOTNOTE_MARKER_TEXT = /\[(\d+)\]|\^(\d+)/g;
export const FOOTNOTE_SECTION_HEADER = /(?:^|\n)\s*(?:Notes|Footnotes|Endnotes)\s*\n/i;

// Identifier patterns
export const ISBN_13 = /\bISBN[-:\s]*(97[89][-\s]?\d{1,5}[-\s]?\d{1,7}[-\s]?\d{1,6}[-\s]?\d)\b/gi;
export const ISBN_10 = /\bISBN[-:\s]*(\d{1,5}[-\s]?\d{1,7}[-\s]?\d{1,6}[-\s]?[\dX])\b/gi;
export const DOI_PATTERN = /\b(10\.\d{4,9}\/[^\s"<>{}|\\^\[\]`]+)/gi;

// TOC detection
export const TOC_SECTION_HEADER = /(?:^|\n)\s*(?:Table of Contents|Contents)\s*\n/i;

// Terminology variant pairs: [variant1, variant2]
export const HYPHENATION_VARIANTS: [string, string][] = [
  ['e-mail', 'email'],
  ['on-line', 'online'],
  ['data-base', 'database'],
  ['web-site', 'website'],
  ['health-care', 'healthcare'],
  ['co-operation', 'cooperation'],
  ['re-use', 'reuse'],
];

export const SPELLING_VARIANTS: [string, string][] = [
  ['colour', 'color'],
  ['behaviour', 'behavior'],
  ['centre', 'center'],
  ['analyse', 'analyze'],
  ['organise', 'organize'],
  ['labour', 'labor'],
  ['favour', 'favor'],
  ['programme', 'program'],
];

// Unit patterns
export const UNIT_WITH_NUMBER = /(\d+(?:\.\d+)?)\s*(mg|g|kg|ml|mL|L|cm|mm|m|km|s|min|h|Hz|kHz|MHz|GHz|Pa|kPa|MPa|°C|°F|K|mol|mmol|µmol|nmol|J|kJ|MJ|W|kW|MW|V|mV|A|mA|Ω|µm|nm|pm)/g;
