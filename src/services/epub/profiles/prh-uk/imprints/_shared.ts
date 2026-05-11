/**
 * Shared boilerplate fragments used by multiple PRH UK imprints.
 *
 * Most adult imprints (Penguin, Pelican, #Merky, Cornerstone Saga, plus
 * fallback imprints like Ebury / Transworld / RHCP / BBC / Michael Joseph
 * / Young Arrow) share the adult copyright template. Children's imprints
 * (Puffin, Ladybird) share the children's template. Vintage is bespoke
 * (separate fragments in `vintage.ts`).
 *
 * Strings are sourced from `branding-guide-digest.md` and verified
 * against the Branding Guide EPUB's `copyright-ad.xhtml`,
 * `copyright-ch.xhtml`, and `vintage/copyright.xhtml`.
 */

import type { CopyrightContentCheck } from './_types';

// ── Distinctive needle fragments ─────────────────────────────────────────
// Each is a short fragment unique to its host paragraph. The matcher
// normalises whitespace + case before searching, so case-mismatches and
// line-break variations don't fail the check. Paraphrasing IS tolerated as
// a false-negative risk (see P2 implementation plan).

/** TDM-reservation paragraph signature (DSM Directive 2019/790 opt-out). */
export const TDM_RESERVATION_FRAGMENT =
  'article 4(3) of the dsm directive 2019/790';

/** EEA representative line — Penguin Random House Ireland, Dublin. */
export const EEA_LINE_FRAGMENT =
  'morrison chambers, 32 nassau street, dublin d02 yh68';

/** British Library CIP statement. */
export const BL_CIP_FRAGMENT =
  'cip catalogue record for this book is available from the british library';

/** Group statement — PRH group of companies. */
export const GROUP_STATEMENT_FRAGMENT =
  'part of the penguin random house group of companies';

/** Adult correspondence address — One Embassy Gardens, London. */
export const ADULT_ADDRESS_FRAGMENT =
  'one embassy gardens, 8 viaduct gardens, london sw11 7bw';

/** Children's correspondence address. */
export const CHILDRENS_ADDRESS_FRAGMENT =
  "penguin random house children's";

/** PRH UK logo reference — checked separately as a file/alt-text concern, not text. */
export const PRH_UK_LOGO_ALT = 'penguin random house uk';

/** Generic ISBN pattern check — ISBN 13-digit format. */
export const ISBN_FRAGMENT_HINT = 'isbn';

// ── Shared check builders ────────────────────────────────────────────────

/**
 * Boilerplate checks every adult-template copyright page must satisfy.
 * Composed into per-imprint rule files via spread; imprints customise
 * the imprint-URL and group-statement checks where the wording differs.
 */
