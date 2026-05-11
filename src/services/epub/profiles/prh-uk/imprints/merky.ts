import type { ImprintRules } from './_types';
import { adultCopyrightChecks, PENGUIN_CO_UK_URL_CHECK } from './_shared';

/**
 * #Merky Books (Cornerstone — Stormzy-founded imprint). Per Style Guide
 * §10.4.1: uses the adult copyright template with "#MERKY BOOKS" as the
 * division name. The imprint-specific deviation is on the title page,
 * not the copyright page.
 */
export const MERKY_RULES: ImprintRules = {
  imprint: 'merky',
  displayName: '#Merky Books',
  copyrightTemplate: 'adult',
  copyrightContentChecks: [
    ...adultCopyrightChecks(),
    PENGUIN_CO_UK_URL_CHECK,
  ],
  // No dedicated brand page in the #Merky template — the imprint relies
  // on the title page's logo and bespoke styling rather than a separate
  // brand-mark frontmatter section.
  brandPage: null,
  titlePage: {
    // #Merky uses the parent-group logo alt rather than its own
    // marketing name (Branding Guide §6).
    logoAlt: 'Penguin Random House',
  },
};
