/**
 * Per-imprint boilerplate snippet templates (P5/PR1).
 *
 * Each template function consumes a `BoilerplateMetadata` payload
 * (book title, author, ISBN, year, imprint display name, division
 * label) and returns the verbatim PRH boilerplate snippets that
 * should appear on a conformant copyright page for that imprint.
 *
 * Templates are split into three families per Branding Guide §5:
 *   - adult         — Penguin / Pelican / #Merky / Cornerstone Saga
 *                     (and any "unknown" PRH-UK imprint that falls
 *                     back to the adult template)
 *   - children      — Puffin / Ladybird (with three URLs + split
 *                     text/illustrations copyright)
 *   - vintage-bespoke — Vintage (different opener; no TDM / no EEA)
 *
 * Each snippet is keyed by the PRH-COPY-* code it addresses so the
 * caller (boilerplate-injector.service) can match snippets against
 * a list of issues the validator flagged.
 *
 * Missing metadata values become explicit `__MISSING_<FIELD>__`
 * placeholders so the FE can prompt the operator for input before
 * applying. We never silently substitute empty strings.
 */

import type { PrhImprint } from '../../types';

export type ImprintTemplate = 'adult' | 'children' | 'vintage-bespoke';

/** Token used to mark required metadata that the OPF didn't supply. */
export const MISSING_TOKEN_PREFIX = '__MISSING_';

export interface BoilerplateMetadata {
  /** `dc:title` from the OPF, or null when missing. */
  bookTitle: string | null;
  /** `dc:creator` from the OPF, or null when missing. */
  authorName: string | null;
  /** Hyphenated ISBN-13 from `dc:identifier`, or null when missing. */
  isbn: string | null;
  /** Publication year (4 digits) — derived from `dc:date` or null. */
  year: string | null;
  /** Marketing-name of the detected imprint (e.g. "Penguin"). */
  imprintDisplayName: string;
  /** Division label that prefixes the address block (e.g. "Penguin Books"). */
  division: string;
}

export interface BoilerplateSnippet {
  /** PRH-COPY-* code this snippet addresses. */
  code: string;
  /** Short human-readable label the FE shows above the preview. */
  description: string;
  /** XHTML markup ready to insert into the copyright page. */
  html: string;
  /**
   * Names of metadata fields the operator must fill in before
   * applying. Empty array when the snippet is fully substituted.
   */
  missingFields: BoilerplateMissingField[];
}

export type BoilerplateMissingField =
  | 'bookTitle'
  | 'authorName'
  | 'isbn'
  | 'year';

/**
 * Pick the template family for a detected imprint. Falls back to
 * adult for null / 'unknown' — those are PRH-UK builds where the
 * imprint detector didn't lock onto a specific imprint; the adult
 * template is the safest default.
 */
export function imprintTemplate(imprint: PrhImprint | null | 'unknown'): ImprintTemplate {
  switch (imprint) {
    case 'puffin':
    case 'ladybird':
      return 'children';
    case 'vintage':
      return 'vintage-bespoke';
    default:
      return 'adult';
  }
}

/** Substitute metadata placeholders, leaving `__MISSING_*__` for absent values. */
function sub(text: string, metadata: BoilerplateMetadata): { html: string; missing: BoilerplateMissingField[] } {
  const missing: BoilerplateMissingField[] = [];
  const substitute = (
    template: string,
    value: string | null,
    field: BoilerplateMissingField,
  ): string => {
    if (value && value.trim().length > 0) return template.replace(/\[BOOK_TITLE\]|\[AUTHOR_NAME\]|\[ISBN\]|\[YEAR\]/, value.trim());
    if (!missing.includes(field)) missing.push(field);
    return template;
  };

  let html = text;
  if (html.includes('[BOOK_TITLE]')) html = substitute(html, metadata.bookTitle, 'bookTitle');
  if (html.includes('[AUTHOR_NAME]')) html = substitute(html, metadata.authorName, 'authorName');
  if (html.includes('[ISBN]')) html = substitute(html, metadata.isbn, 'isbn');
  if (html.includes('[YEAR]')) html = substitute(html, metadata.year, 'year');

  // Convert any remaining placeholders to the explicit __MISSING_*__
  // token so the FE renders them as editable required fields.
  html = html
    .replace(/\[BOOK_TITLE\]/g, `${MISSING_TOKEN_PREFIX}BOOK_TITLE__`)
    .replace(/\[AUTHOR_NAME\]/g, `${MISSING_TOKEN_PREFIX}AUTHOR_NAME__`)
    .replace(/\[ISBN\]/g, `${MISSING_TOKEN_PREFIX}ISBN__`)
    .replace(/\[YEAR\]/g, `${MISSING_TOKEN_PREFIX}YEAR__`);

  return { html, missing };
}

