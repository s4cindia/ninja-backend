import type { ImprintRules } from './_types';
import { adultCopyrightChecks, PENGUIN_CO_UK_URL_CHECK } from './_shared';

/**
 * Pelican (Penguin Press) uses the adult copyright template per the
 * Branding Guide; its bespoke branding lives in the brand page + title
 * page + part-title styling rather than the copyright boilerplate.
 */
export const PELICAN_RULES: ImprintRules = {
  imprint: 'pelican',
  displayName: 'Pelican',
  copyrightTemplate: 'adult',
  copyrightContentChecks: [
    ...adultCopyrightChecks(),
    PENGUIN_CO_UK_URL_CHECK,
  ],
};
