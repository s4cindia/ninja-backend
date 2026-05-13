/**
 * PRH UK profile module.
 *
 * PR1 (foundation) added the imprint detector. PR2 adds the metadata and
 * spine validators plus their auto-fix remediators. PR3+ will add nav,
 * per-XHTML, and image validators.
 */

export { detectPrhImprint } from './imprint-detector';
export type { ImprintDetectionInput, ImprintDetectionResult } from './imprint-detector';

export { runPrhUkValidators } from './run-validators';
export type { PrhValidatorIssue } from './validators/types';
export {
  fixConformsTo,
  fixCertifiedBy,
  fixCertifierCredential,
  fixCertifierLink,
  fixTdmReservation,
  fixA11ySummaryUrl,
} from './remediators/metadata-remediator';
export { fixXmlLang } from './remediators/xhtml-remediator';
export { fixDecorativeRole } from './remediators/image-remediator';
export {
  fixDeprecatedTags,
  fixInlineStyles,
  fixEpubTypePlacement,
  addDocAriaRoles,
  fixBodyPurity,
  fixPagebreakMalformed,
} from './remediators/markup-remediator';