// ── Verbatim text fragments (per Branding Guide §5) ──────────────────────

const TDM_PARAGRAPH_HTML = `<p>Penguin Random House values and supports copyright. Copyright fuels creativity, encourages diverse voices, promotes freedom of expression and supports a vibrant culture. Thank you for purchasing an authorized edition of this book and for respecting intellectual property laws by not reproducing, scanning or distributing any part of it by any means without permission. You are supporting authors and enabling Penguin Random House to continue to publish books for everyone. <strong>No part of this book may be used or reproduced in any manner for the purpose of training artificial intelligence technologies or systems. In accordance with Article 4(3) of the DSM Directive 2019/790, Penguin Random House expressly reserves this work from the text and data mining exception.</strong></p>`;

const EEA_LINE_HTML = `<p>The authorized representative in the EEA is Penguin Random House Ireland, Morrison Chambers, 32 Nassau Street, Dublin D02 YH68</p>`;

const BL_CIP_HTML = `<p>A CIP catalogue record for this book is available from the British Library</p>`;

const PRH_LOGO_HTML = `<figure class="copyright_logo"><img src="prh_core_assets/images/prh_uk_logo.jpg" alt="Penguin Random House UK" /></figure>`;

const VINTAGE_OPENER_HTML = `<p>This ebook is copyright material and must not be copied, reproduced, transferred, distributed, leased, licensed or publicly performed or used in any way except as specifically permitted in writing by the publishers, as allowed under the terms and conditions under which it was purchased or as strictly permitted by applicable copyright law. Any unauthorized distribution or use of this text may be a direct infringement of the author's and publisher's rights and those responsible may be liable in law accordingly.</p>`;

// ── Template builders ────────────────────────────────────────────────────

/**
 * Adult copyright-page snippets (Penguin, Pelican, #Merky,
 * Cornerstone Saga + unknown-imprint fallback).
 */
function buildAdultSnippets(metadata: BoilerplateMetadata): BoilerplateSnippet[] {
  const snippets: BoilerplateSnippet[] = [];

  snippets.push({
    code: 'PRH-COPY-TDM-PARAGRAPH-MISSING',
    description: 'TDM-reservation paragraph (DSM Directive 2019/790 opt-out)',
    html: TDM_PARAGRAPH_HTML,
    missingFields: [],
  });

  snippets.push({
    code: 'PRH-COPY-EEA-LINE-MISSING',
    description: 'EEA representative line (Penguin Random House Ireland, Dublin)',
    html: EEA_LINE_HTML,
    missingFields: [],
  });

  snippets.push({
    code: 'PRH-COPY-BL-CIP-MISSING',
    description: 'British Library CIP statement',
    html: BL_CIP_HTML,
    missingFields: [],
  });

  const groupRaw = `<p>${metadata.division} is part of the Penguin Random House group of companies whose addresses can be found at <a href="http://global.penguinrandomhouse.com">global.penguinrandomhouse.com</a>.</p>`;
  snippets.push({
    code: 'PRH-COPY-GROUP-STATEMENT-MISSING',
    description: 'PRH group-of-companies statement',
    html: groupRaw,
    missingFields: [],
  });

  const addressRaw = `<p>All correspondence to:<br/>${metadata.division}<br/>Penguin Random House<br/>One Embassy Gardens, 8 Viaduct Gardens, London SW11 7BW</p>`;
  snippets.push({
    code: 'PRH-COPY-ADDRESS-BLOCK-MISSING',
    description: 'Correspondence address (One Embassy Gardens, London SW11 7BW)',
    html: addressRaw,
    missingFields: [],
  });

  const isbnRaw = sub('<p>ISBN: [ISBN]</p>', metadata);
  snippets.push({
    code: 'PRH-COPY-ISBN-MISSING',
    description: 'ISBN-13 in canonical format',
    html: isbnRaw.html,
    missingFields: isbnRaw.missing,
  });

  snippets.push({
    code: 'PRH-COPY-IMPRINT-URL-MISSING',
    description: 'Imprint URL (www.penguin.co.uk)',
    html: `<p><a href="http://www.penguin.co.uk">www.penguin.co.uk</a></p>`,
    missingFields: [],
  });

  snippets.push({
    code: 'PRH-COPY-PRH-LOGO-MISSING',
    description: 'PRH UK group logo (figure + img with alt "Penguin Random House UK")',
    html: PRH_LOGO_HTML,
    missingFields: [],
  });

  return snippets;
}

