import type { ImprintRules } from './_types';
import { BL_CIP_FRAGMENT, GROUP_STATEMENT_FRAGMENT, ISBN_FRAGMENT_HINT } from './_shared';

/**
 * Vintage — bespoke copyright template per the Branding Guide
 * (vintage/copyright.xhtml). Notable differences from the adult template:
 *   - Opens with a different anti-piracy paragraph (NOT the TDM/DSM one).
 *   - 1988 Act assertion: "...has asserted his/her right to be identified
 *     as the author of this Work in accordance with the Copyright,
 *     Designs and Patents Act 1988".
 *   - Address: "VINTAGE | 20 Vauxhall Bridge Road, London SW1V 2SA".
 *   - Imprint URL: penguin.co.uk/vintage.
 *   - Does NOT include the EEA-representative line.
 *   - Does NOT include the TDM-reservation paragraph.
 *   - Group statement IS included.
 *   - CIP IS included.
 *
 * Because Vintage doesn't include the TDM clause or EEA line, we
 * intentionally drop those checks from Vintage's rule set — otherwise
 * every conformant Vintage book would emit false positives.
 */
export const VINTAGE_RULES: ImprintRules = {
  imprint: 'vintage',
  displayName: 'Vintage',
  copyrightTemplate: 'vintage-bespoke',
  copyrightContentChecks: [
    // No TDM check — Vintage doesn't use it.
    // No EEA check — Vintage doesn't use it either.
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
        'Add the PRH group-of-companies statement (Vintage uses the same one as the adult template).',
    },
    {
      code: 'PRH-COPY-ADDRESS-BLOCK-MISSING',
      // Vintage-specific street address — different from adult.
      needle: '20 vauxhall bridge road, london sw1v 2sa',
      severity: 'minor',
      suggestion:
        'Add the Vintage correspondence address: "VINTAGE | 20 Vauxhall Bridge Road, London SW1V 2SA".',
    },
    {
      code: 'PRH-COPY-ISBN-MISSING',
      needle: ISBN_FRAGMENT_HINT,
      severity: 'moderate',
      suggestion: 'Add the ISBN line in the format "ISBN: 978-X-XXX-XXXXX-X".',
    },
    {
      code: 'PRH-COPY-IMPRINT-URL-MISSING',
      needle: 'penguin.co.uk/vintage',
      severity: 'minor',
      suggestion: 'Add the Vintage imprint URL: penguin.co.uk/vintage',
    },
  ],
};
