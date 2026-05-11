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
  socials: {
    // Penguin full socials page (follow_penguin.xhtml). Order matters
    // per Branding Guide §6 — Twitter first, TikTok last.
    channels: [
      { id: 'twitter', handle: 'twitter.com/penguinukbooks' },
      { id: 'facebook', handle: 'facebook.com/penguinbooks' },
      { id: 'instagram', handle: 'instagram.com/penguinukbooks' },
      { id: 'youtube', handle: 'youtube.com/penguinbooks' },
      { id: 'pinterest', handle: 'pinterest.com/penguinukbooks' },
      { id: 'linkedin', handle: 'linkedin.com/company/penguin-random-house-uk' },
      { id: 'tiktok', handle: 'tiktok.com/@penguinukbooks' },
    ],
    strapline: 'Find out more about the author and discover your next read at',
  },
  // Penguin YA cut-down socials page (follow_penguin_ya.xhtml). Per
  // Branding Guide §6: Instagram + YouTube + TikTok only, with the
  // TikTok handle pointing at @houseofya rather than @penguinukbooks.
  socialsYa: {
    channels: [
      { id: 'instagram', handle: 'instagram.com/penguinukbooks' },
      { id: 'youtube', handle: 'youtube.com/penguinbooks' },
      { id: 'tiktok', handle: 'tiktok.com/@houseofya' },
    ],
  },
};
