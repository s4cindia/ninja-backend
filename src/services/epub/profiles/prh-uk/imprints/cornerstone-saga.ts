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
};
