/**
 * PRH UK imprint-rules registry.
 *
 * `getImprintRules(imprint)` returns the rule set for a detected
 * imprint, or `null` when the imprint is `'unknown'` / `null` (P2
 * validators gate on this — they don't run against unidentified
 * imprints to avoid false positives on multi-imprint demo docs).
 *
 * Imprints documented in the Branding Guide with bespoke rule sets:
 *   - Penguin, Puffin, Vintage, Pelican, Ladybird, #Merky,
 *     Cornerstone Saga
 *
 * Imprints listed in the Style Guide as "use adult template" fall back
 * to PENGUIN_RULES (which is the canonical adult template). Per Style
 * Guide §10.4.1 this covers Ebury, Transworld, RHCP, BBC Books,
 * Michael Joseph, Young Arrow and any others that aren't first-class
 * here.
 */

import type { PrhImprint } from '../../types';
import type { ImprintRules } from './_types';
import { PENGUIN_RULES } from './penguin';
import { PUFFIN_RULES } from './puffin';
import { VINTAGE_RULES } from './vintage';
import { PELICAN_RULES } from './pelican';
import { LADYBIRD_RULES } from './ladybird';
import { MERKY_RULES } from './merky';
import { CORNERSTONE_SAGA_RULES } from './cornerstone-saga';

const RULES_BY_IMPRINT: Partial<Record<PrhImprint, ImprintRules>> = {
  penguin: PENGUIN_RULES,
  puffin: PUFFIN_RULES,
  vintage: VINTAGE_RULES,
  pelican: PELICAN_RULES,
  ladybird: LADYBIRD_RULES,
  merky: MERKY_RULES,
  'cornerstone-saga': CORNERSTONE_SAGA_RULES,
  // 'unknown' is intentionally absent — P2 validators short-circuit on it.
};

/**
 * Return imprint rules for a detected imprint, or null when the imprint
 * is not first-class. Callers should also gate on this null check.
 */
export function getImprintRules(imprint: PrhImprint | null): ImprintRules | null {
  if (!imprint || imprint === 'unknown') return null;
  return RULES_BY_IMPRINT[imprint] ?? null;
}

export type { ImprintRules } from './_types';
