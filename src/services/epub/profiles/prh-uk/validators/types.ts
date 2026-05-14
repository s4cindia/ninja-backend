/**
 * Shared types for PRH UK validators. Validators are pure functions over
 * pre-parsed EPUB inputs and return a list of `PrhValidatorIssue` objects
 * that the orchestrator translates into the audit pipeline's
 * `AccessibilityIssue` shape.
 */

import type { PrhIssueSeverity } from '../../../../../constants/prh-issue-codes';

export interface PrhValidatorIssue {
  /** PRH-* code from prh-issue-codes.ts. */
  code: string;
  severity: PrhIssueSeverity;
  /** WCAG criteria this maps to (may be empty for publisher-specific rules). */
  wcag: string[];
  /** Human-readable message shown in the UI. */
  message: string;
  /** Concrete remediation hint shown in the UI. */
  suggestion: string;
  /** File or location the issue applies to (e.g. 'package.opf'). */
  location: string;
}

/**
 * Inputs every PRH validator can read. Parsed once in the orchestrator so
 * each validator is cheap and pure.
 */
export interface PrhValidatorInput {
  /** Full OPF (package.opf) content as string. */
  opfContent: string;
  /** Path of the OPF inside the zip (e.g. 'EPUB/package.opf'). */
  opfPath: string;
}

/** One XHTML file's content + path, surfaced to per-XHTML validators. */
export interface PrhXhtmlFile {
  path: string;
  content: string;
}

/** Inputs the per-XHTML validator reads — extends the OPF input. */
export interface PrhPerXhtmlInput extends PrhValidatorInput {
  /** dc:title from the OPF, if present. Used to flag generic page titles. */
  bookTitle: string | null;
  /** Every XHTML/HTML file in the EPUB. */
  xhtmlFiles: PrhXhtmlFile[];
}

/** Inputs the nav-doc validator reads — extends the OPF input. */
export interface PrhNavInput extends PrhValidatorInput {
  /** Full nav.xhtml content, or null if no nav doc was located. */
  navContent: string | null;
  /** Path of the nav doc inside the zip, or null. */
  navPath: string | null;
}

/** One CSS stylesheet's content + path. */
export interface PrhCssFile {
  /** Zip-relative path (e.g. 'EPUB/styles/basestyles.css'). */
  path: string;
  content: string;
  /**
   * Whether this stylesheet is part of the publisher's own /styles
   * directory (vs. a vendor/utility file vendored into the EPUB).
   * Class-name rules apply only to publisher stylesheets so we don't
   * false-flag third-party utility frameworks (TailwindCSS,
   * Bootstrap, NG-style) that the publisher may have embedded.
   */
  isPublisherOwned: boolean;
}

/** Inputs the CSS-conventions validator reads. */
export interface PrhCssConventionsInput extends PrhPerXhtmlInput {
  /** Every CSS file referenced by the manifest. */
  cssFiles: PrhCssFile[];
}

/** One manifest item resolved into a zip path + media type. */
export interface PrhManifestEntry {
  /** Resolved zip-relative path. */
  path: string;
  /** OPF media-type attribute (lowercased). */
  mediaType: string;
  /** Manifest item `properties` tokens, lowercased + split on whitespace. */
  properties: string[];
  /** Uncompressed size in bytes. May be `null` when the entry is
   *  manifested but absent from the zip (a separate concern handled
   *  by epubcheck). */
  sizeBytes: number | null;
}

/** Inputs the file-layout validator reads. */
export interface PrhFileLayoutInput extends PrhValidatorInput {
  /** Resolved manifest entries with sizes. */
  manifestEntries: PrhManifestEntry[];
  /** Every zip entry path (for dir-layout + fixed-name checks). */
  zipPaths: string[];
  /** True when the spine declares `toc="ncx"` (EPUB2 compat — toc.ncx
   *  becomes required when this flag is set). */
  requiresNcx: boolean;
}
