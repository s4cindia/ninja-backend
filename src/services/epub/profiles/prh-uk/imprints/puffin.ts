import type { ImprintRules } from './_types';
import { childrensCopyrightChecks } from './_shared';

/**
 * Puffin — children's imprint. Uses the children's copyright template
 * which expects all three children's imprint URLs (Penguin, Puffin,
 * Ladybird) and a split Text/Illustrations Copyright structure.
 *
 * We check for all three URLs because PRH's `copyright-ch.xhtml`
 * template uses the same three URLs across Puffin and Ladybird; an
 * EPUB missing any of them is non-conforming regardless of which
 * children's imprint published it.
 */
export const PUFFIN_RULES: ImprintRules = {
  imprint: 'puffin',
  displayName: 'Puffin',
  copyrightTemplate: 'children',
  copyrightContentChecks: [
    ...childrensCopyrightChecks(),
    {
      code: 'PRH-COPY-IMPRINT-URL-MISSING',
      needle: 'puffin.co.uk',
      severity: 'minor',
      suggestion: 'Add the imprint URL: www.puffin.co.uk',
    },
    {
      code: 'PRH-COPY-IMPRINT-URL-MISSING',
      needle: 'penguin.co.uk',
      severity: 'minor',
      suggestion: 'Add the imprint URL: www.penguin.co.uk (children\'s template references all three).',
    },
    {
      code: 'PRH-COPY-IMPRINT-URL-MISSING',
      needle: 'ladybird.co.uk',
      severity: 'minor',
      suggestion: 'Add the imprint URL: www.ladybird.co.uk',
    },
  ],
  brandPage: {
    figureClass: 'brand_logo_solo',
    logoAlt: 'Puffin Books',
  },
  titlePage: {
    // Puffin uses the children's full-bleed title page (image-only).
    // The validator drops the structured-imprint-logo check for this
    // path; alt text is descriptive ("Book Title - Subtitle by Author")
    // rather than the imprint name.
    logoAlt: 'Puffin Books',
    imageOnly: true,
  },
};