/**
 * Children's copyright-page snippets (Puffin, Ladybird). Differs
 * from adult in three places:
 *   - Address block uses "Penguin Random House Children's, ..."
 *   - Includes three URLs (penguin / puffin / ladybird) instead of one
 *   - Group statement references the children's division
 */
function buildChildrensSnippets(metadata: BoilerplateMetadata): BoilerplateSnippet[] {
  const snippets: BoilerplateSnippet[] = [];

  // TDM + EEA + BL CIP + PRH logo identical to adult.
  snippets.push({
    code: 'PRH-COPY-TDM-PARAGRAPH-MISSING',
    description: 'TDM-reservation paragraph (DSM Directive 2019/790 opt-out)',
    html: TDM_PARAGRAPH_HTML,
    missingFields: [],
  });
  snippets.push({
    code: 'PRH-COPY-EEA-LINE-MISSING',
    description: 'EEA representative line (Penguin Random House Ireland, Dublin)',
    html: EEA_LINE_HTML,
    missingFields: [],
  });
  snippets.push({
    code: 'PRH-COPY-BL-CIP-MISSING',
    description: 'British Library CIP statement',
    html: BL_CIP_HTML,
    missingFields: [],
  });

  const groupRaw = `<p>${metadata.division} is part of the Penguin Random House group of companies whose addresses can be found at <a href="http://global.penguinrandomhouse.com">global.penguinrandomhouse.com</a>.</p>`;
  snippets.push({
    code: 'PRH-COPY-GROUP-STATEMENT-MISSING',
    description: 'PRH group-of-companies statement (children\'s division)',
    html: groupRaw,
    missingFields: [],
  });

  const addressRaw = `<p>All correspondence to:<br/>Penguin Random House Children’s<br/>Penguin Random House<br/>One Embassy Gardens, 8 Viaduct Gardens, London SW11 7BW</p>`;
  snippets.push({
    code: 'PRH-COPY-ADDRESS-BLOCK-MISSING',
    description: 'Correspondence address (Penguin Random House Children’s)',
    html: addressRaw,
    missingFields: [],
  });

  const isbnRaw = sub('<p id="isbn">ISBN: [ISBN]</p>', metadata);
  snippets.push({
    code: 'PRH-COPY-ISBN-MISSING',
    description: 'ISBN-13 in canonical format (with id="isbn" per children\'s template)',
    html: isbnRaw.html,
    missingFields: isbnRaw.missing,
  });

  // Three URLs — emitted as a single block because the validator
  // dedupes the URL code by `code` (one issue, multiple needles).
  snippets.push({
    code: 'PRH-COPY-IMPRINT-URL-MISSING',
    description: 'Imprint URLs (penguin.co.uk, puffin.co.uk, ladybird.co.uk)',
    html: `<p><a href="http://www.penguin.co.uk">www.penguin.co.uk</a><br/><a href="http://www.puffin.co.uk">www.puffin.co.uk</a><br/><a href="http://www.ladybird.co.uk">www.ladybird.co.uk</a></p>`,
    missingFields: [],
  });

  snippets.push({
    code: 'PRH-COPY-PRH-LOGO-MISSING',
    description: 'PRH UK group logo (figure + img with alt "Penguin Random House UK")',
    html: PRH_LOGO_HTML,
    missingFields: [],
  });

  return snippets;
}

