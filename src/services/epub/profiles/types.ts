/**
 * Publisher-profile types for the EPUB audit pipeline.
 *
 * A "publisher profile" identifies that an uploaded EPUB was prepared for a
 * specific publisher (today: PRH UK; the shape generalises to others). When a
 * profile is detected, downstream PRH-specific validators run alongside the
 * standards-based audit (EPUBCheck + ACE + JS auditor); when no profile is
 * detected, behaviour is unchanged.
 */

/** Known publisher identifiers. Open-ended — extend as profiles are added. */
export type PublisherId = 'PRH-UK';

/** PRH UK imprint identifiers. Extend as PRH adds imprints. */
export type PrhImprint =
  | 'penguin'
  | 'puffin'
  | 'vintage'
  | 'pelican'
  | 'ladybird'
  | 'merky'
  | 'cornerstone-saga'
  | 'unknown';

/**
 * Detection confidence. `high` means multiple corroborating signals matched;
 * `medium` is one strong signal; `low` is a single weak hint. Validators only
 * run on `medium` or `high` to avoid false positives on EPUBs that incidentally
 * mention a publisher URL.
 */
export type DetectionConfidence = 'high' | 'medium' | 'low';

/**
 * One observation that contributed to a detection result. Surfaced in the
 * audit response so a reviewer can see WHY we believe the profile applies.
 */
export interface ProfileSignal {
  /** Short kebab-case identifier — useful in logs and tests. */
  id: string;
  /** Human-readable description shown in the UI (e.g. "OPF dc:publisher matches Penguin Random House UK"). */
  description: string;
  /**
   * Strength of this single signal. The detector aggregates strengths into the
   * overall confidence.
   */
  strength: 'strong' | 'moderate' | 'weak';
}

export interface PublisherProfile {
  /** `null` when no profile was detected with at least `low` confidence. */
  publisher: PublisherId | null;
  /** Imprint within the publisher; `'unknown'` when only the publisher matched. */
  imprint: PrhImprint | null;
  /** Aggregate confidence across all matched signals. */
  confidence: DetectionConfidence;
  /** Every signal that contributed to the result, in detection order. */
  signals: ProfileSignal[];
}

/** Convenience: the "no profile detected" result. */
export const NO_PROFILE: PublisherProfile = {
  publisher: null,
  imprint: null,
  confidence: 'low',
  signals: [],
};
