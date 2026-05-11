import type { ImprintRules } from './_types';
import { adultCopyrightChecks, PENGUIN_CO_UK_URL_CHECK } from './_shared';

/**
 * Cornerstone — Penny Street Saga. Uses the adult copyright template;
 * bespoke branding lives in the socials page (Penny Street newsletter +
 * Facebook handle), not the copyright boilerplate.
 */
export const CORNERSTONE_SAGA_RULES: ImprintRules = {
  imprint: 'cornerstone-saga',
  displayName: 'Cornerstone Saga',
  copyrightTemplate: 'adult',
  copyrightContentChecks: [
    ...adultCopyrightChecks(),
    PENGUIN_CO_UK_URL_CHECK,
  ],
  // Cornerstone — Penny Street Saga has no canonical brand page or
  // standalone title page in the Branding Guide; its imprint-specific
  // styling lives on the socials page and end-matter promo blocks.
  brandPage: null,
  titlePage: null,
};