export function adultCopyrightChecks(): CopyrightContentCheck[] {
  return [
    {
      code: 'PRH-COPY-TDM-PARAGRAPH-MISSING',
      needle: TDM_RESERVATION_FRAGMENT,
      severity: 'moderate',
      suggestion:
        'Add the verbatim PRH TDM-reservation paragraph (the one that ends with "...In accordance with Article 4(3) of the DSM Directive 2019/790, Penguin Random House expressly reserves this work from the text and data mining exception."). See the Branding Guide → copyright-ad.xhtml for the full text.',
    },
    {
      code: 'PRH-COPY-EEA-LINE-MISSING',
      needle: EEA_LINE_FRAGMENT,
      severity: 'moderate',
      suggestion:
        'Add the verbatim EEA-representative line: "The authorized representative in the EEA is Penguin Random House Ireland, Morrison Chambers, 32 Nassau Street, Dublin D02 YH68".',
    },
    {
      code: 'PRH-COPY-BL-CIP-MISSING',
      needle: BL_CIP_FRAGMENT,
      severity: 'minor',
      suggestion:
        'Add the British Library CIP statement: "A CIP catalogue record for this book is available from the British Library".',
    },
    {
      code: 'PRH-COPY-GROUP-STATEMENT-MISSING',
      needle: GROUP_STATEMENT_FRAGMENT,
      severity: 'minor',
      suggestion:
        'Add the group statement: "[Division] is part of the Penguin Random House group of companies whose addresses can be found at global.penguinrandomhouse.com."',
    },
    {
      code: 'PRH-COPY-ADDRESS-BLOCK-MISSING',
      needle: ADULT_ADDRESS_FRAGMENT,
      severity: 'minor',
      suggestion:
        'Add the correspondence address: "Penguin Random House, One Embassy Gardens, 8 Viaduct Gardens, London SW11 7BW".',
    },
    {
      code: 'PRH-COPY-ISBN-MISSING',
      needle: ISBN_FRAGMENT_HINT,
      severity: 'moderate',
      suggestion: 'Add the ISBN line in the format "ISBN: 978-X-XXX-XXXXX-X".',
    },
    // PRH-COPY-PRH-LOGO-MISSING is checked separately via an alt-text
    // probe rather than a string-needle (the validator hands the
    // logo-alt-check to a dedicated branch). Listed in the registry but
    // omitted from this default-checks builder.
    // PRH-COPY-IMPRINT-URL-MISSING is imprint-specific: adult templates
    // expect www.penguin.co.uk; children's expects three URLs; Vintage
    // expects penguin.co.uk/vintage. Each imprint file appends its own.
  ];
}

/**
 * Boilerplate checks every children's-template copyright page must
 * satisfy. Identical to adult plus expects three imprint URLs (handled
 * per-imprint) and a children's-specific address line.
 */
export function childrensCopyrightChecks(): CopyrightContentCheck[] {
  return [
    {
      code: 'PRH-COPY-TDM-PARAGRAPH-MISSING',
      needle: TDM_RESERVATION_FRAGMENT,
      severity: 'moderate',
      suggestion:
        'Add the verbatim PRH TDM-reservation paragraph. See Branding Guide → copyright-ch.xhtml.',
    },
    {
      code: 'PRH-COPY-EEA-LINE-MISSING',
      needle: EEA_LINE_FRAGMENT,
      severity: 'moderate',
      suggestion:
        'Add the verbatim EEA-representative line: "The authorized representative in the EEA is Penguin Random House Ireland, Morrison Chambers, 32 Nassau Street, Dublin D02 YH68".',
    },
    {
      code: 'PRH-COPY-BL-CIP-MISSING',
      needle: BL_CIP_FRAGMENT,
      severity: 'minor',
      suggestion:
        'Add the British Library CIP statement: "A CIP catalogue record for this book is available from the British Library".',
    },
    {
      code: 'PRH-COPY-GROUP-STATEMENT-MISSING',
      needle: GROUP_STATEMENT_FRAGMENT,
      severity: 'minor',
      suggestion: 'Add the PRH group-of-companies statement.',
    },
    {
      code: 'PRH-COPY-ADDRESS-BLOCK-MISSING',
      needle: CHILDRENS_ADDRESS_FRAGMENT,
      severity: 'minor',
      suggestion:
        'Add the correspondence address for Penguin Random House Children’s (One Embassy Gardens, London).',
    },
    {
      code: 'PRH-COPY-ISBN-MISSING',
      needle: ISBN_FRAGMENT_HINT,
      severity: 'moderate',
      suggestion: 'Add the ISBN line in the format "ISBN: 978-X-XXX-XXXXX-X".',
    },
  ];
}

/** Adult imprint URL check (penguin.co.uk). */
export const PENGUIN_CO_UK_URL_CHECK: CopyrightContentCheck = {
  code: 'PRH-COPY-IMPRINT-URL-MISSING',
  needle: 'penguin.co.uk',
  severity: 'minor',
  suggestion:
    'Add the imprint URL: <a href="http://www.penguin.co.uk">www.penguin.co.uk</a>.',
};