/**
 * Vintage bespoke copyright-page snippets. Notable differences:
 *   - NO TDM paragraph; opens with the bespoke anti-piracy paragraph
 *   - NO EEA representative line
 *   - Address: "VINTAGE | 20 Vauxhall Bridge Road, London SW1V 2SA"
 *   - URL: penguin.co.uk/vintage
 */
function buildVintageSnippets(metadata: BoilerplateMetadata): BoilerplateSnippet[] {
  const snippets: BoilerplateSnippet[] = [];

  // Vintage opens with this paragraph in place of the TDM block.
  // No PRH-COPY-* code maps to it directly; we surface it for
  // completeness and let the operator decide whether to inject.
  snippets.push({
    code: 'PRH-COPY-VINTAGE-OPENER-MISSING',
    description: 'Vintage anti-piracy opener (not the TDM paragraph)',
    html: VINTAGE_OPENER_HTML,
    missingFields: [],
  });

  snippets.push({
    code: 'PRH-COPY-BL-CIP-MISSING',
    description: 'British Library CIP statement',
    html: BL_CIP_HTML,
    missingFields: [],
  });

  const groupRaw = `<p>Vintage is part of the Penguin Random House group of companies whose addresses can be found at <a href="http://global.penguinrandomhouse.com">global.penguinrandomhouse.com</a>.</p>`;
  snippets.push({
    code: 'PRH-COPY-GROUP-STATEMENT-MISSING',
    description: 'PRH group-of-companies statement (Vintage)',
    html: groupRaw,
    missingFields: [],
  });

  const addressRaw = `<p>VINTAGE<br/>20 Vauxhall Bridge Road, London SW1V 2SA</p>`;
  snippets.push({
    code: 'PRH-COPY-ADDRESS-BLOCK-MISSING',
    description: 'Vintage correspondence address (20 Vauxhall Bridge Road)',
    html: addressRaw,
    missingFields: [],
  });

  const isbnRaw = sub('<p>ISBN: [ISBN]</p>', metadata);
  snippets.push({
    code: 'PRH-COPY-ISBN-MISSING',
    description: 'ISBN-13 in canonical format',
    html: isbnRaw.html,
    missingFields: isbnRaw.missing,
  });

  snippets.push({
    code: 'PRH-COPY-IMPRINT-URL-MISSING',
    description: 'Vintage imprint URL (penguin.co.uk/vintage)',
    html: `<p><a href="http://www.penguin.co.uk/vintage">www.penguin.co.uk/vintage</a></p>`,
    missingFields: [],
  });

  snippets.push({
    code: 'PRH-COPY-PRH-LOGO-MISSING',
    description: 'PRH UK group logo (figure + img with alt "Penguin Random House UK")',
    html: PRH_LOGO_HTML,
    missingFields: [],
  });

  return snippets;
}

/**
 * Top-level template dispatcher. Pass the resolved imprint template
 * + metadata; receive the full per-imprint snippet list. The caller
 * filters by which codes the validator actually flagged.
 */
export function buildBoilerplateSnippets(
  template: ImprintTemplate,
  metadata: BoilerplateMetadata,
): BoilerplateSnippet[] {
  switch (template) {
    case 'children':
      return buildChildrensSnippets(metadata);
    case 'vintage-bespoke':
      return buildVintageSnippets(metadata);
    case 'adult':
    default:
      return buildAdultSnippets(metadata);
  }
}
