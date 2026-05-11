import type { ImprintRules } from './_types';
import { childrensCopyrightChecks } from './_shared';

/**
 * Ladybird — children's classics imprint. Same template as Puffin
 * (children's), with all three children's imprint URLs expected.
 */
export const LADYBIRD_RULES: ImprintRules = {
  imprint: 'ladybird',
  displayName: 'Ladybird',
  copyrightTemplate: 'children',
  copyrightContentChecks: [
    ...childrensCopyrightChecks(),
    {
      code: 'PRH-COPY-IMPRINT-URL-MISSING',
      needle: 'ladybird.co.uk',
      severity: 'minor',
      suggestion: 'Add the imprint URL: www.ladybird.co.uk',
    },
    {
      code: 'PRH-COPY-IMPRINT-URL-MISSING',
      needle: 'penguin.co.uk',
      severity: 'minor',
      suggestion: 'Add the imprint URL: www.penguin.co.uk (children\'s template references all three).',
    },
    {
      code: 'PRH-COPY-IMPRINT-URL-MISSING',
      needle: 'puffin.co.uk',
      severity: 'minor',
      suggestion: 'Add the imprint URL: www.puffin.co.uk',
    },
  ],
  brandPage: {
    figureClass: 'brand_logo_solo',
    logoAlt: 'Ladybird Books',
  },
  titlePage: {
    // Ladybird's title page adds <figure class="portrait_small"> for the
    // interior illustration plus <h4> credits; structurally still a
    // <section epub:type="titlepage"> with imprint_logo.
    logoAlt: 'Ladybird Books',
  },
  // Ladybird has no canonical socials page — classics ads only.
  socials: null,
};
