import type { ImprintRules } from './_types';
import { adultCopyrightChecks, PENGUIN_CO_UK_URL_CHECK } from './_shared';

export const PENGUIN_RULES: ImprintRules = {
  imprint: 'penguin',
  displayName: 'Penguin',
  copyrightTemplate: 'adult',
  copyrightContentChecks: [
    ...adultCopyrightChecks(),
    PENGUIN_CO_UK_URL_CHECK,
  ],
  brandPage: {
    figureClass: 'brand_logo_solo',
    logoAlt: 'Penguin Random House',
  },
  titlePage: {
    // Branding Guide §4 ships 6 structural variants for Penguin; the
    // validator does a soft fingerprint match so any of them passes.
    // Logo alt is the parent-group name across all variants.
    logoAlt: 'Penguin Random House',
  },
};
