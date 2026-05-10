/**
 * PRH UK VPAT 2.5 edition template.
 *
 * Pinned to PRH UK's accessibility delivery standard per the Technical
 * Guide's `accessibility_meta_boilerplates.txt`:
 *   - Conforms to: EPUB Accessibility 1.1 - WCAG 2.2 Level AA
 *   - Certified by: Penguin Random House UK
 *   - Certifier credential: Ace by DAISY OK
 *   - Accessibility summary URL: https://www.penguin.co.uk/accessibility
 *   - TDM-reservation: declared at publisher level
 *
 * Note: like the other VPAT templates in this directory, this file is
 * declarative metadata that the wider codebase doesn't (yet) consume —
 * the canonical edition wiring lives in `acr-generator.service.ts`.
 * Keeping it here for symmetry with the existing 4 editions and so a
 * future template-rendering pipeline has a single source of truth.
 */

export const VPAT_PRH_UK_TEMPLATE = {
  edition: 'VPAT2.5-PRH-UK',
  title: 'Voluntary Product Accessibility Template (VPAT) - PRH UK Edition',
  standards: ['EPUB Accessibility 1.1', 'WCAG 2.2'],
  description:
    'Penguin Random House UK delivery profile. Pins conformance to EPUB Accessibility 1.1 + WCAG 2.2 Level AA; certifier-of-record is Penguin Random House UK with Ace by DAISY OK credential.',
  certifier: {
    certifiedBy: 'Penguin Random House UK',
    certifierCredential: 'Ace by DAISY OK',
    credentialUrl: 'https://daisy.github.io/ace',
  },
  accessibilityConformsTo: 'EPUB Accessibility 1.1 - WCAG 2.2 Level AA',
  accessibilitySummaryUrl: 'https://www.penguin.co.uk/accessibility',
  tdmReservation: true,
  tdmReservationNote:
    'No part of this work may be used or reproduced in any manner for the purpose of training artificial intelligence technologies or systems. In accordance with Article 4(3) of the DSM Directive 2019/790, Penguin Random House expressly reserves this work from the text and data mining exception.',
  sections: [
    {
      id: 'wcag-a',
      title: 'Table 1: Success Criteria, Level A',
      description: 'WCAG 2.2 Level A criteria',
    },
    {
      id: 'wcag-aa',
      title: 'Table 2: Success Criteria, Level AA',
      description: 'WCAG 2.2 Level AA criteria',
    },
    // No AAA section — PRH's published target is AA.
  ],
  benefits: [
    'Pinned to PRH UK accessibility certification (WCAG 2.2 AA + EPUB Accessibility 1.1)',
    'Embeds the certifier-of-record line PRH requires in delivered VPATs',
    'Surfaces the TDM-reservation publisher notice',
    'Single document covers what PRH production controllers expect at hand-off',
  ],
} as const;
