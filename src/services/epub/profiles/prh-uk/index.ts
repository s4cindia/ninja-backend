/**
 * PRH UK profile module.
 *
 * PR1 (foundation): exposes the imprint detector only. Validators (metadata,
 * spine, nav, per-XHTML, image) and remediators land in PR2-PR4.
 */

export { detectPrhImprint } from './imprint-detector';
export type { ImprintDetectionInput, ImprintDetectionResult } from './imprint-detector';
